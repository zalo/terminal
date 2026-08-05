export interface TileRect { x: number; y: number; w: number; h: number; z: number }

export interface SessionMeta {
  status?: 'working' | 'waiting' | 'finished' | 'idle';
  task?: string;
  cwd?: string;
  preview_url?: string;
  updated_at?: number;
}

export interface RosterEntry {
  key: string;               // "<context>:<session>"
  name: string;
  context: string;
  callsign: string;
  created: string;
  lastAccess: string;
  meta?: SessionMeta;
}

export interface CanvasTheme {
  mode?: 'night' | 'day';
  accent?: string;
  backgroundUrl?: string | null;
  autoArrange?: boolean;
}

export interface BrowserRect extends TileRect { url: string; proxy?: boolean }

export interface LayoutState {
  tiles: Record<string, TileRect>;
  previews: Record<string, TileRect>;
  browsers: Record<string, BrowserRect>;
  names: Record<string, string>;
  theme?: CanvasTheme;
}

export interface PresenceClient { id: string; name: string; color: string }

export interface ScreenFrame {
  key: string;
  lines: string[];
  cols: number;
  rows: number;
  cx: number;
  cy: number;
  alt: boolean;
}

export type Op =
  | { kind: 'tile'; key: string; rect: Partial<TileRect> }
  | { kind: 'preview'; key: string; rect: Partial<TileRect> }
  | { kind: 'preview:close'; key: string }
  | {
      kind: 'tiles';
      tiles?: Record<string, TileRect>;
      previews?: Record<string, TileRect>;
      browsers?: Record<string, TileRect>;
      fit?: boolean;
    }
  | { kind: 'theme'; theme: CanvasTheme }
  | { kind: 'browser'; id: string; rect?: Partial<TileRect>; url?: string; proxy?: boolean }
  | { kind: 'browser:close'; id: string };

export interface VoicePresence {
  state: string;             // 'listening' | 'speaking' | 'off' | ...
  transcript?: string;
  action?: string;
}
