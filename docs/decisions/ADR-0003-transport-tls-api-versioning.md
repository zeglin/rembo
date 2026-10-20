# ADR-0003: Transport, TLS and API versioning

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md §l, §m

## Decision

### HTTPS only, two address modes

**Domain mode (recommended).** WebPKI certificate (Let's Encrypt via Caddy, or
the user's existing proxy). Clients use the system trust store. Required for
cloud.

**IP mode (no domain).** The hub serves a long-lived (10-year) self-signed
ECDSA P-256 certificate with the IP in its SAN; the key never rotates on its
own. The account key carries `sha256(SPKI DER)` of that key (ADR-0002).
Client procedure (verified behaviour of Node's TLS stack, research §l3):

1. First contact: raw `tls.connect` with `rejectUnauthorized: false`, read
   `getPeerCertificate().raw`, compute SPKI via
   `new X509Certificate(raw).publicKey.export({type:'spki',format:'der'})`,
   compare to the pin, close. No HTTP data is sent on this connection. This
   is not "verification disabled": CA validation is replaced by an exact
   public-key match against a pin delivered out of band (inside the account
   key), which is stricter than CA trust; on mismatch the socket is destroyed
   before anything is written.
2. Store the certificate PEM in `config.json`. All API traffic uses
   `node:https` with `ca: <that PEM>` (replaces the public CA store) and
   `rejectUnauthorized: true`, plus a `checkServerIdentity` that re-checks the
   SPKI pin and skips the IP/hostname match (so `rembo hub set-url` survives
   IP changes).
3. On a certificate change with the same key (re-issued cert) the pin still
   matches: step 1 runs again automatically. A different key = hard failure
   with a clear message (possible MITM or a reinstalled hub without its key).

Not used: `rejectUnauthorized:false` + `checkServerIdentity` (the callback is
never called for an unverified chain, so it pins nothing); `cert.pubkey`
(SPKI only for RSA keys); the npm `undici` Agent (extra dependency; recent
advisory GHSA-2m5v-pch6-74hx about dropped `checkServerIdentity`). The client
uses `node:https` for everything, zero dependencies.

Let's Encrypt IP certificates (GA 2026-01-15, 160-hour `shortlived` profile,
http-01/tls-alpn-01 only) are an **optional** alternative for IP mode
(`init --ip --letsencrypt`, via Caddy >= 2.11.4 with `default_sni`). Not the
default: renewal every few days needs public 80/443 at all times, and pinning
would need `reuse_private_keys`.

Plain HTTP is refused by the client, except `http://127.0.0.1` / `localhost`
for development and tests.

### Authentication and proxies

`Authorization: Bearer` device tokens (ADR-0002). Documented proxy
requirements: pass `Authorization` through and do not log it,
`client_max_body_size` >= hub request limit, hyphenated header names (nginx
drops `_` headers).

### Versioning

- URL major: `/v1/...`.
- Request header `Rembo-Protocol: <int>`; every response carries
  `Rembo-Protocol-Min`, `Rembo-Protocol-Max`.
- Client too old -> `426 {error: "client_too_old", min_protocol, message:
  "Your rembo is too old for this hub. Run: rembo update"}`. Client newer than
  the hub's max -> client falls back to the hub's max if it still supports it,
  else tells the user to update the hub.
- `GET /health` (unauthenticated): `{ok, protocol: {min, max}}`, nothing else.
- Errors are JSON `{error: <code>, message: <what to do next>}`; 401 bodies are
  uniform (no account enumeration).

### Limits (defaults, configurable)

Object <= 1 MiB ciphertext, request <= 16 MiB, batch <= 500 operations,
60 requests/min per device burst 120, 10 failed auth/min per IP then
exponential lockout. Payloads are JSON with base64url ciphertext (simple,
proxy-friendly; ~33% overhead acceptable at these sizes).

## Consequences

- IP mode needs no CA, no DNS, no renewals, and is MITM-safe from the first
  connection because the trust anchor arrives inside the account key.
- A reinstalled IP-mode hub must keep its TLS key (backed up with the DB) or
  all devices must re-join; `rembo-server backup` includes it.
