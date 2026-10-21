# rembo plugin for Claude Code

rembo gives every Claude Code session on every machine you use the same
memory. Facts you or Claude save in one session (paths, commands, decisions,
preferences, infrastructure) are available in all others, end-to-end
encrypted on the way through your own hub.

This folder is installed by `rembo setup` (or `rembo install`); do not add it
by hand. It contains:

- an MCP server `rembo` with the tools `search`, `read`, `list`, `remember`
  and `forget`;
- a SessionStart hook that adds a bounded memory snapshot (from the local
  copy, no network) and starts a background sync, and a SessionEnd hook that
  starts a sync;
- a small hooks module (mod) with the `/rembo on | off | status | sync |
  search | forget` command and a "Rembo Mode On/Off" status line.

Turn rembo off for one session with `/rembo off`, at launch with
`REMBO=off claude`, or by default with `rembo off`. Remove it with
`rembo uninstall`.

Project, documentation and license (MIT): https://github.com/zeglin/rembo
