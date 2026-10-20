# rembo architecture

Status: draft for review (Etap 0, revised after a first-principles review),
2026-10-20. Decisions: `docs/decisions/`; platform facts:
`docs/research/platform.md`.

## Goal

Every Claude Code session on every machine of a user knows what earlier
sessions established, without the user's involvement, while the hub
(self-hosted or rembo cloud) cannot read the memory.

## Design in five lines

1. **Store**: immutable encrypted entries in an append-only log per vault on
   the hub; full plaintext copy on every device (ADR-0004, 0005, 0006).
2. **Deliver**: a SessionStart hook injects a bounded snapshot from the local
   copy; MCP tools search and read the rest (ADR-0006, 0012).
3. **Capture**: Claude Code's native auto memory is bridged automatically;
   the `remember` tool covers cross-project facts (ADR-0006).
4. **Protect**: AES-256-GCM via `node:crypto`, vault key known only to
   devices, recovery key never leaves the user (ADR-0005); device tokens
   hashed on the hub (ADR-0002).
5. **Install**: `npx rembo@latest setup <key>`; hub via
   `npx rembo-server@latest init` (ADR-0001, 0010).

## Components

```
packages/
  core/     entries + views, envelope crypto, sync (outbox, log pull),
            native-memory bridge, secret guard, search, API types
  rembo/    npm package `rembo`: CLI + Claude Code plugin (2 hooks, MCP
            server, mod), bundled with esbuild, no native modules
  server/   npm package `rembo-server`: HTTP API, append-only log on
            node:sqlite, selfhost|cloud modes, admin CLI, installer, Dockerfile
```

TypeScript strict, ESM, npm workspaces, vitest. Client Node >= 22.12, hub
Node >= 24.16 (ADR-0008).

```
 machine A                    machine B                      hub
 ┌───────────────────┐       ┌───────────────────┐       ┌──────────────────┐
 │ Claude Code       │       │ Claude Code       │ HTTPS │ rembo-server     │
 │  hooks · MCP · mod│       │  hooks · MCP · mod│◄─────►│ append-only log  │
 │ ~/.rembo (plain)  │       │ ~/.rembo (plain)  │       │ ciphertext only  │
 └───────────────────┘       └───────────────────┘       └──────────────────┘
```

## Client layout (`~/.rembo/`)

```
config.json         hub URL, cert pin, device token (0600), defaults
app/<version>/      installed runtime: dist/*.js + plugin/ (ADR-0001)
marketplace/        local Claude Code marketplace -> app/<version>
vaults/<id>/        key (0600), md/ (entries + generated views),
                    state.json (cursor), outbox/, lock/
bridge.json         native-memory files already imported (path -> hash, entry id)
status.json         last sync result (status line, doctor)
logs/  backup/
```

## Plugin (ADR-0012 layers)

| piece | API stability | job |
| --- | --- | --- |
| MCP server `rembo` | open standard | `search`, `read`, `list`, `remember`, `forget`; push after writes, pull every 60 s and before stale searches; `instructions` with usage rules |
| SessionStart hook | documented | snapshot (≤ 8000 chars) from local copy, spawn detached sync |
| SessionEnd hook | documented | spawn detached sync (1.5 s budget) |
| mod | early access | `/rembo …` without model turns, "Rembo Mode On/Off" line, toasts, off enforcement; version-guarded |

## Flows

- **Setup**: check Node, Claude Code, hub, protocol -> register device ->
  first device: create vault key + recovery key, upload keyring; next device:
  ask for recovery key, unwrap keyring -> install app + marketplace + plugin
  -> discovery/import -> write/sync/read self-test -> summary.
- **Session start**: resolve project from `cwd`, emit the wrapped snapshot,
  spawn `rembo sync`. No network on this path.
- **Recall**: `search` -> quick pull if stale -> in-memory scoring -> hits
  with id, path, device, date -> `read`.
- **Store**: `remember` -> secret guard -> new entry -> local file + outbox ->
  push.
- **Sync**: push outbox, pull log since cursor, apply, run the native-memory
  bridge, regenerate views.
- **Discovery** (setup and `rembo scan`): projects Claude Code knows
  (`~/.claude/projects/*`, real path from the transcripts' `cwd` because
  folder names are lossy) -> their `CLAUDE.md`, `.claude/CLAUDE.md`,
  `CLAUDE.local.md`, `.claude/rules/*.md`, `AGENTS.md`, plus native
  `memory/*.md` and `~/.claude/CLAUDE.md`. Text picker (Enter / space / a /
  n / filter), non-interactive flags. Extra roots only with `--roots`.
  Read-only; dedup by keyed content hash; secret report without values.

## Hub

Node HTTP server, `node:sqlite` (WAL) behind a repository interface, bearer
device tokens, rate limits, size limits, protocol negotiation, admin CLI,
daily backups, `/health`. TLS: self-signed + pin in IP mode, Caddy or the
existing proxy in domain mode (ADR-0003, 0010).

## Performance budgets (measured in Etap 2)

SessionStart < 300 ms · `search` < 200 ms at 10,000 entries · hub down: no
effect on the session, writes queued.

## Not in this round

Cloud implementation (ADR-0011 design only), classifier (ADR-0009 deferred),
team vaults, semantic search, web panel, other MCP clients, device linking,
vault rotation (Etap 6).
