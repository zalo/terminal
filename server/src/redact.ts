// Secret redaction for terminal text that leaves the machine (voice AI context).
//
// Terminal scrollback routinely contains printed credentials — env dumps,
// curl commands, .env files catted to the screen. Anything returned by the
// voice-facing endpoints is scrubbed here before it is sent to the xAI
// realtime API. Redactions keep a type hint (e.g. [redacted:aws-key]) so the
// voice model can still talk about what's on screen without seeing the value.
//
// This gates only the voice path. Canvas tiles streaming to the user's own
// browser are NOT redacted — that traffic never touches a third party.

interface Rule {
  name: string;
  re: RegExp;
  // Replacement; defaults to `[redacted:<name>]`.
  replace?: (match: RegExpExecArray) => string;
}

const RULES: Rule[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
  },
  { name: 'aws-key', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // OpenAI/Anthropic-style and xAI keys. Long tail after the prefix avoids
  // matching prose like "sk-learn".
  { name: 'api-key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'api-key', re: /\bxai-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'auth-header',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replace: (m) => `${m[1]} [redacted:auth-header]`,
  },
  {
    // KEY=value / key: value assignments where the key name smells secret.
    // Keeps the key name, scrubs the value.
    name: 'assignment',
    re: /\b((?:api[_-]?key|apikey|secret|token|passwd|password|credential|auth|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*)(\s*[=:]\s*)(["']?)([^\s"']{8,})\3/gi,
    replace: (m) => `${m[1]}${m[2]}${m[3]}[redacted:value]${m[3]}`,
  },
  {
    // High-entropy fallback: long mixed-case base64-ish runs. Deliberately
    // skips pure hex (git SHAs, docker ids — useful, not secret).
    name: 'high-entropy',
    re: /\b(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      if (rule.replace) {
        // Rebuild a RegExpExecArray-ish from replace() callback args.
        const groups = args.slice(0, -2) as unknown as RegExpExecArray;
        return rule.replace(groups);
      }
      return `[redacted:${rule.name}]`;
    });
  }
  return out;
}
