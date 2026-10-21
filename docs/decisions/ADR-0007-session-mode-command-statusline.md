# ADR-0007: Session mode, `/rembo` command and status line

- Status: proposed (revised 2026-10-20 after first-principles review)
- Date: 2026-10-20
- Research: docs/research/platform.md §c–§f

## Decision

A small **mod** (hooks module in the rembo plugin) owns everything
session-interactive. No status line wrapper, no PreToolUse fallback.

- `/rembo on|off|status|sync|search <q>|forget <id>`: registered with
  `$.command.register({ name: "rembo", argumentHint, immediate: true })`,
  answered by a `command.run` hook: no model turn.
  - Mode is session state (`$.state`), initial value from `REMBO=off` in the
    environment or the config default.
  - `/rembo on` in a session that started off returns the snapshot as
    `context` (read by the model, not shown), so memory arrives without a
    turn.
  - Other subcommands run `node <app>/dist/cli.js <cmd> --json` through
    `$.process.run` and print the result.
- **Off enforcement:** a `tool.call` hook on the rembo MCP tools answers
  "rembo is off in this session" while off.
- **Status line:** `$.ui.status("Rembo Mode On · ✓")` / `"Rembo Mode Off"`,
  sync state (`✓`, `↑2`, `offline`) read from `~/.rembo/status.json` via
  `$.fs` on start, after commands, and every 30 s. It is the plugin's own line
  under the prompt; the user's `statusLine` is never touched.
- **Toasts:** "Remembered: <title>" after a `remember` call (observed via the
  `tool.call` result).
- The mod has no crypto and no network code; it uses the CLI.
- Version guard: on `session.start` the mod checks `$.session.version()`
  against the range it was tested with; outside it, the mod disables itself
  and logs one line. The core keeps working.

**As built (Etap 2).** The module is active for 2.1.287 <= version < 2.2.0
(any error during its start disables it for the session). Who enforces what:
`REMBO=off` at launch — hook (no snapshot), MCP server (tools refuse) and
module; `rembo off` (default for new sessions) — hook and module, so
`/rembo on` can still turn a session on; `/rembo off` — module only (tool
calls denied). `/rembo on` returns the snapshot as `context`.

**Without the mod** (Claude Code < 2.1.287, `claude -p`, `disableAllHooks`,
policy): memory still works (SessionStart hook + MCP). Per-session control is
`REMBO=off claude` at launch; `rembo off` sets the global default. `rembo
doctor` reports whether the mod is active.

**What "off" means (documented):** no rembo tools, no `/rembo`-triggered
injection. What was injected at session start stays until `/clear`/compaction.
Claude Code's native auto-memory is not rembo's; files it writes in an off
session are still bridged on the next sync (disable native memory to avoid
that).

## Consequences

- Exact `/rembo off` and "Rembo Mode On/Off" with one small module and no
  settings edits.
- The early-access mods API is isolated to one file with a version guard and
  is covered by `claude plugin validate` / `claude plugin test` in CI.
