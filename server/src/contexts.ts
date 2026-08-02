// Context-aware dispatch for the terminal coordinator.
//
// A "context" is one tmux identity — either the admin (running as the server
// user) or an agent user reached via sudo -u. When CONTEXTS_CONFIG is set and
// points to a valid JSON file, the coordinator routes session operations to
// the appropriate context. When unset/missing, the server falls back to its
// original single-context behavior.
//
// See scripts/contexts/README.md and config/contexts.example.json.

import { execFileSync, execFile, spawn as cpSpawn } from 'child_process';
import { spawn as ptySpawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface Context {
  name: string;            // internal id, e.g. "work"
  user: string | null;     // null = run as current user (admin)
  label: string;           // UI label
  tmuxSocket: string;      // tmux -S socket path for this context
  metaDir: string;         // dir Claude Code hook writes <session>.json into
  cwd: string | null;      // default cwd when creating a new session
}

export interface ContextsConfig {
  contexts: Context[];
}

export interface SessionRow {
  name: string;
  context: string;         // context.name
  created: Date;
  lastAccess: Date;
}

export function loadContexts(configPath: string | undefined | null): ContextsConfig | null {
  if (!configPath) return null;
  if (!fs.existsSync(configPath)) {
    console.warn(`[contexts] CONTEXTS_CONFIG=${configPath} does not exist; running in single-context mode`);
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.contexts)) {
      console.warn(`[contexts] ${configPath} is missing 'contexts' array; ignoring`);
      return null;
    }
    // Basic validation + defaults
    for (const c of parsed.contexts) {
      if (typeof c.name !== 'string') throw new Error(`context missing 'name'`);
      if (typeof c.tmuxSocket !== 'string') throw new Error(`context ${c.name} missing 'tmuxSocket'`);
      if (typeof c.metaDir !== 'string') throw new Error(`context ${c.name} missing 'metaDir'`);
      if (!('user' in c)) c.user = null;
      if (!('cwd' in c)) c.cwd = null;
      if (!('label' in c)) c.label = c.name;
    }
    console.log(`[contexts] loaded ${parsed.contexts.length} contexts from ${configPath}: ${parsed.contexts.map((c: Context) => c.name).join(', ')}`);
    return parsed as ContextsConfig;
  } catch (e) {
    console.error(`[contexts] failed to load ${configPath}:`, e);
    return null;
  }
}

function buildTmuxArgs(ctx: Context, args: string[]): string[] {
  return ['-S', ctx.tmuxSocket, ...args];
}

// Run `tmux <args>` synchronously in a context. Throws on error.
export function runTmuxSync(ctx: Context, args: string[]): string {
  const tmuxArgs = buildTmuxArgs(ctx, args);
  if (ctx.user) {
    return execFileSync('sudo', ['-n', '-u', ctx.user, '--', 'tmux', ...tmuxArgs], {
      encoding: 'utf-8',
    }).trim();
  }
  return execFileSync('tmux', tmuxArgs, { encoding: 'utf-8' }).trim();
}

// Async version returning exit code + stdout (never throws).
export function runTmuxAsync(ctx: Context, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const tmuxArgs = buildTmuxArgs(ctx, args);
    const cmd = ctx.user ? 'sudo' : 'tmux';
    const cmdArgs = ctx.user
      ? ['-n', '-u', ctx.user, '--', 'tmux', ...tmuxArgs]
      : tmuxArgs;
    execFile(cmd, cmdArgs, { encoding: 'utf-8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function listSessions(ctx: Context): SessionRow[] {
  try {
    const out = runTmuxSync(ctx, [
      'list-sessions',
      '-F', '#{session_name}|#{session_created}|#{session_activity}',
    ]);
    if (!out) return [];
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created, lastAccess] = line.split('|');
        return {
          name,
          context: ctx.name,
          created: new Date(parseInt(created, 10) * 1000),
          lastAccess: new Date(parseInt(lastAccess, 10) * 1000),
        };
      });
  } catch {
    return [];
  }
}

