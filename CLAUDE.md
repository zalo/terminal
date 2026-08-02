# Terminal Project

Read `README.md` for project overview, setup, and service management instructions.

## Known Issues

- **WebGL renderer disabled (2026-04-08):** xterm.js WebGL addon causes glyph corruption (only top-left corner of each character renders). Likely caused by an iOS Safari WebGL regression. The WebGL addon is commented out in `frontend/src/components/Terminal.tsx` (~line 244) in favor of the DOM renderer. If a future iOS update fixes this, re-enable WebGL there for better rendering performance.
- **Wheel events must never reach xterm (2026-08-02):** Desktop wheel/trackpad scrolling broke whenever the app inside tmux enabled mouse reporting (Claude Code does). `attachCustomWheelEventHandler(() => false)` is NOT sufficient: with mouse reporting active, xterm 6 binds its own wheel listener that unconditionally `preventDefault()`s, so the outer `.terminal-scroll-container` never scrolls. Fixed with a capture-phase `wheel` listener on the scroll container that `stopPropagation()`s (passive, so native container scrolling proceeds) in `frontend/src/components/Terminal.tsx`. Touch scrolling (iOS) was never affected, which is why this only showed up on desktop browsers.
