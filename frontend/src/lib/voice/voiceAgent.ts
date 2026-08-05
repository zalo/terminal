// Grok Voice realtime agent for the canvas.
//
// Connects the browser directly to wss://api.x.ai/v1/realtime using an
// ephemeral token minted by our server (POST /api/voice/token) passed as a
// WebSocket subprotocol — audio streams browser ↔ xAI with no relay. The
// xAI protocol is OpenAI-Realtime-compatible; see the xAI speech-to-speech
// docs for the event vocabulary used below.
//
// Client-side function tools are executed by a VoiceHost (the canvas view),
// which is where "zoom to casper" or "set night mode" have to run anyway.

export type VoiceStatus =
  | 'off' | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking'
  | 'nokey' | 'error';

export interface VoiceHost {
  buildInstructions(): string;
  keyterms(): string[];
  // Execute a client tool; return value is JSON-serialized as the tool output.
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  onStatus(status: VoiceStatus): void;
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean): void;
  onAction(description: string): void;
}

const MODEL = 'grok-voice-latest';
const RATE = 24000;

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties, required },
  };
}

const SESSION_PARAM = {
  type: 'string',
  description: 'The session, by callsign (e.g. "casper") or tmux session name.',
};

export const VOICE_TOOLS: unknown[] = [
  fn('list_sessions', 'List every terminal session: callsign, tmux name, context, status, current task, and preview URL if any.', {}),
  fn('read_session', 'Read the current screen contents of a terminal session (optionally with scrollback history). Always call this before answering questions about what a session is doing or what happened in it.', {
    session: SESSION_PARAM,
    lines: { type: 'number', description: 'Scrollback lines to include before the visible screen (default 0, max 2000).' },
  }, ['session']),
  fn('type_text', 'Type text into a terminal session. Set press_enter=false to type without running.', {
    session: SESSION_PARAM,
    text: { type: 'string', description: 'Literal text to type.' },
    press_enter: { type: 'boolean', description: 'Press Enter after typing (default true).' },
  }, ['session', 'text']),
  fn('press_keys', 'Press special keys in a session. Key names: Enter, Escape, Tab, Space, Up, Down, Left, Right, BSpace, C-c (Ctrl-C), C-d, C-z, PageUp, PageDown.', {
    session: SESSION_PARAM,
    keys: { type: 'array', items: { type: 'string' }, description: 'Keys to press, in order.' },
  }, ['session', 'keys']),
  fn('create_session', 'Create a new terminal session. A friendly callsign is assigned automatically and returned.', {
    name: { type: 'string', description: 'tmux session name (letters, digits, dashes). Optional — one is generated if omitted.' },
    context: { type: 'string', description: 'Context to create it in (optional).' },
  }),
  fn('kill_session', 'Kill (terminate) a terminal session. Destructive — you MUST get explicit verbal confirmation from the user first, then call with confirmed=true.', {
    session: SESSION_PARAM,
    confirmed: { type: 'boolean', description: 'Must be true; only after the user verbally confirmed.' },
  }, ['session', 'confirmed']),
  fn('focus_session', 'Pan/zoom the canvas to bring a session tile front and center.', { session: SESSION_PARAM }, ['session']),
  fn('arrange_grid', 'Arrange all session tiles into a tidy grid and frame them for everyone. Optionally force a shape: columns=2 gives 2-wide (e.g. 2x2), columns=1 a single column, rows=1 a single row.', {
    columns: { type: 'number', description: 'Force this many columns.' },
    rows: { type: 'number', description: 'Force this many rows (used when columns is omitted).' },
  }),
  fn('list_windows', 'List the open browser windows and preview windows on the canvas (id, URL, owner).', {}),
  fn('close_window', 'Close an open browser window or preview window.', {
    window: { type: 'string', description: 'Window id, part of its URL, or (for previews) the session callsign.' },
  }, ['window']),
  fn('navigate_window', 'Point an existing browser window at a different URL.', {
    window: { type: 'string', description: 'Window id or part of its current URL.' },
    url: { type: 'string', description: 'The https URL to navigate to.' },
  }, ['window', 'url']),
  fn('move_next_to', 'Place one canvas item directly beside another — e.g. a preview next to its session, or a browser window next to a terminal. Items can be a callsign, "<callsign> preview", a window id, or part of a URL.', {
    item: { type: 'string', description: 'The item to move.' },
    target: { type: 'string', description: 'The item it should sit next to.' },
  }, ['item', 'target']),
  fn('open_preview', "Open a session's live web preview (its dev server) as an iframe tile on the canvas.", { session: SESSION_PARAM }, ['session']),
  fn('close_preview', "Close a session's preview tile.", { session: SESSION_PARAM }, ['session']),
  fn('set_theme', 'Change the canvas appearance for everyone: night or day mode, and/or the accent color.', {
    mode: { type: 'string', enum: ['night', 'day'], description: 'Color scheme.' },
    accent: { type: 'string', description: 'Accent color as a hex value like #4fd1c5.' },
  }),
  fn('set_background', 'Set or clear the canvas background image. To find a new image, first use web_search to locate a direct https image URL (jpg/png/webp), then pass it here.', {
    url: { type: 'string', description: 'Direct https URL of an image.' },
    clear: { type: 'boolean', description: 'true to remove the background image.' },
  }),
  fn('open_url', 'Open a URL as a small browser window on the canvas. Use web_search first if you need to find the URL.', {
    url: { type: 'string', description: 'https URL to open.' },
  }, ['url']),
  fn('go_to_sleep', 'End the voice session ("go to sleep"). The user restarts it with the microphone button.', {}),
  // xAI server-side tool: lets the model search the web (e.g. for background images).
  { type: 'web_search' },
];

