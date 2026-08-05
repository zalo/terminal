// Iframe src resolution: localhost targets are unreachable from a remote
// client, so when the app itself is being accessed remotely they route
// through the server's path-preserving local proxy (/lp/<port>/...), which
// forwards assets, XHR, and websockets to 127.0.0.1:<port>.

export function isAppLocal(): boolean {
  return /^(localhost|127\.)/.test(window.location.hostname);
}

export function localPortOf(url: string): { port: number; path: string } | null {
  const m = url.match(/^(https?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::(\d{1,5}))?(\/[^]*)?$/i);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : m[1].toLowerCase() === 'https' ? 443 : 80;
  return { port, path: m[3] || '/' };
}

export function resolveFrameSrc(url: string): string {
  if (isAppLocal()) return url;
  const lp = localPortOf(url);
  return lp ? `/lp/${lp.port}${lp.path}` : url;
}
