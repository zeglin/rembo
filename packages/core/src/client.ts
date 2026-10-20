import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveKeys,
  formatRecoveryKey,
  newRecoveryKey,
  newVaultKey,
  openKeyring,
  openObject,
  parseRecoveryKey,
  randomId,
  sealKeyring,
  sealObject,
  type DerivedKeys,
  type VaultKey,
} from './crypto.ts';
import {
  entryFromPlaintext,
  entryToPlaintext,
  validateEntry,
  type Entry,
  type EntryMeta,
  type EntrySource,
  type EntryType,
} from './entry.ts';
import { RemboError } from './errors.ts';
import { atomicWrite, readJson, tryLock, waitLock } from './fsutil.ts';
import { scanSecrets } from './guard.ts';
import { HubClient, HubError, type HubEndpoint } from './http.ts';
import { decodeAccountKey } from './keys.ts';
import {
  LIMITS,
  type ChangeRecord,
  type ChangesResponse,
  type DeviceInfo,
  type HealthResponse,
  type KeyringResponse,
  type PutResult,
  type RegisterResponse,
  type VaultInfo,
} from './protocol.ts';
import { MemorySearch, type SearchHit, type SearchOptions } from './search.ts';
import { LocalVault, type PendingOp } from './store.ts';
import { liveEntries } from './views.ts';

export const DEFAULT_CLOUD_URL = 'https://hub.rembo.dev';
export const CLIENT_VERSION = '0.1.0';

export interface ClientConfig {
  v: 1;
  hub: HubEndpoint;
  device: { id: string; token: string; name: string };
  accountId: string;
  vault: { id: string; encryption: boolean };
  defaults: { mode: 'on' | 'off' };
}

export interface SetupOptions {
  home: string;
  accountKey: string;
  recoveryKey?: string | undefined;
  deviceName?: string | undefined;
  platform?: string | undefined;
  hubUrl?: string | undefined;
  encryption?: boolean | undefined;
}

export interface SetupResult {
  client: RemboClient;
  createdVault: boolean;
  recoveryKey?: string;
}

export interface RememberInput {
  title: string;
  body?: string | undefined;
  summary?: string | undefined;
  type?: EntryType | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
  supersedes?: string[] | undefined;
  source?: Partial<EntrySource> | undefined;
  id?: string | undefined;
}

export interface SyncResult {
  status: 'ok' | 'busy' | 'offline';
  pushed: number;
  pulled: number;
  removed: number;
  rejected: number;
  cursor?: number;
  head?: number;
  error?: string;
}

export interface SyncStatus {
  ok: boolean;
  at: string;
  pending: number;
  error?: string | undefined;
}

export function defaultHome(): string {
  return process.env.REMBO_HOME || path.join(os.homedir(), '.rembo');
}

const configPath = (home: string) => path.join(home, 'config.json');
const statusPath = (home: string) => path.join(home, 'status.json');

/** One machine's view of rembo: config, local vault replica, hub connection. */
export class RemboClient {
  readonly home: string;
  readonly config: ClientConfig;
  readonly vault: LocalVault;
  readonly hub: HubClient;
  private readonly keys: DerivedKeys;

  private constructor(home: string, config: ClientConfig, vaultKey: VaultKey) {
    this.home = home;
    this.config = config;
    this.vault = new LocalVault(home, config.vault.id);
    this.keys = deriveKeys(vaultKey);
    this.hub = RemboClient.hubFor(home, config);
  }

  private static hubFor(home: string, config: ClientConfig): HubClient {
    const hub = new HubClient(config.hub, config.device.token);
    hub.onCertLearned = async (pem) => {
      config.hub.certPem = pem;
      await atomicWrite(configPath(home), JSON.stringify(config, null, 2), 0o600);
    };
    return hub;
  }

  static async open(home = defaultHome()): Promise<RemboClient> {
    const config = await readJson<ClientConfig | null>(configPath(home), null);
    if (!config) {
      throw new RemboError('not_setup', 'rembo is not set up on this machine.', 'Run: npx rembo@latest setup <account-key>');
    }
    const vault = new LocalVault(home, config.vault.id);
    const key = await readJson<{ kid: string; key: string } | null>(vault.keyFile, null);
    if (!key) throw new RemboError('missing_vault_key', 'The vault key is missing on this machine.', 'Run rembo setup again with your recovery key.');
    return new RemboClient(home, config, { kid: Buffer.from(key.kid, 'hex'), key: Buffer.from(key.key, 'hex') });
  }

