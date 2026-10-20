import { sha256 } from './crypto.ts';
import { RemboError } from './errors.ts';

export const ACCOUNT_KEY_PREFIX = 'rmb1_';
export const DEVICE_TOKEN_PREFIX = 'rmbd_';

const FLAG_PIN = 1;
const FLAG_HUB = 2;

/**
 * Account key: authorizes device registration. Carries the hub address and,
 * for IP-mode hubs, the SHA-256 pin of the hub's TLS public key.
 */
export interface AccountKey {
  keyId: string; // 8 bytes, hex
  secret: Buffer; // 32 bytes
  hub?: string | undefined; // base URL; absent = default cloud hub
  certPin?: string | undefined; // base64url SHA-256 of the SPKI
}

export function encodeAccountKey(key: AccountKey): string {
  const flags = (key.certPin ? FLAG_PIN : 0) | (key.hub ? FLAG_HUB : 0);
  const parts: Buffer[] = [Buffer.from([1, flags]), Buffer.from(key.keyId, 'hex'), key.secret];
  if (key.certPin) {
    const pin = Buffer.from(key.certPin, 'base64url');
    if (pin.length !== 32) throw new Error('certPin must be a base64url SHA-256');
    parts.push(pin);
  }
  if (key.hub) {
    const hub = Buffer.from(key.hub, 'utf8');
    if (hub.length > 255) throw new Error('hub URL too long');
    parts.push(Buffer.from([hub.length]), hub);
  }
  const payload = Buffer.concat(parts);
  return ACCOUNT_KEY_PREFIX + Buffer.concat([payload, sha256(payload).subarray(0, 4)]).toString('base64url');
}

export function decodeAccountKey(text: string): AccountKey {
  const bad = (why: string) =>
    new RemboError(
      'bad_account_key',
      `This is not a valid rembo account key (${why}).`,
      'Copy the whole key (it starts with rmb1_) from your hub admin or rembo cloud page.',
    );
  const t = text.trim();
  if (!t.startsWith(ACCOUNT_KEY_PREFIX)) throw bad('it should start with rmb1_');
  const raw = Buffer.from(t.slice(ACCOUNT_KEY_PREFIX.length), 'base64url');
  if (raw.length < 2 + 8 + 32 + 4) throw bad('too short');
  const payload = raw.subarray(0, raw.length - 4);
  if (!sha256(payload).subarray(0, 4).equals(raw.subarray(raw.length - 4))) {
    throw bad('checksum mismatch, probably a copy/paste error');
  }
  if (payload[0] !== 1) throw bad('unsupported version, update rembo');
  const flags = payload[1]!;
  let off = 2;
  const keyId = payload.subarray(off, off + 8).toString('hex');
  off += 8;
  const secret = Buffer.from(payload.subarray(off, off + 32));
  off += 32;
  let certPin: string | undefined;
  if (flags & FLAG_PIN) {
    certPin = payload.subarray(off, off + 32).toString('base64url');
    off += 32;
  }
  let hub: string | undefined;
  if (flags & FLAG_HUB) {
    const len = payload[off] ?? 0;
    off += 1;
    hub = payload.subarray(off, off + len).toString('utf8');
    off += len;
  }
  if (off !== payload.length) throw bad('unexpected length');
  return { keyId, secret, hub, certPin };
}

export interface DeviceToken {
  deviceId: string; // 12 bytes, hex
  secret: Buffer; // 32 bytes
}

export function encodeDeviceToken(token: DeviceToken): string {
  return `${DEVICE_TOKEN_PREFIX}${token.deviceId}.${token.secret.toString('base64url')}`;
}

export function decodeDeviceToken(text: string): DeviceToken | null {
  const m = /^rmbd_([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) return null;
  return { deviceId: m[1]!, secret: Buffer.from(m[2]!, 'base64url') };
}

/** Hash stored by the hub for high-entropy secrets (account keys, device tokens). */
export function hashSecret(secret: Buffer): string {
  return sha256(secret).toString('hex');
}
