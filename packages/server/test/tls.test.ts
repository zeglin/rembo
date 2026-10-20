import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HubClient, spkiPin } from '../../core/src/http.ts';
import { startHub, tlsPaths, type RunningHub } from '../src/hub.ts';
import { createSelfSignedCert } from '../src/x509.ts';

describe('self-signed certificate', () => {
  test('is valid X.509 with IP SANs and a valid self-signature', () => {
    const { certPem } = createSelfSignedCert({ ips: ['203.0.113.10', '2001:db8::1'], dnsNames: ['hub.example.com'] });
    const cert = new X509Certificate(certPem);
    expect(cert.subjectAltName).toContain('IP Address:203.0.113.10');
    expect(cert.subjectAltName).toContain('IP Address:2001:DB8:0:0:0:0:0:1');
    expect(cert.subjectAltName).toContain('DNS:hub.example.com');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 9);
  });
});

describe('TLS with a pinned key', () => {
  let dir: string;
  let hub: RunningHub;
  let pin: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rembo-tls-'));
    const { certPem, keyPem } = createSelfSignedCert({ ips: ['127.0.0.1'] });
    const p = tlsPaths(dir);
    await fs.mkdir(path.dirname(p.cert), { recursive: true });
    await fs.writeFile(p.cert, certPem);
    await fs.writeFile(p.key, keyPem);
    pin = spkiPin(new X509Certificate(certPem).raw);
    hub = await startHub({ dataDir: dir, port: 0, tls: true });
  });

  afterAll(async () => {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('connects when the pin matches, learning the certificate once', async () => {
    let learned = '';
    const client = new HubClient({ url: hub.url, certPin: pin });
    client.onCertLearned = async (pem) => {
      learned = pem;
    };
    expect(await client.request('GET', '/health')).toMatchObject({ ok: true });
    expect(learned).toContain('BEGIN CERTIFICATE');
    expect(await client.request('GET', '/health')).toMatchObject({ ok: true }); // reuses the pinned agent
    client.close();
  });

  test('refuses a different key', async () => {
    const client = new HubClient({ url: hub.url, certPin: Buffer.alloc(32, 1).toString('base64url') });
    await expect(client.request('GET', '/health')).rejects.toMatchObject({ code: 'pin_mismatch' });
  });

  test('refuses a stored certificate whose key does not match the pin', async () => {
    const other = createSelfSignedCert({ ips: ['127.0.0.1'] }).certPem;
    const client = new HubClient({ url: hub.url, certPin: spkiPin(new X509Certificate(other).raw), certPem: other });
    await expect(client.request('GET', '/health')).rejects.toMatchObject({ code: expect.stringMatching(/pin_mismatch|unreachable/) });
  });

  test('without a pin the self-signed hub is not trusted (WebPKI mode)', async () => {
    const client = new HubClient({ url: hub.url });
    await expect(client.request('GET', '/health')).rejects.toBeTruthy();
  });

  test('plain HTTP is refused for non-local hubs', async () => {
    const client = new HubClient({ url: 'http://203.0.113.10:8787' });
    await expect(client.request('GET', '/health')).rejects.toMatchObject({ code: 'insecure_url' });
  });
});
