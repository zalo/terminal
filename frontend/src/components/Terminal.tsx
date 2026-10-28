import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { copyText } from '../lib/clipboard';
import { MultilineUrlProvider } from '../lib/multilineLinks';
import { unwrapSelection, sourceLinesFromText, type SourceLine } from '../lib/unwrap';
import { openExternal } from '../lib/openExternal';

interface TerminalProps {
  sessionName: string;
  context?: string;
  onReady: (ref: {
    sendInput: (data: string) => void;
    paste: (text: string) => void;
    focus: () => void;
    copySelection: () => Promise<void>;
    hasSelection: () => boolean;
    enterSelectMode: () => void;
    scrollUp: () => void;
    scrollDown: () => void;
  }) => void;
  onConnectionChange?: (connected: boolean, connecting: boolean) => void;
}

const TERMINAL_ROWS = 200; // Tall terminal for scrollback history

// Copies re-join lines the TUI wrapped to the pane width (long URLs/commands
// come out as one line). Persisted; toggled from the select overlay's bar.
const UNWRAP_COPY_KEY = 'terminal.unwrapCopy';
function loadUnwrapCopy(): boolean {
  try { return localStorage.getItem(UNWRAP_COPY_KEY) !== '0'; } catch { return true; }
}

// Right-edge column of a buffer row: index just past the last non-blank cell.
function rowEdge(terminal: XTerm, row: number): number {
  const line = terminal.buffer.active.getLine(row);
  if (!line) return 0;
  const cell = terminal.buffer.active.getNullCell();
  for (let col = line.length - 1; col >= 0; col--) {
    const c = line.getCell(col, cell);
    if (!c) continue;
    const chars = c.getChars();
    if (chars && chars.trim()) return col + Math.max(1, c.getWidth());
  }
  return 0;
}

// xterm's selection text with wrapped fragments re-joined. Falls back to the
// raw selection when the buffer range can't be mapped onto it.
function getSelectionUnwrapped(terminal: XTerm): string {
  const raw = terminal.getSelection();
  const pieces = raw.split('\n');
  const pos = terminal.getSelectionPosition();
  if (pieces.length < 2 || !pos) return raw;
  const buffer = terminal.buffer.active;
  const lines: SourceLine[] = [];
  let row = pos.start.y;
  while (lines.length < pieces.length && row < buffer.length) {
    // One logical line: xterm joins soft-wrapped rows in getSelection() too.
    let text = '';
    let edge = 0;
    for (;;) {
      const line = buffer.getLine(row);
      if (!line) break;
      text += line.translateToString(true);
      edge = rowEdge(terminal, row);
      row++;
      const next = buffer.getLine(row);
      if (!next || !next.isWrapped) break;
    }
    lines.push({ text: text.trimEnd(), edge });
  }
  return unwrapSelection(pieces, lines, terminal.cols);
}

// Reveal the cursor by scrolling the outer container. Scroll overrides are only
// ever applied downward: if the cursor is already visible, or revealing it would
// mean scrolling up, the user's position is left alone (a viewport refresh /
// keyboard toggle used to yank the view upward mid-typing because of a rough
// 17px row estimate that drifted from xterm's real cell height).
function scrollDownToCursor(container: HTMLElement, terminal: XTerm, onlyIfHidden: boolean) {
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  const measured = screen && terminal.rows > 0 ? screen.offsetHeight / terminal.rows : 0;
  const rowHeight = measured > 0 ? measured : 17;

  const cursorRow = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
  const cursorPixelPosition = cursorRow * rowHeight;
  const scrollTop = container.scrollTop;
  const containerHeight = container.clientHeight;

  if (onlyIfHidden) {
    const cursorVisible = cursorPixelPosition >= scrollTop &&
                          cursorPixelPosition + rowHeight <= scrollTop + containerHeight;
    if (cursorVisible) return;
  }

  // Show cursor well above the bottom of the visible area (extra 200px for keyboard)
  const targetScroll = Math.max(0, cursorPixelPosition - containerHeight + rowHeight * 3 + 200);
  if (targetScroll > scrollTop) {
    container.scrollTop = targetScroll;
  }
}

