import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { entryFromMarkdown, entryRelPath, entryToMarkdown, type Entry, type EntryMeta } from './entry.ts';
import { RemboError } from './errors.ts';
import { atomicWrite, exists, readJson } from './fsutil.ts';
import { OBJECT_ID_RE } from './protocol.ts';
import { renderViews } from './views.ts';

export type OutboxOp = { op: 'put'; id: string; data: string } | { op: 'delete'; id: string; proof: string };

export interface PendingOp {
  file: string;
  op: OutboxOp;
}

export interface VaultState {
  cursor: number;
}

/** A hub record kept as received (still encrypted). */
export interface DeferredRecord {
  seq: number;
  id: string;
  kind: string;
  data: string;
}

const VIEW_DIRS = ['projects', 'topics', 'machines'];

/** The local replica of one vault: plaintext markdown, outbox, cursor. */
export class LocalVault {
  readonly dir: string;
  readonly vaultId: string;

  constructor(home: string, vaultId: string) {
    this.vaultId = vaultId;
    this.dir = path.join(home, 'vaults', vaultId);
  }

  get mdDir(): string {
    return path.join(this.dir, 'md');
  }
  get outboxDir(): string {
    return path.join(this.dir, 'outbox');
  }
  get lockDir(): string {
    return path.join(this.dir, 'lock');
  }
  get keyFile(): string {
    return path.join(this.dir, 'key.json');
  }
  get deferredDir(): string {
    return path.join(this.dir, 'deferred');
  }
  get failedDir(): string {
    return path.join(this.dir, 'failed');
  }
  private get viewsStampFile(): string {
    return path.join(this.dir, 'views.stamp');
  }
  private get viewsDirtyFile(): string {
    return path.join(this.dir, 'views.dirty');
  }
  private get stateFile(): string {
    return path.join(this.dir, 'state.json');
  }
  private get entriesDir(): string {
    return path.join(this.mdDir, 'entries');
  }

  readState(): Promise<VaultState> {
    return readJson<VaultState>(this.stateFile, { cursor: 0 });
  }

  writeState(state: VaultState): Promise<void> {
    return atomicWrite(this.stateFile, JSON.stringify(state));
  }

  entryPath(meta: Pick<EntryMeta, 'id' | 'created'>): string {
    return path.join(this.mdDir, ...entryRelPath(meta).split('/'));
  }

  writeEntry(entry: Entry): Promise<void> {
    return atomicWrite(this.entryPath(entry.meta), entryToMarkdown(entry));
  }

  hasEntry(meta: Pick<EntryMeta, 'id' | 'created'>): Promise<boolean> {
    return exists(this.entryPath(meta));
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  }

  async findEntryFile(id: string): Promise<string | null> {
    if (!OBJECT_ID_RE.test(id)) throw new RemboError('invalid_id', `"${id}" is not a valid entry id.`);
    for (const year of await this.listDir(this.entriesDir)) {
      for (const month of await this.listDir(path.join(this.entriesDir, year))) {
        const file = path.join(this.entriesDir, year, month, `${id}.md`);
        if (await exists(file)) return file;
      }
    }
    return null;
  }

  async readEntry(id: string): Promise<Entry | null> {
    const file = await this.findEntryFile(id);
    return file ? entryFromMarkdown(await fs.readFile(file, 'utf8')) : null;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const file = await this.findEntryFile(id);
    if (!file) return false;
    await fs.rm(file, { force: true });
    return true;
  }

