// Shared multi-touch state. When two or more fingers are down anywhere on
// the canvas, the gesture belongs to the stage (pinch/pan) — tiles must
// refuse to start drags and abandon any drag in progress, even if a finger
// landed on their header. CanvasStage maintains the flag from window-level
// capture listeners (which see every pointer, including ones captured by a
// tile).

let active = false;

export function isMultiTouch(): boolean {
  return active;
}

export function setMultiTouch(on: boolean): void {
  active = on;
}
