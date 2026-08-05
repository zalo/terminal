// Stable identity hue per session key — tiles, sidebar rows, and callsigns
// share it so a session is recognizable at a glance.

const SESSION_HUES = [
  '#4fd1c5', '#f6ad55', '#b794f4', '#68d391', '#f687b3',
  '#63b3ed', '#fbd38d', '#81e6d9', '#fc8181', '#d6bcfa',
];

export function sessionColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return SESSION_HUES[Math.abs(h) % SESSION_HUES.length];
}

export const STATUS_COLORS: Record<string, string> = {
  working: '#f6ad55',
  waiting: '#4fd1c5',
  finished: '#68d391',
  idle: '#718096',
};