  /** Registers this device and creates (first device) or unlocks (next devices) the vault. */
  static async setup(opts: SetupOptions): Promise<SetupResult> {
    if (await readJson(configPath(opts.home), null)) {
      throw new RemboError('already_setup', `rembo is already set up in ${opts.home}.`, 'Run rembo status, or remove that folder to start over.');
    }
    const account = decodeAccountKey(opts.accountKey);
    const recovery = opts.recoveryKey ? parseRecoveryKey(opts.recoveryKey) : undefined;
    const endpoint: HubEndpoint = { url: opts.hubUrl ?? account.hub ?? DEFAULT_CLOUD_URL, certPin: account.certPin };
    const hub = new HubClient(endpoint);
    try {
      await hub.request<HealthResponse>('GET', '/health');
      const reg = await hub.request<RegisterResponse>(
        'POST',
        '/v1/devices',
        { name: opts.deviceName ?? os.hostname(), platform: opts.platform ?? `${process.platform}-${process.arch}` },
        { bearer: opts.accountKey.trim() },
      );
      hub.setToken(reg.token);

      let vaultInfo: VaultInfo;
      let vaultKey: VaultKey;
      let recoveryText: string | undefined;
      const existing = reg.vaults[0];
      if (existing) {
        if (!recovery) {
          throw new RemboError(
            'recovery_key_required',
            'This account already has a vault; this machine needs the recovery key to unlock it.',
            'Run setup again with --recovery-key RK-… (shown when the first machine was set up).',
          );
        }
        const kr = await hub.request<KeyringResponse>('GET', `/v1/vaults/${existing.id}/keyring`);
        vaultKey = openKeyring(Buffer.from(kr.keyring, 'base64url'), recovery, existing.id);
        vaultInfo = existing;
      } else {
        const id = randomId();
        const rk = recovery ?? newRecoveryKey();
        vaultKey = newVaultKey();
        const encryption = opts.encryption ?? true;
        await hub.request('POST', '/v1/vaults', { id, encryption, keyring: sealKeyring(vaultKey, rk, id).toString('base64url') });
        vaultInfo = { id, encryption, keyringVersion: 1 };
        recoveryText = recovery ? undefined : formatRecoveryKey(rk);
      }

      const config: ClientConfig = {
        v: 1,
        hub: hub.endpoint,
        device: { id: reg.deviceId, token: reg.token, name: opts.deviceName ?? os.hostname() },
        accountId: reg.accountId,
        vault: { id: vaultInfo.id, encryption: vaultInfo.encryption },
        defaults: { mode: 'on' },
      };
      const vault = new LocalVault(opts.home, vaultInfo.id);
      await atomicWrite(vault.keyFile, JSON.stringify({ kid: vaultKey.kid.toString('hex'), key: vaultKey.key.toString('hex') }), 0o600);
      await atomicWrite(configPath(opts.home), JSON.stringify(config, null, 2), 0o600);
      const client = new RemboClient(opts.home, config, vaultKey);
      const result: SetupResult = { client, createdVault: !existing };
      if (recoveryText) result.recoveryKey = recoveryText;
      return result;
    } finally {
      hub.close();
    }
  }

  private async saveConfig(): Promise<void> {
    await atomicWrite(configPath(this.home), JSON.stringify(this.config, null, 2), 0o600);
  }

  async remember(input: RememberInput): Promise<Entry> {
    const findings = scanSecrets([input.title, input.summary ?? '', input.body ?? ''].join('\n'));
    if (findings.length) {
      const rules = [...new Set(findings.map((f) => f.rule))].join(', ');
      throw new RemboError(
        'secret_detected',
        `Refusing to store this: it looks like it contains a secret (${rules}).`,
        'rembo is not a secrets store. Save a pointer instead, e.g. "login: password manager entry <name>".',
      );
    }
    const meta: Partial<EntryMeta> = {
      id: input.id ?? randomId(),
      type: input.type ?? 'fact',
      title: input.title,
      summary: input.summary ?? input.title,
      scope: input.scope ?? 'global',
      tags: input.tags ?? [],
      source: { origin: 'remember', device: this.config.device.name, ...input.source },
      created: new Date().toISOString(),
      author_device: this.config.device.id,
      supersedes: input.supersedes ?? [],
    };
    const entry = validateEntry({ meta, body: input.body ?? '' });
    const envelope = sealObject(entryToPlaintext(entry), {
      vaultId: this.vault.vaultId,
      objectId: entry.meta.id,
      keys: this.keys,
      encrypt: this.config.vault.encryption,
    });
    if (envelope.length > LIMITS.objectBytes) throw new RemboError('too_large', 'This entry is too large (max 1 MiB).', 'Split it or store a summary.');
    await this.vault.writeEntry(entry);
    await this.vault.enqueue({ op: 'put', id: entry.meta.id, data: envelope.toString('base64url') });
    return entry;
  }

  async forget(id: string): Promise<boolean> {
    const existed = await this.vault.deleteEntry(id);
    if (!existed) throw new RemboError('not_found', `No entry with id ${id} on this machine.`, 'Run rembo sync, then try again.');
    await this.vault.enqueue({ op: 'delete', id });
    return true;
  }

