import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { RemboError } from '../../core/src/errors.ts';
import { decodeAccountKey, decodeDeviceToken, encodeDeviceToken, hashSecret } from '../../core/src/keys.ts';
import {
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_MAX,
  HEADER_PROTOCOL_MIN,
  LIMITS,
  OBJECT_ID_RE,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  VAULT_ID_RE,
  type DeviceInfo,
} from '../../core/src/protocol.ts';
import { HubDb, type DeviceRow } from './db.ts';
import { DEFAULT_LIMITS, FailureLimiter, TokenBucket, type HubLimits } from './limits.ts';

export type HubMode = 'selfhost' | 'cloud';

export interface HubOptions {
  db: HubDb;
  mode?: HubMode;
  limits?: Partial<HubLimits>;
  trustProxy?: boolean;
  log?: ((line: string) => void) | undefined;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unauthorized = () => new ApiError(401, 'unauthorized', 'Authentication failed.');
const notFound = () => new ApiError(404, 'not_found', 'Not found.');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new ApiError(413, 'too_large', 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, 'too_large', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

function str(v: unknown, field: string, max = 100): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ApiError(400, 'bad_request', `Field "${field}" must be a string of 1-${max} characters.`);
  return v.trim();
}

function decodeData(v: unknown): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]*$/.test(v)) throw new ApiError(400, 'bad_request', 'Object data must be base64url.');
  const data = Buffer.from(v, 'base64url');
  if (data.length === 0 || data.length > LIMITS.objectBytes) throw new ApiError(413, 'too_large', 'Object too large (max 1 MiB).');
  return data;
}

type Route = { name: string; method: string; re: RegExp };
const ROUTES: Route[] = [
  { name: 'health', method: 'GET', re: /^\/health$/ },
  { name: 'register', method: 'POST', re: /^\/v1\/devices$/ },
  { name: 'devices', method: 'GET', re: /^\/v1\/devices$/ },
  { name: 'revokeDevice', method: 'DELETE', re: /^\/v1\/devices\/([^/]+)$/ },
  { name: 'vaults', method: 'GET', re: /^\/v1\/vaults$/ },
  { name: 'createVault', method: 'POST', re: /^\/v1\/vaults$/ },
  { name: 'keyring', method: 'GET', re: /^\/v1\/vaults\/([^/]+)\/keyring$/ },
  { name: 'put', method: 'POST', re: /^\/v1\/vaults\/([^/]+)\/objects$/ },
  { name: 'delete', method: 'DELETE', re: /^\/v1\/vaults\/([^/]+)\/objects\/([^/]+)$/ },
  { name: 'changes', method: 'GET', re: /^\/v1\/vaults\/([^/]+)\/changes$/ },
];

function deviceInfo(d: DeviceRow, currentId: string): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    role: d.role,
    createdAt: d.created_at,
    lastSeen: d.last_seen,
    revoked: d.revoked_at !== null,
    current: d.id === currentId,
  };
}

