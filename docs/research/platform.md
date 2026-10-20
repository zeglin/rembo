# Platform research (Etap 0)

Verified 2026-10-20 against Claude Code **2.1.304** (native installer,
Windows 11), official docs at code.claude.com, the local CLI (`claude plugin
--help` and subcommands), and the mods API declaration file the engine ships
(`types/claude-code.d.ts`, "EARLY ACCESS"). Verdicts: **confirmed**,
**wrong** (the prompt's assumption does not hold), **uncertain** (with the
experiment that settles it). Items marked *(local)* were observed on this
machine, not documented.

## a) Plugins

| claim | verdict | facts | source | consequence |
| --- | --- | --- | --- | --- |
| Structure / manifest | confirmed | `.claude-plugin/plugin.json` (only `name` required; also `version`, `userConfig`, `hooks`, `mcpServers`, `skills`, `commands`, `types`, `dependencies`, `settings`...). Default dirs `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/` (added to the Bash tool PATH), `settings.json` (only `agent`, `subagentStatusLine` honoured) | code.claude.com/docs/en/plugins/manifest-reference | plugin layout in ADR-0001 |
| User scope works in all projects | confirmed | `--scope user` -> `enabledPlugins["rembo@rembo"]` in `~/.claude/settings.json`; install record `~/.claude/plugins/installed_plugins.json` | plugins/install, plugins/loading | install once per machine |
| Non-interactive install | confirmed | `claude plugin marketplace add <path\|owner/repo\|git url\|url> --scope user --json`; `claude plugin install <p>@<mkt> --scope user --json [--config K=V]`; `enable/disable/uninstall [--keep-data]/update`; `configure <p> --values-stdin` *(local help)* | plugins/cli-reference | `rembo setup` drives the CLI, no settings surgery |
| Marketplace from a local path | confirmed | directory marketplace + relative plugin source is **read in place** (no cache copy); `/reload-plugins` re-reads | plugins/loading; mods reference.md | ADR-0001 app dir + local marketplace |
| Plugin source = npm package | confirmed | marketplace entry `source: {source: "npm", package, version, registry}`; copied into `~/.claude/plugins/cache/<mkt>/<plugin>/<version>/`. CLI: `claude plugin install <pkg>@npm [--registry]` *(local help)* | plugins/marketplace-reference | used later for the public marketplace (install from inside Claude Code) |
| Marketplace source = npm | **wrong** | "NPM marketplace sources not yet implemented" | plugins/marketplace-reference | — |
| Folder inside a global npm package | confirmed (works) | can be added as a directory marketplace and is read in place | plugins/loading | rejected anyway: npx cache is ephemeral; global install optional |
| Version pinning | confirmed | `version` in plugin.json wins; `ref`/`sha` for git sources | plugins/marketplace-reference | exact version per app dir |
| Auto-updates | confirmed | off by default for third-party marketplaces; `autoUpdate` on `extraKnownMarketplaces`; checked ~10 min after first message | plugins/loading | `rembo update` is explicit |
| Reserved prefixes | confirmed | plugin names `claude-*`, `anthropic-*`, `anthropics-*`, `cc-plugin-*` and some exact names are rejected; `rembo` is free | plugins/manifest-reference#reserved-names | none |
| npm install on plugin install | confirmed (conditional) | runs only if plugin root has `package.json` **and** a lockfile; no lifecycle scripts; 60 s timeout | plugins/loading#node-js-package-dependencies | ship bundled single files, no package.json in plugin dir |

