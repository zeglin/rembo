import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RemboClient } from '../packages/core/src/client.ts';
import { deriveKeys, formatRecoveryKey, newRecoveryKey, randomId, sealObject } from '../packages/core/src/crypto.ts';
import { exists, tryLock } from '../packages/core/src/fsutil.ts';
import { HubClient } from '../packages/core/src/http.ts';
import { encodeAccountKey, hashSecret } from '../packages/core/src/keys.ts';
import { startHub, type RunningHub } from '../packages/server/src/hub.ts';

const UNLIMITED = { requestsPerMinute: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY, authFailuresPerMinute: 1000 };

let root: string;
let hub: RunningHub;
let proxy: { url: string; rules: { dropVaultCreate: boolean; stallChanges: boolean }; close(): Promise<void> };

const home = (name: string) => path.join(root, name);

function newAccountKey(hubUrl = hub.url): string {
  const account = hub.db.createAccount();
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32);
  hub.db.addAccountKey(account, keyId, hashSecret(secret));
  return encodeAccountKey({ keyId, secret, hub: hubUrl });
}

/** A pass-through proxy in front of the hub that can misbehave on demand. */
async function startProxy(target: string): Promise<typeof proxy> {
  const rules = { dropVaultCreate: false, stallChanges: false };
  const server = http.createServer((req, res) => {
    if (rules.dropVaultCreate && req.method === 'POST' && req.url === '/v1/vaults') return void req.socket.destroy();
    if (rules.stallChanges && req.url?.includes('/changes')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ records: [], head: 999, more: true }));
    }
    const up = http.request(target + req.url, { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    rules,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Seals a record with the vault key read from a client's home, as another (newer) device would. */
async function sealAs(client: RemboClient, id: string, payload: unknown): Promise<string> {
  const key = JSON.parse(await fs.readFile(client.vault.keyFile, 'utf8')) as { kid: string; key: string };
  const keys = deriveKeys({ kid: Buffer.from(key.kid, 'hex'), key: Buffer.from(key.key, 'hex') });
  const plain = Buffer.from(JSON.stringify(payload));
  return sealObject(plain, { vaultId: client.vault.vaultId, objectId: id, keys, encrypt: true }).toString('base64url');
}

async function putRaw(client: RemboClient, id: string, data: string): Promise<void> {
  const raw = new HubClient(client.config.hub, client.config.device.token);
  await raw.request('POST', `/v1/vaults/${client.vault.vaultId}/objects`, { items: [{ id, data }] });
  raw.close();
}

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'fact',
  title: `Entry ${id.slice(0, 6)}`,
  summary: 's',
  scope: 'global',
  tags: [],
  source: { origin: 'remember' },
  created: new Date().toISOString(),
  supersedes: [],
  ...extra,
});

const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`did not finish within ${ms} ms`)), ms))]);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rembo-rb-'));
  hub = await startHub({ dataDir: home('hub'), port: 0, limits: UNLIMITED });
  proxy = await startProxy(hub.url);
});

