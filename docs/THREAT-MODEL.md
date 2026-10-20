# rembo threat model

Status: draft for review (Etap 0), 2026-10-20.

## Assets

1. Memory content (entries, pages, imported docs): confidentiality, integrity.
2. Credentials: account key, device keys, vault key, recovery phrase.
3. Availability of memory (local copy + hub).
4. Tenant isolation on a multi-tenant (cloud) hub.
5. Metadata: account e-mail (cloud), device names, IPs, object counts/sizes,
   timing.

## Trust boundaries

```
 [device: Claude Code + rembo plugin + ~/.rembo plaintext]  <-- trusted
        |  HTTPS (pinned SPKI or WebPKI), signed requests
 [reverse proxy / network]                                  <-- untrusted
        |
 [hub: API + SQLite + backups]                              <-- untrusted for content,
                                                                trusted for availability
 [LLM providers: Anthropic (session), optional classifier]  <-- sees what it is sent
```

## What rembo protects against

| threat | mitigation |
| --- | --- |
| Hub DB / backup theft, curious operator (incl. rembo cloud staff) | E2E: XChaCha20-Poly1305 with a vault key the hub never has; titles, paths, tags inside ciphertext; random-looking object ids; optional size padding (ADR-0005) |
| Hub tampering with objects | AEAD with AAD = vault id + object id + rev: swaps, edits and rev-rollbacks of a known object are detected |
| Leaked hub DB used to impersonate devices | hub stores only Ed25519 public keys (account and device keys) (ADR-0002) |
| Network eavesdropping / MITM | TLS only, no plain HTTP; IP mode pins the hub's SPKI from the account key; domain mode uses WebPKI (ADR-0003) |
| Replay of captured requests | signature covers method, path, body hash, timestamp, nonce; ±300 s window + nonce cache |
| Unauthorized device | registration requires a signature by the account key; device limit; per-device revocation; `vault rotate` after revocation |
| Brute force / scanning | no unauthenticated endpoints except `/health` (no data); constant-time checks; no account enumeration (uniform 401); rate limits and temporary lockouts; request size limits |
| Cross-tenant access (cloud) | every query is scoped by `account_id` at the repository layer; tests with two accounts in Etap 1 |
| Secrets stored in memory by mistake | client-side secret guard before every write and every outbound text; report without values (ADR-0006) |
| Prompt injection via memory written on another machine ("memory poisoning") | content injected as delimited reference data with an explicit "not instructions" preamble; provenance (`author_device`, sources) shown in results; `read-only` device role for less trusted machines; `/rembo forget` |
| Supply chain (malicious update) | no install scripts; zero runtime deps in the client bundle; exact version pinning in the local marketplace; npm provenance + trusted publishing (Etap 6); `rembo update` is explicit, never automatic |

## What rembo does NOT protect against (stated in README/docs)

- **The model provider sees decrypted memory** whenever Claude reads it
  (injection or tools): it becomes part of the conversation.
- **A compromised device** has the plaintext: `~/.rembo/vaults/*/md`, the vault
  key, and Claude Code's own transcripts in `~/.claude/projects` (not
  encrypted at rest by Claude Code either).
- **The mod and hooks run unsandboxed** inside the user's Claude Code and see
  every prompt and tool call. Users trust the rembo publisher as they trust
  any plugin.
- **Metadata is visible to the hub**: which account and device, when, from
  which IP, how many objects, their sizes (unless padding), sync frequency.
- **An enabled classifier** sends redacted snippets of conversations to the
  chosen provider (opt-in, explained when enabling; ADR-0009).
- **Availability attacks by the hub**: it can withhold changes, go offline,
  or present an old full state to a newly joined device. Local copies keep
  working; detected rollback of a known object is refused.
- **Loss of the recovery phrase and all devices** = loss of the vault. Nobody,
  including rembo cloud, can recover it.
- rembo is **not a secrets manager**; the guard is best-effort pattern
  matching, not a guarantee.

## Hub hardening (self-host defaults, ADR-0010)

Non-root service user; listens on localhost behind the proxy, or binds 443 via
`CAP_NET_BIND_SERVICE` in IP mode; systemd sandboxing (`ProtectSystem=strict`,
`NoNewPrivileges`, `PrivateTmp`, read-write only on the data dir); no admin
API on the network (admin = CLI over SSH); logs without content, keys, or
signatures; daily backups with rotation (backups are ciphertext + metadata);
firewall guidance: 22, 443 (+80 for ACME in domain mode). Optional hardened
mode: hub reachable only over WireGuard/Tailscale. A non-standard port is a
convenience, not security.

## Privacy / GDPR (cloud, next round)

Encryption limits breach impact, but accounts, e-mails, IPs and usage metadata
are personal data: privacy policy, terms, DPA, data export (ciphertext) and
deletion, retention for logs and backups. Tracked in ADR-0011.
