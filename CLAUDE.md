# rembo — notes for Claude Code sessions

- Start by reading `docs/PROGRESS.md` (what is done, what is next, open
  questions). Design: `docs/ARCHITECTURE.md`, `docs/decisions/`,
  `docs/research/platform.md`, `docs/THREAT-MODEL.md`.
- The repo is public from the first commit. Never commit secrets, IP
  addresses, hostnames, or personal/infrastructure data. Such data lives only
  in git-ignored files (`private/`, root `*.txt` listed in `.gitignore`); read
  them only when a task needs them and never copy their content anywhere.
  Run `git status` before every commit.
- Code, comments, CLI messages and docs are in English.
- Do not touch the real `~/.claude` configuration, real servers, or publish
  anything (npm, GitHub, DNS) without the maintainer's explicit approval. Test
  with an isolated `CLAUDE_CONFIG_DIR` and Docker.
- Client: zero native modules, minimal dependencies, Node >= 22.
- Update `docs/PROGRESS.md` at the end of every work session.