/** The hub's HTTP handler. Content is opaque ciphertext; nothing here can read it. */
export function createHandler(opts: HubOptions): http.RequestListener {
  const db = opts.db;
  const mode = opts.mode ?? 'selfhost';
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const failures = new FailureLimiter(limits.authFailuresPerMinute);
  const buckets = new TokenBucket(limits.requestsPerMinute, limits.burst);
  const lastTouch = new Map<string, number>();

  const clientIp = (req: http.IncomingMessage) => {
    // Behind one trusted proxy the real client is the right-most entry (the one the proxy appended);
    // left-most entries are whatever the client sent.
    const fwd = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() : '';
    return fwd || req.socket.remoteAddress || 'unknown';
  };

  const bearer = (req: http.IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

  const fail = (ip: string): never => {
    failures.fail(ip);
    throw unauthorized();
  };

  function authDevice(req: http.IncomingMessage, ip: string): DeviceRow {
    if (failures.isBlocked(ip)) throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts; try again later.');
    const token = decodeDeviceToken(bearer(req) ?? '');
    if (!token) return fail(ip);
    const device = db.getDevice(token.deviceId);
    if (!device || device.revoked_at || !safeEqualHex(device.token_hash, hashSecret(token.secret))) return fail(ip);
    if (!buckets.take(device.id)) throw new ApiError(429, 'rate_limited', 'Too many requests; slow down.');
    const t = Date.now();
    if (t - (lastTouch.get(device.id) ?? 0) > 60_000) {
      lastTouch.set(device.id, t);
      db.touchDevice(device.id);
    }
    return device;
  }

  function requireFull(device: DeviceRow): void {
    if (device.role !== 'full') throw new ApiError(403, 'read_only', 'This device is read-only.');
  }

  function requireVault(device: DeviceRow, vaultId: string) {
    if (!VAULT_ID_RE.test(vaultId)) throw notFound();
    const vault = db.getVault(device.account_id, vaultId);
    if (!vault) throw notFound();
    return vault;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<{ status: number; body: unknown; device?: string }> {
    const url = new URL(req.url ?? '/', 'http://hub');
    const method = req.method ?? 'GET';
    let match: RegExpExecArray | null = null;
    const r = ROUTES.find((rt) => rt.method === method && (match = rt.re.exec(url.pathname)));
    if (!r || !match) throw notFound();
    const params = (match as RegExpExecArray).slice(1).map(decodeURIComponent);

    if (r.name === 'health') return { status: 200, body: { ok: true, protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX } } };

    const requested = Number(req.headers[HEADER_PROTOCOL] ?? PROTOCOL_VERSION);
    if (!Number.isInteger(requested) || requested < PROTOCOL_MIN) {
      throw new ApiError(426, 'client_too_old', 'This hub requires a newer rembo client.');
    }

    if (r.name === 'register') {
      if (failures.isBlocked(ip)) throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts; try again later.');
      let keyId: string;
      let secret: Buffer;
      try {
        ({ keyId, secret } = decodeAccountKey(bearer(req) ?? ''));
      } catch {
        return fail(ip);
      }
      const key = db.getAccountKey(keyId);
      if (!key || key.revoked_at || !safeEqualHex(key.secret_hash, hashSecret(secret))) return fail(ip);
      const body = (await readBody(req, 64 * 1024)) as { name?: unknown; platform?: unknown };
      if (db.countActiveDevices(key.account_id) >= limits.maxDevicesPerAccount) {
        throw new ApiError(403, 'device_limit', 'This account has reached its device limit; revoke an old device first.');
      }
      const tokenSecret = randomBytes(32);
      const deviceId = db.createDevice({
        accountId: key.account_id,
        keyId,
        tokenHash: hashSecret(tokenSecret),
        name: str(body.name, 'name'),
        platform: str(body.platform, 'platform', 64),
      });
      return {
        status: 201,
        device: deviceId,
        body: {
          deviceId,
          token: encodeDeviceToken({ deviceId, secret: tokenSecret }),
          accountId: key.account_id,
          vaults: db.listVaults(key.account_id),
        },
      };
    }

    const device = authDevice(req, ip);
    const ok = (body: unknown, status = 200) => ({ status, body, device: device.id });

    switch (r.name) {
      case 'devices':
        return ok({ devices: db.listDevices(device.account_id).map((d) => deviceInfo(d, device.id)) });
      case 'revokeDevice': {
        requireFull(device);
        if (!db.revokeDevice(params[0]!, device.account_id)) throw notFound();
        return ok({ revoked: params[0] });
      }
      case 'vaults':
        return ok({ vaults: db.listVaults(device.account_id) });
      case 'createVault': {
        requireFull(device);
        const body = (await readBody(req, 256 * 1024)) as { id?: unknown; encryption?: unknown; keyring?: unknown };
        const id = String(body.id ?? '');
        if (!VAULT_ID_RE.test(id)) throw new ApiError(400, 'bad_request', 'Vault id must be 32 hex characters.');
        const encryption = body.encryption !== false;
        if (mode === 'cloud' && !encryption) throw new ApiError(400, 'encryption_required', 'rembo cloud stores encrypted vaults only.');
        if (!db.createVault(device.account_id, id, encryption, decodeData(body.keyring))) throw new ApiError(409, 'exists', 'Vault already exists.');
        return ok({ id, encryption, keyringVersion: 1 }, 201);
      }
      case 'keyring': {
        const vault = requireVault(device, params[0]!);
        return ok({ keyring: Buffer.from(vault.keyring).toString('base64url'), version: vault.keyring_version });
      }
      case 'put': {
        requireFull(device);
        const vault = requireVault(device, params[0]!);
        const body = (await readBody(req, LIMITS.requestBytes)) as { items?: unknown };
        if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > LIMITS.batchItems) {
          throw new ApiError(400, 'bad_request', `"items" must hold 1-${LIMITS.batchItems} objects.`);
        }
        const items = body.items.map((it: { id?: unknown; data?: unknown }) => {
          if (typeof it?.id !== 'string' || !OBJECT_ID_RE.test(it.id)) throw new ApiError(400, 'bad_request', 'Invalid object id.');
          return { id: it.id, data: decodeData(it.data) };
        });
        return ok({ results: db.putObjects(vault.id, items, device.id) });
      }
      case 'delete': {
        requireFull(device);
        const vault = requireVault(device, params[0]!);
        if (!OBJECT_ID_RE.test(params[1]!)) throw new ApiError(400, 'bad_request', 'Invalid object id.');
        const body = (await readBody(req, 64 * 1024)) as { proof?: unknown };
        return ok({ seq: db.tombstone(vault.id, params[1]!, device.id, decodeData(body.proof)) });
      }
      case 'changes': {
        const vault = requireVault(device, params[0]!);
        const since = Number(url.searchParams.get('since') ?? 0);
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? LIMITS.changesPage)));
        if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit)) throw new ApiError(400, 'bad_request', 'Invalid "since" or "limit".');
        const { records, head } = db.changes(vault.id, since, limit);
        const last = records.at(-1)?.seq ?? since;
        return ok({ records, head, more: last < head && records.length === limit });
      }
    }
    throw notFound();
  }

  return (req, res) => {
    const started = performance.now();
    const ip = clientIp(req);
    res.setHeader(HEADER_PROTOCOL_MIN, String(PROTOCOL_MIN));
    res.setHeader(HEADER_PROTOCOL_MAX, String(PROTOCOL_MAX));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    let routeName = '-';
    const finish = (status: number, body: unknown, device?: string) => {
      const text = JSON.stringify(body);
      res.statusCode = status;
      if (status === 413) res.setHeader('connection', 'close');
      res.end(text);
      opts.log?.(`${req.method} ${routeName} ${status} ${Math.round(performance.now() - started)}ms${device ? ' dev=' + device.slice(0, 8) : ''}`);
    };
    routeName = new URL(req.url ?? '/', 'http://hub').pathname.replace(/\/[0-9a-f]{16,}|\/[A-Za-z0-9_-]{16,64}(?=$|\/)/g, '/:id');
    route(req, res, ip).then(
      (r) => finish(r.status, r.body, r.device),
      (e: unknown) => {
        if (e instanceof ApiError) return finish(e.status, { error: e.code, message: e.message });
        if (e instanceof RemboError) return finish(400, { error: e.code, message: e.message });
        opts.log?.(`internal error: ${(e as Error)?.stack ?? String(e)}`);
        finish(500, { error: 'internal', message: 'Internal hub error.' });
      },
    );
  };
}

