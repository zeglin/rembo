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
  }
}
