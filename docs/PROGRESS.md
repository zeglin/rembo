# Progress

## 2026-10-20 — Etap 0 (research and design) — done, awaiting approval

Done:
- Repo initialised (`main`), `.gitignore` verified (private files ignored),
  MIT LICENSE, README stub, CLAUDE.md.
- Platform research 4a–4m: `docs/research/platform.md` (Claude Code 2.1.304,
  docs, local CLI, mods declaration file, web sources dated).
- `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md`, `docs/DEVIATIONS.md`.
- ADRs 0001–0011 in `docs/decisions/` (status: proposed).

Next (after approval): Etap 1 — monorepo scaffold (npm workspaces, TS strict,
ESM, vitest, esbuild), `packages/core` (envelope + crypto with test vectors,
object model, outbox, sync engine, secret guard, MiniSearch backend),
`packages/server` (node:sqlite repository, API v1, signatures, nonce cache,
limits, admin CLI), client CLI without the plugin (setup, remember, search,
sync, status, doctor). DoD per brief §9.

Open questions for the maintainer:
1. Upgrade Node on this machine (20.15.1, EOL) to 24 LTS before Etap 2? Etap 1
   tests can run on 20 only partially (`@noble/ciphers` v2 needs >= 20.19).
2. Accept the mod (early-access API) as the UX layer for `/rembo` and the
   status line, with the core on stable hooks + MCP?
3. Classifier default when enabled: `claude` (session's own client, no new
   third party) — OK?
4. LICENSE holder line: "The rembo authors" — or a specific name?

Experiments planned for Etap 2 (uncertain items in research):
- detached child from a hook: does Claude Code wait for it (Windows)?
- bare `/rembo` resolution for a plugin skill named like the plugin.
- does `CLAUDE_CONFIG_DIR` relocate `~/.claude.json`?
- where sensitive `userConfig` values are stored per OS.