## b) userConfig

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Schema | confirmed | `type` string/number/boolean/directory/file, `title`, `description`, `required`, `default`, `options`, `multiple`, `sensitive`, `min`/`max` | — |
| Where sensitive values live | **uncertain** | "the platform's secure credential store"; per-OS location not documented (Claude's own login creds: macOS Keychain, Windows/Linux `~/.claude/.credentials.json`). Experiment: test plugin with a sensitive field, inspect `.credentials.json` and `cmdkey /list` | do not depend on it |
| How values reach components | confirmed | hooks: env `CLAUDE_PLUGIN_OPTION_<KEY>`; exec-form `args` and MCP `command/args/env`: `${user_config.KEY}` substitution; MCP process itself gets only `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`; skills: non-sensitive only | usable for a future "install from /plugin" flow |
| Non-interactive set | confirmed | `claude plugin install ... --config K=V`; `claude plugin configure <p> --values-stdin` (JSON) | — |
| External CLI can read them | **uncertain / assume no** | undocumented | rembo keeps its own store in `~/.rembo` (0600). On Windows the profile ACL is user-only by default; DPAPI would need native code or PowerShell, deferred |

## c) Hooks

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Events | confirmed (+ more) | SessionStart (matchers `startup`, `resume`, `clear`, `compact`, **`fork`**), UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SessionEnd, PreCompact, PostCompact, CwdChanged, ... | handle `fork`/`resume` like startup |
| Input | confirmed | common: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; SessionStart adds `source`; UserPromptSubmit `prompt`; Stop `stop_hook_active`, `last_assistant_message` (no `reason`); SessionEnd `reason` | classifier can use `last_assistant_message` without reading the transcript |
| Context size limit | confirmed | stdout / `additionalContext` capped at **10,000 characters**; overflow saved to a file, model gets path + 2,000-char preview; same for UserPromptSubmit | snapshot budget 8,000 chars hard cap |
| Timeouts | confirmed | command hooks default 600 s; UserPromptSubmit 30 s; **SessionEnd shared 1.5 s budget**; failing hooks don't break the session; exit 2 blocks only where blocking applies | SessionEnd only spawns a detached sync |
| Windows shell | confirmed | `shell: "bash"` (Git Bash) or `"powershell"`; PowerShell when Git Bash is absent. **Exec form** `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.js"]` runs without a shell; `command` must be a real .exe | exec form + absolute Node path (ADR-0001) |
| Background work | confirmed / uncertain | `"async": true` runs a command hook in the background; whether a hook's detached child keeps it alive is uncertain -> experiment: spawn `detached`, `stdio: 'ignore'`, `unref()`, time the return on Windows | Etap 2 measurement |
| Hook types | confirmed | command, http, mcp_tool, prompt, agent | — |
| Session id for MCP servers | **wrong** | no documented `CLAUDE_SESSION_ID`; mods have `$.session.id()` | per-session mode enforced by a PreToolUse hook (ADR-0007) |

## d) Mods

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Exist, TypeScript, shipped in plugins, on by default | confirmed | plugin whose `hooks/hooks.json` has `modules: ["./register.ts"]`; on by default since **2.1.287** (CLI), 2.1.286 (Desktop); declaration file header: "EARLY ACCESS: this surface may change between releases without notice" | UX layer only (ADR-0007) |
| Runtime | confirmed | isolated environment: no Node, no DOM; `crypto.subtle`, `TextEncoder`, `URL`; everything else via `$`: `$.fs`, `$.process.run/spawn` (argv, no shell, CLI only), `$.http.fetch` (through the host; no custom TLS trust), `$.store` (4 MiB JSON, cross-session), `$.state` (session) | mod calls the CLI; no crypto/sync in the mod |
| Status bar segment | confirmed (different shape) | `$.ui.status(text)`: "pins text as this plugin's status line under the prompt, beside the engine's own pinned notices", one per plugin; does not touch the user's `statusLine` | requirement 5.3 met without a wrapper |
| Model-free slash commands | confirmed | `$.command.register({name, description, argumentHint, immediate})` -> bare `/name`; `command.run` hook answering `{text}` runs no turn (the text row is visible to the model later); built-in names refused; not invoked under `claude -p` | exact `/rembo on|off` |
| Toasts | confirmed | `$.ui.toast(text, {timeoutMs})` | "Remembered: ..." |
| Prompt rewriting / system prompt | confirmed | `prompt.submit` (`next({...e, text})`), `prompt.compose` (append a `session` section), `prompt.context` | possible later injection path; SessionStart stays primary |
| Model calls | confirmed | `$.model.complete({model, prompt})` on the session's own client | classifier provider `claude` (ADR-0009) |
| Disabled by | confirmed | `disableAllHooks`, `--safe-mode`, organization policy | core must not depend on the mod |

## e) Status line

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Plugin can add a segment to `statusLine` | **wrong** | plugins cannot ship `statusLine` | mod `$.ui.status` (separate line) is the primary route |
| Wrapper fallback | confirmed feasible | `statusLine: {type: "command", command, padding, refreshInterval}`; stdin JSON with `session_id`, `cwd`, `model`, `workspace`...; multi-line output allowed; runs Git Bash or PowerShell on Windows; `/statusline` may overwrite it; `disableAllHooks` hides custom status lines too | opt-in `rembo statusline install` |

## f) Slash commands from plugins

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Exactly `/rembo on|off` | confirmed via mods only | plugin skills/commands are `/<plugin>:<name>`; bare `/name` only "unless another command uses that name" (uncertain for plugin == skill name; test in Etap 2); mod commands are bare | mod command; skill fallback `/rembo:rembo` |
| Arguments | confirmed | skills: `$ARGUMENTS`, `$0..`, `argument-hint`; mods: `e.args` | — |
| Zero-token | confirmed for mods only | `disable-model-invocation` only blocks auto-invocation; `` !`cmd` `` still runs a turn | — |

## g) MCP in a plugin

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| stdio server, variables | confirmed | `.mcp.json` or `mcpServers`; `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (= `~/.claude/plugins/data/<id>/`, deleted on uninstall unless `--keep-data`), `${CLAUDE_PROJECT_DIR}` | rembo data stays in `~/.rembo`, not plugin data |
| Install runs npm install | **wrong as general claim** | only with package.json + lockfile | bundle |
| Tool names | confirmed | `mcp__plugin_rembo_rembo__search` for plugin `rembo`, server `rembo`; mod tools would be `mcp__rembo__x` | PreToolUse matcher `mcp__plugin_rembo_.*` |

## h) Runtime

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| Node available with native installer | **wrong** | native `claude.exe` is self-contained (~290 MB *(local)*); Node is not provided to hooks/MCP; the npm-installed Claude Code requires Node >= 22 | rembo requires Node on the machine (ADR-0008); setup checks it |
| Node on this machine | *(local)* | Node **20.15.1**, npm 10.7.0 | upgrade needed before Etap 2 (ADR-0008) |

## i) Test isolation

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | confirmed | "all settings, session history, and plugins are stored under this path"; whether `~/.claude.json` relocates is **uncertain** (experiment in Etap 2) | e2e tests run with a temp `CLAUDE_CONFIG_DIR` + `HOME`/`USERPROFILE` override |
| Session-only plugin loading | confirmed | `claude --plugin-dir <dir>`, `CLAUDE_CODE_PLUGIN_DIRS`; `claude plugin validate --strict`; `claude plugin test <dir>` for mods | CI checks |

## j) Local data to scan

| claim | verdict | facts | consequence |
| --- | --- | --- | --- |
| `~/.claude/projects/<encoded>/` | confirmed + *(local)* | `D:\rembo` -> `D--rembo` (`:` and `\` both `-`: **lossy**, undocumented); contains `<session>.jsonl`, `<session>/`, `memory/` | decode the real path from the `cwd` field of the first transcript lines *(local: present)* |
| Auto memory | confirmed | `memory/MEMORY.md` + topic files; first 200 lines / 25 KB loaded; settings `autoMemoryEnabled`, `autoMemoryDirectory`; machine-local | import `memory/*.md` |
| Instruction files | confirmed | `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md`, `@imports`, `AGENTS.md` | discovery signals |
| Transcript retention | confirmed | `cleanupPeriodDays` default 30 | discovery sees ~30 days of sessions |

## k) Classifier ("Jev", "Treg", OpenRouter)

| claim | verdict | facts | source | consequence |
| --- | --- | --- | --- | --- |
| "Jev" | confirmed (real name) | video title "Claude Code Mods: Build a Jev Memory Harness". Jev = hosted "System One" decision model by TypeSafe AI (`POST api.typesafe.ai/v1/systemone`; yes/no -> P(yes), choice, score); $0.042 / M input tokens, outputs free; ~100 ms typical; SDK `@typesafe-ai/sdk`. Not offered through OpenRouter. A Claude Code plugin using it exists: `jevmem` (MIT, 2026-09) | typesafe.ai (2026-10-19); promptfoo.dev/docs/providers/typesafe (2026-10-19); github.com/Avinash-jetwani/jevmem | `jev` provider option, BYOK (ADR-0009) |
| "Treg" | uncertain | no tool of that name found in TypeSafe docs, SDKs or articles | — | ignored |
| OpenRouter logprobs / structured output | confirmed | per provider endpoint (153/470 models list `logprobs` on 2026-10-20); Anthropic, Gemini, GPT-5.x and Groq endpoints show none; `response_format: json_schema` per endpoint; use `provider.require_parameters: true` | openrouter.ai/docs (routing, structured outputs); live `/api/v1/models` | `openrouter` provider uses json_schema or a 1-token label + logprobs |
| Cost | confirmed | per 1000 calls at 600 in / 60 out: mistral-nemo ~$0.020, gpt-oss-20b ~$0.02 (+reasoning), gemma-3-27b ~$0.07, qwen3-30b-instruct ~$0.07, gpt-4o-mini ~$0.13; Jev ~$0.025 | OpenRouter API 2026-10-20 | negligible; prefer non-reasoning models for logprobs |
| Mods `$.model.complete` | confirmed | one completion on the session's own client, `ModelCompleteResult` | mods API declaration file | `claude` provider: no extra key, no new third party |

## l) TLS

| claim | verdict | facts | source | consequence |
| --- | --- | --- | --- | --- |
| Let's Encrypt for domains | confirmed | standard | — | domain mode via Caddy or existing proxy |
| Let's Encrypt for IP addresses | confirmed | GA 2026-01-15; only the `shortlived` profile (160 h); http-01 / tls-alpn-01 only; IPv4 + IPv6; 50 certs / 7 days per IP | letsencrypt.org/2026/01/15/6day-and-ip-general-availability; letsencrypt.org/docs/rate-limits (2026-08-05) | optional for IP mode, not default (renewal every few days) |
| Caddy support | confirmed | ACME profiles since 2.10.0; IP certs work on 2.11.4+ with `issuer acme { profile shortlived }` and `default_sni <ip>`; IP defaults to Caddy's internal CA otherwise; `reuse_private_keys` exists | caddyserver.com/docs/automatic-https; github.com/caddyserver/caddy/issues/7399 | Caddy for domain mode |
| Self-signed + SPKI pin in Node | confirmed (with corrections) | `rejectUnauthorized:false` + `checkServerIdentity` does **not** pin (callback only runs after successful chain verification); `cert.pubkey` is SPKI only for RSA -> compute from `cert.raw` via `X509Certificate`; correct: `ca: <pinned PEM>` + `checkServerIdentity` re-checking the SPKI | nodejs.org/api/tls.html; Node source `lib/internal/tls/wrap.js`, `src/crypto/crypto_x509.cc` | ADR-0003 two-step procedure, `node:https` only |
| undici Agent | caution | npm `undici` needed for a dispatcher; advisory GHSA-2m5v-pch6-74hx (2026-10-15): `tls.checkServerIdentity` dropped; fixed 6.29.1 / 7.30.1 / 8.12.2 | osv.dev/vulnerability/GHSA-2m5v-pch6-74hx | not used |
| Existing nginx / Traefik | confirmed gotchas | nginx `proxy_pass` with a URI part normalizes/rewrites the path (breaks path signatures); Host rewritten by default; Traefik 3.6.4–3.6.6 rejected encoded slashes | nginx.org proxy module docs; doc.traefik.io migrate v3 | sign path only, never Host; documented snippets |

## m) Device authentication

| option | secret on the wire | DB leak usable | behind TLS-terminating proxy | complexity |
| --- | --- | --- | --- | --- |
| bearer token (hash stored) | yes (every request; visible to proxies/logs) | no | works | trivial |
| **Ed25519 per-request signature** | **no** | **no (public keys only)** | **works** | moderate |
| mTLS | no | no | breaks unless the proxy verifies and forwards the cert | high |

Ed25519 in Node: `crypto.sign(null, data, key)` since v12 (confirmed in Node
20–26 docs); raw public keys import via JWK `{kty:'OKP', crv:'Ed25519', x}`.
Prior art: RFC 9421 HTTP Message Signatures (Cloudflare Web Bot Auth uses it
with Ed25519 + nonce), RFC 9530 Content-Digest, DPoP (RFC 9449). Decision:
custom minimal scheme with RFC 9421 semantics (ADR-0002, ADR-0003).

## Crypto libraries and runtime (supporting research)

- Node built-ins: Ed25519, X25519, HKDF, IETF ChaCha20-Poly1305 (no
  XChaCha20). `crypto.argon2` since **v24.7.0** (not in Node 22; needs
  OpenSSL >= 3.2).
- `@noble/ciphers` 2.4.0: XChaCha20-Poly1305, Cure53-audited (v1.0.0, 2024),
  ESM, Node >= 20.19. `@noble/hashes` argon2id: not audited, slow in JS.
  `hash-wasm` 4.12.0: argon2id WASM, ~11 KB, last release 2024-11, not
  audited. `libsodium-wrappers` 0.8.4: ~290 KB, Argon2 only in "sumo".
- Node: 20 EOL 2026-04-30; 22 Maintenance to 2027-04-30; 24 Maintenance from
  2026-10-20; 26 Active LTS from 2026-10-28 (github.com/nodejs/Release).
- `node:sqlite`: no flag since 22.13; Release Candidate in 24.15+; WAL via
  pragma; fixes for a TEXT truncation bug in 24.16 / 26.1.
