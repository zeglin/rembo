/** Client-side secret guard: findings name the rule and position, never the value. */

export interface SecretFinding {
  rule: string;
  line: number;
  column: number;
}

interface Rule {
  id: string;
  re: RegExp;
  allow?: (match: string) => boolean;
}

// Pointers to a password manager are explicitly allowed ("password: KeePassXC entry 'x'").
const PASSWORD_MANAGER = /^["']?(keepass|keepassxc|bitwarden|1password|lastpass|dashlane|vaultwarden|pass\b|password[\s-]?manager|menedżer)/i;

const RULES: Rule[] = [
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'rembo-key', re: /\b(?:rmb1|rmbd)_[A-Za-z0-9_.-]{20,}/g },
  { id: 'rembo-recovery-key', re: /\bRK-(?:[A-Z2-7]{4}-){5,}[A-Z2-7]{1,4}\b/g },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@/gi },
  {
    id: 'password-assignment',
    re: /\b(?:password|passwd|pwd|hasło|haslo|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    allow: (m) => PASSWORD_MANAGER.test(m.replace(/^[^:=]*[:=]\s*/, '')),
  },
  { id: 'cookie', re: /\b(?:set-)?cookie\s*:\s*[^\s=;]+=[^\s;]{12,}/gi },
];

const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(token: string): boolean {
  if (/^[0-9a-f]+$/i.test(token)) return false; // hashes and ids
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  return entropy(token) >= 4.2;
}

interface Match extends SecretFinding {
  start: number;
  end: number;
}

function matchLine(line: string, lineNo: number): Match[] {
  const found: Match[] = [];
  const overlaps = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of line.matchAll(rule.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (rule.allow?.(m[0]) || overlaps(start, end)) continue;
      found.push({ rule: rule.id, line: lineNo, column: start + 1, start, end });
    }
  }
  for (const m of line.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!overlaps(start, end) && looksRandom(m[0])) {
      found.push({ rule: 'high-entropy', line: lineNo, column: start + 1, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function scanSecrets(text: string): SecretFinding[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, i) => matchLine(line, i + 1))
    .map(({ rule, line, column }) => ({ rule, line, column }));
}

export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n').map((line, i) => {
    const matches = matchLine(line, i + 1);
    let out = line;
    for (const m of [...matches].reverse()) out = out.slice(0, m.start) + `[REDACTED:${m.rule}]` + out.slice(m.end);
    findings.push(...matches.map(({ rule, line: l, column }) => ({ rule, line: l, column })));
    return out;
  });
  return { text: lines.join('\n'), findings };
}
