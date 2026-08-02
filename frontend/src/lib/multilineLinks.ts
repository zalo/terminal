import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm';

// Link provider that detects URLs in the buffer, including URLs that were
// hard-wrapped across lines (Claude Code indents and wraps long URLs, leaving
// spaces and line breaks inside them). Wrapped segments are joined back into
// one clickable link whose underline spans all of its rows, and the URL opened
// on activation has the wrapping whitespace stripped out.

// ASCII-only RFC 3986-ish URL character set. Stops at whitespace, quotes,
// box-drawing characters, and other decoration.
const URL_CHARS = "[-a-zA-Z0-9._~:/?#[\\]@!$&'()*+,;=%]";
const URL_RE = new RegExp(`https?://${URL_CHARS}+`, 'g');
const CONTINUATION_RE = new RegExp(`^(\\s*)(${URL_CHARS}+)`);

// Signals that a URL was broken mid-token by wrapping.
const DANGLING_END = /[/\-_=&?#%+.,:;@~]$/;
const STRUCTURAL = /[/=&?#%~]/;
const LEADING_PUNCT = /^[-_+.,:;@]/;

// Logical lines to scan above/below the requested line so a multi-line URL is
// still offered when hovering its continuation rows.
const LOOKBEHIND = 6;
const LOOKAHEAD = 7;
const MAX_URL_LENGTH = 2048;

interface CharRef {
  row: number;
  col: number;
}

// A hard line with soft-wrapped rows joined; refs maps each string index back
// to its buffer position. endCol is the column of the last non-space char.
interface LogicalLine {
  text: string;
  refs: CharRef[];
  endCol: number;
}

function readLogicalLine(terminal: Terminal, startRow: number): { line: LogicalLine; nextRow: number } {
  const buffer = terminal.buffer.active;
  const recycled = buffer.getNullCell();
  let text = '';
  const refs: CharRef[] = [];
  let row = startRow;
  for (;;) {
    const bufLine = buffer.getLine(row);
    if (!bufLine) break;
    for (let col = 0; col < bufLine.length; col++) {
      const cell = bufLine.getCell(col, recycled);
      if (!cell || cell.getWidth() === 0) continue; // skip wide-char spacer cells
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) refs.push({ row, col });
      text += chars;
    }
    const next = buffer.getLine(row + 1);
    if (!next || !next.isWrapped) break;
    row++;
  }
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  return {
    line: { text: text.slice(0, end), refs: refs.slice(0, end), endCol: end > 0 ? refs[end - 1].col : -1 },
    nextRow: row + 1,
  };
}

// A continuation is joined only when the URL so far ends at end-of-line and
// the next line's leading token looks like a URL tail rather than prose.
function shouldJoin(url: string, endCol: number, cols: number, token: string, tokenToEol: boolean): boolean {
  if (!token || token.length < 2) return false;
  // Tails that don't fill their line must look substantial to count.
  if (!tokenToEol && token.length < 8) return false;
  if (DANGLING_END.test(url)) return true;
  if (STRUCTURAL.test(token) || LEADING_PUNCT.test(token)) return true;
  // The break happened right at the terminal edge: mid-token hard wrap.
  return endCol >= cols - 2;
}

// Strip trailing prose punctuation and unbalanced closing brackets.
function trimTrailingJunk(url: string): number {
  const count = (s: string, ch: string) => {
    let n = 0;
    for (const c of s) if (c === ch) n++;
    return n;
  };
  let len = url.length;
  for (;;) {
    if (!len) break;
    const c = url[len - 1];
    if ('.,;:!?"\'`'.includes(c)) {
      len--;
    } else if (c === ')' && count(url.slice(0, len), '(') < count(url.slice(0, len), ')')) {
      len--;
    } else if (c === ']' && count(url.slice(0, len), '[') < count(url.slice(0, len), ']')) {
      len--;
    } else {
      break;
    }
  }
  return len;
}

export class MultilineUrlProvider implements ILinkProvider {
  private readonly _terminal: Terminal;
  private readonly _openUri: (uri: string) => void;

  constructor(terminal: Terminal, openUri: (uri: string) => void) {
    this._terminal = terminal;
    this._openUri = openUri;
  }

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const terminal = this._terminal;
    const buffer = terminal.buffer.active;
    const row = y - 1;
    if (row < 0 || row >= buffer.length) {
      callback(undefined);
      return;
    }

    const logicalStart = (r: number): number => {
      while (r > 0 && buffer.getLine(r)?.isWrapped) r--;
      return r;
    };

    let start = logicalStart(row);
    for (let i = 0; i < LOOKBEHIND && start > 0; i++) start = logicalStart(start - 1);

    const lines: LogicalLine[] = [];
    let r = start;
    let below = 0;
    while (r < buffer.length && below < LOOKAHEAD) {
      const { line, nextRow } = readLogicalLine(terminal, r);
      lines.push(line);
      if (nextRow > row) below++;
      r = nextRow;
    }

    const links: ILink[] = [];
    for (let i = 0; i < lines.length; i++) {
      URL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = URL_RE.exec(lines[i].text))) {
        let url = match[0];
        let refs = lines[i].refs.slice(match.index, match.index + url.length);

        let li = i;
        let atEol = match.index + url.length >= lines[li].text.length;
        while (atEol && li + 1 < lines.length && url.length < MAX_URL_LENGTH) {
          const nextLine = lines[li + 1];
          const cont = CONTINUATION_RE.exec(nextLine.text);
          if (!cont || !cont[2]) break;
          const tokenStart = cont[1].length;
          const token = cont[2];
          const tokenToEol = tokenStart + token.length >= nextLine.text.length;
          if (!shouldJoin(url, lines[li].endCol, terminal.cols, token, tokenToEol)) break;
          url += token;
          refs = refs.concat(nextLine.refs.slice(tokenStart, tokenStart + token.length));
          li++;
          atEol = tokenToEol;
        }

        const len = trimTrailingJunk(url);
        url = url.slice(0, len);
        refs = refs.slice(0, len);
        if (url.length < 11) continue;
        try {
          new URL(url);
        } catch {
          continue;
        }

        const first = refs[0];
        const last = refs[refs.length - 1];
        if (row < first.row || row > last.row) continue;

        const uri = url;
        links.push({
          range: {
            start: { x: first.col + 1, y: first.row + 1 },
            end: { x: last.col + 1, y: last.row + 1 },
          },
          text: uri,
          activate: () => this._openUri(uri),
        });
      }
    }
    callback(links.length ? links : undefined);
  }
}