export function sessionExists(ctx: Context, name: string): boolean {
  try {
    runTmuxSync(ctx, ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// Create a new tmux session in a context. tmux's -e flag seeds the session
// env so that Claude Code's metadata hook writes to the per-context meta dir.
export function createSession(ctx: Context, name: string): boolean {
  try {
    const cwd = ctx.cwd || undefined;
    const args = ['new-session', '-d', '-s', name];
    if (cwd) args.push('-c', cwd);
    args.push('-e', `CLAUDE_META_DIR=${ctx.metaDir}`);
    args.push('-e', `TMUX_SOCKET=${ctx.tmuxSocket}`);
    runTmuxSync(ctx, args);
    return true;
  } catch (e) {
    console.error(`[contexts:${ctx.name}] failed to create session '${name}':`, (e as Error).message);
    return false;
  }
}

export function killSession(ctx: Context, name: string): boolean {
  try {
    runTmuxSync(ctx, ['kill-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// Read Claude Code metadata for one session in a context.
// Meta files are written by the Claude Code hook (as the context user) to
// ctx.metaDir. They land in /tmp so default umask 022 makes them world-readable,
// which means the coordinator can read them without sudo.
export function readMeta(ctx: Context, sessionName: string): Record<string, unknown> | undefined {
  const file = path.join(ctx.metaDir, `${sanitizeForFilename(sessionName)}.json`);
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function deleteMeta(ctx: Context, sessionName: string): void {
  const file = path.join(ctx.metaDir, `${sanitizeForFilename(sessionName)}.json`);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Best-effort; if the admin can't delete (wrong user owns it), let the
    // context user's hook clean up on next session-end.
  }
}

function sanitizeForFilename(name: string): string {
  return name.replace(/[/\\]/g, '_');
}

// Spawn a pty that attaches to the tmux session in its context.
// In admin context this is the same `tmux attach-session` the original code
// ran. In a peer context it's `sudo -u <user> tmux attach-session`, so the
// pty's child process (and therefore everything in it) runs as <user>.
export function spawnAttachPty(
  ctx: Context,
  sessionName: string,
  opts: { cols: number; rows: number; env?: NodeJS.ProcessEnv },
): IPty {
  const tmuxArgs = buildTmuxArgs(ctx, ['attach-session', '-t', sessionName]);
  const cmd = ctx.user ? 'sudo' : 'tmux';
  const args = ctx.user ? ['-n', '-u', ctx.user, '--', 'tmux', ...tmuxArgs] : tmuxArgs;
  // Intentionally no `cwd` here: node-pty does chdir() before exec(), which
  // means the chdir runs as the coordinator user (selstad) BEFORE sudo has
  // switched to the agent user. Selstad can't traverse into an agent user's
  // Desktop (mode 0750 <user>:<user>), so setting cwd to ctx.cwd produces
  // "chdir(2) failed: Permission denied". Attach-session doesn't need a cwd
  // anyway — the session's panes already have their own working directory.
  return ptySpawn(cmd, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    env: (opts.env || process.env) as { [k: string]: string },
  });
}

// Find a context by name. Throws if missing.
export function mustFindContext(cfg: ContextsConfig, name: string): Context {
  const c = cfg.contexts.find((x) => x.name === name);
  if (!c) throw new Error(`unknown context: ${name}`);
  return c;
}

// Default context (used when a request doesn't specify one).
export function defaultContext(cfg: ContextsConfig): Context {
  const admin = cfg.contexts.find((x) => x.name === 'admin') || cfg.contexts[0];
  return admin;
}

// --- Context-aware filesystem ops (Files tab) --------------------------------
// These run ordinary shell utilities (find, stat, cat, tee, mkdir, touch, mv,
// du, dd) via sudo -u <ctx.user>. For admin contexts (user=null) they run
// directly with no sudo. Rationale: the coordinator process is selstad; peer
// homes are 0710/0750 so selstad can't directly fs.readdir them, and we don't
// want to require selstad to be in every agent's group.

export function contextHome(ctx: Context): string {
  return ctx.user ? `/home/${ctx.user}` : os.homedir();
}

export function contextWorkspaceRoot(ctx: Context): string {
  return ctx.cwd || contextHome(ctx);
}

// Path must be inside the context's home dir.
export function isCtxPathSafe(ctx: Context, requestedPath: string): boolean {
  const home = contextHome(ctx);
  const resolved = path.resolve(requestedPath);
  return resolved === home || resolved.startsWith(home + path.sep);
}

function wrapSudo(ctx: Context, cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (ctx.user) return { cmd: 'sudo', args: ['-n', '-u', ctx.user, '--', cmd, ...args] };
  return { cmd, args };
}

function runSync(ctx: Context, cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const { cmd: c, args: a } = wrapSudo(ctx, cmd, args);
  return new Promise((resolve) => {
    execFile(c, a, { encoding: 'buffer', maxBuffer: opts.maxBuffer || 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
      const stderrStr = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : String(stderr || '');
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as NodeJS.ErrnoException).code as unknown as number : (err ? 1 : 0);
      resolve({ stdout: stdoutBuf, stderr: stderrStr, code });
    });
  });
}

export interface CtxFileEntry {
  name: string;
  type: 'directory' | 'file';
  size: number | null;
  modified: Date;
}

export async function ctxReadDir(ctx: Context, dirPath: string): Promise<CtxFileEntry[]> {
  const { stdout, code, stderr } = await runSync(ctx, 'find', [
    dirPath,
    '-mindepth', '1',
    '-maxdepth', '1',
    '-printf', '%f\t%y\t%s\t%T@\n',
  ]);
  if (code !== 0) throw new Error(stderr || 'find failed');
  const out: CtxFileEntry[] = [];
  for (const line of stdout.toString('utf-8').split('\n')) {
    if (!line) continue;
    const [name, typeChar, sizeStr, mtimeStr] = line.split('\t');
    const isDir = typeChar === 'd';
    out.push({
      name,
      type: isDir ? 'directory' : 'file',
      size: isDir ? null : parseInt(sizeStr, 10) || 0,
      modified: new Date((parseFloat(mtimeStr) || 0) * 1000),
    });
  }
  return out;
}

export async function ctxStat(ctx: Context, p: string): Promise<{ type: 'directory' | 'file' | 'other'; size: number; mtime: Date } | null> {
  const { stdout, code } = await runSync(ctx, 'stat', ['-c', '%F|%s|%Y', '--', p]);
  if (code !== 0) return null;
  const [fileType, sizeStr, mtimeStr] = stdout.toString('utf-8').trim().split('|');
  const t: 'directory' | 'file' | 'other' =
    fileType === 'directory' ? 'directory' : fileType === 'regular file' || fileType === 'regular empty file' ? 'file' : 'other';
  return { type: t, size: parseInt(sizeStr, 10) || 0, mtime: new Date((parseInt(mtimeStr, 10) || 0) * 1000) };
}

export async function ctxReadFile(ctx: Context, p: string, maxBytes: number): Promise<Buffer> {
  const { stdout, code, stderr } = await runSync(ctx, 'cat', ['--', p], { maxBuffer: maxBytes });
  if (code !== 0) throw new Error(stderr || 'cat failed');
  return stdout;
}

export function ctxWriteFile(ctx: Context, p: string, content: Buffer): Promise<void> {
  const { cmd, args } = wrapSudo(ctx, 'tee', ['--', p]);
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `tee exit ${code}`))));
    proc.stdin.end(content);
  });
}

