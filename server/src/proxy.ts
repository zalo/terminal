// Document proxy for canvas browser tiles.
//
// Sites that send X-Frame-Options / CSP frame-ancestors refuse to render in
// an iframe. GET /api/proxy?url=<https://...> fetches the document
// server-side and re-serves it same-origin with those headers gone, a <base>
// tag so subresources load from the real origin, and a small injected script
// that reroutes link clicks and GET-form submits back through the proxy so
// basic browsing (search → results → article) keeps working.
//
// Limits: no cookies/logins, POST forms and same-origin XHR apps break —
// this is for reading, not web apps. Targets resolving to private/loopback
// addresses are refused (a framed page must not be able to reach services
// on this machine or LAN through us).

import type { Express, RequestHandler } from 'express';
import type http from 'http';
import { request as httpRequest } from 'http';
import type { Duplex } from 'stream';
import dns from 'dns/promises';
import net from 'net';
import { Readable } from 'stream';
import { ByteSlice, contentRange, ifRangeMatches, parseByteRange } from './range';

const MAX_BYTES = 20 * 1024 * 1024;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') ||
      low.startsWith('fe80') || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.') ||
      low.startsWith('::ffff:192.168.');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  return a === 127 || a === 10 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

async function isBlockedHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return true;
  }
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // unresolvable — refuse
  }
}

// ============================================================================
// Local reverse proxy: /lp/<port>/<path> → http://127.0.0.1:<port>/<path>
//
// Terminals constantly print localhost URLs (dev servers, docs previews)
// that are unreachable from a remote client. Unlike the document proxy
// below, this is path-preserving and forwards everything — HTML, assets,
// XHR, WebSocket upgrades — so SPAs work. Absolute paths in HTML are
// rewritten under the /lp/<port> prefix, and a Referer fallback catches
// runtime requests to bare absolute paths (e.g. fetch('/api/data') from a
// proxied dev app). Targets are pinned to 127.0.0.1.
// ============================================================================

const LP_RE = /^\/lp\/(\d{1,5})(\/[^]*)?$/;

