# rembo

Shared, end-to-end encrypted memory for every Claude Code session on every
machine you use.

> **Status: pre-release, not ready for use.** The core, the self-hosted hub
> and the `rembo` CLI work and are tested; the Claude Code plugin is being
> built. Nothing is published on npm yet. Progress:
> [docs/PROGRESS.md](docs/PROGRESS.md).

## What it does

- A fact remembered in one Claude Code session is available in every other
  session, on every machine connected to the same vault.
- The hub stores only ciphertext. Entries are encrypted on your machine
  (AES-256-GCM, `node:crypto` only); the vault key is unlocked by a recovery
  key that never leaves your hands.
- Every machine keeps a full local copy as plain markdown, so memory works
  offline and survives losing the hub.
- Self-host the hub (`rembo-server`, Node.js + SQLite) on your own server;
  a hosted "rembo cloud" may follow later.

Planned install, once released: `npx rembo@latest setup <account-key>`.

## Repository layout

| path | contents |
| --- | --- |
| `packages/core` | shared logic: crypto, entries, sync, search, secret guard |
| `packages/server` | `rembo-server`, the hub |
| `packages/rembo` | `rembo`, the CLI (and the Claude Code plugin) |
| `docs/` | architecture, threat model, decisions (ADRs), progress |

## Development

Node.js 24.16 or newer:

```
npm install
npm test
npm run typecheck
npm run build
```

Security issues: hello@rembo.dev. See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## License

MIT, see [LICENSE](LICENSE).
