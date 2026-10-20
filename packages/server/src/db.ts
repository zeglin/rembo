import { randomBytes } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChangeRecord, PutResult, VaultInfo } from '../../core/src/protocol.ts';

const SCHEMA_V1 = `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'selfhost',
  created_at TEXT NOT NULL
);
CREATE TABLE account_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  secret_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key_id TEXT,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL,
  last_seen TEXT,
  revoked_at TEXT
);
CREATE INDEX devices_account ON devices(account_id);
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  head_seq INTEGER NOT NULL DEFAULT 0,
  encryption INTEGER NOT NULL,
  keyring BLOB NOT NULL,
  keyring_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX vaults_account ON vaults(account_id);
CREATE TABLE records (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  seq INTEGER NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('put', 'tombstone')),
  data BLOB,
  size INTEGER NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, seq)
);
CREATE UNIQUE INDEX records_object ON records(vault_id, object_id, kind);
`;

export interface DeviceRow {
  id: string;
  account_id: string;
  key_id: string | null;
  token_hash: string;
  name: string;
  platform: string;
  role: 'full' | 'read-only';
  created_at: string;
  last_seen: string | null;
  revoked_at: string | null;
}

export interface AccountKeyRow {
  id: string;
  account_id: string;
  secret_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

const now = () => new Date().toISOString();
const hexId = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * Repository over SQLite (node:sqlite, WAL). Every vault/device query is
 * scoped by account id; the cloud mode will swap this for Postgres.
 */
export class HubDb {
  readonly db: DatabaseSync;
  private readonly s: Record<string, StatementSync>;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    const p = (sql: string) => this.db.prepare(sql);
    this.s = {
      head: p('SELECT head_seq FROM vaults WHERE id = ?'),
      setHead: p('UPDATE vaults SET head_seq = ? WHERE id = ?'),
      objectAny: p('SELECT seq FROM records WHERE vault_id = ? AND object_id = ? ORDER BY seq LIMIT 1'),
      tombstone: p("SELECT seq FROM records WHERE vault_id = ? AND object_id = ? AND kind = 'tombstone'"),
      erasePut: p("DELETE FROM records WHERE vault_id = ? AND object_id = ? AND kind = 'put'"),
      insert: p('INSERT INTO records (vault_id, seq, object_id, kind, data, size, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      changes: p('SELECT seq, object_id, kind, data, device_id, created_at FROM records WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      device: p('SELECT * FROM devices WHERE id = ?'),
      touch: p('UPDATE devices SET last_seen = ? WHERE id = ?'),
      vault: p('SELECT id, encryption, keyring, keyring_version, head_seq FROM vaults WHERE id = ? AND account_id = ?'),
      vaults: p('SELECT id, encryption, keyring_version FROM vaults WHERE account_id = ? ORDER BY created_at'),
      accountKey: p('SELECT * FROM account_keys WHERE id = ?'),
    };
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version < 1) {
      this.tx(() => {
        this.db.exec(SCHEMA_V1);
        this.db.exec('PRAGMA user_version = 1');
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- accounts and keys

  createAccount(plan = 'selfhost'): string {
    const id = hexId(8);
    this.db.prepare('INSERT INTO accounts (id, plan, created_at) VALUES (?, ?, ?)').run(id, plan, now());
    return id;
  }

  listAccounts(): { id: string; plan: string; created_at: string; devices: number; vaults: number }[] {
    return this.db
      .prepare(
        `SELECT a.id, a.plan, a.created_at,
          (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
          (SELECT COUNT(*) FROM vaults v WHERE v.account_id = a.id) AS vaults
         FROM accounts a ORDER BY a.created_at`,
      )
      .all() as never;
  }

  addAccountKey(accountId: string, keyId: string, secretHash: string, label?: string): void {
    this.db
      .prepare('INSERT INTO account_keys (id, account_id, secret_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(keyId, accountId, secretHash, label ?? null, now());
  }

  getAccountKey(keyId: string): AccountKeyRow | undefined {
    return this.s.accountKey!.get(keyId) as AccountKeyRow | undefined;
  }

  listAccountKeys(): AccountKeyRow[] {
    return this.db.prepare('SELECT * FROM account_keys ORDER BY created_at').all() as unknown as AccountKeyRow[];
  }

  revokeAccountKey(keyId: string): boolean {
    return Number(this.db.prepare('UPDATE account_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), keyId).changes) > 0;
  }

  // ---- devices

  createDevice(d: { accountId: string; keyId: string | null; tokenHash: string; name: string; platform: string; id?: string }): string {
    const id = d.id ?? hexId(12);
    this.db
      .prepare('INSERT INTO devices (id, account_id, key_id, token_hash, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.accountId, d.keyId, d.tokenHash, d.name, d.platform, now());
    return id;
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.s.device!.get(id) as DeviceRow | undefined;
  }

  touchDevice(id: string): void {
    this.s.touch!.run(now(), id);
  }

  listDevices(accountId?: string): DeviceRow[] {
    return (
      accountId
        ? this.db.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY created_at').all(accountId)
        : this.db.prepare('SELECT * FROM devices ORDER BY created_at').all()
    ) as unknown as DeviceRow[];
  }

  countActiveDevices(accountId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL').get(accountId) as { n: number }).n);
  }

  /** Revokes a device; with `accountId`, only within that account. */
  revokeDevice(id: string, accountId?: string): boolean {
    const sql = accountId
      ? 'UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL'
      : 'UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
    const r = accountId ? this.db.prepare(sql).run(now(), id, accountId) : this.db.prepare(sql).run(now(), id);
    return Number(r.changes) > 0;
  }

  // ---- vaults

  createVault(accountId: string, id: string, encryption: boolean, keyring: Buffer): boolean {
    try {
      this.db
        .prepare('INSERT INTO vaults (id, account_id, encryption, keyring, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, accountId, encryption ? 1 : 0, keyring, now());
      return true;
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/.test(String((e as Error).message))) return false;
      throw e;
    }
  }

  getVault(accountId: string, id: string): { id: string; encryption: number; keyring: Uint8Array; keyring_version: number; head_seq: number } | undefined {
    return this.s.vault!.get(id, accountId) as never;
  }

  listVaults(accountId: string): VaultInfo[] {
    return (this.s.vaults!.all(accountId) as { id: string; encryption: number; keyring_version: number }[]).map((v) => ({
      id: v.id,
      encryption: v.encryption === 1,
      keyringVersion: v.keyring_version,
    }));
  }

  // ---- the append-only log

  /** Idempotent puts: an id that already has a record (put or tombstone) answers "exists". */
  putObjects(vaultId: string, items: { id: string; data: Buffer }[], deviceId: string): PutResult[] {
    return this.tx(() => {
      let head = Number((this.s.head!.get(vaultId) as { head_seq: number }).head_seq);
      const at = now();
      const results: PutResult[] = items.map((it) => {
        const existing = this.s.objectAny!.get(vaultId, it.id) as { seq: number } | undefined;
        if (existing) return { id: it.id, status: 'exists', seq: Number(existing.seq) };
        head += 1;
        this.s.insert!.run(vaultId, head, it.id, 'put', it.data, it.data.length, deviceId, at);
        return { id: it.id, status: 'created', seq: head };
      });
      this.s.setHead!.run(head, vaultId);
      return results;
    });
  }

  /** Appends a tombstone and erases the stored ciphertext of that object. */
  tombstone(vaultId: string, objectId: string, deviceId: string): number {
    return this.tx(() => {
      const existing = this.s.tombstone!.get(vaultId, objectId) as { seq: number } | undefined;
      if (existing) return Number(existing.seq);
      this.s.erasePut!.run(vaultId, objectId);
      const head = Number((this.s.head!.get(vaultId) as { head_seq: number }).head_seq) + 1;
      this.s.insert!.run(vaultId, head, objectId, 'tombstone', null, 0, deviceId, now());
      this.s.setHead!.run(head, vaultId);
      return head;
    });
  }

  changes(vaultId: string, since: number, limit: number): { records: ChangeRecord[]; head: number } {
    const head = Number((this.s.head!.get(vaultId) as { head_seq: number }).head_seq);
    const rows = this.s.changes!.all(vaultId, since, limit) as {
      seq: number;
      object_id: string;
      kind: 'put' | 'tombstone';
      data: Uint8Array | null;
      device_id: string | null;
      created_at: string;
    }[];
    const records = rows.map((r) => {
      const rec: ChangeRecord = { seq: Number(r.seq), id: r.object_id, kind: r.kind, device: r.device_id, at: r.created_at };
      if (r.data) rec.data = Buffer.from(r.data).toString('base64url');
      return rec;
    });
    return { records, head };
  }

  // ---- operations

  stats(): { accounts: number; devices: number; vaults: number; records: number; bytes: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n ?? 0);
    return {
      accounts: one('SELECT COUNT(*) AS n FROM accounts'),
      devices: one('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL'),
      vaults: one('SELECT COUNT(*) AS n FROM vaults'),
      records: one('SELECT COUNT(*) AS n FROM records'),
      bytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM records'),
    };
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  backup(dest: string): void {
    this.db.prepare('VACUUM INTO ?').run(dest);
  }

  close(): void {
    this.db.close();
  }
}
