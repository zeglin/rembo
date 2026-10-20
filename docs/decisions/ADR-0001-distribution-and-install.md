# ADR-0001: Distribution, installation and updates

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md §a, §b, §g, §h

## Context

Goal: `npx rembo@latest setup <key>` (or `npm i -g rembo && rembo setup <key>`)
connects a machine in under 2 minutes; no postinstall side effects; CLI,
plugin, MCP server and hooks always at the same version; `rembo update` and a
clean `rembo uninstall`.

Verified facts that shape this (Claude Code 2.1.304):

- `claude plugin marketplace add <path>` accepts a local directory; a plugin
  whose marketplace entry is a relative path is **read in place** (no cache
  copy); changes apply on next session or `/reload-plugins`.
- An `npm` *plugin* source exists but copies the package into
  `~/.claude/plugins/cache/...`; an npm *marketplace* source does not exist.
- `claude plugin install <p>@<mkt> --scope user` is non-interactive, works in
  all projects; `--json` everywhere; `claude plugin configure --values-stdin`.
- Installing a plugin runs `npm install` only if the plugin root has both
  `package.json` and a lockfile. We ship neither in the plugin dir.
- Plugin names `claude-*`, `anthropic-*` etc. are reserved; `rembo` is free.
- Hook commands can use exec form (`"command": "<exe>", "args": [...]`), no
  shell, which is the portable form on Windows.

## Decision

**One npm package `rembo`** (bundled with esbuild, zero runtime dependencies,
no native modules, no install scripts) containing:

```
rembo/
  bin/rembo.js           CLI entry (thin; loads dist/cli.js)
  dist/                  cli.js, hook.js, mcp.js (single files)
  plugin/                the Claude Code plugin, as shipped
    .claude-plugin/plugin.json
    hooks/hooks.json     SessionStart + SessionEnd (rendered at setup) + mod module
    hooks/mod.js         mod (UX layer, ADR-0007)
    .mcp.json            stdio server -> dist/mcp.js (rendered at setup)
```

**Self-install into an app directory, registered as a local marketplace.**
`rembo setup` copies its own `dist/` + `plugin/` into
`~/.rembo/app/<version>/`, writes `~/.rembo/marketplace/.claude-plugin/marketplace.json`
with one entry `{ "name": "rembo", "source": "../app/<version>" }`-style
relative path, then runs:

```
claude plugin marketplace add ~/.rembo/marketplace --scope user --json
claude plugin install rembo@rembo --scope user --json
```

At copy time setup renders `hooks.json` and `.mcp.json` with the **absolute
path of the Node binary that runs setup** (`process.execPath`) in exec form.
This removes the dependence on `node` being on the PATH of whatever launched
Claude Code (desktop app, IDE, Task Scheduler), the most likely Windows
failure mode.

Why not the npm plugin source: it downloads a second copy that can drift from
the CLI version, and the plugin files cannot be rendered per machine. Why not
reference the global npm folder in place: `npx` caches are ephemeral and a
global install is optional.

**Updates.** `rembo update` = run `npx rembo@latest setup --upgrade`
semantics: the newer package copies itself to `~/.rembo/app/<new>/`, rewrites
the marketplace entry, runs `claude plugin marketplace update rembo` and
`claude plugin update rembo@rembo`, keeps the previous version for
`rembo update --rollback`. A global `npm i -g rembo` CLI checks the app
version and tells the user when they differ (`rembo doctor`). Claude Code's
own marketplace auto-update is off for third-party marketplaces and is not
relied upon.

**No direct edits of Claude Code settings.** Setup changes Claude Code only
through `claude plugin marketplace add` / `claude plugin install`; before that
it backs up `~/.claude/settings.json` to `~/.rembo/backup/<timestamp>/`.
`rembo uninstall` runs `claude plugin uninstall` and `marketplace remove`,
checks the result against the backup, and offers to delete `~/.rembo` (local
copy; hub data untouched).

**Non-interactive path:**
`rembo setup <key> --recovery-file <file> --scan all|none --yes [--hub <url>]`.

**Install from inside Claude Code (later, Etap 6).** A public marketplace repo
(`.claude-plugin/marketplace.json` with an `npm` source) allows
`/plugin install rembo --marketplace <owner>/<repo>`. On first session the mod
detects "not set up" and offers `/rembo setup` in a pane (the recovery key
must be shown in UI, never in the transcript). Designed, not built in the MVP.

**Node requirement.** See ADR-0008 (Node >= 22).

## Consequences

- Single version on disk per machine for hooks, MCP, mod, CLI copy; no
  `postinstall`; the only writes to user config happen in an explicit
  `rembo setup` with backups.
- Two Claude Code installs per user (e.g. `CLAUDE_CONFIG_DIR` profiles) need
  `rembo setup --claude-config <dir>`; supported by passing the env var
  through.
- Users who only ran `npx` have no `rembo` on their shell PATH. Inside Claude
  Code the plugin's `bin/` is on the Bash tool PATH and `/rembo` covers daily
  use; `npm i -g rembo` is documented for the shell.
