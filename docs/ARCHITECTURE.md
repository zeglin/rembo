# rembo architecture

Status: draft for review (Etap 0), 2026-10-20. Decisions are in
`docs/decisions/`; verified platform facts in `docs/research/platform.md`.

## Goal

Every Claude Code session on every machine of a user remembers what earlier
sessions established, without the user's involvement, while the hub (self-
hosted or rembo cloud) cannot read the memory.

## Components

```
packages/
  core/     memory model, object envelope + crypto, sync engine, outbox,
            secret guard, search backend, API types, protocol version
  rembo/    published npm package `rembo`: CLI + Claude Code plugin
            (hooks, MCP stdio server, skill, mod, status line wrapper),
            bundled with esbuild into single files, zero runtime deps
  server/   published npm package `rembo-server`: HTTP API, repository layer
            (SQLite now, Postgres later), modes selfhost|cloud, admin CLI,
            installer (`init`), Dockerfile + compose
docs/       this file, THREAT-MODEL.md, decisions/, research/, PROGRESS.md
```

TypeScript strict, ESM, Node >= 22 (ADR-0008), npm workspaces, vitest.

## Deployment shapes

```
 machine A (Windows)          machine B (Linux VPS)            hub
 ┌────────────────────┐       ┌────────────────────┐      ┌──────────────────┐
 │ Claude Code        │       │ Claude Code        │      │ rembo-server     │
 │  ├ hooks (node)    │       │  ├ hooks           │ TLS  │  HTTP API /v1    │
 │  ├ MCP rembo       │◄─────►│  ├ MCP rembo       │◄────►│  SQLite (WAL)    │
 │  └ mod (UX)        │ sync  │  └ mod             │      │  ciphertext only │
 │ ~/.rembo (plain)   │       │ ~/.rembo           │      │  backups         │
 └────────────────────┘       └────────────────────┘      └──────────────────┘
```

Self-hosted: the user's VPS, `npx rembo-server init` (ADR-0010).
Cloud (next round): our hub, same protocol, `mode: cloud` (ADR-0011).
The client has no cloud/self-host logic: the account key says where the hub
is (ADR-0002).

## Client layout (`~/.rembo/`)

```
config.json            hub URL, SPKI pin, account/device ids, defaults (mode, budget, classifier)
device.json            Ed25519 device key (0600)
app/<version>/         installed runtime: dist/*.js + plugin/ (ADR-0001)
marketplace/           local Claude Code marketplace pointing at app/<version>
vaults/<vault_id>/     key (0600), md/ (plaintext tree), base/, state.json,
                       outbox/, index/, sessions/, lock
status.json            last sync result for the status line / doctor
logs/                  rotating, no content
backup/                settings backups made by setup (restored by uninstall)
```

## Plugin composition

| piece | API | job |
| --- | --- | --- |
| SessionStart hook | classic, exec form `node hook.js session-start` | build snapshot from local copy (<300 ms), print as context (≤ 8000 chars), spawn detached sync |
| PreToolUse hook (`mcp__plugin_rembo_.*`) | classic | deny rembo tools in sessions that are off |
| UserPromptSubmit / Stop hooks | classic, `async: true` | append to classifier inbox when the classifier is on (ADR-0009) |
| SessionEnd hook | classic (1.5 s budget) | spawn detached sync, return |
| MCP server `rembo` | stdio, long-lived per session | tools `search`, `read`, `list`, `remember`, `forget`; push after writes, pull every 60 s and before reads when stale |
| skill `rembo` | skill | rules: search before building from scratch, store important findings, cite ids, admit when nothing is found; fallback `/rembo:rembo on|off` |
| mod | early-access hooks module | bare `/rembo …` without model turns, status line entry, toasts; calls the CLI, no crypto/network itself (ADR-0007) |
| status line wrapper | optional | for setups without the mod |

## Main flows

**Setup** (`rembo setup <key>`): check Node/Claude Code/hub reachability and
protocol -> register device (signed by the account key) -> first device:
create vault key + recovery phrase, upload wrapped keyring; next device:
ask for phrase, unwrap keyring -> install app + marketplace + plugin (user
scope) -> discovery and import (ADR-0006 secret guard) -> write/sync/read
self-test -> summary.

**Session start**: hook reads `vaults/*/md` and the session mode, resolves the
project from `cwd` (git remote / alias / folder), emits the wrapped snapshot,
spawns `rembo sync` detached. No network on the critical path.

**Recall**: Claude calls `search` -> MCP does a quick pull if stale (≤ 1.5 s,
skipped when offline) -> MiniSearch over the local index -> hits with id,
path, device, date -> `read` returns the full entry.

**Store**: `remember` -> secret guard -> new L2 entry (+ L1 page update if
given) -> local write + index -> outbox -> push.

**Sync**: ADR-0004 (ordered change feed, conditional puts, deterministic ids,
3-way merge for L1).

**Discovery/import** (Etap 4): scan `~/.claude/projects/*` (real path from the
`cwd` field of the first transcript lines, since folder names are lossily
encoded: `D:\rembo` -> `D--rembo`), `memory/*.md`, `~/.claude/CLAUDE.md`,
`~/.claude/rules/`, and folders containing `CLAUDE.md`, `CLAUDE.local.md`,
`.claude/`, `AGENTS.md` under configurable roots with exclusions and depth/
time limits. Text-mode picker (works in PowerShell, Windows Terminal, SSH);
`--scan all|none --include --exclude --yes --dry-run`. Read-only in scanned
folders; dedup by keyed content hash; secret report without values.
Transcripts are not imported raw. Note: Claude Code deletes transcripts after
`cleanupPeriodDays` (default 30).

## Hub

Node HTTP server (no framework), repository interface over SQLite in WAL mode,
per-request signature verification, rate limiting, size limits, nonce cache,
protocol negotiation (ADR-0003), admin CLI (`key`, `account`, `device`,
`backup`, `status`), daily backup with rotation, `/health`. TLS: built-in
self-signed + SPKI pin for IP mode, Caddy/existing proxy for domain mode
(ADR-0010).

## Performance budgets (to be measured in Etap 2)

| path | budget |
| --- | --- |
| SessionStart hook (Node cold start + snapshot) | < 300 ms |
| UserPromptSubmit hook | < 50 ms (async, returns immediately) |
| `search` at 10,000 entries | < 200 ms (index resident in the MCP process) |
| hub down | session unaffected; reads local; writes queued |

## Out of scope now (interfaces only)

Cloud mode implementation, team vaults, semantic search/reranker, web panel,
WireGuard mode, publishing.