function rewriteLocalHtml(html: string, port: number): string {
  return html.replace(/(\s(?:src|href|action)\s*=\s*["'])\/(?!\/|lp\/)/gi, `$1/lp/${port}/`);
}

export interface LocalProxyOptions {
  /** When set, only ports it approves are proxied; others answer 404. */
  allowPort?: (port: number) => boolean;
}

// Mounted late (just before the SPA fallback) so it never shadows the app's
// own routes; /lp/* paths and referred-from-/lp/* strays both land here.
export function localProxyMiddleware(opts: LocalProxyOptions = {}): RequestHandler {
  return (req, res, next) => {
    let port: number;
    let targetPath: string;
    const m = req.originalUrl.match(LP_RE);
    if (m) {
      port = parseInt(m[1], 10);
      targetPath = m[2] || '/';
    } else {
      const ref = String(req.headers.referer || '').match(/\/lp\/(\d{1,5})\//);
      if (!ref) return next();
      port = parseInt(ref[1], 10);
      targetPath = req.originalUrl;
    }
    if (!(port >= 1 && port <= 65535)) return res.status(400).send('local proxy: bad port');
    if (opts.allowPort && !opts.allowPort(port)) {
      return res.status(404).type('text/plain').send(`local proxy: port ${port} is not shared\n`);
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers['accept-encoding']; // html may be rewritten — skip compression
    const upstream = httpRequest(
      { host: '127.0.0.1', port, method: req.method, path: targetPath, headers },
      (ures) => {
        const outHeaders = { ...ures.headers };
        delete outHeaders['x-frame-options'];
        delete outHeaders['content-security-policy'];
        // Keep absolute-path redirects inside the prefix.
        if (typeof outHeaders.location === 'string' && outHeaders.location.startsWith('/') &&
            !outHeaders.location.startsWith('//') && !outHeaders.location.startsWith('/lp/')) {
          outHeaders.location = `/lp/${port}${outHeaders.location}`;
        }
        const status = ures.statusCode || 200;
        const ct = String(ures.headers['content-type'] || '');
        // A partial (206) HTML body is a fragment; rewriting it would be
        // meaningless and would break Content-Range, so only whole documents
        // get the path rewrite.
        if (ct.includes('text/html') && status !== 206) {
          const chunks: Buffer[] = [];
          ures.on('data', (c: Buffer) => chunks.push(c));
          ures.on('end', () => {
            const html = rewriteLocalHtml(Buffer.concat(chunks).toString('utf-8'), port);
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            delete outHeaders['content-range'];
            res.writeHead(status, outHeaders);
            res.end(html);
          });
          return;
        }

        // Range requests the upstream honored (206/416) pass straight
        // through: headers and body are already correct. When the upstream
        // ignored the Range and answered 200 with the whole resource (python
        // -m http.server, many dev servers), satisfy the range here instead:
        // media players — Safari/iOS in particular — refuse to play from a
        // server that never answers 206.
        const synth = status === 200 ? planSyntheticRange(req.headers, ures.headers) : null;
        if (synth === 'unsatisfiable') {
          const size = Number(ures.headers['content-length']);
          ures.on('error', () => {});
          ures.destroy();
          res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' });
          res.end();
          return;
        }
        if (synth) {
          const size = Number(ures.headers['content-length']);
          const partial = {
            ...outHeaders,
            'content-range': contentRange(synth, size),
            'content-length': String(synth.end - synth.start + 1),
            'accept-ranges': 'bytes',
          };
          delete partial['transfer-encoding'];
          res.writeHead(206, partial);
          ures.on('error', () => {});
          if (req.method === 'HEAD') {
            ures.destroy();
            res.end();
            return;
          }
          const slice = new ByteSlice(synth.start, synth.end);
          slice.on('sliced', () => ures.destroy()); // stop downloading the remainder
          ures.pipe(slice).pipe(res);
          return;
        }

        res.writeHead(status, outHeaders);
        ures.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).send(`local proxy: nothing listening on 127.0.0.1:${port}`);
      else res.end();
    });
    forwardRequestBody(req, upstream);
  };
}

// The app-wide express.json() has already drained JSON request bodies by the
// time we run, so piping req would never end the upstream request (it hung
// until the client gave up). Re-serialize what the parser kept; everything
// else streams through untouched.
function forwardRequestBody(req: Parameters<RequestHandler>[0], upstream: http.ClientRequest) {
  if (!req.readableEnded) {
    req.pipe(upstream);
    return;
  }
  const body = req.body === undefined ? '' : JSON.stringify(req.body);
  upstream.removeHeader('transfer-encoding');
  upstream.setHeader('content-length', Buffer.byteLength(body));
  upstream.end(body);
}

// Decide whether a 200 from the upstream can be turned into the 206 the
// client asked for. Only when the upstream clearly does not do ranges
// itself (a server that advertises `Accept-Ranges: bytes` and still sent
// 200 is reporting an If-Range mismatch, which must stay a full response),
// the body is unencoded so byte offsets line up, the total size is known,
// and the client's If-Range validator (if any) still matches.
function planSyntheticRange(
  reqHeaders: http.IncomingHttpHeaders,
  upHeaders: http.IncomingHttpHeaders,
): ReturnType<typeof parseByteRange> {
  const range = reqHeaders.range;
  if (typeof range !== 'string') return null;
  const acceptRanges = String(upHeaders['accept-ranges'] || '').toLowerCase();
  if (acceptRanges && acceptRanges !== 'none') return null;
  const encoding = String(upHeaders['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') return null;
  const size = Number(upHeaders['content-length']);
  if (!Number.isFinite(size) || upHeaders['content-length'] === undefined) return null;
  const ifRange = typeof reqHeaders['if-range'] === 'string' ? reqHeaders['if-range'] : undefined;
  if (!ifRangeMatches(ifRange, upHeaders.etag, upHeaders['last-modified'])) return null;
  return parseByteRange(range, size);
}

// WebSocket pass-through for /lp/<port>/... upgrades (dev-server HMR, apps
// with live sockets). Returns true if the upgrade was handled.
export interface LocalWsOptions extends LocalProxyOptions {
  /** Called once an upgrade to <port> has been accepted. */
  onAccept?: (port: number) => void;
}

export function handleLocalWsUpgrade(
  request: http.IncomingMessage, socket: Duplex, head: Buffer, opts: LocalWsOptions = {},
): boolean {
  const m = (request.url || '').match(LP_RE);
  if (!m) return false;
  const port = parseInt(m[1], 10);
  if (!(port >= 1 && port <= 65535)) { socket.destroy(); return true; }
  if (opts.allowPort && !opts.allowPort(port)) { socket.destroy(); return true; }
  opts.onAccept?.(port);
  const path = m[2] || '/';
  const upstream = net.connect(port, '127.0.0.1', () => {
    let raw = `${request.method} ${path} HTTP/1.1\r\n`;
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i];
      const value = key.toLowerCase() === 'host' ? `127.0.0.1:${port}` : request.rawHeaders[i + 1];
      raw += `${key}: ${value}\r\n`;
    }
    upstream.write(raw + '\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  return true;
}

// Injected into proxied documents: reroute navigation through the proxy.
const NAV_SCRIPT = `<script>(function(){
  // Absolute proxy URL: relative paths would resolve against the injected
  // <base> (the proxied site's origin), not ours.
  var ORIGIN='';try{ORIGIN=new URL(location.href).origin}catch(e){}
  var PROX=ORIGIN+'/api/proxy?url=';
  function prox(u){try{var abs=new URL(u,document.baseURI);if(abs.protocol==='http:'||abs.protocol==='https:')return PROX+encodeURIComponent(abs.href);}catch(e){}return u;}
  addEventListener('click',function(e){
    var el=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    if(!el)return;
    var href=el.getAttribute('href');
    if(!href||href.charAt(0)==='#'||href.slice(0,11)==='javascript:')return;
    e.preventDefault();e.stopPropagation();
    location.href=prox(href);
  },true);
  addEventListener('submit',function(e){
    var f=e.target;
    if(!f||!f.tagName||f.tagName!=='FORM')return;
    var method=(f.getAttribute('method')||'get').toLowerCase();
    if(method!=='get')return;
    e.preventDefault();e.stopPropagation();
    try{
      var action=new URL(f.getAttribute('action')||document.baseURI,document.baseURI);
      action.search=new URLSearchParams(new FormData(f)).toString();
      location.href=prox(action.href);
    }catch(err){}
  },true);
})()</script>`;

function rewriteHtml(html: string, finalUrl: string): string {
  const baseAttr = finalUrl.replace(/"/g, '&quot;');
  // Drop CSP / frame-busting meta tags (we serve the document, so header
  // versions are already gone).
  let out = html.replace(
    /<meta[^>]+http-equiv=["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi,
    '',
  );
  // Announce the real URL to the parent (the browser tile's URL bar).
  // Proxied frames run in an opaque-origin sandbox, so postMessage is the
  // only channel out.
  const announce = `<script>try{parent.postMessage({__tcNav:${JSON.stringify(finalUrl)}},'*')}catch(e){}</script>`;
  const inject = `<base href="${baseAttr}">${NAV_SCRIPT}${announce}`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  } else {
    out = inject + out;
  }
  return out;
}

// Frameability probe: does this URL refuse to render in an iframe?
// Browser tiles call this on direct loads and auto-switch to the document
// proxy when the answer is no — deterministic, unlike client-side guessing
// (a blocked iframe fires no reliable signal to its parent).
const frameCache = new Map<string, { frameable: boolean; at: number }>();
const FRAME_CACHE_TTL = 10 * 60 * 1000;

export function registerProxyRoutes(app: Express) {
  app.get('/api/proxy/check', async (req, res) => {
    const raw = String(req.query.url || '');
    if (!/^https?:\/\//.test(raw) || raw.length > 4000) {
      return res.status(400).json({ error: 'bad url' });
    }
    const cached = frameCache.get(raw);
    if (cached && Date.now() - cached.at < FRAME_CACHE_TTL) {
      return res.json({ frameable: cached.frameable });
    }
    let frameable = true;
    try {
      // Local/private targets are handled by /lp or unreachable — skip.
      if (!(await isBlockedHost(new URL(raw).hostname))) {
        const r = await fetch(raw, {
          redirect: 'follow',
          headers: { 'user-agent': String(req.headers['user-agent'] || 'Mozilla/5.0') },
          signal: AbortSignal.timeout(8000),
        });
        const xfo = r.headers.get('x-frame-options');
        const csp = r.headers.get('content-security-policy') || '';
        if (xfo || /frame-ancestors/i.test(csp)) frameable = false;
        try { await r.body?.cancel(); } catch { /* body already consumed */ }
      }
    } catch { /* unreachable — let the direct iframe surface the error */ }
    frameCache.set(raw, { frameable, at: Date.now() });
    res.json({ frameable });
  });

  app.get('/api/proxy', async (req, res) => {
    const raw = String(req.query.url || '');
    if (!/^https?:\/\//.test(raw) || raw.length > 4000) {
      return res.status(400).send('proxy: need an http(s) url');
    }
    let target: URL;
    try { target = new URL(raw); } catch { return res.status(400).send('proxy: bad url'); }
    if (await isBlockedHost(target.hostname)) {
      return res.status(403).send('proxy: target refused (private or unresolvable)');
    }

    try {
      const fwd: Record<string, string> = {
        'user-agent': String(req.headers['user-agent'] || 'Mozilla/5.0 (X11; Linux x86_64) TerminalCanvas/1.0'),
        accept: String(req.headers.accept || 'text/html,*/*'),
        'accept-language': String(req.headers['accept-language'] || 'en'),
      };
      // Ranged reads (media seeking, PDF viewers) pass through verbatim.
      // Identity encoding keeps the upstream's byte offsets meaningful.
      if (typeof req.headers.range === 'string') {
        fwd.range = req.headers.range;
        fwd['accept-encoding'] = 'identity';
        if (typeof req.headers['if-range'] === 'string') fwd['if-range'] = req.headers['if-range'];
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      const upstream = await fetch(target, {
        redirect: 'follow',
        headers: fwd,
        signal: abort.signal,
      }).finally(() => clearTimeout(timer));

      // Redirects may land somewhere private — re-check the final host.
      const finalUrl = new URL(upstream.url);
      if (await isBlockedHost(finalUrl.hostname)) {
        return res.status(403).send('proxy: redirect target refused');
      }

      const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
      res.status(upstream.status);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-store');

      // Whole HTML documents are buffered (bounded) and rewritten. Partial
      // HTML (206) is a fragment, so it streams like any other body.
      if (contentType.includes('text/html') && upstream.status !== 206) {
        const len = Number(upstream.headers.get('content-length') || 0);
        if (len > MAX_BYTES) return res.status(502).send('proxy: response too large');
        const html = await upstream.text();
        if (html.length > MAX_BYTES) return res.status(502).send('proxy: response too large');
        return res.send(rewriteHtml(html, upstream.url));
      }

      // Everything else streams through so large media is never held in
      // memory; range metadata is relayed so clients can seek.
      for (const h of ['content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      // fetch() transparently decodes compressed bodies, so the upstream
      // Content-Length is only truthful for identity-encoded responses.
      const enc = (upstream.headers.get('content-encoding') || 'identity').toLowerCase();
      const len = upstream.headers.get('content-length');
      if (enc === 'identity' && len) res.setHeader('content-length', len);

      if (!upstream.body || req.method === 'HEAD') {
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        return res.end();
      }
      const body = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
      res.on('close', () => { if (!body.readableEnded) body.destroy(); });
      body.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
      body.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).send(`proxy: fetch failed (${(e as Error).name})`);
      else res.end();
    }
  });
}
