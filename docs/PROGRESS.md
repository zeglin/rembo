# Progress

## 2026-10-20 — Etap 1 (core + hub + CLI) — done

Built (TypeScript strict, ESM, zero runtime dependencies):

- `packages/core`: envelope crypto (AES-256-GCM via `node:crypto`, AAD =
  vault + object id, 512-byte padding, plaintext envelopes refused in
  encrypted vaults), keyring + recovery key (`RK-…`, checksum), account key
  (`rmb1_…`, hub URL + optional SPKI pin, checksum) and device tokens, entry
  model (markdown + JSON-valued frontmatter), L0/L1 views, secret guard,
  in-memory search (Polish diacritics folded), project identity from git
  remote, atomic writes + mkdir lock, local vault + outbox, hub client
  (`node:https`, SPKI pinning with first-contact probe), `RemboClient`
  (setup, remember, forget, sync, search, devices, hub set-url).
- `packages/server` (`rembo-server`): `node:sqlite` append-only log
  (idempotent puts, tombstones erase ciphertext), HTTP API v1 with protocol
  headers, bearer device tokens (hashes only), per-IP lockout, per-device
  token bucket, size limits, account scoping on every query; self-signed
  P-256 certificate generator (pure DER + OpenSSL signing); admin CLI
  (`serve`, `tls create`, `key create|list|revoke`, `account`, `device`,
  `status`, `backup`).
- `packages/rembo` (`rembo`): CLI `setup`, `remember`, `search`, `read`,
  `list`, `forget`, `sync`, `status`, `doctor`, `device list|revoke`,
  `hub set-url`, `--json` everywhere.
- Build: `npm run build` (esbuild single-file bundles: client 22.12+, hub
  24.16+). Tests: `npm test` (vitest), `npm run typecheck`.

DoD evidence (`npm test`, 47 tests, ~21 s):
- 3 clients, 1000 parallel operations (≈800 writes, ≈200 forgets) with
  interleaved syncs → identical entry sets and INDEX.md on all clients, every
  expected entry present, every forgotten one absent, empty outboxes.
- Hub database files (incl. WAL) contain none of the marker phrases; a
  positive control (device name, stored in clear) proves the scan reads them.
- Account isolation: another account's vault, keyring, objects and devices
  answer 404; listings show only own resources.
- Also: success criterion 2 (fact from A found on C with source), offline
  queue, secret refusal, device revocation, auth lockout, TLS pin match /
  mismatch, 10k-entry search < 200 ms, real CLI end to end; manual smoke test
  of the bundled CLIs on Windows.

Environment changes (approved): system Node upgraded 20.15.1 → 24.20.0 via
winget (`OpenJS.NodeJS.LTS`). Dev dependencies: typescript 7, vitest 5 +
vite, esbuild, @types/node. npm's install-scripts policy blocked esbuild's
postinstall; not needed (platform binary comes from optionalDependencies).

Deferred on purpose:
- Native auto-memory bridge → Etap 4 (shares scanning code with discovery).
- `rembo update`, `rembo uninstall`, plugin install → Etap 2.
- `rembo-server init` (installer, systemd, Caddy) → Etap 3.
- Vault rotation, device link → Etap 6.

## Next: Etap 2 — Claude Code plugin + one-command install

1. Plugin folder in `packages/rembo/plugin/`: manifest, `hooks/hooks.json`
   (SessionStart: snapshot ≤ 8000 chars + detached sync; SessionEnd: detached
   sync), `.mcp.json` (stdio server: search, read, list, remember, forget,
   with `instructions`), mod module (`/rembo`, `$.ui.status`, toasts, off
   enforcement, version guard).
2. `rembo setup` installs the app into `~/.rembo/app/<ver>`, renders hooks
   and MCP config with the absolute Node path, registers the local
   marketplace and installs the plugin (user scope); `rembo uninstall`,
   `rembo update`.
3. Experiments first: detached child from a hook on Windows; classic hooks +
   `modules` in one hooks.json; MCP `instructions` size limit; whether
   `CLAUDE_CONFIG_DIR` relocates `~/.claude.json`.
4. e2e with an isolated `CLAUDE_CONFIG_DIR` (`claude -p`), timing budgets.

Open questions: none blocking.