// --- Audio helpers -------------------------------------------------------------

const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

function resampleTo(rate: number, from: number, input: Float32Array): Float32Array {
  if (from === rate) return input;
  const ratio = from / rate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToPcm16Base64(f32: Float32Array): string {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
  return f32;
}

// --- Agent -----------------------------------------------------------------------

interface PendingCall { name: string; callId: string; args: Record<string, unknown> }

export class VoiceAgent {
  private host: VoiceHost;
  private ws: WebSocket | null = null;
  private status: VoiceStatus = 'off';

  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private playCursor = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private itemPlayStart = 0;           // audioCtx time the current item began playing
  private lastAssistantItemId: string | null = null;

  private responseActive = false;
  private pendingCalls: PendingCall[] = [];
  private assistantText = '';
  private sleeping = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: VoiceHost) {
    this.host = host;
  }

  getStatus(): VoiceStatus { return this.status; }

  private setStatus(s: VoiceStatus) {
    if (this.status === s) return;
    this.status = s;
    this.host.onStatus(s);
  }

  async start(): Promise<void> {
    if (this.ws) return;
    this.sleeping = false;
    this.setStatus('connecting');
    try {
      const tokenRes = await fetch('/api/voice/token', { method: 'POST' });
      if (tokenRes.status === 503) { this.setStatus('nokey'); return; }
      if (!tokenRes.ok) throw new Error(`token mint failed (${tokenRes.status})`);
      const { token } = await tokenRes.json();

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      this.audioCtx = new AudioContext();
      await this.audioCtx.resume();
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const ws = new WebSocket(
        `wss://api.x.ai/v1/realtime?model=${MODEL}`,
        [`xai-client-secret.${token}`],
      );
      this.ws = ws;

      ws.onopen = () => {
        this.sendSessionUpdate();
        this.startMic();
        this.setStatus('idle');
      };
      ws.onmessage = (ev) => this.handleEvent(ev.data as string);
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        if (this.status !== 'off' && this.status !== 'nokey' && !this.sleeping) {
          this.setStatus('error');
        }
        this.teardown();
      };
    } catch (e) {
      console.error('[voice] start failed:', e);
      this.setStatus(
        (e as Error).name === 'NotAllowedError' ? 'error' : this.status === 'nokey' ? 'nokey' : 'error',
      );
      this.teardown();
    }
  }

  stop() {
    this.sleeping = true;
    this.teardown();
    this.setStatus('off');
  }

  private teardown() {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.stopPlayback();
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.workletNode = null;
    this.sourceNode = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendSessionUpdate() {
    this.send({
      type: 'session.update',
      session: {
        voice: 'eve',
        instructions: this.host.buildInstructions(),
        turn_detection: { type: 'server_vad' },
        reasoning: { effort: 'none' },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: RATE },
            transcription: { keyterms: this.host.keyterms().slice(0, 100) },
          },
          output: { format: { type: 'audio/pcm', rate: RATE } },
        },
        tools: VOICE_TOOLS,
      },
    });
  }

  // Re-push instructions/keyterms when the session roster changes.
  refreshContext() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.sendSessionUpdate();
    }, 1500);
  }

  // --- Mic capture ------------------------------------------------------------

  private startMic() {
    if (!this.audioCtx || !this.mediaStream) return;
    const ctx = this.audioCtx;
    this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm-capture');
    let buffer: Float32Array[] = [];
    let buffered = 0;
    this.workletNode.port.onmessage = (ev) => {
      const chunk = ev.data as Float32Array;
      buffer.push(chunk);
      buffered += chunk.length;
      // ~100ms batches
      if (buffered >= ctx.sampleRate / 10) {
        const merged = new Float32Array(buffered);
        let o = 0;
        for (const c of buffer) { merged.set(c, o); o += c.length; }
        buffer = []; buffered = 0;
        const resampled = resampleTo(RATE, ctx.sampleRate, merged);
        this.send({ type: 'input_audio_buffer.append', audio: floatToPcm16Base64(resampled) });
      }
    };
    this.sourceNode.connect(this.workletNode);
    // Keep the worklet pulling without producing audible output.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.workletNode.connect(sink);
    sink.connect(ctx.destination);
  }

  // --- Playback ------------------------------------------------------------------

  private enqueueAudio(b64: string) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const f32 = base64ToFloat32(b64);
    if (f32.length === 0) return;
    const buf = ctx.createBuffer(1, f32.length, RATE);
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.05, this.playCursor);
    if (this.activeSources.size === 0) this.itemPlayStart = startAt;
    src.start(startAt);
    this.playCursor = startAt + buf.duration;
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0 && !this.responseActive && this.status === 'speaking') {
        this.setStatus('idle');
      }
    };
  }

  private stopPlayback() {
    for (const src of this.activeSources) { try { src.stop(); } catch { /* not started */ } }
    this.activeSources.clear();
    this.playCursor = 0;
  }

  private playedMs(): number {
    if (!this.audioCtx || this.activeSources.size === 0) return 0;
    return Math.max(0, Math.round((this.audioCtx.currentTime - this.itemPlayStart) * 1000));
  }

  // --- Event handling ----------------------------------------------------------------

  private handleEvent(raw: string) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch { return; }
    const type = ev.type as string;

    switch (type) {
      case 'input_audio_buffer.speech_started': {
        // Barge-in: kill local playback and cancel any streaming response.
        const played = this.playedMs();
        this.stopPlayback();
        if (this.responseActive) this.send({ type: 'response.cancel' });
        if (this.lastAssistantItemId && played > 0) {
          this.send({
            type: 'conversation.item.truncate',
            item_id: this.lastAssistantItemId,
            content_index: 0,
            audio_end_ms: played,
          });
        }
        this.setStatus('listening');
        break;
      }
      case 'input_audio_buffer.speech_stopped':
        this.setStatus('thinking');
        break;
      case 'conversation.item.input_audio_transcription.updated':
        this.host.onTranscript('user', String((ev as { transcript?: string }).transcript ?? extractTranscript(ev)), false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.host.onTranscript('user', String((ev as { transcript?: string }).transcript ?? extractTranscript(ev)), true);
        break;
      case 'response.created':
        this.responseActive = true;
        this.assistantText = '';
        this.pendingCalls = [];
        break;
      case 'response.output_item.added': {
        const item = ev.item as { id?: string; type?: string } | undefined;
        if (item?.type === 'message' && item.id) this.lastAssistantItemId = item.id;
        break;
      }
      case 'response.output_audio.delta':
        this.enqueueAudio(String(ev.delta || ''));
        this.setStatus('speaking');
        break;
      case 'response.output_audio_transcript.delta':
        this.assistantText += String(ev.delta || '');
        this.host.onTranscript('assistant', this.assistantText, false);
        break;
      case 'response.output_audio_transcript.done':
        this.host.onTranscript('assistant', String(ev.transcript || this.assistantText), true);
        break;
      case 'response.function_call_arguments.done': {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(String(ev.arguments || '{}')); } catch { /* keep {} */ }
        this.pendingCalls.push({
          name: String(ev.name || ''),
          callId: String(ev.call_id || ''),
          args,
        });
        break;
      }
      case 'response.done': {
        this.responseActive = false;
        if (this.pendingCalls.length > 0) {
          const calls = this.pendingCalls;
          this.pendingCalls = [];
          void this.runToolCalls(calls);
        } else if (this.activeSources.size === 0 && this.status !== 'listening') {
          this.setStatus('idle');
        }
        break;
      }
      case 'error': {
        const err = ev.error as { message?: string } | undefined;
        console.error('[voice] server error:', err?.message || raw);
        break;
      }
    }
  }

  private async runToolCalls(calls: PendingCall[]) {
    this.setStatus('thinking');
    let wantsSleep = false;
    for (const call of calls) {
      this.host.onAction(describeCall(call));
      let result: unknown;
      try {
        result = await this.host.execute(call.name, call.args);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      if (call.name === 'go_to_sleep') wantsSleep = true;
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(result ?? { ok: true }),
        },
      });
    }
    if (wantsSleep) {
      // Speak a fixed goodbye without another model turn, then close.
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'force_message',
          role: 'assistant',
          interruptible: false,
          content: [{ type: 'output_text', text: 'Going to sleep. Tap the mic when you need me.' }],
        },
      });
      setTimeout(() => this.stop(), 2600);
      return;
    }
    this.send({ type: 'response.create' });
  }
}

