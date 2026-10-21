import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CLIENT_VERSION, defaultHome, RemboClient, type SyncResult } from '../../core/src/client.ts';
import { ENTRY_TYPES, entryToMarkdown, isValidScope, type EntryType } from '../../core/src/entry.ts';
import { RemboError, untrusted } from '../../core/src/errors.ts';
import { atomicWrite } from '../../core/src/fsutil.ts';
import { HubClient } from '../../core/src/http.ts';
import { resolveProject } from '../../core/src/project.ts';
import { PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, type HealthResponse } from '../../core/src/protocol.ts';
import { liveEntries } from '../../core/src/views.ts';
import { log, runHook } from './hook.ts';
import { claudeConfigDir, findClaude, installedAppVersion, installPlugin, PLUGIN_ID, runClaude, uninstallPlugin } from './install.ts';
import { McpServer } from './mcp.ts';
import { buildSnapshot } from './snapshot.ts';

const HELP = `rembo ${CLIENT_VERSION} — shared, end-to-end encrypted memory for Claude Code

Usage: rembo <command> [options]

Setup
  setup <account-key>          Connect this machine (the first machine creates the vault)
    --recovery-key <RK-…>      Recovery key (every machine after the first)
    --recovery-file <file>     Read the recovery key from a file
    --name <name>              Device name (default: hostname)
    --hub <url>                Override the hub address stored in the key
    --no-encryption            Self-hosted only: store memory unencrypted (not recommended)
    --no-plugin                Do not install the Claude Code plugin

Memory
  remember <title> [--body <text> | --body-file <file|->] [--summary <s>]
           [--type <${ENTRY_TYPES.join('|')}>] [--scope <global|project:x|machine:x> | --global]
           [--tags a,b] [--supersedes <id>]
  search <query…> [--scope <s>] [--limit <n>]
  read <id>
  list [--scope <s>]
  forget <id> [--only]          Forget an entry and its earlier versions (--only: just this one)

Sync and status
  sync [--retry-failed] | status | doctor

Claude Code
  install | update             Install or update the Claude Code plugin
  uninstall [--purge --yes]    Remove the plugin (--purge also deletes ~/.rembo)
  on | off                     Default for new sessions (one session: /rembo on|off)
  snapshot [--cwd <dir>]       Print the memory a session starts with

Devices and hub
  device list | device revoke <id>
  hub set-url <url>

Global options: --json, --home <dir> (default: $REMBO_HOME or ~/.rembo),
  --claude-config <dir> (default: $CLAUDE_CONFIG_DIR or ~/.claude), --version, --help`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  isTTY: boolean;
  prompt?(question: string): Promise<string>;
  readStdin?(): Promise<string>;
}

