# ADR-0010: Hub installer and deployment

- Status: proposed
- Date: 2026-10-20

## Context

One command on a clean Linux VPS, < 10 minutes including TLS, no knowledge of
Docker/Caddy/systemd. Must integrate with an existing reverse proxy instead of
replacing it.

## Decision

**Default: `npx rembo-server@latest init`** (Node >= 24.16 required; the
installer checks and prints the one-line install for Debian/Ubuntu/RHEL
families). Docker compose is provided as an alternative, not the default:
many VPSes have no Docker, and Docker's port publishing bypasses ufw rules, a
common foot-gun for non-experts.

`init` steps (each idempotent, `--dry-run` prints the plan):

1. Preflight, read-only: OS, systemd, Node, free disk, who listens on 80/443,
   existing nginx/Traefik/Caddy, firewall status.
2. Create system user `rembo`, data dir `/var/lib/rembo` (0700), config
   `/etc/rembo/hub.json`, install the package into `/opt/rembo-server/<ver>`.
3. TLS by mode:
   - `--ip` (default when no domain): generate a P-256 key + 10-year
     self-signed cert (IP SAN) with `node:crypto` + a small X.509 builder (or
     `openssl` when present); the hub serves TLS itself on `--port` (default
     443) with `CAP_NET_BIND_SERVICE`. The SPKI pin goes into account keys.
   - `--domain hub.example.com`: if 80/443 are free, install Caddy (static
     binary, checksum-verified) as a systemd service proxying to
     `127.0.0.1:8787`, ACME e-mail configurable; if a proxy already owns
     80/443, **integration mode**: hub on localhost, installer prints (and with
     `--write-proxy-config` writes, with backup) an nginx/Traefik/Caddy snippet;
     certificates stay with the existing proxy.
4. systemd unit with sandboxing (`ProtectSystem=strict`, `NoNewPrivileges`,
   `PrivateTmp`, `ReadWritePaths=/var/lib/rembo`), restart on failure;
   systemd timer for the daily backup.
5. Firewall: print the needed rules (443, +80 for ACME); apply only with
   `--configure-firewall` and never touch SSH rules.
6. Create the account and the first account key; print it with the next step
   (`npx rembo@latest setup <key>` on each machine).

Admin CLI (local only, over SSH): `rembo-server key create|list|revoke`,
`account list`, `device list|revoke`, `backup [--now]`, `restore`, `status`,
`upgrade`, `uninstall`.

**Backups:** daily `VACUUM INTO` snapshot + TLS key + config, rotated (7 daily,
4 weekly), in `/var/lib/rembo/backups`; documented off-site copy (they hold
only ciphertext and metadata).

**Logs:** journald, structured, no bodies, no keys, no signatures; request id,
device id, status, latency.

## Consequences

- The no-domain path has no external moving parts (no ACME, no Caddy).
- Domain mode depends on Caddy or the user's proxy for certificates.
- Etap 3 tests `init` on a clean VM/container first, then the real VPS after a
  read-only survey and approval.
