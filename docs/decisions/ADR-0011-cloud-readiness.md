# ADR-0011: Cloud readiness (design only)

- Status: proposed (implementation: next round)
- Date: 2026-10-20

## Context

rembo cloud is a paid hosted hub. Same client, same protocol; the server runs
`mode: cloud`. This round implements `selfhost` only, but nothing may block
cloud.

## Decision

**One server codebase, modes as configuration + modules.**
`selfhost` = core API + SQLite + admin CLI. `cloud` = the same core plus
modules behind interfaces that `selfhost` implements trivially:

| interface | selfhost impl | cloud impl (next round) |
| --- | --- | --- |
| `Repository` (accounts, keys, devices, vaults, objects) | SQLite (WAL) | Postgres; every query takes `accountId` |
| `PlanPolicy` (limits: devices, vault bytes, objects, req/min) | unlimited | per plan, from billing |
| `KeyIssuer` | `rembo-server key create` | issued after purchase (webhook) |
| `BillingAdapter` | none | provider TBD (Stripe or a merchant of record) |
| `RateLimiter` | in-memory | Redis/Postgres-backed (multi-instance) |
| `BackupJob` | nightly SQLite `VACUUM INTO` + rotation | managed PG backups + PITR |
| `Mailer` | none | transactional e-mail for account events |

**Data model is multi-tenant from day one:** `accounts(id, plan, limits,
created)`, `account_keys(id, account_id, secret_hash, revoked_at, label)`,
`devices(id, account_id, token_hash, name, role, last_seen, revoked_at)`,
`vaults(id, account_id, head_seq)`, `records(vault_id, seq, object_id, kind,
ciphertext, size, author_device_id, created_at)` (append-only, ADR-0004).
Selfhost creates one account at `init`.

**Encryption is forced on in cloud** (`vault-config` with `encryption: off` is
rejected by a cloud hub).

**Keys.** Cloud account keys omit the hub address (default cloud URL) and use
WebPKI TLS. Provisioning flow: checkout -> webhook -> account + key -> key
shown once in the customer page and e-mailed? (no: e-mail is a weak channel;
show once + allow regenerate). Decided next round.

**Migration self-hosted <-> cloud.** `rembo migrate --to <key>`: the client
registers with the target hub, uploads every object as ciphertext (same
object ids, same vault key, same wrapped keyring), verifies counts and
hashes, then switches the stored hub. No decryption on any server.

**Operations to design next round:** monitoring (no content, aggregate
metrics), abuse limits, account deletion (hard delete + backup expiry),
export (ciphertext bundle + instructions), status page, GDPR documents
(privacy policy, terms, DPA, subprocessors list), classifier proxy only as an
explicit opt-in (it would break zero-knowledge for those snippets).

## Consequences

- Etap 1 must already: scope every repository call by account, enforce limits
  through `PlanPolicy`, and keep the API free of selfhost assumptions (e.g. no
  "the only account" shortcuts in handlers).
- Account isolation tests are part of the Etap 1 DoD.
