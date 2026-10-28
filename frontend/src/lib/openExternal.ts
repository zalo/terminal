// Open a URL outside the current document. Never navigates the current tab:
// the web terminal is a long-lived tmux view (and on iPhone a Home Screen PWA
// where a same-tab navigation replaces the whole app).
//
// - Desktop / mobile browser: new tab via a synthetic <a target=_blank> click.
//   This is more reliable than window.open(..., 'noopener') inside link
//   handlers on WebKit, where a null-returning noopener open has been seen to
//   navigate the opener instead.
// - iOS standalone PWA: hand the URL to Chrome via its googlechrome(s)://
//   scheme, and nothing else. An earlier "fall back to _blank if we're still
//   visible" safety net double-opened every link: the PWA doesn't reliably
//   report itself hidden while Chrome is launching, so the fallback fired too.
//   If Chrome isn't installed the tap is a no-op; long-press the link to copy
//   it instead.

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS desktop UA
}

function isStandalone(): boolean {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function openBlank(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function chromeScheme(url: string): string | null {
  if (/^https:\/\//i.test(url)) return 'googlechromes://' + url.slice('https://'.length);
  if (/^http:\/\//i.test(url)) return 'googlechrome://' + url.slice('http://'.length);
  return null;
}

export function openExternal(url: string): void {
  const chrome = isIos() && isStandalone() ? chromeScheme(url) : null;
  if (chrome) {
    window.location.href = chrome;
    return;
  }
  openBlank(url);
}