afterAll(async () => {
  await proxy.close();
  await hub.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('setup', () => {
  test('a failed setup leaves no config and no active device behind', async () => {
    const accountKey = newAccountKey();
    const first = await RemboClient.setup({ home: home('s1'), accountKey, deviceName: 'first' });
    const wrong = formatRecoveryKey(newRecoveryKey());
    await expect(RemboClient.setup({ home: home('s2'), accountKey, recoveryKey: wrong, deviceName: 'typo' })).rejects.toMatchObject({
      code: 'wrong_recovery_key',
    });
    await expect(RemboClient.setup({ home: home('s3'), accountKey, deviceName: 'no-key' })).rejects.toMatchObject({ code: 'recovery_key_required' });
    expect(await exists(path.join(home('s2'), 'config.json'))).toBe(false);
    const active = (await first.client.listDevices()).filter((d) => !d.revoked).map((d) => d.name);
    expect(active).toEqual(['first']);
    first.client.close();
  });

  test('if the hub drops vault creation, the vault is created on the next sync and the recovery key still works', async () => {
    const accountKey = newAccountKey(proxy.url);
    proxy.rules.dropVaultCreate = true;
    const first = await RemboClient.setup({ home: home('p1'), accountKey, deviceName: 'first' });
    proxy.rules.dropVaultCreate = false;
    expect(first.vaultPending).toBe(true);
    expect(first.recoveryKey).toMatch(/^RK-/);
    await first.client.remember({ title: 'Written before the vault existed on the hub' });
    expect((await first.client.sync()).status).toBe('ok');
    expect(first.client.config.vault.pendingKeyring).toBeUndefined();
    const second = await RemboClient.setup({ home: home('p2'), accountKey, recoveryKey: first.recoveryKey, deviceName: 'second' });
    await second.client.sync();
    expect((await second.client.search('before the vault existed')).length).toBe(1);
    first.client.close();
    second.client.close();
  });
});

describe('sync robustness', () => {
  let a: RemboClient;
  let b: RemboClient;

  beforeAll(async () => {
    const accountKey = newAccountKey();
    const first = await RemboClient.setup({ home: home('a'), accountKey, deviceName: 'a' });
    a = first.client;
    b = (await RemboClient.setup({ home: home('b'), accountKey, recoveryKey: first.recoveryKey, deviceName: 'b' })).client;
  });

  afterAll(() => {
    a.close();
    b.close();
  });

  test('entries from a newer rembo are kept, not skipped, and applied once readable', async () => {
    const future = randomId();
    await putRaw(a, future, await sealAs(a, future, { v: 2, meta: meta(future), body: 'from the future' }));
    const first = await b.sync();
    expect(first).toMatchObject({ deferred: 1, rejected: 0 });
    expect(await b.read(future)).toBeNull();
    expect((await b.sync()).deferred).toBe(1); // retried, still unreadable, still kept

    // After an update the same authentic record becomes readable (simulated by a readable payload).
    const [file] = await fs.readdir(b.vault.deferredDir);
    const record = JSON.parse(await fs.readFile(path.join(b.vault.deferredDir, file!), 'utf8'));
    record.data = await sealAs(a, future, { v: 1, meta: meta(future, { expires: '2030-01-01' }), body: 'now readable' });
    await fs.writeFile(path.join(b.vault.deferredDir, file!), JSON.stringify(record));
    expect(await b.sync()).toMatchObject({ pulled: 1, deferred: 0 });
    const entry = await b.read(future);
    expect(entry?.body).toBe('now readable');
    expect(entry?.extra).toEqual({ expires: '2030-01-01' }); // unknown fields survive
    expect(await b.deferredCount()).toBe(0);
  });

  test('a change the hub refuses moves to failed/ and does not block the rest', async () => {
    await a.vault.enqueue({ op: 'put', id: 'too-short', data: 'AAAA' });
    const good = await a.remember({ title: 'Sent despite a refused neighbour' });
    const r = await a.sync();
    expect(r).toMatchObject({ status: 'ok', failed: 1 });
    expect(await a.pendingCount()).toBe(0);
    expect(await a.failedCount()).toBe(1);
    await b.sync();
    expect(await b.read(good.meta.id)).not.toBeNull();
    expect(await a.retryFailed()).toBe(1);
    expect((await a.sync()).failed).toBe(1);
  });

  test('large uploads are split under the request limit and pulled in pages', async () => {
    const body = 'lorem ipsum dolor sit amet '.repeat(26_000); // ~700 KB each, ~28 MB in total
    for (let i = 0; i < 30; i++) await a.remember({ title: `Large document ${i}`, body });
    const pushed = await a.sync();
    expect(pushed).toMatchObject({ status: 'ok', failed: 0 });
    expect(await a.pendingCount()).toBe(0);
    const pulled = await b.sync();
    expect(pulled.pulled).toBe(30);
    expect(pulled.cursor).toBe(pulled.head);
  }, 180_000);

  test('a hub that claims more pages but sends none cannot make sync loop forever', async () => {
    await a.setHubUrl(proxy.url);
    proxy.rules.stallChanges = true;
    try {
      expect((await within(10_000, a.sync())).status).toBe('ok');
    } finally {
      proxy.rules.stallChanges = false;
      await a.setHubUrl(hub.url);
    }
  });

  test('forget removes earlier versions too, and views drop it even offline', async () => {
    const v1 = await a.remember({ title: 'Build server is box-17', type: 'infra' });
    const v2 = await a.remember({ title: 'Build server moved to box-42', type: 'infra', supersedes: [v1.meta.id] });
    await a.sync();
    await b.sync();
    await a.setHubUrl('http://127.0.0.1:9');
    try {
      expect(await a.forget(v2.meta.id)).toEqual([v2.meta.id, v1.meta.id]);
      expect((await a.sync()).status).toBe('offline');
      const index = await fs.readFile(path.join(a.vault.mdDir, 'INDEX.md'), 'utf8');
      expect(index).not.toContain('box-17');
      expect(index).not.toContain('box-42');
    } finally {
      await a.setHubUrl(hub.url);
    }
    await a.sync();
    expect((await b.sync()).removed).toBe(2);
    expect(await b.read(v1.meta.id)).toBeNull();
  });

  test('the hub answers 400 to a malformed URL', async () => {
    const res = await fetch(`${hub.url}/v1/vaults/%zz/keyring`, { headers: { authorization: `Bearer ${a.config.device.token}` } });
    expect(res.status).toBe(400);
  });
});

describe('sync lock', () => {
  test('a stale lock can be taken over, and the old holder cannot release the new one', async () => {
    const dir = path.join(root, 'locks', 'lock');
    const first = await tryLock(dir);
    expect(first).not.toBeNull();
    expect(await tryLock(dir)).toBeNull();
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(dir, old, old); // a hung holder: no heartbeat for 10 minutes
    const second = await tryLock(dir);
    expect(second).not.toBeNull();
    await first!.release();
    expect(await tryLock(dir)).toBeNull(); // still held by the second
    await fs.utimes(dir, old, old);
    await second!.refresh(); // heartbeat
    expect(await tryLock(dir)).toBeNull();
    await second!.release();
    const third = await tryLock(dir);
    expect(third).not.toBeNull();
    await third!.release();
  });
});
