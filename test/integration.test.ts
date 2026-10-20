import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RemboClient } from '../packages/core/src/client.ts';
import { entryToMarkdown } from '../packages/core/src/entry.ts';
import { HubClient } from '../packages/core/src/http.ts';
import { encodeAccountKey, hashSecret } from '../packages/core/src/keys.ts';
import { liveEntries } from '../packages/core/src/views.ts';
import { startHub, type RunningHub } from '../packages/server/src/hub.ts';

const run = promisify(execFile);
const UNLIMITED = { requestsPerMinute: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY, authFailuresPerMinute: 1000 };

let root: string;
let hub: RunningHub;

function newAccountKey(accountId?: string): string {
  const account = accountId ?? hub.db.createAccount();
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32);
  hub.db.addAccountKey(account, keyId, hashSecret(secret));
  return encodeAccountKey({ keyId, secret, hub: hub.url });
}

const home = (name: string) => path.join(root, name);

async function snapshot(client: RemboClient): Promise<Map<string, string>> {
  return new Map(liveEntries(await client.loadEntries()).map((e) => [e.meta.id, entryToMarkdown(e)]));
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rembo-it-'));
  hub = await startHub({ dataDir: home('hub'), port: 0, limits: UNLIMITED });
});

afterAll(async () => {
  await hub.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('three machines', () => {
  let clients: RemboClient[] = [];
  let accountKey: string;
  let recoveryKey: string;

  test('first machine creates the vault, others join with the recovery key', async () => {
    accountKey = newAccountKey();
    const first = await RemboClient.setup({ home: home('a'), accountKey, deviceName: 'machine-a' });
    expect(first.createdVault).toBe(true);
    recoveryKey = first.recoveryKey!;
    expect(recoveryKey).toMatch(/^RK-/);
    await expect(RemboClient.setup({ home: home('x'), accountKey, deviceName: 'machine-x' })).rejects.toMatchObject({ code: 'recovery_key_required' });
    await expect(
      RemboClient.setup({ home: home('y'), accountKey, deviceName: 'machine-y', recoveryKey: '  ' + recoveryKey.replace('RK-', 'rk-').toLowerCase() + '\n' }),
    ).resolves.toMatchObject({ createdVault: false });
    const b = await RemboClient.setup({ home: home('b'), accountKey, recoveryKey, deviceName: 'machine-b' });
    const c = await RemboClient.setup({ home: home('c'), accountKey, recoveryKey, deviceName: 'machine-c' });
    clients = [first.client, b.client, c.client];
    expect(new Set(clients.map((cl) => cl.config.vault.id)).size).toBe(1);
  });

  test('success criterion 2: a fact stored on A is found on C', async () => {
    const [a, , c] = clients as [RemboClient, RemboClient, RemboClient];
    await a.remember({
      title: 'Real-estate scraper location',
      body: 'Lives in D:\\work\\estate-scraper. Run it with `python run.py --city waw`.',
      scope: 'project:estate-scraper',
      type: 'howto',
    });
    await a.sync();
    await c.sync();
    const hits = await c.search('where is the estate scraper and how to run it');
    expect(hits[0]?.title).toBe('Real-estate scraper location');
    expect(hits[0]?.device).toBe('machine-a');
    const page = await fs.readFile(path.join(c.vault.mdDir, 'projects', 'estate-scraper.md'), 'utf8');
    expect(page).toContain('Real-estate scraper location');
  });

  test('1000 parallel operations converge to an identical state with zero lost writes', async () => {
    const expected = new Set<string>();
    const remembered: string[][] = [[], [], []];
    const forgotten = new Set<string>();
    const background: Promise<unknown>[] = [];

    const op = async (i: number) => {
      const k = i % 3;
      const client = clients[k]!;
      const own = remembered[k]!;
      if (i % 5 === 4 && own.length > 0) {
        const id = own.splice(Math.floor(Math.random() * own.length), 1)[0]!;
        await client.forget(id);
        forgotten.add(id);
        expected.delete(id);
      } else {
        const e = await client.remember({ title: `note ${i}`, body: `body ${i} ${randomBytes(8).toString('hex')}`, scope: i % 2 ? 'global' : 'project:demo' });
        own.push(e.meta.id);
        expected.add(e.meta.id);
      }
      if (i % 25 === 0) background.push(clients[(k + 1) % 3]!.sync()); // syncs interleave with writes
    };

    for (let i = 0; i < 1000; i += 50) {
      await Promise.all(Array.from({ length: 50 }, (_, j) => op(i + j)));
    }
    await Promise.all(background);
    for (let round = 0; round < 3; round++) {
      for (const client of clients) await client.sync({ wait: true });
    }

    const states = await Promise.all(clients.map(snapshot));
    const expectedIds = [...expected, ...(await snapshot(clients[0]!)).keys()].filter((id) => !forgotten.has(id));
    for (const state of states) {
      for (const id of expected) expect(state.has(id), `missing ${id}`).toBe(true);
      for (const id of forgotten) expect(state.has(id), `forgotten ${id} still present`).toBe(false);
      expect(state).toEqual(states[0]);
    }
    expect(new Set(expectedIds).size).toBe(states[0]!.size);
    for (const client of clients) expect(await client.pendingCount()).toBe(0);

    const views = await Promise.all(clients.map((cl) => fs.readFile(path.join(cl.vault.mdDir, 'INDEX.md'), 'utf8')));
    expect(new Set(views).size).toBe(1);
    expect(forgotten.size).toBeGreaterThan(100);
  });

  test('the hub database contains no plaintext', async () => {
    const markers = ['ZEBRA-PURPLE-OTTER-4711', 'Kraków-Żółw-Marker', 'estate-scraper', 'python run.py'];
    const a = clients[0]!;
    await a.remember({ title: markers[0]!, body: markers[1]!, tags: ['marker-tag'] });
    await a.sync();
    hub.db.checkpoint();
    const dir = home('hub');
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('hub.db'));
    const all = Buffer.concat(await Promise.all(files.map((f) => fs.readFile(path.join(dir, f)))));
    // Positive control: device names are metadata the hub stores in clear, so the scan must see them.
    expect(all.includes(Buffer.from('machine-a', 'utf8'))).toBe(true);
    for (const m of [...markers, 'marker-tag', 'note 1']) {
      expect(all.includes(Buffer.from(m, 'utf8')), `"${m}" found in the hub database`).toBe(false);
    }
  });

  test('offline: writes queue locally and sync later', async () => {
    const a = clients[0]!;
    const offline = await RemboClient.open(home('a'));
    await offline.setHubUrl('http://127.0.0.1:9'); // nothing listens there
    const e = await offline.remember({ title: 'Written while offline' });
    const r = await offline.sync();
    expect(r.status).toBe('offline');
    expect(await offline.pendingCount()).toBe(1);
    await offline.setHubUrl(hub.url);
    const back = await RemboClient.open(home('a'));
    expect((await back.sync()).status).toBe('ok');
    await clients[1]!.sync();
    expect(await clients[1]!.read(e.meta.id)).not.toBeNull();
    offline.close();
    back.close();
    void a;
  });

  test('secrets are refused before anything is stored', async () => {
    await expect(clients[0]!.remember({ title: 'db', body: 'postgres://admin:hunter22@db:5432/app' })).rejects.toMatchObject({ code: 'secret_detected' });
    await expect(clients[0]!.remember({ title: 'shop login', body: 'password: KeePassXC entry shop-admin' })).resolves.toBeTruthy();
  });

  test('revoked devices lose access', async () => {
    const [a, b] = clients as [RemboClient, RemboClient];
    const devices = await a.listDevices();
    const y = devices.find((d) => d.name === 'machine-y')!;
    await a.revokeDevice(y.id);
    const yClient = await RemboClient.open(home('y'));
    await expect(yClient.sync()).rejects.toMatchObject({ status: 401 });
    expect((await b.listDevices()).find((d) => d.id === y.id)?.revoked).toBe(true);
    yClient.close();
  });

  afterAll(() => clients.forEach((c) => c.close()));
});

describe('account isolation', () => {
  test('a device never sees or touches another account', async () => {
    const a = await RemboClient.setup({ home: home('iso-a'), accountKey: newAccountKey(), deviceName: 'iso-a' });
    const b = await RemboClient.setup({ home: home('iso-b'), accountKey: newAccountKey(), deviceName: 'iso-b' });
    await b.client.remember({ title: 'account B private note' });
    await b.client.sync();
    const vb = b.client.config.vault.id;
    const asA = new HubClient({ url: hub.url }, a.client.config.device.token);
    const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 404 });
    await denied(asA.request('GET', `/v1/vaults/${vb}/changes?since=0`));
    await denied(asA.request('GET', `/v1/vaults/${vb}/keyring`));
    await denied(asA.request('POST', `/v1/vaults/${vb}/objects`, { items: [{ id: 'f'.repeat(32), data: 'AAAA' }] }));
    await denied(asA.request('DELETE', `/v1/vaults/${vb}/objects/${'f'.repeat(32)}`));
    await denied(asA.request('DELETE', `/v1/devices/${b.client.config.device.id}`));
    const vaults = await asA.request<{ vaults: { id: string }[] }>('GET', '/v1/vaults');
    expect(vaults.vaults.map((v) => v.id)).toEqual([a.client.config.vault.id]);
    const devices = await asA.request<{ devices: { id: string }[] }>('GET', '/v1/devices');
    expect(devices.devices.map((d) => d.id)).toEqual([a.client.config.device.id]);
    expect((await b.client.loadEntries()).length).toBe(1);
    asA.close();
    a.client.close();
    b.client.close();
  });

  test('bad credentials get a uniform 401, then a lockout', async () => {
    const local = await startHub({ dataDir: home('hub-lock'), port: 0, limits: { authFailuresPerMinute: 3 } });
    const bad = new HubClient({ url: local.url }, 'rmbd_' + 'ab'.repeat(12) + '.' + 'A'.repeat(43));
    for (let i = 0; i < 3; i++) await expect(bad.request('GET', '/v1/vaults')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(bad.request('GET', '/v1/vaults')).rejects.toMatchObject({ status: 429 });
    bad.close();
    await local.close();
  });
});