function extractTranscript(ev: Record<string, unknown>): string {
  // Some event shapes nest the transcript under item/content.
  const item = ev.item as { content?: Array<{ transcript?: string }> } | undefined;
  return item?.content?.find((c) => c.transcript)?.transcript || '';
}

function describeCall(call: PendingCall): string {
  const a = call.args;
  switch (call.name) {
    case 'read_session': return `read ${a.session}`;
    case 'type_text': return `${a.session} ← ${String(a.text).slice(0, 40)}`;
    case 'press_keys': return `${a.session} ← [${(a.keys as string[])?.join(' ')}]`;
    case 'create_session': return `new session${a.name ? ` "${a.name}"` : ''}`;
    case 'kill_session': return `kill ${a.session}`;
    case 'focus_session': return `focus ${a.session}`;
    case 'arrange_grid': return a.columns ? `arrange ${a.columns}-wide` : a.rows ? `arrange ${a.rows} row(s)` : 'arrange grid';
    case 'list_windows': return 'list windows';
    case 'close_window': return `close window ${String(a.window).slice(0, 30)}`;
    case 'navigate_window': return `window → ${String(a.url).slice(0, 40)}`;
    case 'move_next_to': return `${String(a.item).slice(0, 20)} → beside ${String(a.target).slice(0, 20)}`;
    case 'open_preview': return `preview ${a.session}`;
    case 'close_preview': return `close preview ${a.session}`;
    case 'set_theme': return `theme ${a.mode || ''} ${a.accent || ''}`.trim();
    case 'set_background': return a.clear ? 'clear background' : 'set background';
    case 'open_url': return `open ${String(a.url).slice(0, 50)}`;
    case 'go_to_sleep': return 'going to sleep';
    case 'list_sessions': return 'list sessions';
    default: return call.name;
  }
}