export default function Terminal({ sessionName, context, onReady, onConnectionChange }: TerminalProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const manualScrollRef = useRef(false); // Track if user manually scrolled via buttons
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isUnmountedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [selectText, setSelectText] = useState<string | null>(null);
  const selectTextRef = useRef<string | null>(null);
  selectTextRef.current = selectText;
  const [copiedAll, setCopiedAll] = useState(false);
  const overlayScrollRef = useRef<HTMLDivElement>(null);
  const [unwrapCopy, setUnwrapCopy] = useState<boolean>(loadUnwrapCopy);
  const unwrapCopyRef = useRef(unwrapCopy);
  unwrapCopyRef.current = unwrapCopy;

  const toggleUnwrapCopy = useCallback(() => {
    setUnwrapCopy((v) => {
      try { localStorage.setItem(UNWRAP_COPY_KEY, v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }, []);

  // Text of the native selection inside the select overlay, unwrapped when
  // enabled. Null when the selection isn't inside the overlay.
  const getOverlaySelection = useCallback((): string | null => {
    const pre = overlayScrollRef.current?.querySelector('pre');
    const sel = window.getSelection();
    const all = selectTextRef.current;
    if (!pre || !sel || sel.rangeCount === 0 || sel.isCollapsed || all === null) return null;
    const range = sel.getRangeAt(0);
    if (!pre.contains(range.commonAncestorContainer)) return null;
    const raw = sel.toString();
    if (!unwrapCopyRef.current) return raw;
    const pieces = raw.split('\n');
    if (pieces.length < 2) return raw;
    // Locate the selection start within the overlay text to find its line
    const before = range.cloneRange();
    before.selectNodeContents(pre);
    before.setEnd(range.startContainer, range.startOffset);
    const startIdx = before.toString().length;
    const allLines = all.split('\n');
    let lineIdx = 0;
    for (let consumed = 0; lineIdx < allLines.length - 1; lineIdx++) {
      consumed += allLines[lineIdx].length + 1;
      if (consumed > startIdx) break;
    }
    const lines = sourceLinesFromText(allLines.slice(lineIdx, lineIdx + pieces.length));
    return unwrapSelection(pieces, lines, terminalRef.current?.cols ?? 80);
  }, []);

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionChange?.(connected, connecting);
  }, [connected, connecting, onConnectionChange]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
      manualScrollRef.current = false; // Reset manual scroll when user types
    }
  }, []);

  const paste = useCallback((text: string) => {
    // terminal.paste() respects bracketed paste mode, so multi-line pastes
    // arrive as one block instead of executing line by line
    terminalRef.current?.paste(text);
    manualScrollRef.current = false;
  }, []);

  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const copySelection = useCallback(async () => {
    const term = terminalRef.current;
    const selection = term ? (unwrapCopyRef.current ? getSelectionUnwrapped(term) : term.getSelection()) : '';
    if (selection) {
      const ok = await copyText(selection);
      if (!ok) console.error('Failed to copy selection');
    }
  }, []);

  const hasSelection = useCallback(() => {
    return terminalRef.current?.hasSelection() || false;
  }, []);

  // Select mode: snapshot the buffer as plain text in an overlay where native
  // browser selection (long-press on mobile, drag on desktop) just works —
  // xterm's constant re-rendering can't clobber it.
  const enterSelectMode = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    setSelectText(lines.join('\n'));
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectText(null);
    setCopiedAll(false);
    terminalRef.current?.focus();
  }, []);

  const handleCopyAll = useCallback(async () => {
    if (!selectText) return;
    let text = selectText;
    if (unwrapCopy) {
      const lines = selectText.split('\n');
      text = unwrapSelection(lines, sourceLinesFromText(lines), terminalRef.current?.cols ?? 80);
    }
    if (await copyText(text)) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    }
  }, [selectText, unwrapCopy]);

  // Mirror the terminal's scroll position when the overlay opens
  useEffect(() => {
    if (selectText !== null && overlayScrollRef.current && scrollContainerRef.current) {
      overlayScrollRef.current.scrollTop = scrollContainerRef.current.scrollTop;
    }
  }, [selectText]);

  const scrollUp = useCallback(() => {
    if (scrollContainerRef.current) {
      manualScrollRef.current = true;
      scrollContainerRef.current.scrollBy({ top: -300, behavior: 'smooth' });
    }
  }, []);

  const scrollDown = useCallback(() => {
    if (scrollContainerRef.current) {
      manualScrollRef.current = true;
      scrollContainerRef.current.scrollBy({ top: 300, behavior: 'smooth' });
    }
  }, []);

  // Handle visual viewport changes (keyboard appearing/disappearing)
  useEffect(() => {
    const updateViewportHeight = () => {
      if (window.visualViewport) {
        setViewportHeight(window.visualViewport.height);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      updateViewportHeight();
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateViewportHeight);
      }
    };
  }, []);

  // Scroll to cursor position when viewport height changes (keyboard appears)
  // Only scroll if needed to keep cursor visible, and scroll to cursor not to bottom
  useEffect(() => {
    // Skip if user manually scrolled via buttons
    if (manualScrollRef.current) return;

    if (scrollContainerRef.current && terminalRef.current && viewportHeight !== null) {
      // Only scroll if the cursor is hidden (e.g. keyboard pushed it off screen),
      // and never upward.
      scrollDownToCursor(scrollContainerRef.current, terminalRef.current, true);
    }
  }, [viewportHeight]);

  const connectWebSocket = useCallback(() => {
    if (isUnmountedRef.current) return;

    setConnecting(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?session=${encodeURIComponent(sessionName)}${context ? `&context=${encodeURIComponent(context)}` : ''}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);

      if (scrollContainerRef.current) {
        const containerWidth = scrollContainerRef.current.clientWidth - 16;
        const charWidth = 8.4;
        const cols = Math.floor(containerWidth / charWidth);
        ws.send(JSON.stringify({ type: 'resize', cols: Math.max(cols, 40), rows: TERMINAL_ROWS }));
      }
    };

    ws.onmessage = (event) => {
      if (terminalRef.current) {
        terminalRef.current.write(event.data);
      }
    };

    ws.onerror = () => {
      setConnected(false);
      setConnecting(false);
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);

      if (isUnmountedRef.current) return;

      // Flat 2-second reconnect (simpler, more responsive for local server)
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = window.setTimeout(() => {
        if (!isUnmountedRef.current) {
          connectWebSocket();
        }
      }, 2000);
    };
  }, [sessionName, context]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      rows: TERMINAL_ROWS,
      cols: 80,
      scrollback: 0, // Disable internal scrollback since we're using container scroll
      theme: {
        background: '#1a1a2e',
        foreground: '#e2e8f0',
        cursor: '#4fd1c5',
        cursorAccent: '#1a1a2e',
        selectionBackground: 'rgba(79, 209, 197, 0.4)',
        selectionForeground: '#ffffff',
        black: '#3f3f46',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#4fd1c5',
        white: '#e2e8f0',
        brightBlack: '#71717a',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#5eead4',
        brightWhite: '#f8fafc',
      },
      allowProposedApi: true,
    });

    terminalRef.current = terminal;

    // TUIs like Claude Code (and tmux with mouse on) enable terminal mouse
    // tracking, which makes xterm forward drags to the app instead of
    // selecting locally — "selections" then land in tmux's paste buffer
    // ("paste with prefix + ]") and never reach the system clipboard. Swallow
    // the tracking-enable sequences so dragging always selects locally.
    // Scrolling is unaffected (the outer container owns wheel/touch scroll).
    const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      const flat: number[] = [];
      for (const p of params) {
        if (Array.isArray(p)) flat.push(...p);
        else flat.push(p);
      }
      return flat.length > 0 && flat.every((p) => MOUSE_TRACKING_MODES.has(p));
    });

    // Load fit addon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Linkify URLs, joining URLs hard-wrapped across lines (Claude Code
    // indents and wraps long ones) into a single clickable link
    terminal.registerLinkProvider(
      new MultilineUrlProvider(terminal, openExternal)
    );

    // Open terminal in container
    terminal.open(containerRef.current);

    // Ctrl/Cmd+C copies an active selection instead of sending SIGINT (no
    // selection: ^C still interrupts). Ctrl/Cmd+V is left entirely to the
    // browser so the native paste event fires — otherwise xterm sends ^V to
    // the shell, which Claude Code interprets as "paste image from host
    // clipboard" and text paste never happens.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyV') return false;
      if (mod && e.code === 'KeyC') {
        if (terminal.hasSelection()) {
          copyText(unwrapCopyRef.current ? getSelectionUnwrapped(terminal) : terminal.getSelection());
          terminal.clearSelection();
          return false;
        }
        if (e.shiftKey) return false;
      }
      return true;
    });

    // Let wheel/scroll events pass through to the outer scroll container
    // instead of being intercepted by xterm (which converts them to arrow keys)
    terminal.attachCustomWheelEventHandler(() => false);

    // The custom wheel handler above isn't enough when the app inside tmux
    // enables mouse reporting (Claude Code does): xterm binds its own wheel
    // listener that unconditionally preventDefaults, killing trackpad/wheel
    // scrolling on desktop. Stop wheel events in the capture phase so they
    // never reach xterm and the container scrolls natively.
    const scrollContainer = scrollContainerRef.current;
    const handleWheelCapture = (e: WheelEvent) => {
      e.stopPropagation();
      manualScrollRef.current = true; // same as the scroll buttons: don't auto-jump to cursor
    };
    scrollContainer?.addEventListener('wheel', handleWheelCapture, {
      capture: true,
      passive: true,
    });

    // WebGL disabled — causes glyph corruption on this system (Playwright Chrome install may have broken GPU context)
    // Using xterm.js DOM renderer instead

    // Get the actual column width based on container
    const updateCols = () => {
      if (scrollContainerRef.current) {
        const containerWidth = scrollContainerRef.current.clientWidth - 16; // padding
        const charWidth = 8.4; // approximate char width for 14px font
        const cols = Math.floor(containerWidth / charWidth);
        terminal.resize(Math.max(cols, 40), TERMINAL_ROWS);
      }
    };

    requestAnimationFrame(updateCols);

    // Connect WebSocket
    connectWebSocket();

    // Handle terminal input
    terminal.onData((data) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Inputs that manage their own clipboard (rich-text box, etc.) — the
    // document-level handlers below must leave those alone.
    const isForeignTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.closest?.('.select-overlay')) return true;
      return (
        (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
        !el.classList.contains('xterm-helper-textarea')
      );
    };

    const uploadPastedImage = async (file: File) => {
      try {
        const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const form = new FormData();
        form.append('file', file, `pasted-image.${ext}`);
        const res = await fetch('/api/paste-image', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        const { path } = await res.json();
        terminal.paste(path);
      } catch (err) {
        console.error('Failed to paste image:', err);
      }
    };

    // Document-level paste: works no matter where focus ended up (buttons,
    // body, xterm's hidden textarea). Images are uploaded to the server and
    // their path typed into the terminal for CLI tools to read.
    const handlePasteEvent = (e: ClipboardEvent) => {
      if (isForeignTarget(e.target)) return;
      if (!e.clipboardData) return;
      e.preventDefault();
      e.stopPropagation(); // keep xterm's own paste handler from double-pasting
      const imageItem = Array.from(e.clipboardData.items).find(
        (item) => item.kind === 'file' && item.type.startsWith('image/')
      );
      const imageFile = imageItem?.getAsFile();
      if (imageFile) {
        uploadPastedImage(imageFile);
        return;
      }
      const text = e.clipboardData.getData('text/plain');
      if (text) terminal.paste(text);
    };

    // Document-level copy: covers Edit-menu / context-menu copy while an
    // xterm selection is active (there's no DOM selection to copy natively)
    const handleCopyEvent = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      // Native selection inside the select overlay (mobile long-press flow)
      const overlayText = getOverlaySelection();
      if (overlayText !== null) {
        e.clipboardData.setData('text/plain', overlayText);
        e.preventDefault();
        return;
      }
      if (isForeignTarget(e.target)) return;
      if (terminal.hasSelection()) {
        const text = unwrapCopyRef.current ? getSelectionUnwrapped(terminal) : terminal.getSelection();
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };

    document.addEventListener('paste', handlePasteEvent, true);
    document.addEventListener('copy', handleCopyEvent, true);

    // iOS/touch: long-press opens the native-selection overlay, since touch
    // can't drive xterm's mouse-based selection model
    let touchTimer: number | null = null;
    let touchStartX = 0;
    let touchStartY = 0;
    const clearTouchTimer = () => {
      if (touchTimer !== null) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }
    };
    const handleTouchStart = (e: TouchEvent) => {
      clearTouchTimer();
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchTimer = window.setTimeout(() => {
        touchTimer = null;
        enterSelectMode();
      }, 500);
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (touchTimer === null) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - touchStartX) > 10 || Math.abs(t.clientY - touchStartY) > 10) {
        clearTouchTimer();
      }
    };
    const scrollEl = scrollContainerRef.current;
    scrollEl?.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollEl?.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollEl?.addEventListener('touchend', clearTouchTimer, { passive: true });
    scrollEl?.addEventListener('touchcancel', clearTouchTimer, { passive: true });

    // Handle container resize - also notify server of new size
    const resizeObserver = new ResizeObserver(() => {
      updateCols();
      if (wsRef.current?.readyState === WebSocket.OPEN && scrollContainerRef.current) {
        const containerWidth = scrollContainerRef.current.clientWidth - 16;
        const charWidth = 8.4;
        const cols = Math.floor(containerWidth / charWidth);
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: Math.max(cols, 40), rows: TERMINAL_ROWS }));
      }
    });
    if (scrollContainerRef.current) {
      resizeObserver.observe(scrollContainerRef.current);
    }

    // Expose methods to parent
    onReady({ sendInput, paste, focus, copySelection, hasSelection, enterSelectMode, scrollUp, scrollDown });

    // Scroll to cursor position initially
    if (scrollContainerRef.current) {
      scrollDownToCursor(scrollContainerRef.current, terminal, false);
    }

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      document.removeEventListener('paste', handlePasteEvent, true);
      document.removeEventListener('copy', handleCopyEvent, true);
      clearTouchTimer();
      scrollEl?.removeEventListener('touchstart', handleTouchStart);
      scrollEl?.removeEventListener('touchmove', handleTouchMove);
      scrollEl?.removeEventListener('touchend', clearTouchTimer);
      scrollEl?.removeEventListener('touchcancel', clearTouchTimer);
      scrollContainer?.removeEventListener('wheel', handleWheelCapture, true);
      resizeObserver.disconnect();
      wsRef.current?.close();
      webglAddonRef.current?.dispose();
      terminal.dispose();
    };
  }, [sessionName, onReady, connectWebSocket, sendInput, paste, focus, copySelection, hasSelection, enterSelectMode, scrollUp, scrollDown, getOverlaySelection]);

  // Calculate container height based on viewport
  const containerStyle: React.CSSProperties = viewportHeight
    ? { height: `${viewportHeight - 140}px` } // Subtract header + control bar + extra padding
    : { height: '100%' };

  return (
    <div className="relative" style={containerStyle}>
      <div
        ref={scrollContainerRef}
        className="terminal-scroll-container"
      >
        <div
          ref={containerRef}
          className="terminal-inner"
        />
      </div>
      {selectText !== null && (
        <div className="select-overlay">
          <div className="select-overlay-bar">
            <span className="select-overlay-hint">Select text to copy</span>
            <button
              className={`control-btn px-3${unwrapCopy ? ' active' : ''}`}
              onClick={toggleUnwrapCopy}
              title="Re-join lines that were wrapped to the terminal width when copying"
            >
              {unwrapCopy ? 'Unwrap ✓' : 'Unwrap'}
            </button>
            <button className="control-btn px-3" onClick={handleCopyAll}>
              {copiedAll ? 'Copied ✓' : 'Copy all'}
            </button>
            <button className="control-btn active px-3" onClick={exitSelectMode}>
              Done
            </button>
          </div>
          <div ref={overlayScrollRef} className="select-overlay-scroll">
            <pre className="select-overlay-text">{selectText}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
