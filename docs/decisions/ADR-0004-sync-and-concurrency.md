# ADR-0004: Sync and concurrency

- Status: proposed
- Date: 2026-10-20

## Context

Many machines and many concurrent Claude Code sessions per machine read and
write one memory vault. The hub only ever sees ciphertext (ADR-0005), so it
cannot merge content. Requirements: zero lost writes, no local corruption,
offline operation with a queue, no daemon in the MVP, session start must not
wait for the network.

Git was rejected in the brainstorm (merge conflicts under parallel writers;
a server holding E2E ciphertext cannot run a merge; heavyweight install).

## Decision

### Hub: a "dumb" ordered object store

Per vault the hub keeps the latest version of each object:

| column | meaning |
| --- | --- |
| `object_id` | opaque, 128-bit, chosen by the client (random ULID-derived or keyed-HMAC, see below) |
| `rev` | per-object integer, set by the client as `base_rev + 1` |
| `seq` | per-vault monotonically increasing integer, assigned by the hub in the write transaction |
| `deleted` | tombstone flag |
| `ciphertext` | the encrypted envelope (absent for tombstones) |
| `author_device_id`, `updated_at`, `size` | metadata the hub legitimately sees |

Every accepted write bumps the vault's `head_seq` and stamps the object with
it, inside one SQLite transaction (`BEGIN IMMEDIATE`). The change feed is
simply "objects with `seq > cursor` ordered by `seq`": it returns the newest
state of every object changed since the cursor, so the log compacts itself
and needs no separate event table.

API (details in ADR-0003):

- `GET /v1/vaults/:vault/changes?since=<seq>&limit=<n>` -> objects with
  `seq > since`, plus `head_seq` and `more`.
- `PUT /v1/vaults/:vault/objects/:id` with `If-Match: <base_rev>` (or
  `If-None-Match: *` for creation) -> `200 {seq, rev}` or
  `409 {current_rev, seq}`.
- `POST /v1/vaults/:vault/batch` -> up to N conditional puts/deletes, each
  answered individually (used for import and outbox flush).
- Deletion = conditional put of a tombstone. Tombstones are kept (they are a
  few bytes); a later GC horizon is possible, after which a client whose cursor
  is older than the horizon does a full resync.

### Client: a smart replica

`~/.rembo/vaults/<vault_id>/`:

```
md/                 decrypted markdown tree (read by MCP tools, Grep, Read)
  INDEX.md          L0, generated locally, never synced
  projects/*.md     L1
  topics/*.md       L1
  entries/YYYY/MM/<id>.md   L2
base/<object_id>    last synced plaintext of each L1 page (3-way merge base)
state.json          cursor (last seq), per-object {rev, path, hash}
outbox/<ulid>.json  one file per pending operation
index/              local search index (ADR-0006, search backend)
sessions/<session_id>.json   per-session mode (on/off)
lock                sync lock (see below)
```

**Write path.** A write (MCP `remember`, CLI, import, classifier) runs the
secret guard, writes the plaintext file atomically, updates the index, and
drops an operation file into `outbox/` (unique name, atomic create; no lock
needed). It then attempts a push with a short timeout; failure leaves the
operation queued. A write never waits for the network for longer than that
timeout and never fails because the hub is down.

**Sync** (`pull` then `push`), under the sync lock:

1. Pull: page through `changes?since=cursor`, verify + decrypt each object,
   reject any object whose `rev` is lower than the locally known rev
   (rollback protection), apply to `md/` atomically, update index, advance
   cursor only after the batch is applied.
2. Push: for each outbox operation in order, send a conditional put. On `200`
   delete the operation file. On `409` resolve (below) and retry.

**Triggers (no daemon).** SessionStart spawns a detached `rembo sync` and
returns immediately (the snapshot is read from the local copy). The MCP
server, which lives as long as the session, pushes after each write, pulls
every 60 s while the session is alive, and does a quick pull (<= 1.5 s budget)
before `search`/`read` when the last pull is older than 30 s. SessionEnd
spawns a detached sync. `rembo sync` runs it on demand.

### Why conflicts are rare by construction

- **L2 entries** get fresh ULID-based ids: two writers never touch the same
  object. Their content is append-only; a correction is a new entry with
  `supersedes:`.
- **Imported documents** get a deterministic id
  `HMAC(k_ids, "import:" || sha256(normalized content))`. The same file
  imported on two machines maps to the same object, so the second import
  becomes a `409`, resolved by a set-union of the `sources` list (a grow-only
  set, conflict-free). The hub learns nothing: without `k_ids` the id is
  random-looking.
- **L1 pages** get a deterministic id `HMAC(k_ids, "page:" || scope || slug)`,
  so two machines creating `projects/web-scraper` concurrently hit the same object
  rather than creating two pages with the same path.
- **L0 INDEX.md** is generated locally from L1 metadata and never synced.

`k_ids` is derived from the vault key with HKDF (ADR-0005).

### L1 conflict resolution

On `409` for an L1 page: fetch the current version, run a line-based 3-way
merge (base = `base/<id>`, ours = local, theirs = remote). Clean merge ->
put with the new `If-Match`. Overlapping hunks -> keep both: the page keeps the
remote text and gains an `## Unmerged changes from <device> (<date>)` section
with the local hunk, plus `needs_consolidation: true` in frontmatter. The
SessionStart snapshot flags such pages so Claude consolidates them at the next
opportunity (a normal L1 edit). Nothing is ever dropped.

### Local concurrency

- Atomic file writes: write `*.tmp-<pid>-<rand>`, `fsync`, `rename`. On
  Windows `rename` can fail with `EPERM`/`EBUSY` when another process (AV,
  indexer, an open `Read`) holds the target; retry with backoff for up to
  ~1 s.
- Sync lock: `mkdir lock` (atomic on all platforms) containing
  `{pid, host, started}`; stale after 2 min or when the pid is gone. A process
  that cannot take the lock skips the sync (sync is idempotent and the holder
  will pick up its outbox file).
- `state.json` and the index are only written by the lock holder; outbox and
  session files are written lock-free with unique names.

## Consequences

- Zero lost writes: the hub serializes writes per vault and rejects stale
  ones; the client never discards a conflicting version.
- The hub stays content-agnostic, which keeps E2E intact and makes the cloud
  hub a straightforward multi-tenant object store.
- The client is where the complexity lives (merge, index, outbox). It is
  testable in isolation: the Etap 1 DoD (3 simulated clients, 1000 parallel
  operations incl. L1 conflicts, identical end state) targets exactly this.
- A malicious hub can withhold or reorder changes (availability) and can
  serve an old full state to a fresh device; it cannot forge or silently
  roll back an object a device has already seen (AAD binds `rev`, see
  ADR-0005). Documented in THREAT-MODEL.md.
