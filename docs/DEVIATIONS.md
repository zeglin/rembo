# Deviations from the kickoff brief (Etap 0)

Changes forced or suggested by research. Each links to its decision record.

| # | brief said | now | why | ADR |
| --- | --- | --- | --- | --- |
| 1 | Node >= 20 | client >= 22.12, hub >= 24.16 (or >= 26.1) | Node 20 EOL 2026-04-30; `node:sqlite` and `crypto.argon2` need newer Node | 0008 |
| 2 | libsodium (or age) | `node:crypto` + `@noble/ciphers` (XChaCha20-Poly1305) + `crypto.argon2`/`hash-wasm` + `@scure/bip39` | same primitives, byte-compatible, audited, ~20 KB instead of ~300 KB WASM; libsodium Argon2 only in "sumo" | 0005 |
| 3 | segment *inside* the user's status line | separate rembo line under the prompt via the mod (`$.ui.status`); status line wrapper only as opt-in fallback | plugins cannot ship or extend `statusLine`; the mod line never touches the user's | 0007 |
| 4 | `/rembo on|off` as a plugin command | bare `/rembo` via the mod (no model turn); fallback `/rembo:rembo` (one short turn) | plugin commands are namespaced and always run the model | 0007 |
| 5 | mods as a main building block | mods = optional UX layer; core = classic hooks + MCP | mods API is "EARLY ACCESS", inactive under `-p` and `disableAllHooks` | 0007 |
| 6 | MCP tools answer "off" themselves | a PreToolUse hook denies rembo tools in off sessions | MCP servers get no session id | 0007 |
| 7 | plugin installed from npm / package folder | `rembo setup` copies itself to `~/.rembo/app/<ver>` and registers a local marketplace (read in place) | one copy per machine, offline, lets setup bake the absolute Node path into hooks (GUI PATH issues on Windows) | 0001 |
| 8 | account key = registration secret | account key = Ed25519 seed; hub stores the public key; registration by signature | secret never on the wire, DB leak useless | 0002 |
| 9 | SPKI pin via custom verification | two-step: probe + pin check, then `ca: <cert>` + SPKI re-check; `node:https`, no undici | `checkServerIdentity` is never called with `rejectUnauthorized:false`; `cert.pubkey` is SPKI only for RSA | 0003 |
| 10 | Let's Encrypt for IP "if available" | available (160-hour certs) but optional; default IP mode = self-signed + pin | renewal every few days, pinning conflicts with key rotation | 0003, 0010 |
| 11 | snapshot ~2000 tokens | hard cap 8000 characters | Claude Code caps hook context at 10,000 chars (rest spilled to a file) | 0006 |
| 12 | sync at SessionEnd | SessionEnd only spawns a detached sync | SessionEnd hooks share a 1.5 s budget | 0004 |
| 13 | classifier "Jev via OpenRouter" | providers: none / heuristic / claude (mod `$.model.complete`) / jev (TypeSafe AI) / openrouter / openai-compatible | Jev is a TypeSafe AI model, not on OpenRouter; `claude` adds no new third party | 0009 |
| 14 | SQLite (implied native module) | built-in `node:sqlite` | no native build on the VPS | 0008 |
| 15 | decode project path from the folder name | read `cwd` from the first transcript lines | folder encoding is lossy (`D:\rembo` -> `D--rembo`) and undocumented | ARCHITECTURE |
| 16 | discovery reaches all past sessions | only ~30 days of transcripts exist by default | `cleanupPeriodDays` = 30 | ARCHITECTURE |
| 17 | install from `/plugin` + userConfig (POWINNO) | designed, deferred to Etap 6 | sensitive userConfig storage undocumented, not readable by the CLI; the recovery phrase must be shown outside the transcript (mod pane) | 0001 |
| 18 | "zero admin API on the network" + `rembo device list|revoke` | devices may list/revoke devices of their own account; hub administration stays CLI-only | cloud users need self-service revocation without SSH | 0002 |
