import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RemboClient } from '../../core/src/client.ts';
import { buildSnapshot } from './snapshot.ts';

export interface HookContext {
  home: string;
  /** The CLI file to run for background work (this process's own entry). */
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

const LOG_LIMIT = 512 * 1024;

/** Appends one line to ~/.rembo/logs/rembo.log (rotated once at 512 KB); never throws. */
export async function log(home: string, line: string): Promise<void> {
  try {
    const dir = path.join(home, 'logs');
    const file = path.join(dir, 'rembo.log');
    await fs.mkdir(dir, { recursive: true });
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    if (size > LOG_LIMIT) await fs.rename(file, `${file}.1`).catch(() => undefined);
    await fs.appendFile(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break a session
  }
}

/** Starts `rembo sync` detached: the hook returns at once and the sync outlives it. */
export function spawnSync(ctx: HookContext): void {
  const child = spawn(process.execPath, [ctx.cliPath, 'sync', '--home', ctx.home], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: ctx.env,
    cwd: ctx.home, // not the project folder: Windows cannot delete or rename a running process's working folder
  });
  child.on('error', (e) => void log(ctx.home, `hook: cannot start sync: ${e.message}`));
  child.unref();
}

/** Off for this session (REMBO=off) or by default (rembo off), unless REMBO=on. */
export function isOff(client: RemboClient, env: NodeJS.ProcessEnv): boolean {
  const flag = (env.REMBO ?? '').toLowerCase();
  if (flag === 'off') return true;
  if (flag === 'on') return false;
  return client.config.defaults.mode === 'off';
}

/**
 * Runs a Claude Code hook and returns what to print on stdout. Hooks never
 * fail a session: problems are logged and the answer is empty.
 */
export async function runHook(event: string, stdin: string, ctx: HookContext): Promise<string> {
  let input: { cwd?: string; source?: string } = {};
  try {
    input = stdin.trim() ? (JSON.parse(stdin) as typeof input) : {};
  } catch {
    // keep defaults
  }
  let client: RemboClient;
  try {
    client = await RemboClient.open(ctx.home);
  } catch {
    return ''; // not set up on this machine
  }
  try {
    if (isOff(client, ctx.env)) return '';
    if (event === 'session-end') {
      spawnSync(ctx);
      return '';
    }
    if (event !== 'session-start') return '';
    const snapshot = await buildSnapshot(client, input.cwd ?? process.cwd());
    spawnSync(ctx);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: snapshot } });
  } catch (e) {
    await log(ctx.home, `hook ${event}: ${(e as Error).stack ?? String(e)}`);
    return '';
  } finally {
    client.close();
  }
}
