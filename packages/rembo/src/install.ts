import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_VERSION } from '../../core/src/client.ts';
import { RemboError } from '../../core/src/errors.ts';
import { atomicWrite, readJson } from '../../core/src/fsutil.ts';

export const PLUGIN_ID = 'rembo@rembo';
const MARKETPLACE = 'rembo';

export interface ClaudeCli {
  file: string;
  shell: boolean;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  appDir?: string;
  version?: string;
}

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The `claude` executable on PATH, or in the native installer's default folder. */
export function findClaude(env: NodeJS.ProcessEnv): ClaudeCli | null {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  // Absolute entries only: a relative one (".") would run a claude planted in the current folder.
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (existsSync(file)) return { file, shell: name.endsWith('.cmd') };
    }
  }
  return null;
}

/** Runs `claude <args>`; a .cmd shim needs a shell on Windows, so arguments are quoted for it. */
export function runClaude(claude: ClaudeCli, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE; // setup may run from inside a Claude Code session
  return new Promise((resolve) => {
    const quote = (a: string) => `"${a.replace(/"/g, '""')}"`;
    const child = claude.shell
      ? spawn(quote(claude.file), args.map(quote), { env: childEnv, shell: true, windowsHide: true })
      : spawn(claude.file, args, { env: childEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function parseJson<T>(text: string): T | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

/** Where this package keeps its bundle and plugin folder (same from the bundle and from sources). */
function sources(): { cli: string; plugin: string; license?: string } {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = path.join(root, 'dist', 'cli.js');
  const plugin = path.join(root, 'plugin');
  if (!existsSync(cli) || !existsSync(path.join(plugin, '.claude-plugin', 'plugin.json'))) {
    throw new RemboError('package_incomplete', 'This copy of rembo has no plugin files to install.', 'Run it from the rembo package: npx rembo@latest install');
  }
  const license = [path.join(root, 'LICENSE'), path.join(root, '..', '..', 'LICENSE')].find((f) => existsSync(f));
  return license ? { cli, plugin, license } : { cli, plugin };
}

/** Writes the per-machine parts: absolute Node path (exec form, no shell, no PATH lookup) and the rembo home. */
async function renderPlugin(appDir: string, home: string): Promise<void> {
  const node = process.execPath;
  const cli = '${CLAUDE_PLUGIN_ROOT}/cli.js';
  const hook = (event: string, timeout: number) => [
    { hooks: [{ type: 'command', command: node, args: [cli, 'hook', event, '--home', home], timeout }] },
  ];
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  await atomicWrite(
    path.join(appDir, 'hooks', 'hooks.json'),
    json({ modules: ['./mod.ts'], hooks: { SessionStart: hook('session-start', 15), SessionEnd: hook('session-end', 5) } }),
  );
  await atomicWrite(path.join(appDir, '.mcp.json'), json({ mcpServers: { rembo: { command: node, args: [cli, 'mcp', '--home', home] } } }));
  await atomicWrite(path.join(appDir, 'app.json'), json({ version: CLIENT_VERSION, node, home }));
  const manifestFile = path.join(appDir, '.claude-plugin', 'plugin.json');
  const manifest = await readJson<Record<string, unknown>>(manifestFile, {});
  await atomicWrite(manifestFile, json({ ...manifest, version: CLIENT_VERSION }));
}

/** Copies settings.json (it may hold secrets in "env") to ~/.rembo/backup, owner-only, keeping the last 10. */
async function backupSettings(home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const settings = path.join(claudeConfigDir(env), 'settings.json');
  if (!existsSync(settings)) return undefined;
  const root = path.join(home, 'backup');
  const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(dir, 'settings.json'), await fs.readFile(settings), 0o600);
  const all = (await fs.readdir(root)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) await fs.rm(path.join(root, old), { recursive: true, force: true });
  return dir;
}

interface PluginRow {
  id: string;
  version?: string;
  enabled?: boolean;
}

async function installedPlugin(claude: ClaudeCli, env: NodeJS.ProcessEnv): Promise<PluginRow | undefined> {
  const list = parseJson<PluginRow[]>((await runClaude(claude, ['plugin', 'list', '--json'], env)).stdout);
  return Array.isArray(list) ? list.find((p) => p.id === PLUGIN_ID) : undefined;
}

/**
 * Copies this version into ~/.rembo/app/<version>, registers ~/.rembo/app as a
 * local marketplace and installs (or updates) the plugin at user scope. Claude
 * Code settings change only through its own CLI; settings.json is backed up first.
 */
export async function installPlugin(home: string, env: NodeJS.ProcessEnv): Promise<InstallResult> {
  const claude = findClaude(env);
  if (!claude) {
    return { ok: false, message: 'Claude Code ("claude") was not found, so the plugin was not installed. Install Claude Code, then run: rembo install' };
  }
  const src = sources();
  const appRoot = path.join(home, 'app');
  const appDir = path.join(appRoot, CLIENT_VERSION);
  // Build the copy next to the target and swap it in, so an interrupted install never leaves a half plugin.
  const staging = `${appDir}.staging-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(src.plugin, staging, { recursive: true, filter: (f) => !/\.test\.tsx?$/.test(f) });
  await fs.copyFile(src.cli, path.join(staging, 'cli.js'));
  if (src.license) await fs.copyFile(src.license, path.join(staging, 'LICENSE'));
  await renderPlugin(staging, home);
  await fs.rm(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.rename(staging, appDir);
  await atomicWrite(
    path.join(appRoot, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: 'rembo', email: 'hello@rembo.dev' },
        plugins: [{ name: 'rembo', source: `./${CLIENT_VERSION}`, version: CLIENT_VERSION, description: 'Shared memory for Claude Code' }],
      },
      null,
      2,
    ) + '\n',
  );
  await backupSettings(home, env);

  const step = async (args: string[]) => {
    const r = await runClaude(claude, args, env);
    const out = parseJson<{ outcome?: string; message?: string }>(r.stdout);
    if (r.code !== 0 || (out?.outcome && out.outcome !== 'ok')) {
      throw new RemboError('plugin_install_failed', `claude ${args.slice(0, 3).join(' ')} failed: ${(out?.message ?? r.stderr ?? r.stdout).trim().slice(0, 300)}`);
    }
  };
  const markets = parseJson<{ name: string }[]>((await runClaude(claude, ['plugin', 'marketplace', 'list', '--json'], env)).stdout) ?? [];
  if (markets.some((m) => m.name === MARKETPLACE)) await step(['plugin', 'marketplace', 'update', MARKETPLACE, '--json']);
  else await step(['plugin', 'marketplace', 'add', appRoot, '--scope', 'user', '--json']);
  const before = await installedPlugin(claude, env);
  if (!before) await step(['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json']);
  else if (before.version !== CLIENT_VERSION) await step(['plugin', 'update', PLUGIN_ID, '--scope', 'user', '--json']);
  if (before && before.enabled === false) await step(['plugin', 'enable', PLUGIN_ID, '--scope', 'user', '--json']);
  const after = await installedPlugin(claude, env);
  if (!after || after.version !== CLIENT_VERSION || after.enabled === false) {
    throw new RemboError('plugin_install_failed', `The plugin did not register as expected (found: ${after ? `${after.version}, enabled ${after.enabled}` : 'nothing'}).`);
  }
  // Keep this version and the previous one (for a manual rollback); drop older copies.
  const versions = (await fs.readdir(appRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name));
  const stamped = await Promise.all(versions.map(async (d) => ({ name: d.name, at: (await fs.stat(path.join(appRoot, d.name))).mtimeMs })));
  for (const old of stamped.sort((a, b) => b.at - a.at).slice(2)) {
    if (old.name !== CLIENT_VERSION) await fs.rm(path.join(appRoot, old.name), { recursive: true, force: true });
  }
  return { ok: true, message: `Claude Code plugin ${PLUGIN_ID} ${CLIENT_VERSION} installed; it is active in new Claude Code sessions.`, appDir, version: CLIENT_VERSION };
}

/** Removes the plugin and the marketplace from Claude Code and the app copies from ~/.rembo. */
export async function uninstallPlugin(home: string, env: NodeJS.ProcessEnv): Promise<InstallResult> {
  const claude = findClaude(env);
  const notes: string[] = [];
  if (claude) {
    if (await installedPlugin(claude, env)) {
      await backupSettings(home, env);
      const r = await runClaude(claude, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user', '--json'], env);
      if (r.code !== 0) notes.push(`plugin uninstall: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    const markets = parseJson<{ name: string }[]>((await runClaude(claude, ['plugin', 'marketplace', 'list', '--json'], env)).stdout) ?? [];
    if (markets.some((m) => m.name === MARKETPLACE)) {
      const r = await runClaude(claude, ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json'], env);
      if (r.code !== 0) notes.push(`marketplace remove: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    if (await installedPlugin(claude, env)) notes.push('the plugin is still listed by claude plugin list');
  } else {
    notes.push('Claude Code ("claude") not found; nothing to remove there');
  }
  await fs.rm(path.join(home, 'app'), { recursive: true, force: true });
  return { ok: notes.length === 0 || !claude, message: notes.length ? `Done with notes: ${notes.join('; ')}` : 'The rembo plugin was removed from Claude Code.' };
}

/** Problems with the installed copy that would make hooks or the MCP server fail silently. */
export async function checkInstalledApp(home: string): Promise<string | undefined> {
  const version = await installedAppVersion(home);
  if (!version) return 'no plugin copy in ' + path.join(home, 'app');
  const app = await readJson<{ node?: string } | null>(path.join(home, 'app', version, 'app.json'), null);
  if (!app?.node || !existsSync(app.node)) return `the Node.js used by the plugin is gone (${app?.node ?? '?'})`;
  if (!existsSync(path.join(home, 'app', version, 'cli.js'))) return 'the plugin copy is incomplete';
  return undefined;
}

/** The installed plugin version recorded in ~/.rembo/app, if any. */
export async function installedAppVersion(home: string): Promise<string | undefined> {
  const marketplace = await readJson<{ plugins?: { version?: string }[] } | null>(path.join(home, 'app', '.claude-plugin', 'marketplace.json'), null);
  return marketplace?.plugins?.[0]?.version;
}
