import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';

interface TerminalProps {
  sessionName: string;
  onReady: (ref: {
    sendInput: (data: string) => void;
    focus: () => void;
    copySelection: () => Promise<void>;
    hasSelection: () => boolean;
    scrollUp: () => void;
    scrollDown: () => void;
  }) => void;
  onConnectionChange?: (connected: boolean, connecting: boolean) => void;
}

// Dynamic row calculation based on content
const MIN_ROWS = 24;  // Reasonable minimum
const ROW_HEIGHT = 17; // pixels per row (fontSize 14px * ~1.2 lineHeight)
const EXTRA_ROWS = 5; // Buffer rows below cursor

export default function Terminal({ sessionName, onReady, onConnectionChange }: TerminalProps) {
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
  const [terminalHeight, setTerminalHeight] = useState<number>(0); // Dynamic terminal height

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

  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const copySelection = useCallback(async () => {
    if (terminalRef.current) {
      const selection = terminalRef.current.getSelection();
      if (selection) {
        try {
          await navigator.clipboard.writeText(selection);
        } catch (e) {
          console.error('Failed to copy:', e);
        }
      }
    }
  }, []);

  const hasSelection = useCallback(() => {
    return terminalRef.current?.hasSelection() || false;
  }, []);

  // Calculate the required terminal rows based on buffer content
  const calculateRequiredRows = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return MIN_ROWS;

    const buffer = terminal.buffer.active;
    const baseY = buffer.baseY;        // Total rows in scrollback buffer
    const cursorY = buffer.cursorY;    // Cursor row in viewport (0-indexed)

    // Total visible rows needed = baseY (scrollback) + cursorY (current position) + EXTRA_ROWS
    // This ensures cursor is always visible with some buffer below
    return Math.max(MIN_ROWS, baseY + cursorY + EXTRA_ROWS);
  }, []);

  // Resize terminal to fit content
  const resizeTerminalToContent = useCallback(() => {
    const terminal = terminalRef.current;
    const ws = wsRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!terminal || !ws || ws.readyState !== WebSocket.OPEN || !scrollContainer) return;

    const requiredRows = calculateRequiredRows();
    const currentRows = terminal.rows;

    // Only resize if we need more rows (never shrink to avoid losing content visibility)
    if (requiredRows > currentRows) {
      // Calculate columns based on container width
      const containerWidth = scrollContainer.clientWidth - 16; // padding
      const charWidth = 8.4;
      const cols = Math.max(Math.floor(containerWidth / charWidth), 40);

      terminal.resize(cols, requiredRows);
      ws.send(JSON.stringify({ type: 'resize', cols, rows: requiredRows }));

      // Update container height to fit terminal content
      const newHeight = requiredRows * ROW_HEIGHT + 16; // +16 for padding
      setTerminalHeight(newHeight);
    }
  }, [calculateRequiredRows]);

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

  // Handle viewport changes (keyboard appearing/disappearing)
  // When viewport shrinks, we may need to reduce terminal size or scroll to keep cursor visible
  useEffect(() => {
    // Skip if user manually scrolled via buttons
    if (manualScrollRef.current) return;

    if (scrollContainerRef.current && terminalRef.current && viewportHeight !== null) {
      const container = scrollContainerRef.current;
      const terminal = terminalRef.current;

      // Get cursor position
      const cursorY = terminal.buffer.active.cursorY;
      const baseY = terminal.buffer.active.baseY;
      const cursorRow = baseY + cursorY;

      // Calculate how many rows can fit in the new viewport
      const availableHeight = viewportHeight - 140 - 16; // minus container padding
      const maxRowsFromViewport = Math.floor(availableHeight / ROW_HEIGHT);

      // If viewport is too small for current content, shrink terminal
      const totalContentRows = baseY + cursorY + EXTRA_ROWS;
      if (totalContentRows > maxRowsFromViewport && maxRowsFromViewport >= MIN_ROWS) {
        terminal.resize(terminal.cols, maxRowsFromViewport);
        wsRef.current?.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: maxRowsFromViewport }));
        setTerminalHeight(maxRowsFromViewport * ROW_HEIGHT + 16);
      }

      // Also scroll to keep cursor visible
      const rowHeight = ROW_HEIGHT;
      const cursorPixelPosition = cursorRow * rowHeight;
      const scrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;
      const cursorVisible = cursorPixelPosition >= scrollTop &&
                           cursorPixelPosition < scrollTop + containerHeight - rowHeight;

      if (!cursorVisible) {
        const targetScroll = Math.max(0, cursorPixelPosition - containerHeight + rowHeight * 3 + 200);
        container.scrollTop = targetScroll;
      }
    }
  }, [viewportHeight]);

  const connectWebSocket = useCallback(() => {
    if (isUnmountedRef.current) return;

    setConnecting(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?session=${sessionName}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);

      if (scrollContainerRef.current) {
        const containerWidth = scrollContainerRef.current.clientWidth - 16;
        const charWidth = 8.4;
        const cols = Math.floor(containerWidth / charWidth);
        ws.send(JSON.stringify({ type: 'resize', cols: Math.max(cols, 40), rows: MIN_ROWS }));
      }
    };

    ws.onmessage = (event) => {
      if (terminalRef.current) {
        terminalRef.current.write(event.data);
        // After writing data, check if terminal needs to grow to show all content
        resizeTerminalToContent();
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
  }, [sessionName]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      rows: MIN_ROWS,
      cols: 80,
      scrollback: 0, // Disable internal scrollback - we grow terminal to fit content
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

    // Load fit addon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Load web links addon
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    });
    terminal.loadAddon(webLinksAddon);

    // Open terminal in container
    terminal.open(containerRef.current);

    // Let wheel/scroll events pass through to the outer scroll container
    // instead of being intercepted by xterm (which converts them to arrow keys)
    terminal.attachCustomWheelEventHandler(() => false);

    // Load WebGL addon after terminal is opened
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
    } catch (e) {
      console.warn('WebGL addon failed to load:', e);
    }

    // Get the actual column width based on container, and grow rows if needed
    const updateSize = () => {
      if (scrollContainerRef.current && terminalRef.current) {
        const containerWidth = scrollContainerRef.current.clientWidth - 16; // padding
        const charWidth = 8.4; // approximate char width for 14px font
        const cols = Math.max(Math.floor(containerWidth / charWidth), 40);
        const rows = calculateRequiredRows();

        // Resize terminal to fit content (only grows, never shrinks)
        const currentRows = terminalRef.current.rows;
        const currentCols = terminalRef.current.cols;
        if (rows > currentRows || cols !== currentCols) {
          terminalRef.current.resize(cols, Math.max(rows, currentRows));
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows: Math.max(rows, currentRows) }));
          }
          // Update container height
          const newHeight = Math.max(rows, currentRows) * ROW_HEIGHT + 16;
          setTerminalHeight(newHeight);
        }
      }
    };

    requestAnimationFrame(updateSize);

    // Connect WebSocket
    connectWebSocket();

    // Handle terminal input
    terminal.onData((data) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle container resize - also notify server of new size and adjust rows
    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    if (scrollContainerRef.current) {
      resizeObserver.observe(scrollContainerRef.current);
    }

    // Expose methods to parent
    onReady({ sendInput, focus, copySelection, hasSelection, scrollUp, scrollDown });

    // With dynamic resizing, the terminal grows to fit content so cursor is always visible
    // No need to manually scroll on initial load

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      resizeObserver.disconnect();
      wsRef.current?.close();
      webglAddonRef.current?.dispose();
      terminal.dispose();
    };
  }, [sessionName, onReady, connectWebSocket, sendInput, focus, copySelection, hasSelection, scrollUp, scrollDown, calculateRequiredRows]);

  // Calculate container height - use terminal height when set, otherwise viewport-based
  // The container grows with terminal content, but is capped at viewport height
  const maxContainerHeight = viewportHeight ? viewportHeight - 140 : undefined;
  const containerStyle: React.CSSProperties = terminalHeight > 0
    ? { height: maxContainerHeight ? Math.min(terminalHeight, maxContainerHeight) : terminalHeight }
    : maxContainerHeight
      ? { height: `${maxContainerHeight}px` }
      : { height: '100%' };

  return (
    <div
      ref={scrollContainerRef}
      className="terminal-scroll-container"
      style={containerStyle}
    >
      <div
        ref={containerRef}
        className="terminal-inner"
      />
    </div>
  );
}
