import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Write to a temp file, flush, rename over the target. On Windows the rename
 * can fail briefly while another process (AV, indexer, an editor) holds the
 * target, so it is retried with backoff.
 */
export async function atomicWrite(file: string, data: string | Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, data, { mode, flush: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRY_CODES.has(code) || attempt >= 10) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      await sleep(25 * (attempt + 1));
    }
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export interface LockHandle {
  /** Heartbeat: long-running holders call this so others do not take the lock as stale. */
  refresh(): Promise<void>;
  /** Removes the lock only if it is still ours (it may have been taken over as stale). */
  release(): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(dir: string, staleMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    if (Date.now() - st.mtimeMs > staleMs) return true; // no heartbeat for staleMs: owner hung or gone
    try {
      const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')) as { pid: number; host: string };
      return owner.host === os.hostname() && !pidAlive(owner.pid);
    } catch {
      return Date.now() - st.mtimeMs > 5000; // owner not written yet, or crashed right after mkdir
    }
  } catch {
    return true;
  }
}

/** mkdir-based lock (atomic on every platform); returns null when held by someone else. */
export async function tryLock(dir: string, staleMs = 120_000): Promise<LockHandle | null> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt === 0 && (await isStale(dir, staleMs))) {
        await fs.rm(dir, { recursive: true, force: true });
        continue;
      }
      return null;
    }
    const token = randomBytes(8).toString('hex');
    const ownerFile = path.join(dir, 'owner.json');
    await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() }));
    return {
      refresh: async () => {
        const t = new Date();
        await fs.utimes(dir, t, t).catch(() => {});
      },
      release: async () => {
        const owner = await readJson<{ token?: string } | null>(ownerFile, null).catch(() => null);
        if (owner?.token === token) await fs.rm(dir, { recursive: true, force: true });
      },
    };
  }
  return null;
}

export async function waitLock(dir: string, timeoutMs: number, staleMs = 120_000): Promise<LockHandle | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = await tryLock(dir, staleMs);
    if (handle || Date.now() > deadline) return handle;
    await sleep(20 + Math.random() * 30);
  }
}