export const processIo = (): Io => ({
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
  cwd: process.cwd(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
});

class UsageError extends Error {}

function nodeOk(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  return major > 22 || (major === 22 && minor >= 12);
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      home: { type: 'string' },
      'recovery-key': { type: 'string' },
      'recovery-file': { type: 'string' },
      name: { type: 'string' },
      hub: { type: 'string' },
      'no-encryption': { type: 'boolean' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      summary: { type: 'string' },
      type: { type: 'string' },
      scope: { type: 'string' },
      global: { type: 'boolean' },
      tags: { type: 'string' },
      supersedes: { type: 'string', multiple: true },
      limit: { type: 'string' },
      only: { type: 'boolean' },
      'no-plugin': { type: 'boolean' },
      'claude-config': { type: 'string' },
      cwd: { type: 'string' },
      purge: { type: 'boolean' },
      yes: { type: 'boolean' },
      'retry-failed': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const home = path.resolve(values.home ?? defaultHome());
  const json = Boolean(values.json);
  const print = (human: string, data?: unknown) => io.out(json && data !== undefined ? JSON.stringify(data, null, 2) : human);
  const [cmd, ...rest] = positionals;

  if (values.version) {
    io.out(CLIENT_VERSION);
    return 0;
  }
  if (values.help || !cmd) {
    io.out(HELP);
    return values.help ? 0 : 2;
  }

  const open = () => RemboClient.open(home);
  const env: NodeJS.ProcessEnv = values['claude-config'] ? { ...process.env, CLAUDE_CONFIG_DIR: path.resolve(values['claude-config']) } : process.env;
  const install = async () => {
    try {
      return await installPlugin(home, env);
    } catch (e) {
      return { ok: false, message: `Claude Code plugin not installed: ${(e as Error).message}` };
    }
  };
  const syncAfterChange = async (client: RemboClient): Promise<{ sync?: SyncResult; note: string }> => {
    try {
      const sync = await client.sync();
      if (sync.status === 'offline') return { sync, note: ' (saved locally; will sync when the hub is reachable)' };
      if (sync.status === 'partial') return { sync, note: ` (saved locally; not sent yet: ${sync.error})` };
      return { sync, note: '' };
    } catch (e) {
      return { note: ` (saved locally; sync failed: ${(e as Error).message})` };
    }
  };
  const scopeFrom = (fallback: string | undefined): string | undefined => {
    if (values.global) return 'global';
    if (values.scope) {
      if (!isValidScope(values.scope)) throw new UsageError(`Invalid scope "${values.scope}". Use global, project:<slug> or machine:<name>.`);
      return values.scope;
    }
    return fallback;
  };

  switch (cmd) {
    case 'setup': {
      const accountKey = rest[0];
      if (!accountKey) throw new UsageError('Usage: rembo setup <account-key>');
      if (!nodeOk()) throw new RemboError('node_too_old', `rembo needs Node.js 22.12 or newer (you have ${process.versions.node}).`, 'Install the current LTS from https://nodejs.org');
      let recoveryKey = values['recovery-key'];
      if (!recoveryKey && values['recovery-file']) recoveryKey = (await fs.readFile(values['recovery-file'], 'utf8')).trim();
      const opts = {
        home,
        accountKey,
        recoveryKey,
        deviceName: values.name,
        hubUrl: values.hub,
        encryption: !values['no-encryption'],
      };
      let result;
      try {
        result = await RemboClient.setup(opts);
      } catch (e) {
        if (e instanceof RemboError && e.code === 'recovery_key_required' && io.isTTY && io.prompt) {
          io.out('This account already has a vault. Paste the recovery key from your first machine.');
          opts.recoveryKey = (await io.prompt('Recovery key (RK-…): ')).trim();
          result = await RemboClient.setup(opts);
        } else throw e;
      }
      const { client } = result;
      // The recovery key is printed before the first sync, so no later failure can swallow it.
      if (!json) {
        io.out(`✓ Device "${client.config.device.name}" registered with ${client.config.hub.url}`);
        if (result.createdVault) {
          io.out(`✓ New vault ${result.vaultPending ? 'prepared (the hub confirms it on the next sync)' : 'created'} (encryption ${client.config.vault.encryption ? 'on' : 'OFF'})`);
          if (result.recoveryKey) {
            io.out('');
            io.out('  Your RECOVERY KEY. Save it in your password manager now; it is shown only once.');
            io.out('  You need it to connect your other machines. Nobody, not even the hub, can recover it:');
            io.out('');
            io.out(`    ${result.recoveryKey}`);
            io.out('');
          }
        }
      }
      let sync: SyncResult | undefined;
      let syncError: string | undefined;
      try {
        sync = await client.sync({ wait: true });
      } catch (e) {
        syncError = (e as Error).message;
      } finally {
        client.close();
      }
      const plugin = values['no-plugin'] ? undefined : await install();
      if (json) {
        print('', { createdVault: result.createdVault, vaultPending: result.vaultPending, recoveryKey: result.recoveryKey, vault: client.config.vault.id, sync, syncError, plugin });
        return 0;
      }
      if (!result.createdVault && sync) io.out(`✓ Vault unlocked; ${sync.pulled} entries downloaded`);
      if (syncError || (sync && sync.status !== 'ok')) io.out(`! First sync did not finish (${syncError ?? sync?.error ?? sync?.status}); run rembo sync later.`);
      if (plugin) io.out(`${plugin.ok ? '✓' : '!'} ${plugin.message}`);
      io.out('✓ Ready. Start a new Claude Code session, or try: rembo remember "Something worth remembering"');
      return 0;
    }

    case 'remember': {
      const title = rest.join(' ').trim();
      if (!title) throw new UsageError('Usage: rembo remember <title> [--body <text>]');
      let body = values.body;
      if (values['body-file'] === '-') body = (await io.readStdin?.()) ?? '';
      else if (values['body-file']) body = await fs.readFile(values['body-file'], 'utf8');
      if (values.type && !ENTRY_TYPES.includes(values.type as EntryType)) throw new UsageError(`--type must be one of: ${ENTRY_TYPES.join(', ')}`);
      const project = resolveProject(io.cwd);
      const client = await open();
      try {
        const entry = await client.remember({
          title,
          body,
          summary: values.summary,
          type: values.type as EntryType | undefined,
          scope: scopeFrom(project.via === 'git' ? `project:${project.slug}` : 'global'),
          tags: values.tags?.split(',').map((t) => t.trim()).filter(Boolean),
          supersedes: values.supersedes,
          source: { path: io.cwd },
        });
        const { sync, note } = await syncAfterChange(client);
        print(`✓ Remembered ${entry.meta.id} [${entry.meta.scope}]${note}`, { entry: entry.meta, sync });
      } finally {
        client.close();
      }
      return 0;
    }

    case 'search': {
      const query = rest.join(' ').trim();
      if (!query) throw new UsageError('Usage: rembo search <query>');
      const client = await open();
      const hits = await client.search(query, { scope: scopeFrom(undefined), limit: Number(values.limit ?? 10) });
      client.close();
      if (json) return print('', { hits }), 0;
      if (!hits.length) io.out('No matches.');
      for (const h of hits) io.out(`${h.id}  ${h.title}\n    ${h.summary}\n    [${h.scope}] ${h.device ?? '?'} ${h.created.slice(0, 10)}  score ${h.score}`);
      return 0;
    }

    case 'read': {
      if (!rest[0]) throw new UsageError('Usage: rembo read <id>');
      const client = await open();
      const entry = await client.read(rest[0]);
      client.close();
      if (!entry) throw new RemboError('not_found', `No entry ${rest[0]} on this machine.`, 'Run rembo sync, then try again.');
      print(entryToMarkdown(entry), { entry });
      return 0;
    }

    case 'list': {
      const client = await open();
      const scope = scopeFrom(undefined);
      const entries = liveEntries(await client.loadEntries())
        .filter((e) => !scope || e.meta.scope === scope)
        .sort((a, b) => b.meta.created.localeCompare(a.meta.created));
      client.close();
      if (json) return print('', { entries: entries.map((e) => e.meta) }), 0;
      if (!entries.length) io.out('No entries.');
      for (const e of entries) io.out(`${e.meta.id}  ${e.meta.created.slice(0, 10)}  [${e.meta.scope}] ${e.meta.title}`);
      return 0;
    }

    case 'forget': {
      if (!rest[0]) throw new UsageError('Usage: rembo forget <id>');
      const client = await open();
      try {
        const ids = await client.forget(rest[0], { only: Boolean(values.only) });
        const { sync, note } = await syncAfterChange(client);
        const older = ids.length > 1 ? ` and ${ids.length - 1} earlier version(s)` : '';
        print(`✓ Forgotten ${rest[0]}${older}${note}`, { forgotten: ids, sync });
      } finally {
        client.close();
      }
      return 0;
    }

    case 'sync': {
      const client = await open();
      const retried = values['retry-failed'] ? await client.retryFailed() : 0;
      const r = await client.sync({ wait: true });
      client.close();
      const extra = [
        retried ? `${retried} failed change(s) retried` : '',
        r.rejected ? `${r.rejected} rejected (could not be verified)` : '',
        r.deferred ? `${r.deferred} waiting for a newer rembo (run: rembo update)` : '',
        r.failed ? `${r.failed} refused by the hub (kept; see rembo doctor)` : '',
      ].filter(Boolean);
      const human =
        r.status === 'offline'
          ? `! Hub unreachable; ${await client.pendingCount()} change(s) queued. ${r.error ?? ''}`
          : r.status === 'busy'
            ? '! Another sync is running; try again in a moment.'
            : `${r.status === 'ok' ? '✓' : '!'} Synced: ${r.pushed} sent, ${r.pulled} received, ${r.removed} removed${extra.length ? `; ${extra.join('; ')}` : ''}${r.status === 'partial' ? `\n  Not sent yet: ${r.error}` : ''}`;
      print(human, { ...r, retried });
      return r.status === 'ok' ? 0 : 1;
    }

    case 'status': {
      const client = await open();
      const entries = liveEntries(await client.loadEntries());
      const last = await client.lastSync();
      const pending = await client.pendingCount();
      const failed = await client.failedCount();
      const deferred = await client.deferredCount();
      client.close();
      const c = client.config;
      const data = { home, hub: c.hub.url, device: c.device, vault: { id: c.vault.id, encryption: c.vault.encryption }, entries: entries.length, pending, failed, deferred, lastSync: last };
      if (json) return print('', { ...data, device: { id: c.device.id, name: c.device.name } }), 0;
      io.out(
        [
          `rembo ${CLIENT_VERSION}`,
          `hub        ${c.hub.url}${c.hub.certPin ? ' (pinned certificate)' : ''}`,
          `device     ${c.device.name} (${c.device.id})`,
          `vault      ${c.vault.id} (encryption ${c.vault.encryption ? 'on' : 'OFF'})`,
          `entries    ${entries.length}, pending uploads ${pending}${failed ? `, ${failed} refused by the hub` : ''}${deferred ? `, ${deferred} need a newer rembo` : ''}`,
          `last sync  ${last ? `${last.at} ${last.ok ? 'ok' : 'failed: ' + last.error}` : 'never'}`,
          `local copy ${path.join(home, 'vaults', c.vault.id, 'md')}`,
        ].join('\n'),
      );
      return 0;
    }

    case 'doctor':
      return doctor(home, io, json, env);

    case 'install':
    case 'update': {
      const before = await installedAppVersion(home);
      await open(); // must be set up first
      const r = await install();
      const note = cmd === 'update' && before === CLIENT_VERSION ? ' (already this version; newer releases: npm i -g rembo@latest, then rembo update)' : '';
      print(`${r.ok ? '✓' : '✗'} ${r.message}${note}`, { ...r, previous: before });
      return r.ok ? 0 : 1;
    }

    case 'uninstall': {
      const r = await uninstallPlugin(home, env);
      if (values.purge) {
        if (!values.yes) throw new UsageError('--purge deletes the local memory copy and keys in ' + home + '; repeat with --yes to confirm.');
        await RemboClient.removeLocal(home);
      }
      print(`${r.ok ? '✓' : '!'} ${r.message}${values.purge ? ` Deleted ${home}.` : ` Your memory stays in ${home} and on the hub.`}`, r);
      return r.ok ? 0 : 1;
    }

    case 'on':
    case 'off': {
      const client = await open();
      await client.setDefaultMode(cmd);
      client.close();
      print(`✓ rembo is ${cmd} by default in new Claude Code sessions.${cmd === 'off' ? ' Turn it on for one session with /rembo on or REMBO=on.' : ''}`, { mode: cmd });
      return 0;
    }

    case 'snapshot': {
      const client = await open();
      const text = await buildSnapshot(client, path.resolve(values.cwd ?? io.cwd));
      client.close();
      print(text, { snapshot: text });
      return 0;
    }

    case 'hook': {
      // Called by Claude Code; always exits 0 and prints only the hook answer.
      const stdin = await Promise.race([io.readStdin?.() ?? Promise.resolve(''), new Promise<string>((r) => setTimeout(() => r(''), 2000).unref())]);
      const answer = await runHook(rest[0] ?? '', stdin, { home, cliPath: process.argv[1] ?? '', env: process.env }).catch(async (e: unknown) => {
        await log(home, `hook: ${(e as Error).stack ?? String(e)}`);
        return '';
      });
      if (answer) io.out(answer);
      return 0;
    }

    case 'mcp': {
      await new McpServer({ home, cwd: io.cwd, env: process.env, output: process.stdout }).serve(process.stdin);
      return 0;
    }

    case 'device': {
      const client = await open();
      try {
        if (rest[0] === 'list') {
          const devices = await client.listDevices();
          if (json) return print('', { devices }), 0;
          for (const d of devices) {
            io.out(`${d.current ? '*' : ' '} ${untrusted(d.id, 40)}  ${untrusted(d.name, 40).padEnd(20)} ${untrusted(d.platform, 40).padEnd(14)} ${d.revoked ? 'REVOKED' : `last seen ${untrusted(d.lastSeen ?? 'never', 40)}`}`);
          }
        } else if (rest[0] === 'revoke' && rest[1]) {
          await client.revokeDevice(rest[1]);
          print(`✓ Device ${rest[1]} revoked. It can no longer sync with the hub.`, { revoked: rest[1] });
        } else throw new UsageError('Usage: rembo device list | rembo device revoke <id>');
      } finally {
        client.close();
      }
      return 0;
    }

    case 'hub': {
      if (rest[0] !== 'set-url' || !rest[1]) throw new UsageError('Usage: rembo hub set-url <url>');
      const client = await open();
      await client.setHubUrl(rest[1]);
      client.close();
      print(`✓ Hub address set to ${rest[1]}`, { hub: rest[1] });
      return 0;
    }
  }
  throw new UsageError(`Unknown command "${cmd}". Run rembo --help.`);
}

async function doctor(home: string, io: Io, json: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string; hint?: string }[] = [];
  const add = (name: string, ok: boolean, detail: string, hint?: string) => checks.push(hint ? { name, ok, detail, hint } : { name, ok, detail });
  add('node', nodeOk(), process.versions.node, 'Install Node.js 22.12 or newer from https://nodejs.org');
  let client: RemboClient | undefined;
  try {
    client = await RemboClient.open(home);
    add('setup', true, `${client.config.device.name} → ${client.config.hub.url}`);
  } catch (e) {
    add('setup', false, (e as Error).message, (e as RemboError).hint ?? 'Run: npx rembo@latest setup <account-key>');
  }
  if (client) {
    const hub = new HubClient(client.config.hub, undefined, { timeoutMs: 8000 });
    try {
      const health = await hub.request<HealthResponse>('GET', '/health');
      const compatible = health.protocol.min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= health.protocol.max;
      add('hub', compatible, `reachable, protocol ${health.protocol.min}-${health.protocol.max} (client ${PROTOCOL_MIN}-${PROTOCOL_MAX})`, compatible ? undefined : 'Run: rembo update (or update the hub)');
    } catch (e) {
      add('hub', false, (e as Error).message, (e as RemboError).hint);
    } finally {
      hub.close();
    }
    try {
      const devices = await client.listDevices();
      add('auth', true, `device active (${devices.filter((d) => !d.revoked).length} active devices on this account)`);
    } catch (e) {
      add('auth', false, (e as Error).message, 'If this device was revoked, run setup again in a fresh --home.');
    }
    const pending = await client.pendingCount();
    const last = await client.lastSync();
    add('sync', pending === 0 && (last?.ok ?? false), `${pending} pending, last sync ${last ? `${last.at} ${last.ok ? 'ok' : `failed (${last.error ?? '?'})`}` : 'never'}`, 'Run: rembo sync');
    const failed = await client.failedCount();
    if (failed) add('failed', false, `${failed} change(s) refused by the hub, kept in ${client.vault.failedDir}`, 'After fixing the cause (e.g. a hub update): rembo sync --retry-failed');
    const deferred = await client.deferredCount();
    if (deferred) add('update', false, `${deferred} entr(ies) written by a newer rembo, kept until this one is updated`, 'Run: rembo update');
    try {
      const probe = path.join(home, `.doctor-${process.pid}`);
      await atomicWrite(probe, 'ok');
      await fs.rm(probe, { force: true });
      add('local', true, `${home} writable (${os.platform()})`);
    } catch (e) {
      add('local', false, (e as Error).message, `Check permissions of ${home}`);
    }
    client.close();
    const claude = findClaude(env);
    if (!claude) add('plugin', false, 'Claude Code ("claude") not found', 'Install Claude Code, then run: rembo install');
    else {
      const listed = await runClaude(claude, ['plugin', 'list', '--json'], env);
      const row = (JSON.parse(listed.stdout.slice(Math.max(0, listed.stdout.indexOf('['))) || '[]') as { id: string; version?: string; enabled?: boolean }[]).find((p) => p.id === PLUGIN_ID);
      const okPlugin = Boolean(row && row.enabled !== false && row.version === CLIENT_VERSION);
      add('plugin', okPlugin, row ? `${PLUGIN_ID} ${row.version}${row.enabled === false ? ' (disabled)' : ''} in ${claudeConfigDir(env)}` : `not installed in ${claudeConfigDir(env)}`, 'Run: rembo install');
    }
  }
  if (json) io.out(JSON.stringify({ checks }, null, 2));
  else for (const c of checks) io.out(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(6)} ${c.detail}${!c.ok && c.hint ? `\n         → ${c.hint}` : ''}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

export async function run(argv: string[]): Promise<void> {
  const io = processIo();
  try {
    process.exitCode = await main(argv, io);
  } catch (e) {
    if (e instanceof RemboError) {
      io.err(`✗ ${e.message}${e.hint ? `\n  → ${e.hint}` : ''}`);
      process.exitCode = 1;
    } else if (e instanceof UsageError || (e as NodeJS.ErrnoException)?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      io.err(`✗ ${(e as Error).message}`);
      process.exitCode = 2;
    } else {
      io.err(`✗ Unexpected error: ${(e as Error)?.stack ?? String(e)}`);
      process.exitCode = 1;
    }
  }
}
