# ADR-0002: Keys, identity and device authentication

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md §m

## Context

Same client for self-hosted and cloud; the hub address comes from the key.
The hub must not be able to read memory (ADR-0005), a leaked hub database
must not yield working credentials, and secrets should not cross the network
where avoidable. Must work behind TLS-terminating reverse proxies.

## Decision

Three independent secrets, each with one job:

| secret | where generated | where it lives | hub stores | purpose |
| --- | --- | --- | --- | --- |
| **account key** `rmb1_...` | hub CLI (`rembo-server key create`) or cloud provisioning | user's clipboard / password manager | Ed25519 **public** key only | authorizes *device registration*; revocable, rotatable, device-count limited |
| **device key** (Ed25519) | each device, at setup | `~/.rembo/device.json` (0600) | public key | signs every API request |
| **vault key** (256-bit) | first device | each device, `~/.rembo/vaults/<id>/key` (0600) | only wrapped (encrypted) copies | encrypts content (ADR-0005) |

The **recovery phrase** (12 BIP-39 words, 128-bit) is generated on the first
device, shown once, never stored by rembo and never sent anywhere. It derives
the key that wraps the vault key (ADR-0005).

### Account key format

`rmb1_` + base64url( version | flags | seed[32] | [spki_sha256[32]] | [hub] ) + checksum

- `seed` is an Ed25519 private seed. The hub keeps only the public key, so a
  leaked hub DB contains no usable account key, and registration proves
  possession by **signature**: the seed never crosses the network.
- `hub`: host[:port] of the hub (domain or IP). Absent in cloud keys, meaning
  the default cloud hub.
- `spki_sha256`: present when the hub runs on a bare IP with a self-signed
  certificate; the client then trusts exactly that public key (ADR-0003).
- 4-byte checksum (truncated SHA-256) catches paste errors with a clear
  message. Typical length ~100 characters.
- `rembo hub set-url <url>` changes the stored address on a device without
  re-registering (IP change, migration); the hub's identity is the SPKI pin /
  domain, not the address.

### Device registration

`POST /v1/devices`: `{device_pubkey, name, platform, account_key_id, ts, nonce,
sig}` where `sig` = Ed25519(account seed, canonical bytes). The hub verifies
against the stored account public key, checks the key is not revoked and the
device limit (plan), and returns `device_id`, `account_id`, vault list.
Device names default to the hostname but are user-editable; the hub sees them
(metadata).

### Request authentication: per-request Ed25519 signatures

Headers on every request:

```
Rembo-Device: <device_id>
Rembo-Date: <unix seconds>
Rembo-Nonce: <128-bit random, base64url>
Rembo-Signature: <base64url Ed25519 signature>
```

Signed string (UTF-8, `\n`-joined):
`rembo-req-v1`, method, path-with-query (relative to the hub base URL),
`Rembo-Date`, nonce, hex SHA-256 of the body, `Rembo-Protocol` value.

Hub checks: device exists and is active; |now - date| <= 300 s; nonce unseen
within the window (replay cache: in-memory LRU in selfhost; a shared store in
cloud); signature valid. On clock skew the hub answers `401 {error:
"clock_skew", server_time}` and the client stores an offset and retries once.

Why not the alternatives (comparison in research §m):

- *Bearer token (hash on server)*: simplest, but the secret travels on every
  request and anything that logs headers (proxy, APM) leaks a working
  credential. Rejected as the primary scheme.
- *mTLS*: secret stays local too, but breaks behind TLS-terminating proxies
  (nginx/Traefik/Cloudflare) unless the proxy forwards and is trusted for the
  client certificate; harder to debug; Node's fetch needs a custom dispatcher
  per request. Rejected.
- *Signatures* need only Node's built-in `crypto` (Ed25519 has been native
  since Node 12), survive any proxy that preserves the path and the custom
  headers, and a DB leak gives only public keys.

### Device roles and revocation

- Roles: `full` (default) and `read-only` (for less trusted machines,
  THREAT-MODEL "memory poisoning"). Enforced by the hub on writes.
- A device can list and revoke devices of **its own account**
  (`rembo device list|revoke`), which cloud users need without SSH. This is
  account self-service, not hub administration: keys, accounts, backups stay
  CLI-only on the server (no admin API on the network).
- Revoking a device stops its API access immediately. Because it already held
  the vault key, `rembo vault rotate` (ADR-0005) is offered right after.

### Later: device linking without the phrase

`rembo device link`: the new device posts an X25519 public key to a short-lived
pairing slot; an existing device shows/compares a 6-digit SAS derived from
both keys and uploads the vault key sealed to the new key. The hub relays
ciphertext only. Designed here, built after the MVP.

## Consequences

- No secret that the hub stores, and no secret on the wire after
  registration, can be replayed elsewhere.
- Request signing is ~50 lines over `node:crypto`; reverse proxies must not
  rewrite paths (documented; base path is configurable on both sides).
- Losing all devices *and* the phrase loses the vault: stated at setup, in
  docs, and in the cloud terms ("we can't help because we can't decrypt").
