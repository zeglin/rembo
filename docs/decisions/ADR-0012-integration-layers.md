# ADR-0012: Integration layers — thin adapters over one core

- Status: proposed
- Date: 2026-10-20

## Context

Claude Code's extension APIs differ in stability: MCP is an open standard,
classic hooks are documented and mature, mods are early access. rembo should
stay working when any one of them changes, and should be usable from other
MCP clients later (an asset for rembo cloud).

## Decision

**All logic lives in the core** (sync, crypto, views, search, secret guard,
bridge), exposed through a contract we control: the CLI with `--json` output
and the `core` library. Every Claude Code integration is a thin adapter that
calls it:

| layer | adapter | job | if it breaks |
| --- | --- | --- | --- |
| 1 (any MCP client) | MCP stdio server | tools `search`, `read`, `list`, `remember`, `forget`; `instructions` with short usage rules | — (core path) |
| 2 (Claude Code) | 2 classic hooks, exec form | SessionStart: inject snapshot + spawn sync; SessionEnd: spawn sync | MCP still works; no automatic snapshot |
| 3 (Claude Code >= 2.1.287) | mod (one file) | `/rembo`, status line, toasts, off enforcement | memory works; `REMBO=off` for control |

- The MCP server reads `clientInfo.name` at initialization: in Claude Code the
  hook injects the snapshot and `instructions` hold only rules; in other
  clients `instructions` also carry L0 (size limits to verify in Etap 2).
- Hooks use only the oldest events (SessionStart, SessionEnd) and exec form;
  any error exits 0 silently and is logged.
- The skill text is folded into the injected rules and MCP `instructions`;
  no separate skill is needed in the MVP.

**Canary.** CI job, daily: if a new Claude Code version is published, run
`claude plugin validate --strict`, `claude plugin test` (mod) and the e2e
suite (`claude -p` with an isolated `CLAUDE_CONFIG_DIR`). `rembo doctor`
shows which layers are active and the tested Claude Code range.

## Consequences

- A breaking change in one Claude Code API costs a rewrite of one small
  adapter, not of rembo.
- Other clients (Claude Desktop, Cursor, Codex) can be supported later with
  `rembo setup --client <name>` writing their MCP config.