describe('CLI end to end', () => {
  const cli = path.resolve('packages/rembo/src/cli.ts');
  const node = (args: string[], env: Record<string, string> = {}) =>
    run(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, cwd: root });

  test('setup, remember, search, status, doctor via the real CLI', async () => {
    const key = newAccountKey();
    const h1 = home('cli-1');
    const h2 = home('cli-2');
    const setup = await node(['setup', key, '--home', h1, '--name', 'cli-one', '--json']);
    const { recoveryKey } = JSON.parse(setup.stdout) as { recoveryKey: string };
    expect(recoveryKey).toMatch(/^RK-/);
    await node(['remember', 'Backup runs nightly at 03:00', '--body', 'via systemd timer rembo-backup', '--global', '--home', h1]);
    const rkFile = path.join(root, 'rk.txt');
    await fs.writeFile(rkFile, recoveryKey);
    await node(['setup', key, '--home', h2, '--name', 'cli-two', '--recovery-file', rkFile]);
    const search = await node(['search', 'backup', 'timer', '--home', h2, '--json']);
    expect((JSON.parse(search.stdout) as { hits: { title: string }[] }).hits[0]?.title).toBe('Backup runs nightly at 03:00');
    const status = await node(['status', '--home', h2]);
    expect(status.stdout).toContain('device     cli-two');
    const doctor = await node(['doctor', '--home', h2]);
    expect(doctor.stdout).toMatch(/✓ hub/);
    const bad = await node(['setup', 'rmb1_garbage', '--home', home('cli-3')]).catch((e: { stderr: string; code: number }) => e);
    expect((bad as { code: number }).code).toBe(1);
    expect((bad as { stderr: string }).stderr).toContain('not a valid rembo account key');
  });
});
