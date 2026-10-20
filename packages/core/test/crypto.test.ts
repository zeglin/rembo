import { describe, expect, test } from 'vitest';
import {
  contentId,
  deriveKeys,
  formatRecoveryKey,
  newRecoveryKey,
  newVaultKey,
  openKeyring,
  openObject,
  parseRecoveryKey,
  sealKeyring,
  sealObject,
} from '../src/crypto.ts';
import { base32Decode, base32Encode } from '../src/encoding.ts';
import { decodeAccountKey, decodeDeviceToken, encodeAccountKey, encodeDeviceToken } from '../src/keys.ts';

const keys = deriveKeys(newVaultKey());
const ctx = { vaultId: 'a'.repeat(32), objectId: 'b'.repeat(32), keys };

describe('object envelope', () => {
  test('round-trips and hides the plaintext', () => {
    const plain = Buffer.from('scraper lives in D:\\work\\scraper — zażółć gęślą jaźń');
    const sealed = sealObject(plain, { ...ctx, encrypt: true });
    expect(sealed.includes(Buffer.from('scraper'))).toBe(false);
    expect(sealed.length % 16).toBeGreaterThanOrEqual(0);
    expect(openObject(sealed, { ...ctx, allowPlain: false }).equals(plain)).toBe(true);
  });

  test('pads sizes to 512-byte buckets', () => {
    const a = sealObject(Buffer.from('x'), { ...ctx, encrypt: true });
    const b = sealObject(Buffer.alloc(400, 1), { ...ctx, encrypt: true });
    expect(a.length).toBe(b.length);
  });

  test('detects tampering, id swaps and wrong keys', () => {
    const sealed = sealObject(Buffer.from('secret note'), { ...ctx, encrypt: true });
    const flipped = Buffer.from(sealed);
    flipped[40]! ^= 1;
    expect(() => openObject(flipped, { ...ctx, allowPlain: false })).toThrow(/failed authentication/);
    expect(() => openObject(sealed, { ...ctx, objectId: 'c'.repeat(32), allowPlain: false })).toThrow(/failed authentication/);
    expect(() => openObject(sealed, { ...ctx, keys: deriveKeys(newVaultKey()), allowPlain: false })).toThrow(/key this device does not have/);
  });

  test('rejects plaintext envelopes in encrypted vaults', () => {
    const plain = sealObject(Buffer.from('injected'), { ...ctx, encrypt: false });
    expect(() => openObject(plain, { ...ctx, allowPlain: false })).toThrow(/Unencrypted object/);
    expect(openObject(plain, { ...ctx, allowPlain: true }).toString()).toBe('injected');
  });
});

describe('keyring and recovery key', () => {
  test('recovery key formats, parses and catches typos', () => {
    const rk = newRecoveryKey();
    const text = formatRecoveryKey(rk);
    expect(text).toMatch(/^RK-([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    expect(parseRecoveryKey(text.toLowerCase()).equals(rk)).toBe(true);
    const typo = text.slice(0, 10) + (text[10] === 'A' ? 'B' : 'A') + text.slice(11);
    expect(() => parseRecoveryKey(typo)).toThrow(/not valid/);
  });

  test('keyring unwraps only with the right recovery key and vault id', () => {
    const vk = newVaultKey();
    const rk = newRecoveryKey();
    const blob = sealKeyring(vk, rk, 'v1');
    expect(openKeyring(blob, rk, 'v1').key.equals(vk.key)).toBe(true);
    expect(() => openKeyring(blob, newRecoveryKey(), 'v1')).toThrow(/does not unlock/);
    expect(() => openKeyring(blob, rk, 'v2')).toThrow(/does not unlock/);
  });

  test('content ids are deterministic per vault and keyed', () => {
    expect(contentId(keys, 'same text\r\n')).toBe(contentId(keys, 'same text'));
    expect(contentId(keys, 'same text')).not.toBe(contentId(deriveKeys(newVaultKey()), 'same text'));
  });
});

describe('keys', () => {
  test('account key round-trips with hub and pin', () => {
    const secret = Buffer.alloc(32, 7);
    const pin = Buffer.alloc(32, 9).toString('base64url');
    const text = encodeAccountKey({ keyId: '0123456789abcdef', secret, hub: 'https://203.0.113.10:443', certPin: pin });
    expect(text.startsWith('rmb1_')).toBe(true);
    const back = decodeAccountKey(` ${text}\n`);
    expect(back).toMatchObject({ keyId: '0123456789abcdef', hub: 'https://203.0.113.10:443', certPin: pin });
    expect(back.secret.equals(secret)).toBe(true);
    expect(decodeAccountKey(encodeAccountKey({ keyId: '0123456789abcdef', secret })).hub).toBeUndefined();
  });

  test('account key checksum catches paste errors', () => {
    const text = encodeAccountKey({ keyId: '0123456789abcdef', secret: Buffer.alloc(32, 1), hub: 'https://hub.example.com' });
    expect(() => decodeAccountKey(text.slice(0, -3))).toThrow(/not a valid rembo account key/);
    expect(() => decodeAccountKey('sk-something')).toThrow(/rmb1_/);
  });

  test('device token round-trips', () => {
    const token = encodeDeviceToken({ deviceId: 'ab'.repeat(12), secret: Buffer.alloc(32, 3) });
    expect(decodeDeviceToken(token)?.deviceId).toBe('ab'.repeat(12));
    expect(decodeDeviceToken('rmbd_nope')).toBeNull();
  });

  test('base32 round-trips', () => {
    const data = Buffer.from([0, 1, 2, 250, 251, 255, 17]);
    expect(Buffer.from(base32Decode(base32Encode(data))).equals(data)).toBe(true);
  });
});