export interface StartHubOptions {
  dataDir: string;
  host?: string;
  port?: number;
  tls?: boolean;
  mode?: HubMode;
  limits?: Partial<HubLimits>;
  trustProxy?: boolean;
  log?: (line: string) => void;
}

export interface RunningHub {
  url: string;
  db: HubDb;
  server: http.Server;
  close(): Promise<void>;
}

export function tlsPaths(dataDir: string): { cert: string; key: string } {
  return { cert: path.join(dataDir, 'tls', 'cert.pem'), key: path.join(dataDir, 'tls', 'key.pem') };
}

export async function startHub(o: StartHubOptions): Promise<RunningHub> {
  await fs.mkdir(o.dataDir, { recursive: true, mode: 0o700 });
  const db = new HubDb(path.join(o.dataDir, 'hub.db'));
  const handler = createHandler({ db, mode: o.mode ?? 'selfhost', limits: o.limits ?? {}, trustProxy: o.trustProxy ?? false, log: o.log });
  let server: http.Server;
  if (o.tls) {
    const p = tlsPaths(o.dataDir);
    server = https.createServer({ cert: readFileSync(p.cert), key: readFileSync(p.key), minVersion: 'TLSv1.2' }, handler);
  } else {
    server = http.createServer(handler);
  }
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 8787, o.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    url: `${o.tls ? 'https' : 'http'}://${host}:${addr.port}`,
    db,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
