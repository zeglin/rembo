import { randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spkiPin } from '../../core/src/http.ts';
import { encodeAccountKey, hashSecret } from '../../core/src/keys.ts';
import { HubDb } from './db.ts';
import { startHub, tlsPaths, type HubMode } from './hub.ts';
import { createSelfSignedCert } from './x509.ts';

export const SERVER_VERSION = '0.1.0';

const HELP = `rembo-server ${SERVER_VERSION} — self-hosted hub for rembo

Usage: rembo-server <command> [options]

  serve [--host <addr>] [--port <n>] [--tls] [--mode selfhost|cloud] [--trust-proxy]
  tls create --ip <address> [--dns <name>]    Self-signed certificate for IP mode
  key create [--url <https://address:port>] [--account <id>] [--label <text>] [--no-pin]
  key list | key revoke <key-id>
  account create | account list
  device list [--account <id>] | device revoke <device-id>
  status
  backup [--keep <n>]

Options: --data-dir <dir>  (default: $REMBO_HUB_DIR, else /var/lib/rembo on Linux)`;

interface HubConfig {
  host?: string;
  port?: number;
  tls?: boolean;
  mode?: HubMode;
  trustProxy?: boolean;
  publicUrl?: string;
}

function defaultDataDir(): string {
  if (process.env.REMBO_HUB_DIR) return process.env.REMBO_HUB_DIR;
  return process.platform === 'linux' ? '/var/lib/rembo' : path.resolve('rembo-hub-data');
}

async function readConfig(dataDir: string): Promise<HubConfig> {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, 'hub.json'), 'utf8')) as HubConfig;
  } catch {
    return {};
  }
}

