// Voice-agent support endpoints.
//
//  - POST /api/voice/token — mints a short-lived xAI ephemeral client secret
//    so the browser can open a WebSocket directly to wss://api.x.ai/v1/realtime
//    (audio never relays through this server). Requires GROK_API_KEY (or
//    XAI_API_KEY) in the environment or the repo-root .env file.
//  - GET  /api/sessions/:name/screen — capture-pane text (with scrollback) for
//    the voice agent's read_session tool. Secret-redacted by default because
//    the result is sent to the xAI API.
//  - POST /api/sessions/:name/keys — inject input via tmux send-keys. Used by
//    the voice agent to type commands into sessions without attaching a
//    client (so it never disturbs window sizes).

import fs from 'fs';
import path from 'path';
import type { Express, Request } from 'express';
import { type Context, runTmuxAsync } from './contexts';
import { redactSecrets } from './redact';
import { pokeStream } from './canvas';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The systemd unit's WorkingDirectory is server/, so dotenv (cwd-based) misses
// the repo-root .env. Fall back to parsing it directly.
function readEnvFileKey(name: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) {
        return m[2].replace(/^["']|["']$/g, '') || null;
      }
    }
  } catch {}
  return null;
}

function getXaiKey(): string | null {
  return (
    process.env.GROK_API_KEY ||
    process.env.XAI_API_KEY ||
    readEnvFileKey('GROK_API_KEY') ||
    readEnvFileKey('XAI_API_KEY')
  );
}

// tmux key names allowed through /keys (beyond literal text).
const KEY_RE = /^(?:[A-Za-z0-9]|C-[a-zA-Z]|M-[a-zA-Z]|F1[0-2]|F[1-9]|Enter|Escape|Space|Tab|BTab|BSpace|Up|Down|Left|Right|Home|End|NPage|PPage|PageUp|PageDown|DC|IC)$/;

export function registerVoiceRoutes(
  app: Express,
  resolveCtx: (req: Request) => Context | null,
) {
  app.post('/api/voice/token', async (_req, res) => {
    const key = getXaiKey();
    if (!key) {
      return res.status(503).json({
        error: 'no_api_key',
        message: 'Set GROK_API_KEY in the repo .env to enable voice.',
      });
    }
    try {
      const r = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      });
      if (!r.ok) {
        const text = await r.text();
        console.error(`[voice] token mint failed (${r.status}): ${text.slice(0, 300)}`);
        return res.status(502).json({ error: 'mint_failed', status: r.status });
      }
      const j = (await r.json()) as Record<string, unknown>;
      const secret = j.client_secret as Record<string, unknown> | string | undefined;
      const token =
        typeof secret === 'string' ? secret :
        typeof secret?.value === 'string' ? secret.value :
        typeof j.value === 'string' ? j.value : null;
      if (!token) {
        console.error('[voice] unexpected client_secrets response shape:', Object.keys(j));
        return res.status(502).json({ error: 'bad_response' });
      }
      res.json({ token, model: 'grok-voice-latest' });
    } catch (e) {
      console.error('[voice] token mint error:', (e as Error).message);
      res.status(502).json({ error: 'mint_failed' });
    }
  });

  // Full session context for the voice agent. Plain text (no ANSI), wrapped
  // lines joined, optional scrollback. Redacted unless ?raw=1.
  app.get('/api/sessions/:name/screen', async (req, res) => {
    const ctx = resolveCtx(req);
    if (!ctx) return res.status(400).json({ error: 'unknown context' });
    const name = req.params.name.replace(/[^a-zA-Z0-9-_]/g, '');
    const lines = Math.min(5000, Math.max(0, parseInt(String(req.query.lines || '0'), 10) || 0));
    const args = ['capture-pane', '-p', '-J', '-t', `=${name}:`];
    if (lines > 0) args.push('-S', `-${lines}`);
    const result = await runTmuxAsync(ctx, args);
    if (!result.ok) {
      return res.status(404).json({ error: 'capture failed', detail: result.stderr.slice(0, 200) });
    }
    let text = result.stdout.replace(/\s+$/, '');
    if (req.query.raw !== '1') text = redactSecrets(text);
    res.json({ session: name, context: ctx.name, text });
  });

  // Inject input. Body: { context?, text?, keys?: string[], enter?: boolean }.
  // text is sent literally (-l); keys are tmux key names (validated).
  app.post('/api/sessions/:name/keys', async (req, res) => {
    const ctx = resolveCtx(req);
    if (!ctx) return res.status(400).json({ error: 'unknown context' });
    const name = req.params.name.replace(/[^a-zA-Z0-9-_]/g, '');
    const target = `=${name}:`;
    const { text, keys, enter } = (req.body || {}) as {
      text?: unknown; keys?: unknown; enter?: unknown;
    };

    if (typeof text === 'string' && text.length > 0) {
      if (text.length > 10000) return res.status(400).json({ error: 'text too long' });
      const r = await runTmuxAsync(ctx, ['send-keys', '-t', target, '-l', '--', text]);
      if (!r.ok) return res.status(404).json({ error: 'send failed', detail: r.stderr.slice(0, 200) });
    }
    if (Array.isArray(keys)) {
      const list = keys.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)).slice(0, 32);
      if (list.length > 0) {
        const r = await runTmuxAsync(ctx, ['send-keys', '-t', target, ...list]);
        if (!r.ok) return res.status(404).json({ error: 'send failed', detail: r.stderr.slice(0, 200) });
      }
    }
    if (enter === true) {
      const r = await runTmuxAsync(ctx, ['send-keys', '-t', target, 'Enter']);
      if (!r.ok) return res.status(404).json({ error: 'send failed', detail: r.stderr.slice(0, 200) });
    }
    // Refresh canvas tiles right away so the injected keys echo without the
    // poll-interval delay.
    pokeStream(ctx.name, name);
    res.json({ success: true });
  });
}
