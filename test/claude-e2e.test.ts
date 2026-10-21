import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { encodeAccountKey, hashSecret } from '../packages/core/src/keys.ts';
import { findClaude, runClaude, type ClaudeCli } from '../packages/rembo/src/install.ts';
import { startHub, type RunningHub } from '../packages/server/src/hub.ts';

// Installs the plugin into a throw-away Claude Code profile and runs a real
// `claude -p`. Without credentials it stops at "Not logged in", after the
// session has started: SessionStart, MCP servers and modules have all run by
// then, and no model is called (nothing is spent). Skipped without `claude`.
const claude = process.env.REMBO_E2E === '0' ? null : findClaude(process.env);
const CLI = path.resolve('packages/rembo/dist/cli.js');

let root: string;
let hub: RunningHub;
let env: NodeJS.ProcessEnv;
let cfg: string;
let rhome: string;
let project: string;
let realBefore: Map<string, string>;

const realFiles = () => {
  const dir = path.join(os.homedir(), '.claude');
  return [path.join(dir, 'settings.json'), path.join(dir, 'plugins', 'installed_plugins.json'), path.join(dir, 'plugins', 'known_marketplaces.json')];
};
const hashes = () => new Map(realFiles().map((f) => [f, existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : '-']));

function rembo(args: string[], cwd = root): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--home', rhome], { cwd, env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end();
  });
}

describe.skipIf(!claude)('Claude Code end to end (isolated profile)', () => {
  const cc = claude as ClaudeCli;

  beforeAll(async () => {
    realBefore = hashes();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rembo-cc-'));
    cfg = path.join(root, 'claude-config');
    rhome = path.join(root, 'rembo-home');
    const fakeHome = path.join(root, 'user');
    project = path.join(root, 'work', 'e2e');
    await fs.mkdir(path.join(project, '.git'), { recursive: true });
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.writeFile(path.join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/example/e2e.git\n');
    env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, USERPROFILE: fakeHome, HOME: fakeHome };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'REMBO', 'REMBO_HOME']) delete env[k];
    hub = await startHub({ dataDir: path.join(root, 'hub'), port: 0 });
  });

  afterAll(async () => {
    await hub?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  test('setup installs the plugin, a session gets the snapshot, MCP and the mod; uninstall removes it', async () => {
    const account = hub.db.createAccount();
    const keyId = randomBytes(8).toString('hex');
    const secret = randomBytes(32);
    hub.db.addAccountKey(account, keyId, hashSecret(secret));
    const setup = await rembo(['setup', encodeAccountKey({ keyId, secret, hub: hub.url }), '--name', 'e2e-box']);
    expect(setup.out).toContain('RK-');
    expect(setup.out).toContain('rembo@rembo 0.1.0 installed');
    expect(setup.code).toBe(0);
    expect((await rembo(['remember', 'E2E marker fact for the session', '--type', 'howto'], project)).code).toBe(0);

    const listed = JSON.parse((await runClaude(cc, ['plugin', 'list', '--json'], env)).stdout) as { id: string; enabled: boolean; version: string }[];
    expect(listed.find((p) => p.id === 'rembo@rembo')).toMatchObject({ enabled: true, version: '0.1.0' });
    expect((await runClaude(cc, ['plugin', 'validate', path.join(rhome, 'app', '0.1.0')], env)).code).toBe(0);
    expect((await rembo(['install'])).out).toContain('installed'); // idempotent

    const session = await new Promise<string>((resolve) => {
      const child = spawn(cc.file, ['-p', 'hello', '--debug'], { cwd: project, env, shell: cc.shell, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.on('close', () => resolve(out));
    });
    expect(session).toMatch(/Not logged in|Invalid API key|login/i); // no credentials: no model call
    const debugDir = path.join(cfg, 'debug');
    const newest = (await fs.readdir(debugDir)).filter((f) => f.endsWith('.txt')).map((f) => path.join(debugDir, f));
    const debug = (await Promise.all(newest.map((f) => fs.readFile(f, 'utf8')))).join('\n');
    expect(debug).toContain('E2E marker fact for the session'); // SessionStart injected the snapshot
    expect(debug).toContain('<rembo-memory>');
    expect(debug).toMatch(/hooks module rembo@rembo loaded/);
    expect(debug).toMatch(/\$\.ui\.status \(rembo\): Rembo Mode On/);
    // MCP connects in the background; a short -p run may end before it finishes, so require a start and no failure
    // (the protocol itself is covered by test/plugin.test.ts).
    expect(debug).toMatch(/MCP server "plugin:rembo:rembo": (Starting connection|Successfully connected)/);
    expect(debug).not.toMatch(/MCP server "plugin:rembo:rembo".*(fail|error)/i);

    const doctor = await rembo(['doctor']);
    expect(doctor.out).toMatch(/✓ plugin/);

    const removed = await rembo(['uninstall']);
    expect(removed.code).toBe(0);
    const after = JSON.parse((await runClaude(cc, ['plugin', 'list', '--json'], env)).stdout) as { id: string }[];
    expect(after.some((p) => p.id === 'rembo@rembo')).toBe(false);
    const settings = await fs.readFile(path.join(cfg, 'settings.json'), 'utf8');
    expect(settings).not.toContain('rembo');
    expect(existsSync(path.join(rhome, 'config.json'))).toBe(true); // memory stays

    expect(hashes()).toEqual(realBefore); // the real ~/.claude was never touched
  }, 300_000);
});
