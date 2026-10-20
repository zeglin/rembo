import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import net from 'node:net';

// Minimal DER encoder for one self-signed ECDSA P-256 certificate (IP mode).
// Signing is done by node:crypto (OpenSSL); this file only lays out ASN.1.

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const ctx = (n: number, content: Buffer) => tlv(0xa0 + n, content);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (b: Buffer, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));

function integer(b: Buffer): Buffer {
  let v = b;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii')) : tlv(0x18, Buffer.from(iso, 'ascii'));
}

function ipBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) throw new Error(`not an IP address: ${ip}`);
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => [parseInt(g || '0', 16) >> 8, parseInt(g || '0', 16) & 0xff]));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

export interface SelfSignedCert {
  certPem: string;
  keyPem: string;
}

/** A long-lived (default 10 years) self-signed certificate for the given IPs and DNS names. */
export function createSelfSignedCert(opts: { ips?: string[]; dnsNames?: string[]; years?: number; commonName?: string }): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (opts.years ?? 10));
  const name = seq(set(seq(oid(OID.commonName), utf8(opts.commonName ?? 'rembo hub'))));
  const altNames = [
    ...(opts.dnsNames ?? []).map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
    ...(opts.ips ?? []).map((ip) => tlv(0x87, ipBytes(ip))),
  ];
  const extensions = [
    seq(oid(OID.basicConstraints), bool(true), octets(seq(bool(true)))),
    seq(oid(OID.keyUsage), bool(true), octets(bitString(Buffer.from([0x84]), 2))), // digitalSignature, keyCertSign
    seq(oid(OID.extKeyUsage), octets(seq(oid(OID.serverAuth)))),
  ];
  if (altNames.length) extensions.push(seq(oid(OID.subjectAltName), octets(seq(...altNames))));
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const tbs = seq(
    ctx(0, integer(Buffer.from([2]))),
    integer(serial),
    seq(oid(OID.ecdsaSha256)),
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, seq(oid(OID.ecdsaSha256)), bitString(signature));
  const cert = new X509Certificate(der); // validates the encoding
  return { certPem: cert.toString(), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
