# Deviations from the kickoff brief

Changes forced by research or chosen in the first-principles review
(2026-10-20, maintainer-approved where marked ✔).

| # | brief said | now | why | ADR |
| --- | --- | --- | --- | --- |
| 1 | Node >= 20 | client >= 22.12, hub >= 24.16 | Node 20 EOL 2026-04-30; `node:sqlite` | 0008 |
| 2 | libsodium: XChaCha20, X25519, Argon2id | `node:crypto` only: AES-256-GCM, HKDF; no Argon2 | OpenSSL is a proven library; zero deps; AES-GCM also in WebCrypto; Argon2 only helps low-entropy secrets and the recovery key is 256 random bits | 0005 |
| 3 | recovery *phrase* | recovery *key* (`RK-` + base32 + checksum) | random key, no KDF; meant for a password manager | 0005 |
| 4 | device auth preferring signatures | bearer device tokens, hashed on the hub ✔ | E2E lowers the stakes; signatures add nonce/clock/proxy complexity | 0002 |
| 5 | L1 pages curated and edited by Claude | entries immutable; L0/L1 generated locally; project overview = `summary` entry ✔ | removes all merge/conflict machinery | 0004, 0006 |
| 6 | change log with `If-Match` / 409 / 3-way merge | append-only log, idempotent puts | follows from 5 | 0004 |
| 7 | classifier (Etap 5) | deferred; native auto-memory bridge + `remember` ✔ | Claude Code already decides what to remember; no text to third parties | 0006, 0009 |
| 8 | status segment inside the user's status line | mod's own line under the prompt (`$.ui.status`); no wrapper | plugins cannot ship or extend `statusLine` | 0007 |
| 9 | `/rembo on|off` as a plugin command | bare `/rembo` from the mod, no model turn; without mods `REMBO=off claude` | plugin commands are namespaced and always run the model | 0007 |
| 10 | mods as a building block | core = MCP + 2 hooks; mod = UX layer with version guard | mods API is early access, inactive under `-p` / `disableAllHooks` | 0012 |
| 11 | skill with rules | rules folded into the snapshot and MCP `instructions` | fewer moving parts | 0012 |
| 12 | MiniSearch index | in-memory scoring in the MCP process behind `SearchBackend` | thousands of small files fit in memory | 0006 |
| 13 | discovery crawls disks from roots | projects Claude Code knows + their instruction files; `--roots` optional | those are the folders "with Claude Code work" by definition; lossy folder names decoded via transcript `cwd` | ARCHITECTURE |
| 14 | plugin from npm / package folder | setup copies itself to `~/.rembo/app/<ver>` + local marketplace, absolute Node path | one copy per machine; GUI PATH issues on Windows | 0001 |
| 15 | SPKI pin via custom verification | probe + pin, then `ca: <cert>` + SPKI re-check, `node:https` | Node's `checkServerIdentity` is not called for unverified chains | 0003 |
| 16 | LE for IP "if available" | available (160-hour certs), optional; default IP mode = self-signed + pin | renewal every few days | 0003 |
| 17 | snapshot ~2000 tokens | hard cap 8000 characters | Claude Code caps hook context at 10,000 chars | 0006 |
| 18 | sync at SessionEnd | SessionEnd spawns a detached sync | 1.5 s budget | 0004 |
| 19 | SQLite (native module implied) | built-in `node:sqlite` | no native build on the VPS | 0008 |
| 20 | install from `/plugin` + userConfig | deferred to Etap 6 | secret storage undocumented; recovery key must not enter the transcript | 0001 |
| 21 | no network admin API + `rembo device list|revoke` | devices may manage their own account's devices; admin stays CLI-only | cloud users need self-service revocation | 0002 |
| 22 | discovery of all past sessions | ~30 days of transcripts exist by default | `cleanupPeriodDays` = 30 | ARCHITECTURE |
| 23 | mod disables itself outside the exact tested version range | active for 2.1.287 <= version < 2.2.0; any error in the module disables it | Claude Code ships several releases a week; an exact range would turn `/rembo` off after every update | 0007 |
| 24 | per-session off enforced for all rembo tools | the MCP server enforces only `REMBO=off`; the default `rembo off` and `/rembo off` are enforced by the hook (no snapshot) and the mod (tool calls denied) | the MCP server has no session id; enforcing the default there would make `/rembo on` impossible | 0007 |
| 25 | `rembo update` = `npx rembo@latest setup --upgrade` | until rembo is on npm, `rembo update` reinstalls the plugin from the running package | nothing published yet | 0001 |
