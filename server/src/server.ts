import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { spawn as cpSpawn, execSync, execFileSync, ChildProcess } from 'child_process';
import readline from 'readline';
import multer from 'multer';
import busboy from 'busboy';
import {
  loadContexts,
  listSessions as ctxListSessions,
  sessionExists as ctxSessionExists,
  createSession as ctxCreateSession,
  killSession as ctxKillSession,
  readMeta as ctxReadMeta,
  deleteMeta as ctxDeleteMeta,
  spawnAttachPty as ctxSpawnAttachPty,
  mustFindContext,
  defaultContext,
  contextWorkspaceRoot,
  isCtxPathSafe,
  ctxReadDir,
  ctxStat,
  ctxReadFile,
  ctxWriteFile,
  ctxMkdir,
  ctxTouch,
  ctxMove,
  ctxExists,
  ctxDirSizes,
  ctxOpenRead,
  ctxWriteFileStream,
  ctxSpawnZipStream,
  type ContextsConfig,
  type Context,
} from './contexts';
import {
  initPush,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  sendToAll,
  listSubscriptions,
} from './push';

const app = express();
const PORT = process.env.PORT || 3000;
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'Desktop');
const TMUX_USER = process.env.TMUX_USER || os.userInfo().username;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '6291456', 10); // 6MB default

// Shared tmux socket path - connects to orchestrator sessions
const TMUX_SOCKET = process.env.TMUX_SOCKET || '/tmp/orchestrator-tmux.sock';
const tmuxSocketArg = TMUX_SOCKET ? `-S '${TMUX_SOCKET}'` : '';

// Directory where Claude Code hooks write per-session metadata (status, task, cwd, preview_url).
// See ~/.claude/hooks/terminal-meta.py and ~/.claude/bin/tm-meta.
const META_DIR = process.env.CLAUDE_META_DIR || '/tmp/claude-terminal-meta';

// Coordinator mode: if CONTEXTS_CONFIG points to a valid JSON file, session
// endpoints fan out to each context (via sudo -u). Otherwise the server runs
// in its original single-context mode — unchanged behavior.
const contexts: ContextsConfig | null = loadContexts(process.env.CONTEXTS_CONFIG);
const COORDINATOR_MODE = contexts !== null;

app.use(cors());
app.use(express.json());

// --- Web Push initialization + endpoints -------------------------------------
// Always on: web push works in single-context mode and coordinator mode alike.
// VAPID keys are generated/loaded from config/vapid-keys.json on first boot.
initPush();

app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys, label } = req.body || {};
  if (typeof endpoint !== 'string' || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  addSubscription({
    endpoint,
    keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
    label: typeof label === 'string' ? label : undefined,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  });
  res.json({ success: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const endpoint = (req.body?.endpoint || req.query.endpoint) as string | undefined;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const removed = removeSubscription(endpoint);
  res.json({ success: removed });
});

app.get('/api/push/subscriptions', (_req, res) => {
  // Returns metadata only — never the keys.
  const list = listSubscriptions().map((s) => ({
    endpoint: s.endpoint,
    label: s.label,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
  }));
  res.json({ subscriptions: list, count: list.length });
});

// Local-only notify trigger: anything running on this machine can curl it,
// but it is rejected for remote callers.
app.post('/api/notify', async (req, res) => {
  const raw = req.ip || req.socket.remoteAddress || '';
  const isLocal =
    raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: 'Local callers only' });

  const { title, body, url, tag, icon, data } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title required' });
  }
  try {
    const result = await sendToAll({
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      url: typeof url === 'string' ? url : '/',
      tag: typeof tag === 'string' ? tag : undefined,
      icon: typeof icon === 'string' ? icon : undefined,
      data: typeof data === 'object' && data ? data : undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Pasted images: the frontend uploads clipboard images here, then types the
// returned path into the terminal so CLI tools (e.g. Claude Code) can read the
// file. Stored in the system temp dir, world-readable so context users can
// access it in coordinator mode.
const pasteUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/paste-image', pasteUpload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file provided' });
  const ext = (path.extname(file.originalname) || '.png').toLowerCase();
  const destPath = path.join(os.tmpdir(), `pasted-image-${Date.now()}${ext}`);
  try {
    fs.renameSync(file.path, destPath);
    fs.chmodSync(destPath, 0o644);
  } catch {
    try { fs.unlinkSync(file.path); } catch {}
    return res.status(500).json({ error: 'Failed to store pasted image' });
  }
  res.json({ path: destPath });
});

// /api/contexts is always registered. When coordinator mode is off it returns
// an empty list, which the frontend treats as "single-context mode" and hides
// all context UI. When on, it returns the real list.
app.get('/api/contexts', (_req, res) => {
  if (!COORDINATOR_MODE || !contexts) {
    return res.json({ contexts: [] });
  }
  res.json({
    contexts: contexts.contexts.map((c) => ({
      name: c.name,
      label: c.label,
      user: c.user,
    })),
  });
});

