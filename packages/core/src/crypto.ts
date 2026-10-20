import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { base32Decode, base32Encode } from './encoding.ts';
import { RemboError } from './errors.ts';

// Envelope: "RMB1" | mode u8 | kid[8] | nonce[12] | ciphertext | tag[16]   (mode 1)
//           "RMB1" | mode u8 | plaintext                                    (mode 0)
const MAGIC = Buffer.from('RMB1', 'ascii');
export const MODE_PLAIN = 0;
export const MODE_AES_GCM = 1;
const KID_LEN = 8;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const PAD_BLOCK = 512;

export interface VaultKey {
  kid: Buffer;
  key: Buffer;
}

export interface DerivedKeys {
  kid: Buffer;
  enc: Buffer;
  ids: Buffer;
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Random 128-bit object id (hex). */
export function randomId(): string {
  return randomBytes(16).toString('hex');
}

export function newVaultKey(): VaultKey {
  return { kid: randomBytes(KID_LEN), key: randomBytes(32) };
}

function hkdf(ikm: Buffer, salt: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

export function deriveKeys(vk: VaultKey): DerivedKeys {
  return { kid: vk.kid, enc: hkdf(vk.key, '', 'rembo/v1/enc'), ids: hkdf(vk.key, '', 'rembo/v1/ids') };
}

/** Length-prefixed field, so concatenated AAD parts cannot be ambiguous. */
function field(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function objectAad(vaultId: string, objectId: string): Buffer {
  return Buffer.concat([field('rembo/obj/v1'), field(vaultId), field(objectId)]);
}

function pad(data: Buffer): Buffer {
  const total = Math.ceil((data.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(data.length, 0);
  data.copy(out, 4);
  return out;
}

function unpad(data: Buffer): Buffer {
  const len = data.readUInt32BE(0);
  if (len > data.length - 4) throw new RemboError('corrupt', 'Corrupted object (bad padding).');
  return data.subarray(4, 4 + len);
}

function aeadSeal(key: Buffer, aad: Buffer, plaintext: Buffer, kid: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([MODE_AES_GCM]), kid, nonce, ct, cipher.getAuthTag()]);
}

function aeadOpen(key: Buffer, aad: Buffer, envelope: Buffer): Buffer {
  const start = 5 + KID_LEN;
  const nonce = envelope.subarray(start, start + NONCE_LEN);
  const ct = envelope.subarray(start + NONCE_LEN, envelope.length - TAG_LEN);
  const tag = envelope.subarray(envelope.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new RemboError('tampered', 'An object failed authentication (wrong key or modified data).');
  }
}

function checkEnvelope(envelope: Buffer): number {
  if (envelope.length < 5 || !envelope.subarray(0, 4).equals(MAGIC)) {
    throw new RemboError('corrupt', 'Not a rembo object.');
  }
  const mode = envelope[4]!;
  if (mode === MODE_AES_GCM && envelope.length < 5 + KID_LEN + NONCE_LEN + TAG_LEN) {
    throw new RemboError('corrupt', 'Truncated rembo object.');
  }
  if (mode !== MODE_PLAIN && mode !== MODE_AES_GCM) {
    throw new RemboError('unsupported', `Unsupported object mode ${mode}; update rembo.`);
  }
  return mode;
}

export interface ObjectContext {
  vaultId: string;
  objectId: string;
  keys: DerivedKeys;
}

export function sealObject(plaintext: Buffer, ctx: ObjectContext & { encrypt: boolean }): Buffer {
  if (!ctx.encrypt) return Buffer.concat([MAGIC, Buffer.from([MODE_PLAIN]), plaintext]);
  return aeadSeal(ctx.keys.enc, objectAad(ctx.vaultId, ctx.objectId), pad(plaintext), ctx.keys.kid);
}

/**
 * Opens an envelope. Plaintext envelopes are accepted only when `allowPlain`
 * is set (vaults with encryption off); otherwise a hub could inject them.
 */
export function openObject(envelope: Buffer, ctx: ObjectContext & { allowPlain: boolean }): Buffer {
  const mode = checkEnvelope(envelope);
  if (mode === MODE_PLAIN) {
    if (!ctx.allowPlain) throw new RemboError('tampered', 'Unencrypted object in an encrypted vault.');
    return envelope.subarray(5);
  }
  const kid = envelope.subarray(5, 5 + KID_LEN);
  if (!kid.equals(ctx.keys.kid)) {
    throw new RemboError('unknown_key', 'Object is encrypted with a key this device does not have.');
  }
  return unpad(aeadOpen(ctx.keys.enc, objectAad(ctx.vaultId, ctx.objectId), envelope));
}

// ---- keyring: the vault key wrapped with a key derived from the recovery key

interface KeyringJson {
  v: 1;
  current: string;
  keys: { kid: string; key: string }[];
}

function keyringKek(recovery: Buffer, vaultId: string): Buffer {
  return hkdf(recovery, vaultId, 'rembo/v1/keyring');
}

function keyringAad(vaultId: string): Buffer {
  return Buffer.concat([field('rembo/keyring/v1'), field(vaultId)]);
}

export function sealKeyring(current: VaultKey, recovery: Buffer, vaultId: string): Buffer {
  const json: KeyringJson = {
    v: 1,
    current: current.kid.toString('hex'),
    keys: [{ kid: current.kid.toString('hex'), key: current.key.toString('hex') }],
  };
  return aeadSeal(keyringKek(recovery, vaultId), keyringAad(vaultId), Buffer.from(JSON.stringify(json)), Buffer.alloc(KID_LEN));
}

export function openKeyring(blob: Buffer, recovery: Buffer, vaultId: string): VaultKey {
  if (checkEnvelope(blob) !== MODE_AES_GCM) throw new RemboError('corrupt', 'Invalid keyring.');
  let json: KeyringJson;
  try {
    json = JSON.parse(aeadOpen(keyringKek(recovery, vaultId), keyringAad(vaultId), blob).toString('utf8')) as KeyringJson;
  } catch {
    throw new RemboError(
      'wrong_recovery_key',
      'This recovery key does not unlock the vault.',
      'Use the recovery key shown when the first machine was set up (it starts with RK-).',
    );
  }
  const current = json.keys.find((k) => k.kid === json.current);
  if (!current) throw new RemboError('corrupt', 'Keyring has no current key.');
  return { kid: Buffer.from(current.kid, 'hex'), key: Buffer.from(current.key, 'hex') };
}

// ---- recovery key: 32 random bytes + 3-byte checksum, base32, "RK-" + groups of 4

export function newRecoveryKey(): Buffer {
  return randomBytes(32);
}

function recoveryChecksum(key: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from('rembo-rk'), key])).subarray(0, 3);
}

export function formatRecoveryKey(key: Buffer): string {
  const b32 = base32Encode(Buffer.concat([key, recoveryChecksum(key)]));
  return 'RK-' + (b32.match(/.{1,4}/g) ?? []).join('-');
}

export function parseRecoveryKey(text: string): Buffer {
  const bad = new RemboError(
    'bad_recovery_key',
    'This recovery key is not valid (typo or incomplete).',
    'Copy it again exactly as it was shown at setup; it starts with RK-.',
  );
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base32Decode(text.trim().replace(/^RK-/i, '')));
  } catch {
    throw bad;
  }
  if (bytes.length !== 35) throw bad;
  const key = Buffer.from(bytes.subarray(0, 32));
  if (!recoveryChecksum(key).equals(bytes.subarray(32))) throw bad;
  return key;
}

/** Keyed, content-derived id: the same text gives the same id on every device of the vault. */
export function contentId(keys: DerivedKeys, text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  return createHmac('sha256', keys.ids).update('doc:').update(sha256(normalized)).digest().subarray(0, 16).toString('hex');
}
