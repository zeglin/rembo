# Progress

## 2026-10-20 — Etap 0 (research and design) — revised, awaiting approval

Done:
- Repo initialised (`main`), `.gitignore` verified, MIT LICENSE, README stub,
  CLAUDE.md.
- Platform research 4a–4m: `docs/research/platform.md`.
- `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md`, `docs/DEVIATIONS.md`,
  ADR-0001…0012.
- First-principles review, maintainer decisions: bearer device tokens;
  native auto-memory bridge instead of a classifier (Etap 5 dropped);
  immutable entries with locally generated L0/L1 (append-only sync).

Next (after approval): Etap 1 — monorepo scaffold (npm workspaces, TS strict,
ESM, vitest, esbuild, `.gitattributes` for LF), `packages/core` (entries,
views, envelope crypto, outbox, log sync, secret guard, search, bridge),
`packages/server` (node:sqlite log, API v1, tokens, limits, admin CLI),
client CLI without the plugin (setup, remember, search, sync, status,
doctor). DoD per brief §9 (3 clients × 1000 parallel ops; no plaintext in the
hub DB; account isolation).

Open questions:
1. Upgrade Node on this machine (20.15.1, EOL) to 24 LTS before Etap 2?
2. LICENSE holder line: "The rembo authors" — or a specific name?

Experiments planned for Etap 2:
- detached child from a hook: does Claude Code wait for it (Windows)?
- can one plugin `hooks/hooks.json` hold both classic hooks and `modules`?
- MCP `instructions` size limit in Claude Code.
- does `CLAUDE_CONFIG_DIR` relocate `~/.claude.json`?
