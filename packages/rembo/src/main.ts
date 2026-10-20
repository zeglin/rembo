import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CLIENT_VERSION, defaultHome, RemboClient } from '../../core/src/client.ts';
import { ENTRY_TYPES, entryToMarkdown, isValidScope, type EntryType } from '../../core/src/entry.ts';
import { RemboError } from '../../core/src/errors.ts';
import { atomicWrite } from '../../core/src/fsutil.ts';
import { HubClient } from '../../core/src/http.ts';
import { resolveProject } from '../../core/src/project.ts';
import { PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION, type HealthResponse } from '../../core/src/protocol.ts';
import { liveEntries } from '../../core/src/views.ts';

const HELP = `rembo ${CLIENT_VERSION} — shared, end-to-end encrypted memory for Claude Code

Usage: rembo <command> [options]

Setup
  setup <account-key>          Connect this machine (the first machine creates the vault)
    --recovery-key <RK-…>      Recovery key (every machine after the first)
    --recovery-file <file>     Read the recovery key from a file
    --name <name>              Device name (default: hostname)
    --hub <url>                Override the hub address stored in the key
    --no-encryption            Self-hosted only: store memory unencrypted (not recommended)

Memory
  remember <title> [--body <text> | --body-file <file|->] [--summary <s>]
           [--type <${ENTRY_TYPES.join('|')}>] [--scope <global|project:x|machine:x> | --global]
           [--tags a,b] [--supersedes <id>]
  search <query…> [--scope <s>] [--limit <n>]
  read <id>
  list [--scope <s>]
  forget <id>

Sync and status
  sync | status | doctor

Devices and hub
  device list | device revoke <id>
  hub set-url <url>

Global options: --json, --home <dir> (default: $REMBO_HOME or ~/.rembo), --version, --help`;

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
      const sync = await result.client.sync({ wait: true });
      result.client.close();
      if (json) {
        print('', { createdVault: result.createdVault, recoveryKey: result.recoveryKey, vault: result.client.config.vault.id, sync });
        return 0;
      }
      io.out(`✓ Device "${result.client.config.device.name}" registered with ${result.client.config.hub.url}`);
      if (result.createdVault) {
        io.out(`✓ New vault created (encryption ${result.client.config.vault.encryption ? 'on' : 'OFF'})`);
        io.out('');
        io.out('  Your RECOVERY KEY. Save it in your password manager now; it is shown only once.');
        io.out('  You need it to connect your other machines. Nobody, not even the hub, can recover it:');
        io.out('');
        io.out(`    ${result.recoveryKey}`);
        io.out('');
      } else {
        io.out(`✓ Vault unlocked; ${sync.pulled} entries downloaded`);
      }
      io.out('✓ Ready. Try: rembo remember "Something worth remembering"   then   rembo search something');
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
        const sync = await client.sync();
        const note = sync.status === 'offline' ? ' (saved locally; will sync when the hub is reachable)' : '';
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
        await client.forget(rest[0]);
        const sync = await client.sync();
        print(`✓ Forgotten ${rest[0]}${sync.status === 'offline' ? ' (locally; the hub will be told when reachable)' : ''}`, { forgotten: rest[0], sync });
      } finally {
        client.close();
      }
      return 0;
    }

    case 'sync': {
      const client = await open();
      const r = await client.sync({ wait: true });
      client.close();
      const human =
        r.status === 'offline'
          ? `! Hub unreachable; ${await client.pendingCount()} change(s) queued. ${r.error ?? ''}`
          : `✓ Synced: ${r.pushed} sent, ${r.pulled} received, ${r.removed} removed${r.rejected ? `, ${r.rejected} rejected (could not be verified)` : ''}`;
      print(human, r);
      return r.status === 'ok' ? 0 : 1;
    }

    case 'status': {
      const client = await open();
      const entries = liveEntries(await client.loadEntries());
      const last = await client.lastSync();
      const pending = await client.pendingCount();
      client.close();
      const c = client.config;
      const data = { home, hub: c.hub.url, device: c.device, vault: c.vault, entries: entries.length, pending, lastSync: last };
      if (json) return print('', { ...data, device: { id: c.device.id, name: c.device.name } }), 0;
      io.out(
        [
          `rembo ${CLIENT_VERSION}`,
          `hub        ${c.hub.url}${c.hub.certPin ? ' (pinned certificate)' : ''}`,
          `device     ${c.device.name} (${c.device.id})`,
          `vault      ${c.vault.id} (encryption ${c.vault.encryption ? 'on' : 'OFF'})`,
          `entries    ${entries.length}, pending uploads ${pending}`,
          `last sync  ${last ? `${last.at} ${last.ok ? 'ok' : 'failed: ' + last.error}` : 'never'}`,
          `local copy ${path.join(home, 'vaults', c.vault.id, 'md')}`,
        ].join('\n'),
      );
      return 0;
    }

    case 'doctor':
      return doctor(home, io, json);

    case 'device': {
      const client = await open();
      try {
        if (rest[0] === 'list') {
          const devices = await client.listDevices();
          if (json) return print('', { devices }), 0;
          for (const d of devices) {
            io.out(`${d.current ? '*' : ' '} ${d.id}  ${d.name.padEnd(20)} ${d.platform.padEnd(14)} ${d.revoked ? 'REVOKED' : `last seen ${d.lastSeen ?? 'never'}`}`);
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

async function doctor(home: string, io: Io, json: boolean): Promise<number> {
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
    add('sync', pending === 0 && (last?.ok ?? false), `${pending} pending, last sync ${last ? `${last.at} ${last.ok ? 'ok' : 'failed'}` : 'never'}`, 'Run: rembo sync');
    try {
      const probe = path.join(home, `.doctor-${process.pid}`);
      await atomicWrite(probe, 'ok');
      await fs.rm(probe, { force: true });
      add('local', true, `${home} writable (${os.platform()})`);
    } catch (e) {
      add('local', false, (e as Error).message, `Check permissions of ${home}`);
    }
    client.close();
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
