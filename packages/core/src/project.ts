import fs from 'node:fs';
import path from 'node:path';
import { slugify } from './entry.ts';

/** git@host:owner/repo.git, ssh://..., https://... -> "host/owner/repo" (lowercase). */
export function normalizeGitRemote(url: string): string | null {
  const u = url.trim();
  let host: string;
  let p: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      p = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(u);
    if (!scp) return null;
    host = scp[1]!;
    p = scp[2]!;
  }
  p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !p) return null;
  return `${host}/${p}`.toLowerCase();
}

function remoteFromConfig(config: string): string | null {
  let current: string | null = null;
  const remotes = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (section) {
      current = section[1]!;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (current && url && !remotes.has(current)) remotes.set(current, url[1]!);
  }
  return remotes.get('origin') ?? remotes.values().next().value ?? null;
}

/** Reads the origin remote URL of the git repository containing `cwd`, without running git. */
export function findGitRemote(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let configPath: string | null = null;
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) {
        configPath = path.join(dotGit, 'config');
      } else {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) {
          const gitDir = path.resolve(dir, m[1]!.trim());
          const commonFile = path.join(gitDir, 'commondir');
          const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
          configPath = path.join(common, 'config');
        }
      }
    } catch {
      // no .git here
    }
    if (configPath) {
      try {
        return remoteFromConfig(fs.readFileSync(configPath, 'utf8'));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ProjectInfo {
  slug: string;
  via: 'git' | 'folder';
  remote?: string;
}

/** Project identity: the git remote's repository name, else the folder name. */
export function resolveProject(cwd: string): ProjectInfo {
  const remote = findGitRemote(cwd);
  const normalized = remote ? normalizeGitRemote(remote) : null;
  if (normalized) return { slug: slugify(normalized.split('/').pop()!), via: 'git', remote: normalized };
  return { slug: slugify(path.basename(path.resolve(cwd))), via: 'folder' };
}