// --- Coordinator routes (registered only when CONTEXTS_CONFIG is active) ----
// These take precedence over the single-context handlers registered below
// because Express matches routes in registration order.
if (COORDINATOR_MODE && contexts) {
  const sanitizeName = (raw: unknown): string => {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
  };

  // Fan-out sessions list: every context's tmux sessions, tagged with context.
  app.get('/api/sessions', (_req, res) => {
    const out: Array<{
      name: string;
      context: string;
      created: Date;
      lastAccess: Date;
      meta?: Record<string, unknown>;
    }> = [];
    for (const ctx of contexts.contexts) {
      for (const row of ctxListSessions(ctx)) {
        out.push({ ...row, meta: ctxReadMeta(ctx, row.name) });
      }
    }
    res.json(out);
  });

  app.get('/api/sessions/:name/meta', (req, res) => {
    const ctxName = (req.query.context as string) || defaultContext(contexts).name;
    let ctx;
    try { ctx = mustFindContext(contexts, ctxName); } catch { return res.status(404).json({ error: 'unknown context' }); }
    const meta = ctxReadMeta(ctx, req.params.name);
    res.json(meta || {});
  });

  app.post('/api/sessions', (req, res) => {
    const ctxName = (req.body?.context as string) || defaultContext(contexts).name;
    let ctx;
    try { ctx = mustFindContext(contexts, ctxName); } catch { return res.status(400).json({ error: 'unknown context' }); }
    const name = sanitizeName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Invalid session name' });
    if (ctxSessionExists(ctx, name)) return res.status(409).json({ error: 'Session already exists' });
    if (ctxCreateSession(ctx, name)) return res.json({ name, context: ctx.name });
    res.status(500).json({ error: 'Failed to create session' });
  });

  app.delete('/api/sessions/:name', (req, res) => {
    const ctxName = (req.query.context as string) || defaultContext(contexts).name;
    let ctx;
    try { ctx = mustFindContext(contexts, ctxName); } catch { return res.status(404).json({ error: 'unknown context' }); }
    if (ctxKillSession(ctx, req.params.name)) {
      ctxDeleteMeta(ctx, req.params.name);
      return res.json({ success: true });
    }
    res.status(404).json({ error: 'Session not found' });
  });

  // --- Files API (context-aware) -------------------------------------------
  // Every file op takes ?context=X (default = admin) and runs as that context's
  // user via sudo -u. Paths are constrained to the context's home dir.
  const resolveCtxFromReq = (req: express.Request): Context | null => {
    const name = (req.query.context as string) || (req.body?.context as string) || defaultContext(contexts).name;
    try { return mustFindContext(contexts, name); } catch { return null; }
  };

  app.get('/api/config', (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    res.json({ rootPath: contextWorkspaceRoot(ctx), context: ctx.name });
  });

  app.get('/api/files', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const requestedPath = (req.query.path as string) || contextWorkspaceRoot(ctx);
    if (!isCtxPathSafe(ctx, requestedPath)) return res.status(403).json({ error: 'Access denied' });
    try {
      const entries = await ctxReadDir(ctx, requestedPath);
      entries.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
      const home = `/home/${ctx.user || os.userInfo().username}`;
      const resolved = path.resolve(requestedPath);
      const parent = resolved !== home ? path.dirname(resolved) : null;
      res.json({
        path: requestedPath,
        parent,
        files: entries,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/files/dir-sizes', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const requestedPath = (req.query.path as string) || contextWorkspaceRoot(ctx);
    if (!isCtxPathSafe(ctx, requestedPath)) return res.status(403).json({ error: 'Access denied' });
    res.json({ sizes: await ctxDirSizes(ctx, requestedPath) });
  });

  app.get('/api/files/content', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const filePath = req.query.path as string;
    if (!filePath || !isCtxPathSafe(ctx, filePath)) return res.status(403).json({ error: 'Access denied' });
    try {
      const st = await ctxStat(ctx, filePath);
      if (!st) return res.status(404).json({ error: 'Not found' });
      if (st.type === 'directory') return res.status(400).json({ error: 'Cannot read directory content' });
      if (st.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large (max 6MB)' });
      const buf = await ctxReadFile(ctx, filePath, MAX_FILE_SIZE);
      res.json({ type: 'text', content: buf.toString('utf-8'), extension: path.extname(filePath).toLowerCase() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.put('/api/files/content', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const filePath = req.body?.path as string;
    const content = req.body?.content as string;
    if (!filePath || typeof content !== 'string' || !isCtxPathSafe(ctx, filePath)) return res.status(403).json({ error: 'Access denied' });
    try {
      await ctxWriteFile(ctx, filePath, Buffer.from(content, 'utf-8'));
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/files/mkdir', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const dirPath = req.body?.path as string;
    if (!dirPath || !isCtxPathSafe(ctx, dirPath)) return res.status(403).json({ error: 'Access denied' });
    if (await ctxExists(ctx, dirPath)) return res.status(409).json({ error: 'Already exists' });
    try { await ctxMkdir(ctx, dirPath); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/files/create', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const filePath = req.body?.path as string;
    if (!filePath || !isCtxPathSafe(ctx, filePath)) return res.status(403).json({ error: 'Access denied' });
    if (await ctxExists(ctx, filePath)) return res.status(409).json({ error: 'Already exists' });
    try { await ctxTouch(ctx, filePath); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/files/move', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const src = req.body?.src as string;
    const dest = req.body?.dest as string;
    if (!src || !dest || !isCtxPathSafe(ctx, src) || !isCtxPathSafe(ctx, dest)) return res.status(403).json({ error: 'Access denied' });
    if (!(await ctxExists(ctx, src))) return res.status(404).json({ error: 'Source not found' });
    if (await ctxExists(ctx, dest)) return res.status(409).json({ error: 'Destination already exists' });
    try { await ctxMove(ctx, src, dest); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/files/download-zip', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const dirPath = req.query.path as string;
    if (!dirPath || !isCtxPathSafe(ctx, dirPath)) return res.status(403).json({ error: 'Access denied' });
    const st = await ctxStat(ctx, dirPath);
    if (!st) return res.status(404).json({ error: 'Directory not found' });
    if (st.type !== 'directory') return res.status(400).json({ error: 'Path is not a directory' });

    const dirName = path.basename(dirPath) || 'download';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${dirName}.zip"`);

    const stream = ctxSpawnZipStream(ctx, dirPath);
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
    });
    req.on('close', () => { stream.kill?.(); });
  });

  // Upload via busboy: stream each file part directly from the request into
  // `sudo -u <user> tee <dest>` without staging on /tmp. This means:
  //   - large files don't need /tmp to have free space equal to the upload
  //   - the network rate is the rate the disk + tee process can absorb
  //     (pipe() backpressure handles this naturally)
  //   - per-file results are streamed back as JSON when all parts finish
  const UPLOAD_FILE_LIMIT = parseInt(
    process.env.UPLOAD_FILE_LIMIT_BYTES || String(50 * 1024 * 1024 * 1024),
    10,
  );
  app.post('/api/files/upload', (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });

    let targetDir: string | null = null;
    let targetVerified = false;
    const results: { name: string; size: number; error?: string; truncated?: boolean }[] = [];
    const pending: Promise<void>[] = [];
    let earlyError: string | null = null;
    let finished = false;

    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: UPLOAD_FILE_LIMIT, files: 64 },
    });

    const verifyTarget = async (): Promise<boolean> => {
      if (targetVerified) return true;
      if (!targetDir) {
        earlyError = 'path field is required';
        return false;
      }
      if (!isCtxPathSafe(ctx, targetDir)) {
        earlyError = 'Access denied';
        return false;
      }
      const st = await ctxStat(ctx, targetDir);
      if (!st || st.type !== 'directory') {
        earlyError = 'Target directory does not exist';
        return false;
      }
      targetVerified = true;
      return true;
    };

    bb.on('field', (name, value) => {
      if (name === 'path') targetDir = String(value);
      if (name === 'context') {
        // Field-based context override (form-only — query string still wins
        // via resolveCtxFromReq above)
      }
    });

    bb.on('file', (_fieldname, fileStream, info) => {
      const filename = info.filename || 'upload';
      // Defer the actual write until target is verified; while waiting, pause.
      const handleFile = async () => {
        const ok = await verifyTarget();
        if (!ok) {
          fileStream.resume();
          results.push({ name: filename, size: 0, error: earlyError || 'failed' });
          return;
        }
        const destPath = path.join(targetDir as string, filename);
        if (!isCtxPathSafe(ctx, destPath)) {
          fileStream.resume();
          results.push({ name: filename, size: 0, error: 'Access denied' });
          return;
        }

        let bytes = 0;
        let truncated = false;
        fileStream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        fileStream.on('limit', () => { truncated = true; });

        try {
          await ctxWriteFileStream(ctx, destPath, fileStream);
          if (truncated) {
            results.push({ name: filename, size: bytes, error: 'File exceeded UPLOAD_FILE_LIMIT_BYTES; truncated', truncated: true });
          } else {
            results.push({ name: filename, size: bytes });
          }
        } catch (e) {
          results.push({ name: filename, size: bytes, error: (e as Error).message });
        }
      };
      pending.push(handleFile());
    });

    const respond = async () => {
      if (finished) return;
      finished = true;
      try {
        await Promise.all(pending);
      } catch {}
      if (results.length === 0 && earlyError) {
        return res.status(400).json({ error: earlyError });
      }
      if (results.length === 0) {
        return res.status(400).json({ error: 'No file provided' });
      }
      res.json({ uploaded: results });
    };

    bb.on('finish', respond);
    bb.on('close', respond);
    bb.on('error', (e: Error) => {
      if (!res.headersSent) res.status(500).json({ error: e.message });
      finished = true;
    });

    req.on('aborted', () => {
      // Client disconnected mid-upload; busboy will fire close. Mark any
      // pending writes as canceled by destroying the request stream (the
      // file streams downstream will error out and reject their promises).
      finished = true;
    });

    req.pipe(bb);
  });

  app.get('/api/files/stream', async (req, res) => {
    const ctx = resolveCtxFromReq(req);
    if (!ctx) return res.status(404).json({ error: 'unknown context' });
    const filePath = req.query.path as string;
    if (!filePath || !isCtxPathSafe(ctx, filePath)) return res.status(403).json({ error: 'Access denied' });
    const st = await ctxStat(ctx, filePath);
    if (!st) return res.status(404).end();
    if (st.type === 'directory') return res.status(400).end();

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    // ?download=1 forces the browser to save instead of inline-render.
    if (req.query.download === '1') {
      const fileName = path.basename(filePath);
      const asciiFallback = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '\\"');
      const utf8Pct = encodeURIComponent(fileName);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Pct}`,
      );
    }

    const fileSize = st.size;
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      res.status(206);
      const stream = ctxOpenRead(ctx, filePath, { start, end });
      stream.pipe(res);
      req.on('close', () => { try { (stream as any).destroy?.(); } catch {} });
    } else {
      res.setHeader('Content-Length', fileSize);
      const stream = ctxOpenRead(ctx, filePath);
      stream.pipe(res);
      req.on('close', () => { try { (stream as any).destroy?.(); } catch {} });
    }
  });
}

// Serve static files in production
const distPath = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Session management
interface SessionMeta {
  status?: 'working' | 'waiting' | 'finished' | 'idle';
  task?: string;
  cwd?: string;
  preview_url?: string;
  claude_session_id?: string;
  updated_at?: number;
}

interface Session {
  name: string;
  created: Date;
  lastAccess: Date;
  meta?: SessionMeta;
}

function sanitizeSessionName(name: string): string {
  return name.replace(/[/\\]/g, '_');
}

function readSessionMeta(sessionName: string): SessionMeta | undefined {
  try {
    const p = path.join(META_DIR, `${sanitizeSessionName(sessionName)}.json`);
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      status: parsed.status,
      task: parsed.task,
      cwd: parsed.cwd,
      preview_url: parsed.preview_url,
      claude_session_id: parsed.claude_session_id,
      updated_at: parsed.updated_at,
    };
  } catch {
    return undefined;
  }
}

function getTmuxSessions(): Session[] {
  try {
    const result = require('child_process').execSync(
      `tmux ${tmuxSocketArg} list-sessions -F '#{session_name}|#{session_created}|#{session_activity}' 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    return result
      .trim()
      .split('\n')
      .filter((line: string) => line.length > 0)
      .map((line: string) => {
        const [name, created, lastAccess] = line.split('|');
        return {
          name,
          created: new Date(parseInt(created) * 1000),
          lastAccess: new Date(parseInt(lastAccess) * 1000),
          meta: readSessionMeta(name),
        };
      });
  } catch {
    return [];
  }
}

function sessionExists(sessionName: string): boolean {
  try {
    require('child_process').execSync(
      `tmux ${tmuxSocketArg} has-session -t '${sessionName}' 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(sessionName: string): boolean {
  try {
    require('child_process').execSync(
      `cd ${WORKSPACE_ROOT} && tmux ${tmuxSocketArg} new-session -d -s '${sessionName}'`,
      { encoding: 'utf-8' }
    );
    return true;
  } catch (e) {
    console.error('Failed to create tmux session:', e);
    return false;
  }
}

// Read the current working directory of a tmux session's active pane
function getTmuxPaneCwd(sessionName: string): string | null {
  try {
    const result = execSync(
      `tmux ${tmuxSocketArg} display-message -p -t '${sessionName}' '#{pane_current_path}' 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    const cwd = result.trim();
    if (cwd && fs.existsSync(cwd)) return cwd;
  } catch { /* ignore */ }
  return null;
}

// API Routes
app.get('/api/config', (_req, res) => {
  res.json({ rootPath: WORKSPACE_ROOT });
});

// Lightweight per-session metadata endpoint — polled by TerminalView while attached.
app.get('/api/sessions/:name/meta', (req, res) => {
  const meta = readSessionMeta(req.params.name);
  if (!meta) return res.json({});
  res.json(meta);
});

app.get('/api/sessions', (_req, res) => {
  const sessions = getTmuxSessions();
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Session name is required' });
  }

  const sanitized = name.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
  if (!sanitized) {
    return res.status(400).json({ error: 'Invalid session name' });
  }

  if (sessionExists(sanitized)) {
    return res.status(409).json({ error: 'Session already exists' });
  }

  if (createTmuxSession(sanitized)) {
    res.json({ name: sanitized });
  } else {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.delete('/api/sessions/:name', (req, res) => {
  const { name } = req.params;
  try {
    require('child_process').execSync(
      `tmux ${tmuxSocketArg} kill-session -t '${name}' 2>/dev/null`,
      { encoding: 'utf-8' }
    );
    // Drop any metadata file so the session fully disappears from the UI.
    try {
      const metaPath = path.join(META_DIR, `${sanitizeSessionName(name)}.json`);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch {}
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

// File browser API — allow browsing anywhere within the user's home directory
const HOME_DIR = os.homedir();
function isPathSafe(requestedPath: string): boolean {
  const resolved = path.resolve(requestedPath);
  return resolved === HOME_DIR || resolved.startsWith(HOME_DIR + path.sep);
}

app.get('/api/files', (req, res) => {
  const requestedPath = (req.query.path as string) || WORKSPACE_ROOT;

  if (!isPathSafe(requestedPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const entries = fs.readdirSync(requestedPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const fullPath = path.join(requestedPath, entry.name);
      const isDir = entry.isDirectory();
      let size: number | null = null;
      let modified: Date = new Date();
      try {
        const stats = fs.statSync(fullPath);
        modified = stats.mtime;
        if (!isDir) size = stats.size;
      } catch {}
      return {
        name: entry.name,
        type: isDir ? 'directory' : 'file',
        size,
        modified,
      };
    });

    // Sort: directories first, then files, both alphabetically
    files.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({
      path: requestedPath,
      parent: path.resolve(requestedPath) !== HOME_DIR ? path.dirname(requestedPath) : null,
      files,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// Async directory sizes — returns { sizes: { name: bytes, ... } }
app.get('/api/files/dir-sizes', (req, res) => {
  const requestedPath = (req.query.path as string) || WORKSPACE_ROOT;

  if (!isPathSafe(requestedPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    // du -b --max-depth=1 on the directory, with a timeout
    const result = execSync(
      `du -b --max-depth=1 ${JSON.stringify(requestedPath)} 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const sizes: Record<string, number> = {};
    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const [sizeStr, dirPath] = line.split('\t');
      if (!dirPath) continue;
      const name = path.basename(dirPath);
      // Skip the parent directory entry itself
      if (path.resolve(dirPath) === path.resolve(requestedPath)) continue;
      sizes[name] = parseInt(sizeStr, 10) || 0;
    }
    res.json({ sizes });
  } catch {
    res.json({ sizes: {} });
  }
});

app.get('/api/files/content', (req, res) => {
  const filePath = req.query.path as string;

  if (!filePath || !isPathSafe(filePath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory content' });
    }

    if (stats.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'File too large (max 6MB)' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ type: 'text', content, extension: ext });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.put('/api/files/content', (req, res) => {
  const filePath = req.body?.path as string;
  const content = req.body?.content as string;

  if (!filePath || typeof content !== 'string' || !isPathSafe(filePath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot write to directory' });
    }
  } catch {
    // File doesn't exist yet — that's OK, we'll create it
  }

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save file' });
  }
});

// Create a new directory
app.post('/api/files/mkdir', (req, res) => {
  const dirPath = req.body?.path as string;

  if (!dirPath || !isPathSafe(dirPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (fs.existsSync(dirPath)) {
    return res.status(409).json({ error: 'Already exists' });
  }

  try {
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to create directory' });
  }
});

// Create a new empty file
app.post('/api/files/create', (req, res) => {
  const filePath = req.body?.path as string;

  if (!filePath || !isPathSafe(filePath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: 'Already exists' });
  }

  try {
    fs.writeFileSync(filePath, '', 'utf-8');
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

// Move / rename a file or directory
app.post('/api/files/move', (req, res) => {
  const src = req.body?.src as string;
  const dest = req.body?.dest as string;

  if (!src || !dest || !isPathSafe(src) || !isPathSafe(dest)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(src)) {
    return res.status(404).json({ error: 'Source not found' });
  }

  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: 'Destination already exists' });
  }

  try {
    fs.renameSync(src, dest);
    res.json({ success: true });
  } catch {
    // rename may fail across filesystems
    try {
      execSync(`mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Failed to move' });
    }
  }
});

app.get('/api/files/stream', (req, res) => {
  const filePath = req.query.path as string;

  if (!filePath || !isPathSafe(filePath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) return res.status(400).end();

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const fileSize = stats.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      res.status(206);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    res.status(500).end();
  }
});

// Download directory as zip
app.get('/api/files/download-zip', (req, res) => {
  const dirPath = req.query.path as string;

  if (!dirPath || !isPathSafe(dirPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
  } catch {
    return res.status(404).json({ error: 'Directory not found' });
  }

  const dirName = path.basename(dirPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${dirName}.zip"`);

  const { spawn: cpSpawnLocal } = require('child_process');
  const zipProc = cpSpawnLocal('zip', ['-r', '-q', '-', '.'], { cwd: dirPath, stdio: ['ignore', 'pipe', 'pipe'] });
  zipProc.stdout.pipe(res);
  zipProc.stderr.on('data', (data: Buffer) => {
    console.error(`[zip] ${data.toString()}`);
  });
  zipProc.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
  });
  req.on('close', () => { zipProc.kill(); });
});

// File upload API — multer stores to a temp dir, then we move to the target directory
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit

app.post('/api/files/upload', upload.array('files'), (req, res) => {
  const targetDir = (req.body?.path as string) || WORKSPACE_ROOT;

  if (!isPathSafe(targetDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return res.status(400).json({ error: 'Target directory does not exist' });
  }

  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const results: { name: string; size: number; error?: string }[] = [];

  for (const file of files) {
    const destPath = path.join(targetDir, file.originalname);
    try {
      fs.renameSync(file.path, destPath);
      results.push({ name: file.originalname, size: file.size });
    } catch (e) {
      // rename may fail across filesystems, fall back to copy
      try {
        fs.copyFileSync(file.path, destPath);
        fs.unlinkSync(file.path);
        results.push({ name: file.originalname, size: file.size });
      } catch (e2) {
        // Clean up temp file
        try { fs.unlinkSync(file.path); } catch {}
        results.push({ name: file.originalname, size: file.size, error: 'Failed to save' });
      }
    }
  }

  res.json({ uploaded: results });
});

// Chat session management - persist session mapping to disk for auto-resume
// Map format: { sessionName: { sessionId, cwd } }
const SESSION_MAP_PATH = path.join(WORKSPACE_ROOT, '.terminal-chat-sessions.json');

interface SessionMapEntry {
  sessionId: string;
  cwd: string;
}

function loadSessionMap(): Record<string, SessionMapEntry | string> {
  try {
    return JSON.parse(fs.readFileSync(SESSION_MAP_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessionMap(map: Record<string, SessionMapEntry | string>): void {
  fs.writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
}

// Get a resumable session ID for a given name+cwd combo
function getResumableSession(name: string, cwd: string): string | null {
  const map = loadSessionMap();
  const entry = map[name];
  if (!entry) return null;
  // Handle old format (plain string) — can't verify cwd, skip
  if (typeof entry === 'string') return null;
  // Only resume if cwd matches
  if (entry.cwd === cwd) return entry.sessionId;
  return null;
}

function saveSession(name: string, sessionId: string, cwd: string): void {
  const map = loadSessionMap();
  map[name] = { sessionId, cwd };
  saveSessionMap(map);
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
  timestamp: number;
}

// Helper: run tmux commands without shell escaping issues
function tmux(...args: string[]): string {
  const fullArgs = TMUX_SOCKET ? ['-S', TMUX_SOCKET, ...args] : args;
  return execFileSync('tmux', fullArgs, { encoding: 'utf-8' }).trim();
}

// Strip ANSI escape sequences from pipe-pane output
function stripAnsi(s: string): string {
  return s.replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\x1b\][^\x07]*\x07/g, '');
}

class ChatSession {
  name: string;
  messages: ChatMessage[] = [];
  browsers: Set<WebSocket> = new Set();
  isStreaming = false;
  claudeSessionId: string | null = null;
  cwd: string;
  private resumedSessionId: string | null = null;
  private outputFile: string;
  private inputFile: string;
  private tailProcess: ChildProcess | null = null;
  private exitCheckInterval: ReturnType<typeof setInterval> | null = null;
  private claudeRunning = false;
  private startGeneration = 0;

  constructor(name: string, resumeSessionId?: string, cwd?: string) {
    this.name = name;
    this.cwd = cwd || getTmuxPaneCwd(name) || WORKSPACE_ROOT;
    this.outputFile = `/tmp/claude-chat-${name}-output.ndjson`;
    this.inputFile = `/tmp/claude-chat-${name}-stdin`;
    console.log(`[chat:${this.name}] Working directory: ${this.cwd}`);

    if (resumeSessionId) {
      this.resumedSessionId = resumeSessionId;
    } else {
      const savedId = getResumableSession(name, this.cwd);
      if (savedId) {
        this.resumedSessionId = savedId;
        console.log(`[chat:${this.name}] Auto-resuming session ${this.resumedSessionId}`);
      }
    }

    // Ensure tmux session exists
    if (!sessionExists(name)) {
      createTmuxSession(name);
    }

    this.startClaude();
  }

  private startClaude() {
    this.startGeneration++;
    const gen = this.startGeneration;

    // Cleanup previous reader
    this.stopReader();

    // Clear output file and input file
    fs.writeFileSync(this.outputFile, '');
    fs.writeFileSync(this.inputFile, '');

    // Stop any existing pipe-pane, then start fresh
    try { tmux('pipe-pane', '-t', this.name); } catch {}
    tmux('pipe-pane', '-O', '-t', this.name, `cat >> '${this.outputFile}'`);

    // Start reading output via tail -f
    this.startOutputReader(gen);

    // Build the claude command — pipe stdin from input file so Claude sees a pipe, not a TTY
    const args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (this.resumedSessionId) {
      args.push('--resume', this.resumedSessionId);
    }
    // tail -f on the input file feeds stdin to Claude via pipe (not TTY)
    const cmd = `cd '${this.cwd}' && tail -f '${this.inputFile}' | ${args.join(' ')}`;

    // Wait for any previous Claude to exit, then inject command
    this.waitAndInject(cmd, gen);
  }

  private waitAndInject(cmd: string, gen: number) {
    if (gen !== this.startGeneration) return;

    let paneCmd = '';
    try {
      paneCmd = tmux('display-message', '-p', '-t', this.name, '#{pane_current_command}');
    } catch {}

    if (paneCmd === 'claude' || paneCmd === 'tail') {
      setTimeout(() => this.waitAndInject(cmd, gen), 300);
      return;
    }

    console.log(`[chat:${this.name}] Injecting Claude into tmux${this.resumedSessionId ? ` (resume ${this.resumedSessionId})` : ''}`);
    tmux('send-keys', '-l', '-t', this.name, cmd);
    tmux('send-keys', '-t', this.name, 'Enter');

    this.startExitCheck(gen);
  }

  private startOutputReader(gen: number) {
    this.tailProcess = cpSpawn('tail', ['-f', '-n', '+1', this.outputFile]);
    const rl = readline.createInterface({ input: this.tailProcess.stdout! });
    rl.on('line', (rawLine) => {
      if (gen !== this.startGeneration) return;
      // Strip ANSI escape codes from pipe-pane output
      const line = stripAnsi(rawLine).trim();
      if (!line) return;
      // Try to find JSON in the line (may be preceded by shell noise)
      const jsonStart = line.indexOf('{');
      if (jsonStart < 0) return;
      try {
        const msg = JSON.parse(line.slice(jsonStart));
        this.handleClaudeMessage(msg);
      } catch {
        // Not valid JSON — skip
      }
    });
    this.tailProcess.on('exit', () => {
      if (this.tailProcess?.pid === undefined) this.tailProcess = null;
    });
  }

  private startExitCheck(gen: number) {
    if (this.exitCheckInterval) clearInterval(this.exitCheckInterval);

    this.exitCheckInterval = setInterval(() => {
      if (gen !== this.startGeneration) {
        clearInterval(this.exitCheckInterval!);
        this.exitCheckInterval = null;
        return;
      }
      try {
        const cmd = tmux('display-message', '-p', '-t', this.name, '#{pane_current_command}');
        // The pane_current_command is 'tail' when `tail -f | claude` is running
        // (tail is the pipeline leader). Claude exiting makes tail get SIGPIPE and exit too.
        const running = cmd === 'claude' || cmd === 'tail';
        if (!this.claudeRunning && running) {
          this.claudeRunning = true;
          console.log(`[chat:${this.name}] Claude is running in tmux`);
        } else if (this.claudeRunning && !running) {
          this.claudeRunning = false;
          this.isStreaming = false;
          console.log(`[chat:${this.name}] Claude exited in tmux`);
          this.broadcast({ type: 'process_exit', code: 0 });
          clearInterval(this.exitCheckInterval!);
          this.exitCheckInterval = null;
        }
      } catch {}
    }, 1500);
  }

  private stopReader() {
    if (this.tailProcess) {
      this.tailProcess.kill();
      this.tailProcess = null;
    }
    if (this.exitCheckInterval) {
      clearInterval(this.exitCheckInterval);
      this.exitCheckInterval = null;
    }
  }

  private handleClaudeMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;
    const subtype = msg.subtype as string | undefined;

    if (type === 'system' && subtype === 'init') {
      if (msg.session_id) {
        this.claudeSessionId = msg.session_id as string;
        saveSession(this.name, this.claudeSessionId, this.cwd);
        console.log(`[chat:${this.name}] Session ID captured: ${this.claudeSessionId}`);
      }
      this.broadcast(msg);
    } else if (type === 'assistant') {
      this.isStreaming = true;
      const chatMsg: ChatMessage = { role: 'assistant', content: msg, timestamp: Date.now() };
      this.messages.push(chatMsg);
      this.broadcast(msg);
    } else if (type === 'result') {
      this.isStreaming = false;
      const chatMsg: ChatMessage = { role: 'system', content: msg, timestamp: Date.now() };
      this.messages.push(chatMsg);
      this.broadcast(msg);
    } else if (type === 'user') {
      const chatMsg: ChatMessage = { role: 'user', content: msg, timestamp: Date.now() };
      this.messages.push(chatMsg);
      this.broadcast(msg);
    } else if (type === 'system') {
      this.broadcast(msg);
    } else {
      this.broadcast(msg);
    }
  }

  // Send a JSON line to Claude by appending to the input file (tail -f feeds it to stdin)
  private writeToStdin(ndjson: string) {
    try {
      fs.appendFileSync(this.inputFile, ndjson + '\n');
    } catch (e) {
      console.error(`[chat:${this.name}] Failed to write to stdin file:`, e);
    }
  }

  resumeSession(sessionId: string) {
    // Send Ctrl+C to stop current Claude
    try { tmux('send-keys', '-t', this.name, 'C-c'); } catch {}
    this.messages = [];
    this.isStreaming = false;
    this.claudeRunning = false;
    this.resumedSessionId = sessionId;
    this.broadcast({ type: 'session_resumed', sessionId });
    // Wait for Claude to exit, then restart
    setTimeout(() => this.startClaude(), 500);
  }

  setCwd(newCwd: string) {
    if (!fs.existsSync(newCwd) || !fs.statSync(newCwd).isDirectory()) return;
    this.cwd = newCwd;
    console.log(`[chat:${this.name}] Working directory changed to: ${this.cwd}`);
    try { tmux('send-keys', '-t', this.name, 'C-c'); } catch {}
    this.messages = [];
    this.isStreaming = false;
    this.claudeRunning = false;
    this.resumedSessionId = null;
    this.broadcast({ type: 'cwd_changed', cwd: this.cwd });
    setTimeout(() => this.startClaude(), 500);
  }

  interrupt() {
    console.log(`[chat:${this.name}] Sending Ctrl+C to tmux pane`);
    try { tmux('send-keys', '-t', this.name, 'C-c'); } catch {}
  }

  sendUserMessage(text: string) {
    const userMsg: ChatMessage = {
      role: 'user',
      content: { type: 'user', text },
      timestamp: Date.now(),
    };
    this.messages.push(userMsg);

    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });
    this.writeToStdin(ndjson);
    this.isStreaming = true;
  }

  sendToolResult(toolUseId: string, content: string) {
    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
      },
    });
    this.writeToStdin(ndjson);
    this.isStreaming = true;
    console.log(`[chat:${this.name}] Sent tool_result for ${toolUseId}`);
  }

  attachBrowser(ws: WebSocket) {
    this.browsers.add(ws);
    ws.send(JSON.stringify({
      type: 'history',
      messages: this.messages.map(m => m.content),
      cwd: this.cwd,
    }));
  }

  detachBrowser(ws: WebSocket) {
    this.browsers.delete(ws);
  }

  private broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.browsers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  stop() {
    this.startGeneration++; // invalidate all pending callbacks
    try { tmux('send-keys', '-t', this.name, 'C-c'); } catch {}
    try { tmux('pipe-pane', '-t', this.name); } catch {} // stop pipe-pane
    this.stopReader();
    for (const ws of this.browsers) {
      ws.close();
    }
    this.browsers.clear();
  }
}

const chatSessions = new Map<string, ChatSession>();

// Chat REST endpoints
app.get('/api/chat/sessions', (_req, res) => {
  const sessions = Array.from(chatSessions.entries()).map(([name, session]) => ({
    name,
    messageCount: session.messages.length,
    isStreaming: session.isStreaming,
    browserCount: session.browsers.size,
  }));
  res.json(sessions);
});

// Extract last real user message from a JSONL session file
// For large files, only reads the last 100KB to avoid loading entire file
const SKIP_PREFIXES = [
  '[Request interrupted',
  'Base directory for this skill:',
  'Continue from where you left off',
];

function extractUserText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'user' && obj.message?.content) {
      for (const c of obj.message.content) {
        if (c.type === 'text' && c.text) {
          const text = c.text.trim();
          if (SKIP_PREFIXES.some(p => text.startsWith(p))) return null;
          return text.slice(0, 200);
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

function readChunkMessages(filePath: string, startByte: number, skipFirst: boolean): Promise<string> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: startByte });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lastMsg = '';
    let first = skipFirst;
    rl.on('line', (line) => {
      if (first) { first = false; return; }
      if (!line.trim()) return;
      const text = extractUserText(line);
      if (text) lastMsg = text;
    });
    rl.on('close', () => resolve(lastMsg));
    rl.on('error', () => resolve(''));
  });
}

async function extractLastUserMessage(filePath: string, fileSize: number): Promise<string> {
  // For large files, read the last 500KB (most likely has the last real message)
  const TAIL_BYTES = 500 * 1024;
  if (fileSize > TAIL_BYTES) {
    const result = await readChunkMessages(filePath, fileSize - TAIL_BYTES, true);
    if (result) return result;
  }
  // For small files or if tail had no messages, read entire file
  return readChunkMessages(filePath, 0, false);
}

// Convert dir name like "-home-selstad-Desktop-CascadeStudio" to readable project label
// Since hyphens are ambiguous (path sep vs part of name), reconstruct actual path
function projectLabel(dirName: string): string {
  const home = os.homedir();
  // The dir name is the absolute path with / replaced by -
  // Reconstruct by trying to find the actual directory
  const candidate = '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
  // Strip home prefix to get relative path, then take last 2 segments
  const rel = candidate.startsWith(home) ? candidate.slice(home.length + 1) : candidate;
  const segments = rel.split('/').filter(Boolean);
  if (segments.length <= 2) return segments.join('/');
  return segments.slice(-2).join('/');
}

// List resumable Claude sessions from all project directories
app.get('/api/chat/history', async (_req, res) => {
  try {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

    if (!fs.existsSync(projectsRoot)) {
      return res.json([]);
    }

    // Scan all project directories for JSONL session files
    const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory());

    interface SessionEntry {
      sessionId: string;
      project: string;
      filePath: string;
      lastMessage: string;
      modifiedAt: string;
      modifiedMs: number;
      fileSize: number;
    }

    const allSessions: SessionEntry[] = [];

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsRoot, dir.name);
      const project = projectLabel(dir.name);
      let jsonlFiles: string[];
      try {
        jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const f of jsonlFiles) {
        const fullPath = path.join(dirPath, f);
        const sessionId = f.replace('.jsonl', '');
        let stats;
        try { stats = fs.statSync(fullPath); } catch { continue; }

        allSessions.push({
          sessionId,
          project,
          filePath: fullPath,
          lastMessage: '',
          modifiedAt: stats.mtime.toISOString(),
          modifiedMs: stats.mtimeMs,
          fileSize: stats.size,
        });
      }
    }

    // Sort by file mtime (= last write = last message time), take top candidates
    allSessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
    const top = allSessions.slice(0, 100); // grab extra since some won't have messages

    await Promise.all(top.map(async (s) => {
      s.lastMessage = await extractLastUserMessage(s.filePath, s.fileSize);
    }));

    const result = top
      .filter(s => s.lastMessage)
      .slice(0, 50)
      .map(({ modifiedMs, fileSize, filePath, ...rest }) => rest);

    res.json(result);
  } catch (e) {
    console.error('Failed to list chat history:', e);
    res.status(500).json({ error: 'Failed to list chat history' });
  }
});

app.delete('/api/chat/:name', (req, res) => {
  const { name } = req.params;
  const session = chatSessions.get(name);
  if (session) {
    session.stop();
    chatSessions.delete(name);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Chat session not found' });
  }
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket servers (noServer mode for path-based routing)
const terminalWss = new WebSocketServer({ noServer: true });
const chatWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/chat') {
    chatWss.handleUpgrade(request, socket, head, (ws) => {
      chatWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Terminal WebSocket handler
interface TerminalConnection {
  pty: IPty;
  ws: WebSocket;
}

const connections = new Map<string, TerminalConnection>();

terminalWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionName = url.searchParams.get('session');
  const ctxName = url.searchParams.get('context');

  if (!sessionName) {
    ws.close(1008, 'Session name required');
    return;
  }

  const sanitized = sessionName.replace(/[^a-zA-Z0-9-_]/g, '');
  console.log(`Connecting to session: ${sanitized}${ctxName ? ` (ctx=${ctxName})` : ''}`);

  // Coordinator path: resolve the requested context (default = admin), then
  // create+attach via sudo -u when the context has a non-null user.
  let pty: IPty;
  if (COORDINATOR_MODE && contexts) {
    let ctx;
    try {
      ctx = mustFindContext(contexts, ctxName || defaultContext(contexts).name);
    } catch {
      ws.close(1008, 'Unknown context');
      return;
    }
    if (!ctxSessionExists(ctx, sanitized)) {
      if (!ctxCreateSession(ctx, sanitized)) {
        ws.close(1011, 'Failed to create session');
        return;
      }
    }
    pty = ctxSpawnAttachPty(ctx, sanitized, {
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } else {
    // Single-context (original) path.
    if (!sessionExists(sanitized)) {
      if (!createTmuxSession(sanitized)) {
        ws.close(1011, 'Failed to create session');
        return;
      }
    }
    const tmuxArgs = TMUX_SOCKET
      ? ['-S', TMUX_SOCKET, 'attach-session', '-t', sanitized]
      : ['attach-session', '-t', sanitized];
    pty = spawn('tmux', tmuxArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });
  }

  const connectionId = `${sanitized}-${Date.now()}`;
  connections.set(connectionId, { pty, ws });

  pty.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  pty.onExit(() => {
    connections.delete(connectionId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'resize' && data.cols && data.rows) {
        pty.resize(data.cols, data.rows);
      } else if (data.type === 'input' && data.data) {
        pty.write(data.data);
      }
    } catch {
      pty.write(message.toString());
    }
  });

  ws.on('close', () => {
    connections.delete(connectionId);
    pty.kill();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    connections.delete(connectionId);
    pty.kill();
  });
});

// Chat WebSocket handler
chatWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionName = url.searchParams.get('session');

  if (!sessionName) {
    ws.close(1008, 'Session name required');
    return;
  }

  const sanitized = sessionName.replace(/[^a-zA-Z0-9-_]/g, '');
  console.log(`[chat] Browser connected for session: ${sanitized}`);

  // Get or create chat session
  let chatSession = chatSessions.get(sanitized);
  if (!chatSession) {
    chatSession = new ChatSession(sanitized);
    chatSessions.set(sanitized, chatSession);
  }

  chatSession.attachBrowser(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'user' && data.text) {
        chatSession!.sendUserMessage(data.text);
      } else if (data.type === 'resume' && data.sessionId) {
        console.log(`[chat:${sanitized}] Resuming session ${data.sessionId}`);
        chatSession!.resumeSession(data.sessionId);
      } else if (data.type === 'question_response' && data.toolUseId && data.answers) {
        chatSession!.sendToolResult(data.toolUseId, JSON.stringify({ answers: data.answers }));
      } else if (data.type === 'set_cwd' && data.cwd) {
        chatSession!.setCwd(data.cwd);
      } else if (data.type === 'interrupt') {
        chatSession!.interrupt();
      }
    } catch (e) {
      console.error(`[chat:${sanitized}] Failed to parse browser message:`, e);
    }
  });

  ws.on('close', () => {
    console.log(`[chat] Browser disconnected from session: ${sanitized}`);
    chatSession!.detachBrowser(ws);
  });

  ws.on('error', (err) => {
    console.error(`[chat:${sanitized}] WebSocket error:`, err);
    chatSession!.detachBrowser(ws);
  });
});

// SPA fallback - use middleware instead of wildcard route for Express 5 compatibility
app.use((_req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// --- Listeners ---------------------------------------------------------------
//
// Two sockets with two trust levels:
//
//  1. MAIN app (terminal WS, chat WS, files/sessions API — i.e. arbitrary code
//     execution as this user) listens ONLY on a Unix-domain socket owned by
//     this user, mode 0600. cloudflared runs as the same user and is pointed at
//     `service: unix:<TERMINAL_SOCKET>`, so it can reach the app — but no other
//     local account (agent-*) and nothing on the network can open the socket.
//     There is no TCP port for the terminal API; the OS enforces the boundary.
//
//  2. NOTIFY-only listener on TCP 127.0.0.1:<PORT>, exposing solely
//     POST /api/notify. Local automation running as any user (tm-notify from an
//     agent-* account) posts here. The terminal API is NOT mounted on it, so a
//     local caller gets nothing else.
//
// Set TERMINAL_TCP=1 to serve the main app on TCP instead — used by dev.sh,
// where Vite proxies to the backend over TCP.

function startNotifyListener() {
  const notifyApp = express();
  notifyApp.use(express.json({ limit: '16kb' }));

  const clip = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.slice(0, max) : '';

  // Accept only same-origin relative paths ("/foo"). Reject absolute/scheme
  // URLs and protocol-relative "//host" so a local caller (incl. untrusted
  // agent accounts) can't craft a notification whose tap-through opens an
  // attacker page, or whose icon leaks the device to a third-party server.
  const safeRelPath = (v: unknown, fallback: string | undefined): string | undefined => {
    if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//')) return v.slice(0, 512);
    return fallback;
  };

  notifyApp.post('/api/notify', async (req, res) => {
    const title = clip(req.body?.title, 200).trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const result = await sendToAll({
        title,
        body: clip(req.body?.body, 1000),
        url: safeRelPath(req.body?.url, '/'),
        tag: req.body?.tag ? clip(req.body.tag, 100) : undefined,
        icon: safeRelPath(req.body?.icon, undefined),
        data: typeof req.body?.data === 'object' && req.body.data ? req.body.data : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 404 everything else — this listener is unmistakably notify-only.
  notifyApp.use((_req, res) => res.status(404).json({ error: 'not found' }));

  http.createServer(notifyApp).listen(Number(PORT), '127.0.0.1', () => {
    console.log(`Notify listener on http://127.0.0.1:${PORT}/api/notify (loopback; all local users)`);
  });
}

if (process.env.TERMINAL_TCP === '1') {
  const HOST = process.env.HOST || '127.0.0.1';
  server.listen(Number(PORT), HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT} (TERMINAL_TCP)`);
    console.log(`Using tmux socket: ${TMUX_SOCKET || 'default'}`);
  });
} else {
  const SOCK = process.env.TERMINAL_SOCKET
    || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'terminal-server.sock');
  try { if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK); } catch {}
  server.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o600); } catch {}
    console.log(`Server running on unix:${SOCK} (mode 0600, ${os.userInfo().username} only)`);
    console.log(`Using tmux socket: ${TMUX_SOCKET || 'default'}`);
    startNotifyListener();
  });
}
