// Re-joins text that a TUI (Claude Code, the shell, tmux) wrapped to the pane
// width, so a copied URL or command comes out as one line instead of several
// indented fragments. Works on a copied selection plus the full buffer lines it
// came from, so wrap decisions can use the real right-edge column of each line.
//
// Observed layout (Claude Code inside tmux): text wraps flush to the pane's
// last column. A word-boundary wrap leaves the line short of the edge (the next
// word would not have fit); a mid-token wrap fills the line exactly.
// Continuation rows share the paragraph's indentation. New blocks start with a
// marker (⏺ ⎿ ❯ table borders, list bullets) or change indentation.
//
// Failure direction is deliberately "keep the newline": a boundary is only
// joined when the evidence says it was a wrap.

export interface SourceLine {
  /** Full logical line, trailing whitespace removed. */
  text: string;
  /** Right-edge column (number of columns the line occupies). */
  edge: number;
}

// Leading whitespace and TUI decoration glyphs (bullets, tree/tool markers,
// box borders, spinners). Stripped from continuation pieces and used to
// measure a line's content indentation.
const DECOR = /^[\s●○◐◑◒◓⏺❯⎿※✻✽✢·✓✔✗✘⚠▸▶→∙]+/;
// Glyphs that mark the start of a new block rather than wrapped continuation.
const BLOCK_MARK = /^\s*[●○◐◑◒◓⏺❯⎿│┃┌┐└┘├┤┬┴┼─═╭╮╰╯※✻✽✢▸▶]/;
const BULLET = /^([-*•]|\d+[.)])\s/;

// Token looks like a URL / path / key=value: a mid-token break is plausible.
const URLISH = /[/\\=&?#%~@]|:\/\//;
// A piece ending / beginning with joiner punctuation was cut mid-token.
const GLUE_END = /[-_=+/&?#]$/;
// A piece ending in a statement/list separator, or a piece that starts a
// NAME=value assignment, was wrapped at a real space.
const SOFT_END = /[;,]$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GLUE_START = /^[_=+/.,:;?&#%]/;
// Long runs (hashes, base64, identifiers) are cut mid-token regardless.
const LONG_TOKEN = 24;
// Word-boundary wraps leave at least this much slack before the edge.
const FIT_SLACK = 2;

function indentOf(text: string): number {
  return DECOR.exec(text)?.[0].length ?? 0;
}

function body(piece: string): string {
  return piece.replace(DECOR, '').trimEnd();
}

function firstToken(s: string): string {
  return s.split(/\s+/, 1)[0] ?? '';
}

function lastToken(s: string): string {
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

// Mid-token cut vs word-boundary wrap that happened to fill the line exactly.
function glue(tokA: string, tokB: string): boolean {
  if (/^--/.test(tokB)) return false; // a CLI flag is its own word
  if (GLUE_END.test(tokA)) return true;
  if (SOFT_END.test(tokA) || ASSIGNMENT.test(tokB)) return false;
  if (URLISH.test(tokA) || URLISH.test(tokB)) return true;
  if (GLUE_START.test(tokB)) return true;
  return tokA.length + tokB.length >= LONG_TOKEN;
}

/**
 * @param pieces  Selected text split on '\n' (one entry per logical line).
 * @param lines   The full source line each piece came from, same length.
 * @param width   Pane width in columns (the wrap edge).
 */
export function unwrapSelection(pieces: string[], lines: SourceLine[], width: number): string {
  if (pieces.length < 2) return pieces.join('');
  if (lines.length !== pieces.length || width <= 0) return pieces.join('\n');

  let out = body(pieces[0]);
  for (let i = 1; i < pieces.length; i++) {
    const a = body(pieces[i - 1]);
    const b = body(pieces[i]);
    let sep: string;

    if (!a || !b) {
      sep = '\n';
    } else if (BLOCK_MARK.test(lines[i].text) || BULLET.test(b)) {
      sep = '\n';
    } else {
      const indA = indentOf(lines[i - 1].text);
      const indB = indentOf(lines[i].text);
      const tokB = firstToken(b);
      if (indB < indA || indB > indA + 4) {
        sep = '\n';
      } else if (lines[i - 1].edge + 1 + tokB.length <= width - FIT_SLACK) {
        // The next word would have fit on the previous line: deliberate break.
        sep = '\n';
      } else if (lines[i - 1].edge >= width && glue(lastToken(a), tokB)) {
        sep = '';
      } else {
        sep = ' ';
      }
    }
    out += sep + b;
  }
  return out;
}

/** Split a block of text into SourceLines, using string length as the edge. */
export function sourceLinesFromText(lines: string[]): SourceLine[] {
  return lines.map((t) => {
    const text = t.trimEnd();
    return { text, edge: text.length };
  });
}
