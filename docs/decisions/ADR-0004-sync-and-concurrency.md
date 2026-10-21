# ADR-0004: Sync and concurrency — append-only log

- Status: proposed (revised 2026-10-20 after first-principles review)
- Date: 2026-10-20

## Context

Many machines and sessions write concurrently; the hub sees only ciphertext
and cannot merge. Requirements: zero lost writes, no local corruption,
offline queue, no daemon, no network on the session-start path.

The first draft used mutable L1 pages with optimistic concurrency, 3-way
merges and keyed deterministic page ids. All of that existed only because
pages were editable from several machines. This revision removes mutation.

## Decision

**All memory objects are immutable.** An object is written once under a
fresh id and never changed. "Editing" = a new entry with `supersedes: [id]`.
"Forgetting" = a tombstone. Views (L0 index, L1 pages) are generated locally
(ADR-0006) and never synced. Conflicts are impossible by construction.

### Hub: an append-only log per vault

`records(vault_id, seq, object_id, kind: put|tombstone, ciphertext?,
size, author_device_id, created_at)`; `seq` is assigned by the hub in the
insert transaction (`BEGIN IMMEDIATE`), strictly increasing per vault.

- `POST /v1/vaults/:vault/objects` — batch of `{id, ciphertext}` (<= 500).
  Each item: `created {seq}` or `exists` (same id already stored: idempotent
  success, so retries and duplicate imports are harmless). Re-writing an id
  with different content is impossible: the existing record wins.
- `DELETE /v1/vaults/:vault/objects/:id` with `{proof}` — appends a tombstone
  and **erases the stored ciphertext** of that id. The proof is a delete
  marker sealed with the vault key (AAD object id `tombstone:<id>`); devices
  apply a tombstone only if the proof verifies, so the hub cannot forge
  deletions of local copies.
- `GET /v1/vaults/:vault/changes?since=<seq>&limit=<n>` — records with
  `seq > since` (at most `limit` and ~8 MiB of data, always at least one
  record), plus `head_seq` and `more` (`last seq < head`).

### Client

```
~/.rembo/vaults/<vault_id>/
  md/            plaintext tree: entries/YYYY/MM/<id>.md + generated INDEX.md,
                 projects/*.md, topics/*.md (ADR-0006)
  state.json     cursor (last applied seq)
  outbox/        one file per pending object (atomic create, unique name)
  failed/        ops the hub refused as invalid (400/413); kept, retryable
  deferred/      authentic records this version cannot read yet; retried
                 on every sync (forward compatibility, key rotation)
  lock/          sync lock (mkdir-based, stale after 2 min / dead pid)
```

- **Write:** secret guard -> write the entry file atomically -> drop it into
  `outbox/` -> try to push (short timeout). Never waits on the network for
  longer than that; never fails because the hub is down.
- **Sync** (under the lock): push the outbox (batches of <= 200 items and
  <= 12 MiB), then pull changes since the cursor, decrypt, write files
  atomically, delete tombstoned files, advance the cursor after each applied
  page, regenerate views when entries changed or a local write marked them
  dirty. A record that fails verification is skipped (counted as rejected);
  an authentic one this version cannot parse is deferred, never skipped. A
  refused op never blocks the queue, and push errors other than auth or
  network do not stop the pull.
- **Triggers (no daemon):** SessionStart spawns a detached `rembo sync`; the
  MCP server (alive for the whole session) pushes after each write, pulls
  every 60 s, and does a quick pull (<= 1.5 s budget) before `search` when the
  last pull is older than 30 s; SessionEnd spawns a detached sync;
  `rembo sync` on demand.
- **Local concurrency:** atomic writes (tmp + fsync + rename, retry on Windows
  `EPERM`/`EBUSY`); only the lock holder writes `state.json` and views; any
  process may add outbox files without the lock.

### Ids

ULIDs for authored entries. Imported documents and bridged native memories
use `HMAC(k_ids, "doc:" || sha256(normalized text))`, so the same content
from two machines is one object (`exists` on the second upload) and the hub
learns nothing about the content.

## Consequences

- No merge code, no conflict states, no `409`: the Etap 1 concurrency test
  (3 clients, 1000 parallel operations, identical end state) checks a log,
  not a merge algorithm.
- Editing history is visible (superseded entries stay until forgotten);
  views show only the newest version of each chain.
- The hub can withhold or delete records (availability), but cannot alter or
  swap them (AEAD with the object id in AAD, ADR-0005).
- The hub is a plain blob log, so a future S3/R2 backend is a small adapter.