// Streaming variant — pipe an input stream into `tee <dest>` as the ctx user.
// Used for uploads so we don't buffer a 100 MB file in memory.
export function ctxWriteFileStream(ctx: Context, destPath: string, input: NodeJS.ReadableStream): Promise<void> {
  const { cmd, args } = wrapSudo(ctx, 'tee', ['--', destPath]);
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `tee exit ${code}`))));
    input.on('error', reject);
    input.pipe(proc.stdin);
  });
}

// Spawn `zip -r -q - .` from <dirPath> as the ctx user. Returns a Readable of
// the zip bytes. The caller should pipe it to the HTTP response and destroy
// it on client disconnect.
export function ctxSpawnZipStream(ctx: Context, dirPath: string): Readable & { kill?: () => void } {
  // Use sh -c so we can cd as the ctx user (sudo can't set cwd across the
  // user switch in a clean way).
  const shArgs = ['-c', 'cd "$1" && zip -r -q - .', '_', dirPath];
  const { cmd, args } = wrapSudo(ctx, 'sh', shArgs);
  const proc = cpSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d: Buffer) => {
    // Bubble warnings to server log but don't kill the stream
    console.error(`[ctx:${ctx.name}] zip stderr: ${d.toString('utf-8').trim()}`);
  });
  const stream = proc.stdout as Readable & { kill?: () => void };
  stream.kill = () => { try { proc.kill(); } catch {} };
  return stream;
}

export async function ctxMkdir(ctx: Context, p: string): Promise<void> {
  const { code, stderr } = await runSync(ctx, 'mkdir', ['-p', '--', p]);
  if (code !== 0) throw new Error(stderr || 'mkdir failed');
}

export async function ctxTouch(ctx: Context, p: string): Promise<void> {
  // Only create if missing — don't update mtime of existing files
  const { code, stderr } = await runSync(ctx, 'sh', ['-c', '[ -e "$1" ] || : > "$1"', '_', p]);
  if (code !== 0) throw new Error(stderr || 'touch failed');
}

export async function ctxMove(ctx: Context, src: string, dest: string): Promise<void> {
  const { code, stderr } = await runSync(ctx, 'mv', ['--', src, dest]);
  if (code !== 0) throw new Error(stderr || 'mv failed');
}

export async function ctxExists(ctx: Context, p: string): Promise<boolean> {
  return (await ctxStat(ctx, p)) !== null;
}

export async function ctxDirSizes(ctx: Context, dirPath: string): Promise<Record<string, number>> {
  try {
    const { stdout, code } = await runSync(ctx, 'du', ['-b', '--max-depth=1', '--', dirPath]);
    if (code !== 0) return {};
    const sizes: Record<string, number> = {};
    const base = path.resolve(dirPath);
    for (const line of stdout.toString('utf-8').trim().split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const sizeStr = line.slice(0, tab);
      const p = line.slice(tab + 1);
      if (path.resolve(p) === base) continue;
      sizes[path.basename(p)] = parseInt(sizeStr, 10) || 0;
    }
    return sizes;
  } catch {
    return {};
  }
}

// Open a byte-range read stream on <filePath> using dd.
// Caller is responsible for closing by unpiping/response-close.
export function ctxOpenRead(ctx: Context, filePath: string, range?: { start: number; end: number }): Readable {
  const ddArgs: string[] = [`if=${filePath}`, 'bs=65536', 'status=none'];
  if (range) {
    ddArgs.push(`iflag=skip_bytes,count_bytes`, `skip=${range.start}`, `count=${range.end - range.start + 1}`);
  }
  const { cmd, args } = wrapSudo(ctx, 'dd', ddArgs);
  const proc = cpSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Swallow dd stderr ("N+0 records in/out") — it's noisy but harmless with status=none
  proc.stderr.on('data', () => {});
  return proc.stdout as Readable;
}