async function writeConfig(dataDir: string, cfg: HubConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dataDir, 'hub.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

class UsageError extends Error {}

function openDb(dataDir: string): HubDb {
  if (!existsSync(dataDir)) throw new UsageError(`Data directory ${dataDir} does not exist. Create it, or pass --data-dir.`);
  return new HubDb(path.join(dataDir, 'hub.db'));
}

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(none)';
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i]!)).join('  ').trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))].join('\n');
}

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      tls: { type: 'boolean' },
      mode: { type: 'string' },
      'trust-proxy': { type: 'boolean' },
      ip: { type: 'string', multiple: true },
      dns: { type: 'string', multiple: true },
      url: { type: 'string' },
      account: { type: 'string' },
      label: { type: 'string' },
      'no-pin': { type: 'boolean' },
      keep: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    out(SERVER_VERSION);
    return 0;
  }
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) {
    out(HELP);
    return values.help ? 0 : 2;
  }
  const dataDir = path.resolve(values['data-dir'] ?? defaultDataDir());
  const cfg = await readConfig(dataDir);

  switch (cmd) {
    case 'serve': {
      const mode = (values.mode ?? cfg.mode ?? 'selfhost') as HubMode;
      if (mode !== 'selfhost' && mode !== 'cloud') throw new UsageError('--mode must be selfhost or cloud');
      const hub = await startHub({
        dataDir,
        host: values.host ?? cfg.host ?? '127.0.0.1',
        port: Number(values.port ?? cfg.port ?? 8787),
        tls: values.tls ?? cfg.tls ?? false,
        mode,
        trustProxy: values['trust-proxy'] ?? cfg.trustProxy ?? false,
        log: (line) => console.error(`${new Date().toISOString()} ${line}`),
      });
      out(`rembo-server ${SERVER_VERSION} listening on ${hub.url} (mode ${mode}, data ${dataDir})`);
      const stop = () => void hub.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return new Promise<number>(() => {}); // runs until a signal
    }

    case 'tls': {
      if (sub !== 'create') throw new UsageError('Usage: rembo-server tls create --ip <address> [--dns <name>]');
      if (!values.ip?.length && !values.dns?.length) throw new UsageError('Pass --ip <address> (and/or --dns <name>).');
      const p = tlsPaths(dataDir);
      if (existsSync(p.cert)) throw new UsageError(`${p.cert} already exists. Devices pin its key; replacing it means re-joining every device.`);
      const { certPem, keyPem } = createSelfSignedCert({ ips: values.ip ?? [], dnsNames: values.dns ?? [] });
      await fs.mkdir(path.dirname(p.cert), { recursive: true, mode: 0o700 });
      await fs.writeFile(p.key, keyPem, { mode: 0o600 });
      await fs.writeFile(p.cert, certPem);
      await writeConfig(dataDir, { ...cfg, tls: true });
      out(`Certificate created: ${p.cert}\nPin (in new account keys): ${spkiPin(new X509Certificate(certPem).raw)}`);
      return 0;
    }

    case 'account': {
      const db = openDb(dataDir);
      try {
        if (sub === 'create') out(db.createAccount());
        else if (sub === 'list') out(table(db.listAccounts()));
        else throw new UsageError('Usage: rembo-server account create|list');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'key': {
      const db = openDb(dataDir);
      try {
        if (sub === 'create') {
          let accountId = values.account;
          if (!accountId) {
            const accounts = db.listAccounts();
            if (accounts.length > 1) throw new UsageError('Several accounts exist; pass --account <id> (see: rembo-server account list).');
            accountId = accounts[0]?.id ?? db.createAccount();
          }
          const url = (values.url ?? cfg.publicUrl)?.replace(/\/+$/, '');
          if (!url) throw new UsageError('Pass --url https://<your-ip-or-domain>[:port] so devices know where the hub is.');
          if (values.url && values.url !== cfg.publicUrl) await writeConfig(dataDir, { ...cfg, publicUrl: url });
          const keyId = randomBytes(8).toString('hex');
          const secret = randomBytes(32);
          db.addAccountKey(accountId, keyId, hashSecret(secret), values.label);
          const p = tlsPaths(dataDir);
          const certPin = !values['no-pin'] && existsSync(p.cert) ? spkiPin(new X509Certificate(readFileSync(p.cert)).raw) : undefined;
          const key = encodeAccountKey({ keyId, secret, hub: url, certPin });
          out(
            [
              `Account key ${keyId} for account ${accountId} (shown once; store it in your password manager):`,
              '',
              `  ${key}`,
              '',
              'On each machine run:',
              `  npx rembo@latest setup ${key}`,
            ].join('\n'),
          );
        } else if (sub === 'list') {
          out(table(db.listAccountKeys().map((k) => ({ id: k.id, account: k.account_id, label: k.label ?? '', created: k.created_at, revoked: k.revoked_at ?? '' }))));
        } else if (sub === 'revoke') {
          if (!arg) throw new UsageError('Usage: rembo-server key revoke <key-id>');
          out(db.revokeAccountKey(arg) ? `Key ${arg} revoked. Devices already registered keep working; revoke them with "device revoke".` : `No active key ${arg}.`);
        } else throw new UsageError('Usage: rembo-server key create|list|revoke');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'device': {
      const db = openDb(dataDir);
      try {
        if (sub === 'list') {
          out(
            table(
              db.listDevices(values.account).map((d) => ({
                id: d.id,
                account: d.account_id,
                name: d.name,
                platform: d.platform,
                role: d.role,
                last_seen: d.last_seen ?? '',
                revoked: d.revoked_at ?? '',
              })),
            ),
          );
        } else if (sub === 'revoke') {
          if (!arg) throw new UsageError('Usage: rembo-server device revoke <device-id>');
          out(db.revokeDevice(arg) ? `Device ${arg} revoked.` : `No active device ${arg}.`);
        } else throw new UsageError('Usage: rembo-server device list|revoke');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'status': {
      const db = openDb(dataDir);
      try {
        const s = db.stats();
        const p = tlsPaths(dataDir);
        const size = (await fs.stat(path.join(dataDir, 'hub.db'))).size;
        out(
          [
            `rembo-server ${SERVER_VERSION}`,
            `data dir   ${dataDir}`,
            `database   ${(size / 1024).toFixed(0)} KiB, ${s.records} records (${(s.bytes / 1024).toFixed(0)} KiB ciphertext)`,
            `accounts   ${s.accounts}, vaults ${s.vaults}, active devices ${s.devices}`,
            `tls        ${existsSync(p.cert) ? `self-signed, pin ${spkiPin(new X509Certificate(readFileSync(p.cert)).raw)}` : 'none (behind a proxy or plain HTTP on localhost)'}`,
            `public url ${cfg.publicUrl ?? '(not set; pass --url to key create)'}`,
          ].join('\n'),
        );
      } finally {
        db.close();
      }
      return 0;
    }

    case 'backup': {
      const keep = Number(values.keep ?? 7);
      const db = openDb(dataDir);
      const dir = path.join(dataDir, 'backups');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
      const dest = path.join(dir, `hub-${stamp}.db`);
      try {
        db.backup(dest);
      } finally {
        db.close();
      }
      const p = tlsPaths(dataDir);
      if (existsSync(p.key)) {
        await fs.copyFile(p.key, path.join(dir, `hub-${stamp}.tls-key.pem`));
        await fs.copyFile(p.cert, path.join(dir, `hub-${stamp}.tls-cert.pem`));
      }
      const stamps = [...new Set((await fs.readdir(dir)).filter((n) => n.startsWith('hub-')).map((n) => n.slice(4, 19)))].sort();
      for (const old of stamps.slice(0, Math.max(0, stamps.length - keep))) {
        for (const n of await fs.readdir(dir)) if (n.startsWith(`hub-${old}`)) await fs.rm(path.join(dir, n), { force: true });
      }
      out(`Backup written: ${dest}`);
      return 0;
    }
  }
  throw new UsageError(`Unknown command "${cmd}". Run rembo-server --help.`);
}

export async function run(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (e) {
    console.error(e instanceof UsageError || e instanceof TypeError ? `Error: ${(e as Error).message}` : e);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
