# ADR-0008: Runtime

- Status: proposed
- Date: 2026-10-20

## Context

The prompt assumed Node >= 20. Node 20 reached end of life on 2026-04-30.
Today Node 22 is Maintenance LTS (to 2027-04-30), Node 24 enters Maintenance
today (to 2028-04-30), Node 26 becomes Active LTS on 2026-10-28. Claude Code's
native installer does not provide Node to hooks or MCP servers; the npm
install of Claude Code itself requires Node >= 22.

## Decision

- **Client (`rembo`)**: `engines.node >= 22.12`. Hooks, MCP server and CLI are
  plain Node scripts. `rembo setup` checks the version and prints the exact
  upgrade step for the OS (winget / nvm / NodeSource). The absolute Node path
  is baked into the plugin's hook and MCP commands at setup (ADR-0001), so a
  different PATH in GUI-launched Claude Code does not matter. Node >= 24.7
  gives native Argon2 (ADR-0005), otherwise the WASM fallback is used.
- **Hub (`rembo-server`)**: `>= 24.16 < 25 || >= 26.1`, SQLite through the
  built-in `node:sqlite` (Release Candidate stability in 24.15+, synchronous
  API, WAL via pragma, bundled SQLite >= 3.53 with the 2026 WAL-reset fix;
  24.16/26.1 also fix a TEXT-truncation bug). No native modules on the hub
  either. Repository layer isolates it (Postgres in cloud).
- CI matrix: client on Node 22 / 24 / 26 × Windows / Linux / macOS; hub on
  24 / 26 × Linux.
- Mods: no Node there (isolated environment); the mod calls the CLI with
  `$.process.run` (ADR-0007).

## Consequences

- This development machine has Node 20.15.1 (EOL): it needs an upgrade before
  Etap 2 (not touched without approval).
- Users of Claude Code's native installer may not have Node; `npx` needs it
  anyway, so the requirement is explicit in the quickstart. A standalone
  binary (Node single-executable application) is a possible later option for
  Node-less machines, not in this phase.
