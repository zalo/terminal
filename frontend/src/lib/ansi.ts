// Minimal ANSI-SGR → HTML renderer for canvas session tiles.
//
// Input is `tmux capture-pane -e` output: plain lines containing only SGR
// (color/attribute) escape sequences. This is NOT a terminal emulator — no
// cursor movement handling — which is exactly why tiles are cheap compared
// to mounting an xterm instance per session.

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

const INVERSE_BG = '#d3d8ea';
const INVERSE_FG = '#101024';

// 16-color palette tuned to the Nightglass theme.
const BASE16 = [
  '#2a2a44', '#f87171', '#68d391', '#f6ad55',
  '#63b3ed', '#b794f4', '#4fd1c5', '#c6ccdf',
  '#5b6084', '#fca5a5', '#9ae6b4', '#fbd38d',
  '#90cdf4', '#d6bcfa', '#81e6d9', '#f1f5f9',
];

function color256(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const idx = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(idx / 36) % 6];
    const g = steps[Math.floor(idx / 6) % 6];
    const b = steps[idx % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

function freshStyle(): Style {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

function applySgr(style: Style, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0: Object.assign(style, freshStyle()); break;
      case 1: style.bold = true; break;
      case 2: style.dim = true; break;
      case 3: style.italic = true; break;
      case 4: style.underline = true; break;
      case 7: style.inverse = true; break;
      case 9: style.strike = true; break;
      case 22: style.bold = false; style.dim = false; break;
      case 23: style.italic = false; break;
      case 24: style.underline = false; break;
      case 27: style.inverse = false; break;
      case 29: style.strike = false; break;
      case 39: style.fg = null; break;
      case 49: style.bg = null; break;
      case 38:
      case 48: {
        const target = p === 38 ? 'fg' : 'bg';
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          style[target] = color256(params[i + 2]);
          i += 2;
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          style[target] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          i += 4;
        }
        break;
      }
      default:
        if (p >= 30 && p <= 37) style.fg = BASE16[p - 30];
        else if (p >= 90 && p <= 97) style.fg = BASE16[p - 90 + 8];
        else if (p >= 40 && p <= 47) style.bg = BASE16[p - 40];
        else if (p >= 100 && p <= 107) style.bg = BASE16[p - 100 + 8];
    }
  }
}

function styleCss(s: Style): string {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    const f = fg || INVERSE_FG;
    fg = bg || INVERSE_BG;
    bg = f === (bg || INVERSE_BG) ? INVERSE_FG : f;
    // Simplest faithful-enough inverse: swap, with defaults filled in.
    fg = s.bg || INVERSE_FG;
    bg = s.fg || INVERSE_BG;
  }
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (s.bold) parts.push('font-weight:600');
  if (s.dim) parts.push('opacity:.55');
  if (s.italic) parts.push('font-style:italic');
  if (s.underline && s.strike) parts.push('text-decoration:underline line-through');
  else if (s.underline) parts.push('text-decoration:underline');
  else if (s.strike) parts.push('text-decoration:line-through');
  return parts.join(';');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// URLs become clickable spans (SessionTile delegates the click to open an
// in-canvas browser tile). Note: capture-pane hard-wraps long lines, so a
// URL that wraps only linkifies its first line.
const URL_RE = /https?:\/\/[^\s'"<>()[\]{}]+/g;

function linkify(text: string): string {
  URL_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    // Trim trailing punctuation that's likely sentence context.
    let url = m[0].replace(/[.,;:!?]+$/, '');
    out += escapeHtml(text.slice(last, m.index));
    const attr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    out += `<span class="term-link" data-url="${attr}">${escapeHtml(url)}</span>`;
    last = m.index + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// Strip escape sequences other than SGR (OSC titles, other CSI, etc.).
const NON_SGR = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-LN-Za-ln-z]|\x1b[^[\]]/g;
const SGR = /\x1b\[([0-9;:]*)m/g;

export function ansiToHtml(lines: string[]): string {
  const style = freshStyle();
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(NON_SGR, '');
    let html = '';
    let last = 0;
    SGR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR.exec(line)) !== null) {
      if (m.index > last) {
        const css = styleCss(style);
        const text = linkify(line.slice(last, m.index));
        html += css ? `<span style="${css}">${text}</span>` : text;
      }
      const params = m[1]
        ? m[1].replace(/:/g, ';').split(';').map((v) => (v === '' ? 0 : parseInt(v, 10)))
        : [0];
      applySgr(style, params);
      last = m.index + m[0].length;
    }
    if (last < line.length) {
      const css = styleCss(style);
      const text = linkify(line.slice(last));
      html += css ? `<span style="${css}">${text}</span>` : text;
    }
    out.push(html);
  }
  return out.join('\n');
}
