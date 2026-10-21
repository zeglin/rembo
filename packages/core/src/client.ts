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
import { atomicWrite, readJson, tryLock, waitLock, type LockHandle } from './fsutil.ts';
import { scanSecrets } from './guard.ts';
import { HubClient, HubError, type HubEndpoint } from './http.ts';
import { decodeAccountKey } from './keys.ts';
import {
  LIMITS,
  OBJECT_ID_RE,
  VAULT_ID_RE,
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
  /** pendingKeyring: a new vault the hub has not confirmed yet; the next sync creates it. */
  vault: { id: string; encryption: boolean; pendingKeyring?: string };
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
  /** The hub was unreachable after registration; the vault is created on the next sync. */
  vaultPending: boolean;
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
  /** partial: received everything, but some local changes could not be sent yet (see error). */
  status: 'ok' | 'partial' | 'busy' | 'offline';
  pushed: number;
  pulled: number;
  removed: number;
  /** Records that failed verification (hub forgery or corruption); skipped. */
  rejected: number;
  /** Authentic records this version cannot read yet; kept and retried after an update. */
  deferred: number;
  /** Local changes the hub refused as invalid; moved to failed/ (rembo sync --retry-failed). */
  failed: number;
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

function isTombstoneFor(proof: Buffer, id: string): boolean {
  try {
    return (JSON.parse(proof.toString('utf8')) as { deleted?: string }).deleted === id;
  } catch {
    return false;
  }
}

export function defaultHome(): string {
  return process.env.REMBO_HOME || path.join(os.homedir(), '.rembo');
}

const PUT_BATCH_ITEMS = 200;
const PUT_BATCH_CHARS = 12 << 20; // base64 characters per request, under the hub's 16 MiB body limit

/** Hub answers that refuse one op for good (invalid or too large): retrying cannot help. */
const isRejection = (e: unknown): e is HubError => e instanceof HubError && (e.status === 400 || e.status === 413);

/** Push failures after which pulling still makes sense: the hub is up and this device is valid. */
const pullAnyway = (e: unknown): e is HubError =>
  e instanceof HubError && ([403, 404, 409, 429].includes(e.status) || e.status >= 500);

function putBatches(ops: PendingOp[]): PendingOp[][] {
  const batches: PendingOp[][] = [];
  let batch: PendingOp[] = [];
  let chars = 0;
  for (const op of ops) {
    const size = op.op.op === 'put' ? op.op.data.length : 0;
    if (batch.length && (batch.length >= PUT_BATCH_ITEMS || chars + size > PUT_BATCH_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(op);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Creates a vault on the hub; a 409 means an earlier attempt already did (vault ids are random). */
async function createVaultOnHub(hub: HubClient, body: { id: string; encryption: boolean; keyring: string }): Promise<void> {
  try {
    await hub.request('POST', '/v1/vaults', body);
  } catch (e) {
    if (!(e instanceof HubError && e.status === 409)) throw e;
  }
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
    let deviceId: string | undefined;
    let keyFile: string | undefined;
    try {
      await hub.request<HealthResponse>('GET', '/health');
      const reg = await hub.request<RegisterResponse>(
        'POST',
        '/v1/devices',
        { name: opts.deviceName ?? os.hostname(), platform: opts.platform ?? `${process.platform}-${process.arch}` },
        { bearer: opts.accountKey.trim() },
      );
      deviceId = reg.deviceId;
      hub.setToken(reg.token);

      let vault: ClientConfig['vault'];
      let vaultKey: VaultKey;
      let recoveryText: string | undefined;
      const existing = reg.vaults[0];
      if (existing) {
        if (!recovery) {
          throw new RemboError(
            'recovery_key_required',
            'This account already has a vault; this machine needs the recovery key to unlock it.',
            'Run setup again in a terminal (it asks for the key), or pass --recovery-file <file>.',
          );
        }
        if (!VAULT_ID_RE.test(existing.id)) throw new RemboError('bad_hub_response', 'The hub returned an invalid vault id.');
        const kr = await hub.request<KeyringResponse>('GET', `/v1/vaults/${existing.id}/keyring`);
        const opened = openKeyring(Buffer.from(kr.keyring, 'base64url'), recovery, existing.id);
        vaultKey = opened.vaultKey;
        // The encryption flag is taken from the authenticated keyring, not from the hub's answer.
        vault = { id: existing.id, encryption: opened.encryption };
      } else {
        const id = randomId();
        const rk = recovery ?? newRecoveryKey();
        const encryption = opts.encryption ?? true;
        vaultKey = newVaultKey();
        vault = { id, encryption, pendingKeyring: sealKeyring(vaultKey, rk, id, encryption).toString('base64url') };
        recoveryText = recovery ? undefined : formatRecoveryKey(rk);
      }

      const config: ClientConfig = {
        v: 1,
        hub: hub.endpoint,
        device: { id: reg.deviceId, token: reg.token, name: opts.deviceName ?? os.hostname() },
        accountId: reg.accountId,
        vault,
        defaults: { mode: 'on' },
      };
      // Local files first: once the vault exists on the hub, this machine already holds its key.
      keyFile = new LocalVault(opts.home, vault.id).keyFile;
      await atomicWrite(keyFile, JSON.stringify({ kid: vaultKey.kid.toString('hex'), key: vaultKey.key.toString('hex') }), 0o600);
      await atomicWrite(configPath(opts.home), JSON.stringify(config, null, 2), 0o600);
      if (vault.pendingKeyring) {
        try {
          await createVaultOnHub(hub, { id: vault.id, encryption: vault.encryption, keyring: vault.pendingKeyring });
          delete vault.pendingKeyring;
          await atomicWrite(configPath(opts.home), JSON.stringify(config, null, 2), 0o600);
        } catch (e) {
          // The hub went away between registration and creation: keep everything; the next sync creates the vault.
          if (!(e instanceof HubError && e.code === 'unreachable')) throw e;
        }
      }
      const client = new RemboClient(opts.home, config, vaultKey);
      const result: SetupResult = { client, createdVault: !existing, vaultPending: Boolean(vault.pendingKeyring) };
      if (recoveryText) result.recoveryKey = recoveryText;
      return result;
    } catch (e) {
      // Leave neither a half-configured machine nor a stray device on the hub.
      if (keyFile) {
        await fs.rm(configPath(opts.home), { force: true });
        await fs.rm(keyFile, { force: true });
      }
      if (deviceId) await hub.request('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`).catch(() => undefined);
      throw e;
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
    await this.vault.markViewsDirty();
    return entry;
  }

  /**
   * Forgets an entry and, unless `only`, every earlier version it supersedes,
   * so an older version cannot resurface. Returns the forgotten ids.
   */
  async forget(id: string, opts: { only?: boolean } = {}): Promise<string[]> {
    if (!(await this.vault.findEntryFile(id))) {
      throw new RemboError('not_found', `No entry with id ${id} on this machine.`, 'Run rembo sync, then try again.');
    }
    const ids = [id];
    if (!opts.only) {
      const byId = new Map((await this.loadEntries()).map((e) => [e.meta.id, e]));
      for (let i = 0; i < ids.length; i++) {
        for (const older of byId.get(ids[i]!)?.meta.supersedes ?? []) if (!ids.includes(older)) ids.push(older);
      }
    }
    for (const x of ids) {
      await this.vault.deleteEntry(x);
      await this.vault.enqueue({ op: 'delete', id: x, proof: this.tombstoneProof(x).toString('base64url') });
    }
    await this.vault.markViewsDirty();
    return ids;
  }

  /** A delete marker sealed with the vault key: other devices honour only tombstones a device created. */
  private tombstoneProof(id: string): Buffer {
    return sealObject(Buffer.from(JSON.stringify({ v: 1, deleted: id })), {
      vaultId: this.vault.vaultId,
      objectId: `tombstone:${id}`,
      keys: this.keys,
      encrypt: this.config.vault.encryption,
    });
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

  /**
   * The authenticated plaintext of a record; 'later' when it uses a key or
   * format this version does not have (e.g. after a key rotation by a newer
   * rembo); null when it was not sealed for this vault and id.
   */
  private openRecord(data: string | undefined, objectId: string): Buffer | 'later' | null {
    try {
      return openObject(Buffer.from(data ?? '', 'base64url'), {
        vaultId: this.vault.vaultId,
        objectId,
        keys: this.keys,
        allowPlain: !this.config.vault.encryption,
      });
    } catch (e) {
      return e instanceof RemboError && (e.code === 'unknown_key' || e.code === 'unsupported') ? 'later' : null;
    }
  }

  /** Applies one hub record; returns whether local entries changed. */
  private async applyRecord(r: ChangeRecord, result: SyncResult): Promise<boolean> {
    if (typeof r.id !== 'string' || !OBJECT_ID_RE.test(r.id)) {
      result.rejected++; // never let a hub-supplied id reach the filesystem
      return false;
    }
    const defer = async () => {
      await this.vault.defer({ seq: r.seq, id: r.id, kind: r.kind, data: r.data ?? '' });
      result.deferred++;
      return false;
    };
    if (r.kind === 'tombstone') {
      const proof = this.openRecord(r.data, `tombstone:${r.id}`);
      if (proof === 'later') return defer();
      if (!proof || !isTombstoneFor(proof, r.id)) {
        result.rejected++; // forged by the hub: keep the local copy
        return false;
      }
      const deleted = await this.vault.deleteEntry(r.id);
      const dropped = await this.vault.removeDeferredFor(r.id);
      if (deleted || dropped) result.removed++;
      return deleted;
    }
    if (r.kind !== 'put') return defer(); // a record kind from a newer protocol
    const plain = this.openRecord(r.data, r.id);
    if (plain === 'later') return defer();
    if (!plain) {
      result.rejected++;
      return false;
    }
    let entry: Entry;
    try {
      entry = entryFromPlaintext(plain);
      if (entry.meta.id !== r.id) throw new Error('id mismatch');
    } catch {
      return defer(); // authentic, but written by a newer rembo: keep it for after an update
    }
    if (await this.vault.hasEntry(entry.meta)) return false;
    await this.vault.writeEntry(entry);
    result.pulled++;
    return true;
  }

  /** Retries records an earlier version could not read; those still unreadable are deferred again. */
  private async retryDeferred(result: SyncResult): Promise<boolean> {
    let changed = false;
    for (const { file, record } of await this.vault.deferredRecords()) {
      const r: ChangeRecord = { seq: record.seq, id: record.id, kind: record.kind as ChangeRecord['kind'], device: null, at: '' };
      if (record.data) r.data = record.data;
      const before = result.deferred;
      if (await this.applyRecord(r, result)) changed = true;
      if (result.deferred === before) await this.vault.removeDeferredFile(file); // applied or rejected; a re-deferral rewrote the file
    }
    return changed;
  }

  private async putBatch(batch: PendingOp[]): Promise<void> {
    await this.hub.request<{ results: PutResult[] }>('POST', `/v1/vaults/${this.vault.vaultId}/objects`, {
      items: batch.map((o) => ({ id: o.op.id, data: (o.op as { data: string }).data })),
    });
  }

  /** Sends one op; an op the hub refuses as invalid moves to failed/ instead of blocking the queue. */
  private async pushOne(op: PendingOp, send: () => Promise<unknown>, result: SyncResult): Promise<void> {
    try {
      await send();
      await this.vault.removeOps([op]);
      result.pushed++;
    } catch (e) {
      if (!isRejection(e)) throw e;
      await this.vault.failOp(op, `${e.code}: ${e.message}`);
      result.failed++;
    }
  }

  private async pushOutbox(result: SyncResult, lock: LockHandle): Promise<void> {
    const ops = await this.vault.pendingOps();
    for (const batch of putBatches(ops.filter((o) => o.op.op === 'put'))) {
      try {
        await this.putBatch(batch);
        await this.vault.removeOps(batch);
        result.pushed += batch.length;
      } catch (e) {
        if (!isRejection(e)) throw e;
        // Find the op the hub refuses by sending the batch one by one.
        for (const op of batch) await this.pushOne(op, () => this.putBatch([op]), result);
      }
      await lock.refresh();
    }
    for (const del of ops.filter((o) => o.op.op === 'delete')) {
      const { id, proof } = del.op as { id: string; proof: string };
      await this.pushOne(del, () => this.hub.request('DELETE', `/v1/vaults/${this.vault.vaultId}/objects/${id}`, { proof }), result);
    }
  }

  /** Views follow local entries with or without the network (e.g. an offline forget); never throws. */
  private async refreshViews(changed: boolean): Promise<void> {
    try {
      if ((await this.vault.takeViewsDirty()) || changed) await this.vault.writeViews(liveEntries(await this.loadEntries()));
    } catch {
      await this.vault.markViewsDirty().catch(() => undefined); // try again on the next sync
    }
  }

  /** Finishes a vault creation that setup could not confirm. */
  private async finishVaultCreation(): Promise<void> {
    const keyring = this.config.vault.pendingKeyring;
    if (!keyring) return;
    await createVaultOnHub(this.hub, { id: this.vault.vaultId, encryption: this.config.vault.encryption, keyring });
    delete this.config.vault.pendingKeyring;
    await this.saveConfig();
  }

  /** Push the outbox, then pull the log since the cursor and apply it. */
  async sync(opts: { wait?: boolean; waitMs?: number } = {}): Promise<SyncResult> {
    const lock = opts.wait ? await waitLock(this.vault.lockDir, opts.waitMs ?? 30_000) : await tryLock(this.vault.lockDir);
    const result: SyncResult = { status: 'ok', pushed: 0, pulled: 0, removed: 0, rejected: 0, deferred: 0, failed: 0 };
    if (!lock) return { ...result, status: 'busy' };
    let changed = false;
    try {
      await this.finishVaultCreation();
      let pushError: HubError | undefined;
      try {
        await this.pushOutbox(result, lock);
      } catch (e) {
        if (!pullAnyway(e)) throw e;
        pushError = e; // one stuck upload must not stop this machine from receiving
      }
      changed = await this.retryDeferred(result);
      let state = await this.vault.readState();
      for (;;) {
        const page = await this.hub.request<ChangesResponse>(
          'GET',
          `/v1/vaults/${this.vault.vaultId}/changes?since=${state.cursor}&limit=${LIMITS.changesPage}`,
        );
        if (!Array.isArray(page?.records)) throw new HubError(0, 'bad_hub_response', 'The hub sent an invalid change list.');
        const before = state.cursor;
        for (const r of page.records) {
          if (!Number.isSafeInteger(r?.seq) || r.seq <= state.cursor) {
            result.rejected++; // out of order: never move the cursor backwards
            continue;
          }
          if (await this.applyRecord(r, result)) changed = true;
          state = { cursor: r.seq };
        }
        await this.vault.writeState(state);
        await lock.refresh();
        result.head = page.head;
        if (!page.more || state.cursor === before) break; // no progress: a buggy or hostile hub must not keep us looping
      }
      result.cursor = state.cursor;
      if (pushError) {
        result.status = 'partial';
        result.error = pushError.message;
      }
      await this.writeStatus({
        ok: !pushError,
        at: new Date().toISOString(),
        pending: (await this.vault.pendingOps()).length,
        error: pushError?.code,
      });
      return result;
    } catch (e) {
      const code = e instanceof RemboError ? e.code : 'error';
      await this.writeStatus({ ok: false, at: new Date().toISOString(), pending: (await this.vault.pendingOps()).length, error: code });
      if (e instanceof HubError && e.code === 'unreachable') return { ...result, status: 'offline', error: e.message };
      throw e;
    } finally {
      await this.refreshViews(changed);
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

  async failedCount(): Promise<number> {
    return this.vault.failedCount();
  }

  async deferredCount(): Promise<number> {
    return (await this.vault.deferredRecords()).length;
  }

  /** Puts changes the hub refused back into the queue (e.g. after a hub fix). */
  async retryFailed(): Promise<number> {
    return this.vault.retryFailed();
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return (await this.hub.request<{ devices: DeviceInfo[] }>('GET', '/v1/devices')).devices;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.hub.request('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  }

  /** Default for new sessions: off means no snapshot and no rembo tools unless /rembo on or REMBO=on. */
  async setDefaultMode(mode: 'on' | 'off'): Promise<void> {
    this.config.defaults.mode = mode;
    await this.saveConfig();
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
