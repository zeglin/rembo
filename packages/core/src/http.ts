import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { sha256 } from './crypto.ts';
import { RemboError } from './errors.ts';
import { HEADER_PROTOCOL, PROTOCOL_VERSION, type ApiErrorBody } from './protocol.ts';

export class HubError extends RemboError {
  readonly status: number;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(code, message, hint);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface HubEndpoint {
  url: string;
  certPin?: string | undefined; // base64url SHA-256 of the hub's SPKI (IP mode)
  certPem?: string | undefined; // learned on first contact, then the only trust anchor
}

/** base64url SHA-256 of the certificate's SubjectPublicKeyInfo (works for RSA, EC, Ed25519). */
export function spkiPin(certDer: Buffer): string {
  const spki = new X509Certificate(certDer).publicKey.export({ type: 'spki', format: 'der' });
  return sha256(spki).toString('base64url');
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function pinMismatch(): HubError {
  return new HubError(
    0,
    'pin_mismatch',
    "The hub's TLS key does not match the key inside your account key.",
    'If the hub was reinstalled, ask its admin for a new account key. Otherwise the connection may be intercepted: do not continue.',
  );
}

/**
 * IP-mode first contact: fetch the hub certificate and accept it only if its
 * public key matches the pin from the account key. No application data is
 * sent on this connection; CA validation is replaced by the exact key match.
 */
export function probeCertificate(url: URL, expectedPin: string, timeoutMs: number): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: Number(url.port || 443),
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: false, // verified below against the pin before any data is sent
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert?.raw) return reject(new HubError(0, 'tls_error', 'The hub did not present a TLS certificate.'));
        if (spkiPin(cert.raw) !== expectedPin) return reject(pinMismatch());
        resolve(new X509Certificate(cert.raw).toString());
      },
    );
    socket.on('timeout', () => socket.destroy(new Error('timeout')));
    socket.on('error', (e) => reject(e));
  });
}

export interface RequestOptions {
  bearer?: string;
  timeoutMs?: number;
}

/** Minimal JSON client for the hub API over node:http(s); zero dependencies. */
export class HubClient {
  readonly endpoint: HubEndpoint;
  private token: string | undefined;
  private agent: https.Agent | undefined;
  private readonly timeoutMs: number;
  onCertLearned: ((pem: string) => Promise<void>) | undefined;

  constructor(endpoint: HubEndpoint, token?: string, opts: { timeoutMs?: number } = {}) {
    this.endpoint = { ...endpoint };
    this.token = token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private unreachable(e: unknown): HubError {
    const err = e as NodeJS.ErrnoException;
    if (err instanceof HubError) return err;
    if (/pin mismatch/.test(err?.message ?? '')) return pinMismatch();
    return new HubError(
      0,
      'unreachable',
      `Cannot reach the hub at ${this.endpoint.url} (${err?.code ?? err?.message ?? 'unknown error'}).`,
      'Check your network and the hub address (rembo hub set-url <url>). rembo keeps working offline and syncs later.',
    );
  }

  private async agentFor(url: URL): Promise<https.Agent | undefined> {
    if (url.protocol === 'http:') {
      if (!isLoopback(url.hostname)) {
        throw new RemboError('insecure_url', 'Refusing to talk to a hub over plain HTTP.', 'Use an https:// hub address.');
      }
      return undefined;
    }
    const pin = this.endpoint.certPin;
    if (!pin) return undefined; // domain mode: system CA store (WebPKI)
    if (this.agent) return this.agent;
    if (!this.endpoint.certPem) {
      this.endpoint.certPem = await probeCertificate(url, pin, this.timeoutMs).catch((e) => {
        throw this.unreachable(e);
      });
      await this.onCertLearned?.(this.endpoint.certPem);
    }
    this.agent = new https.Agent({
      ca: this.endpoint.certPem,
      checkServerIdentity: (_host, cert) => (spkiPin(cert.raw) === pin ? undefined : new Error('rembo: hub certificate pin mismatch')),
      keepAlive: true,
    });
    return this.agent;
  }

  async request<T>(method: string, apiPath: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    try {
      return await this.send<T>(method, apiPath, body, opts);
    } catch (e) {
      // A re-issued certificate with the same pinned key: learn it again once.
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (this.endpoint.certPin && this.endpoint.certPem && /CERT|SELF_SIGNED|LEAF/.test(code)) {
        this.endpoint.certPem = undefined;
        this.agent?.destroy();
        this.agent = undefined;
        return this.send<T>(method, apiPath, body, opts);
      }
      throw e;
    }
  }

  private async send<T>(method: string, apiPath: string, body: unknown, opts: RequestOptions): Promise<T> {
    const url = new URL(this.endpoint.url.replace(/\/+$/, '') + apiPath);
    const agent = await this.agentFor(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { [HEADER_PROTOCOL]: String(PROTOCOL_VERSION), accept: 'application/json' };
    const bearer = opts.bearer ?? this.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise<T>((resolve, reject) => {
      const req = lib.request(url, { method, headers, agent, timeout: opts.timeoutMs ?? this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (e) => reject(this.unreachable(e)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = undefined;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            // non-JSON (e.g. a proxy error page)
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const err = (json ?? {}) as Partial<ApiErrorBody>;
            if (status === 426) {
              return reject(new HubError(426, 'client_too_old', err.message ?? 'This hub needs a newer rembo.', 'Run: rembo update'));
            }
            return reject(new HubError(status, err.error ?? `http_${status}`, err.message ?? `The hub answered HTTP ${status}.`));
          }
          resolve(json as T);
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (/CERT|SELF_SIGNED|LEAF/.test(code)) return reject(e); // handled by request()
        reject(this.unreachable(e));
      });
      req.end(payload);
    });
  }

  close(): void {
    this.agent?.destroy();
  }
}