  async loadEntries(): Promise<Entry[]> {
    return this.vault.loadEntries();
  }

  async read(id: string): Promise<Entry | null> {
    return this.vault.readEntry(id);
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    const index = new MemorySearch();
    index.index(liveEntries(await this.loadEntries()));
    return index.search(query, opts);
  }

  private decodeRecord(r: ChangeRecord): Entry | null {
    try {
      const plain = openObject(Buffer.from(r.data ?? '', 'base64url'), {
        vaultId: this.vault.vaultId,
        objectId: r.id,
        keys: this.keys,
        allowPlain: !this.config.vault.encryption,
      });
      const entry = entryFromPlaintext(plain);
      return entry.meta.id === r.id ? entry : null; // an id swap would be caught by AAD anyway
    } catch {
      return null;
    }
  }

  private async pushOutbox(): Promise<number> {
    const ops = await this.vault.pendingOps();
    const puts = ops.filter((o): o is PendingOp & { op: { op: 'put' } } => o.op.op === 'put');
    let pushed = 0;
    for (let i = 0; i < puts.length; i += 200) {
      const chunk = puts.slice(i, i + 200);
      await this.hub.request<{ results: PutResult[] }>('POST', `/v1/vaults/${this.vault.vaultId}/objects`, {
        items: chunk.map((o) => ({ id: o.op.id, data: (o.op as { data: string }).data })),
      });
      await this.vault.removeOps(chunk);
      pushed += chunk.length;
    }
    for (const del of ops.filter((o) => o.op.op === 'delete')) {
      await this.hub.request('DELETE', `/v1/vaults/${this.vault.vaultId}/objects/${del.op.id}`);
      await this.vault.removeOps([del]);
      pushed++;
    }
    return pushed;
  }

  /** Push the outbox, then pull the log since the cursor and apply it. */
  async sync(opts: { wait?: boolean; waitMs?: number } = {}): Promise<SyncResult> {
    const lock = opts.wait ? await waitLock(this.vault.lockDir, opts.waitMs ?? 30_000) : await tryLock(this.vault.lockDir);
    const result: SyncResult = { status: 'ok', pushed: 0, pulled: 0, removed: 0, rejected: 0 };
    if (!lock) return { ...result, status: 'busy' };
    try {
      result.pushed = await this.pushOutbox();
      let state = await this.vault.readState();
      let changed = result.pushed > 0;
      for (;;) {
        const page = await this.hub.request<ChangesResponse>(
          'GET',
          `/v1/vaults/${this.vault.vaultId}/changes?since=${state.cursor}&limit=${LIMITS.changesPage}`,
        );
        for (const r of page.records) {
          if (r.kind === 'tombstone') {
            if (await this.vault.deleteEntry(r.id)) {
              result.removed++;
              changed = true;
            }
          } else {
            const entry = this.decodeRecord(r);
            if (!entry) result.rejected++;
            else if (!(await this.vault.hasEntry(entry.meta))) {
              await this.vault.writeEntry(entry);
              result.pulled++;
              changed = true;
            }
          }
          state = { cursor: r.seq };
        }
        await this.vault.writeState(state);
        result.head = page.head;
        if (!page.more) break;
      }
      result.cursor = state.cursor;
      if (changed) await this.vault.writeViews(liveEntries(await this.loadEntries()));
      await this.writeStatus({ ok: true, at: new Date().toISOString(), pending: (await this.vault.pendingOps()).length });
      return result;
    } catch (e) {
      const code = e instanceof RemboError ? e.code : 'error';
      await this.writeStatus({ ok: false, at: new Date().toISOString(), pending: (await this.vault.pendingOps()).length, error: code });
      if (e instanceof HubError && e.code === 'unreachable') return { ...result, status: 'offline', error: e.message };
      throw e;
    } finally {
      await lock.release();
    }
  }

  private async writeStatus(status: SyncStatus): Promise<void> {
    await atomicWrite(statusPath(this.home), JSON.stringify(status));
  }

  async lastSync(): Promise<SyncStatus | null> {
    return readJson<SyncStatus | null>(statusPath(this.home), null);
  }

  async pendingCount(): Promise<number> {
    return (await this.vault.pendingOps()).length;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return (await this.hub.request<{ devices: DeviceInfo[] }>('GET', '/v1/devices')).devices;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.hub.request('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  }

  async setHubUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new RemboError('bad_url', 'The hub URL must start with https://');
    this.config.hub.url = url.replace(/\/+$/, '');
    this.hub.endpoint.url = this.config.hub.url;
    await this.saveConfig();
  }

  /** Removes the local replica and config (hub data is untouched). */
  static async removeLocal(home: string): Promise<void> {
    await fs.rm(home, { recursive: true, force: true });
  }

  close(): void {
    this.hub.close();
  }
}
