# ADR-0007: Session mode, `/rembo` command and status line

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md §c, §d, §e, §f

## Context

Required: `/rembo on|off` per session, "Rembo Mode On/Off" shown in addition
to (not instead of) the user's status line, ideally zero-token commands.

Verified facts (2.1.304):

- Plugin commands/skills always run a model turn and are namespaced
  (`/rembo:x`). A plugin cannot ship `statusLine`.
- **Mods** (hooks modules in plugins, on by default since 2.1.287 CLI) can:
  `$.command.register({ name: "rembo", argumentHint, immediate })` giving a
  bare `/rembo` answered by a `command.run` hook with no model turn;
  `$.ui.status(text)` pinning one line per plugin under the prompt, beside the
  engine's notices; `$.ui.toast`; `$.process.run(argv)`; `$.fs`; `$.store`.
- Mods are **early access** ("may change between releases without notice"),
  not active under `claude -p`, and disabled by `disableAllHooks`.
- Classic hooks are stable. PreToolUse receives `session_id` on stdin; MCP
  servers get no documented session id.

## Decision

**Two layers. The core never depends on the mod.**

1. **Core (stable APIs):** classic hooks + MCP server + skill.
   - Session mode is stored in `~/.rembo/sessions/<session_id>.json`
     (default from config, `REMBO=off claude` starts a session off).
   - SessionStart: injects the snapshot only if mode is on.
   - PreToolUse with matcher `mcp__plugin_rembo_.*`: if the session is off,
     deny with "rembo is off in this session". This is how the MCP server's
     tools respect a per-session mode without knowing the session id.
   - UserPromptSubmit / Stop (classifier inbox, ADR-0009) return immediately
     when off.
2. **UX layer (mod, optional):**
   - `/rembo on|off|status|sync|search <q>|forget <id>` registered as a bare
     command, `immediate: true`, answered locally: writes the session file,
     or runs `node <app>/dist/cli.js <cmd> --json` via `$.process.run` and
     prints the result. No model turn.
   - `$.ui.status("Rembo Mode On · ✓")` / `"Rembo Mode Off"`, with sync
     indicator (`✓`, `↑2` pending, `offline`), refreshed from
     `~/.rembo/status.json` on session start, after commands, on a 30 s timer.
   - Toast when the classifier or a tool stores a memory ("Remembered: ...
     /rembo forget <id>").
   - The mod contains no crypto and no network code: everything goes through
     the CLI (the host's `$.http.fetch` cannot do SPKI pinning anyway).

**Fallback when the mod is not active** (older Claude Code, `-p`, policy):
the skill `rembo` (`/rembo:rembo off`, costs a short model turn that runs the
CLI) and an opt-in status line wrapper: `rembo statusline install` saves the
user's current `statusLine` and sets `node <app>/dist/statusline.js`, which
runs the saved command with the same stdin and appends the segment;
`rembo statusline uninstall` (and `rembo uninstall`) restore it. If the user
has no status line, rembo's own is used. Never installed silently.

**What "off" means (documented):** nothing more is injected, nothing is
stored or classified, rembo tools refuse. What was injected at session start
stays in the context window until `/clear` or compaction.

## Consequences

- `/rembo off` is exact and free with the mod, and still available (namespaced,
  one short turn) without it.
- The mod API may break on a Claude Code update; it is isolated, small, and
  guarded by a version check (`$.session.version()`), with the core
  unaffected. `claude plugin validate` and `claude plugin test` run in CI.
- Mods run unsandboxed in-process and see every prompt; that is a supply-chain
  trust point listed in THREAT-MODEL.md.