  /** All entries on disk; unreadable files are reported and skipped. */
  async loadEntries(onError?: (file: string, err: unknown) => void): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const year of await this.listDir(this.entriesDir)) {
      for (const month of await this.listDir(path.join(this.entriesDir, year))) {
        const dir = path.join(this.entriesDir, year, month);
        for (const name of await this.listDir(dir)) {
          if (!name.endsWith('.md')) continue;
          const file = path.join(dir, name);
          try {
            out.push(entryFromMarkdown(await fs.readFile(file, 'utf8')));
          } catch (e) {
            onError?.(file, e);
          }
        }
      }
    }
    return out;
  }

  async enqueue(op: OutboxOp): Promise<void> {
    const name = `${Date.now().toString().padStart(15, '0')}-${randomBytes(6).toString('hex')}.json`;
    await atomicWrite(path.join(this.outboxDir, name), JSON.stringify(op));
  }

  async pendingOps(): Promise<PendingOp[]> {
    const names = (await this.listDir(this.outboxDir)).filter((n) => n.endsWith('.json')).sort();
    const ops: PendingOp[] = [];
    for (const name of names) {
      const file = path.join(this.outboxDir, name);
      try {
        ops.push({ file, op: JSON.parse(await fs.readFile(file, 'utf8')) as OutboxOp });
      } catch {
        // removed concurrently or half-written by a crashed process
      }
    }
    return ops;
  }

  async removeOps(ops: PendingOp[]): Promise<void> {
    await Promise.all(ops.map((o) => fs.rm(o.file, { force: true })));
  }

  /** Moves an op the hub rejected as invalid out of the queue, keeping it for inspection or retry. */
  async failOp(op: PendingOp, error: string): Promise<void> {
    await atomicWrite(path.join(this.failedDir, path.basename(op.file)), JSON.stringify({ ...op.op, error, at: new Date().toISOString() }));
    await fs.rm(op.file, { force: true });
  }

  async failedCount(): Promise<number> {
    return (await this.listDir(this.failedDir)).filter((n) => n.endsWith('.json')).length;
  }

  /** Puts failed ops back into the outbox; returns how many. */
  async retryFailed(): Promise<number> {
    let n = 0;
    for (const name of (await this.listDir(this.failedDir)).filter((x) => x.endsWith('.json'))) {
      const file = path.join(this.failedDir, name);
      const { error: _error, at: _at, ...op } = JSON.parse(await fs.readFile(file, 'utf8')) as OutboxOp & { error?: string; at?: string };
      await atomicWrite(path.join(this.outboxDir, name), JSON.stringify(op));
      await fs.rm(file, { force: true });
      n++;
    }
    return n;
  }

  /** Keeps a record this version cannot read (e.g. from a newer rembo) for a retry after an update. */
  async defer(record: DeferredRecord): Promise<void> {
    if (!OBJECT_ID_RE.test(record.id) || !Number.isSafeInteger(record.seq)) throw new RemboError('invalid_id', 'Invalid record.');
    await atomicWrite(path.join(this.deferredDir, `${record.seq}-${record.id}.json`), JSON.stringify(record));
  }

  /** Deferred records in log order. */
  async deferredRecords(): Promise<{ file: string; record: DeferredRecord }[]> {
    const out: { file: string; record: DeferredRecord }[] = [];
    for (const name of await this.listDir(this.deferredDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.deferredDir, name);
      const record = await readJson<DeferredRecord | null>(file, null).catch(() => null);
      if (record && name === `${record.seq}-${record.id}.json` && OBJECT_ID_RE.test(record.id)) out.push({ file, record });
    }
    return out.sort((a, b) => a.record.seq - b.record.seq);
  }

  removeDeferredFile(file: string): Promise<void> {
    return fs.rm(file, { force: true });
  }

  /** Drops deferred records of an object (it was forgotten); says whether there were any. */
  async removeDeferredFor(id: string): Promise<boolean> {
    let removed = false;
    for (const name of await this.listDir(this.deferredDir)) {
      if (name.endsWith(`-${id}.json`)) {
        await fs.rm(path.join(this.deferredDir, name), { force: true });
        removed = true;
      }
    }
    return removed;
  }

  /** Views are regenerated by the next lock holder, with or without the network. */
  markViewsDirty(): Promise<void> {
    return atomicWrite(this.viewsDirtyFile, '1');
  }

  /** Clears the marker and says whether it was set (cleared first, so a write racing the render re-marks it). */
  async takeViewsDirty(): Promise<boolean> {
    if (!(await exists(this.viewsDirtyFile))) return false;
    await fs.rm(this.viewsDirtyFile, { force: true });
    return true;
  }

  /** Renders L0/L1 views and removes view files that no longer exist. */
  async writeViews(entries: Entry[]): Promise<void> {
    const views = renderViews(entries);
    for (const [rel, content] of views) {
      const file = path.join(this.mdDir, ...rel.split('/'));
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current !== content) await atomicWrite(file, content);
    }
    for (const dir of VIEW_DIRS) {
      for (const name of await this.listDir(path.join(this.mdDir, dir))) {
        if (!views.has(`${dir}/${name}`)) await fs.rm(path.join(this.mdDir, dir, name), { force: true });
      }
    }
    await atomicWrite(this.viewsStampFile, randomBytes(8).toString('hex'));
  }

  /** Changes whenever the views are regenerated, i.e. whenever local entries changed (any process). */
  async viewsStamp(): Promise<string> {
    return fs.readFile(this.viewsStampFile, 'utf8').catch(() => '');
  }
}
