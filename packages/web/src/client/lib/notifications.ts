// notifications.ts — Browser OS notifications + Web Audio drum sounds.
//
// All audio is synthesized via the Web Audio API — no external files needed.
// Notification permission is requested lazily on the first notify() call.
//
// In-memory history (up to HISTORY_CAP entries, newest first) is maintained
// in _history and broadcast via a "percussionist:notification" CustomEvent so
// React components can subscribe without prop-drilling.

export type DrumSound = "success" | "failure" | "cancelled" | "escalated" | "running";

// ---------------------------------------------------------------------------
// History store

export interface NotificationEntry {
  key: string;
  title: string;
  body?: string;
  sound: DrumSound;
  at: number; // Date.now()
}

const HISTORY_CAP = 50;
const _history: NotificationEntry[] = [];

export function getNotificationHistory(): NotificationEntry[] {
  return _history.slice();
}

const NOTIFICATION_EVENT = "percussionist:notification";

// ---------------------------------------------------------------------------
// Audio synthesis

let _ctx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (_ctx) return _ctx;
  try {
    _ctx = new AudioContext();
    return _ctx;
  } catch {
    return null;
  }
}

/** Play a synthesized drum hit appropriate for the given event type. */
export function playDrum(sound: DrumSound): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume if suspended (browsers require prior user gesture).
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => undefined);
  }

  const now = ctx.currentTime;

  switch (sound) {
    case "success":
      // Clean rimshot: sharp attack noise + short ring
      playNoise(ctx, now, { duration: 0.08, frequency: 900, gain: 0.55 });
      playTone(ctx, now, { frequency: 320, duration: 0.18, gain: 0.3, decayRate: 18 });
      break;

    case "failure":
      // Low tom thud: deep punch with a slow tail
      playTone(ctx, now, { frequency: 68, duration: 0.35, gain: 0.7, decayRate: 9, pitchDrop: 38 });
      playNoise(ctx, now, { duration: 0.04, frequency: 200, gain: 0.2 });
      break;

    case "cancelled":
      // Muted cymbal: noise burst, short
      playNoise(ctx, now, { duration: 0.12, frequency: 6000, gain: 0.25, highpass: true });
      playTone(ctx, now, { frequency: 220, duration: 0.2, gain: 0.15, decayRate: 20 });
      break;

    case "escalated":
      // Hi-hat tick × 2 — alert-like
      playNoise(ctx, now,        { duration: 0.05, frequency: 8000, gain: 0.35, highpass: true });
      playNoise(ctx, now + 0.12, { duration: 0.05, frequency: 8000, gain: 0.35, highpass: true });
      break;

    case "running":
      // Short kick: punchy low sine
      playTone(ctx, now, { frequency: 90, duration: 0.2, gain: 0.5, decayRate: 22, pitchDrop: 60 });
      break;
  }
}

interface ToneOptions {
  frequency: number;
  duration: number;
  gain: number;
  decayRate: number;
  pitchDrop?: number; // Hz to drop from start to end
}

function playTone(ctx: AudioContext, startTime: number, opts: ToneOptions): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(opts.frequency, startTime);
  if (opts.pitchDrop) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(opts.frequency - opts.pitchDrop, 10),
      startTime + opts.duration,
    );
  }

  env.gain.setValueAtTime(opts.gain, startTime);
  env.gain.exponentialRampToValueAtTime(0.001, startTime + opts.duration);

  osc.connect(env);
  env.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + opts.duration + 0.01);
}

interface NoiseOptions {
  duration: number;
  frequency: number; // cutoff for the filter
  gain: number;
  highpass?: boolean;
}

function playNoise(ctx: AudioContext, startTime: number, opts: NoiseOptions): void {
  const bufferSize = Math.ceil(ctx.sampleRate * opts.duration);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = opts.highpass ? "highpass" : "lowpass";
  filter.frequency.value = opts.frequency;

  const env = ctx.createGain();
  env.gain.setValueAtTime(opts.gain, startTime);
  env.gain.exponentialRampToValueAtTime(0.001, startTime + opts.duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(ctx.destination);

  source.start(startTime);
  source.stop(startTime + opts.duration + 0.01);
}

// ---------------------------------------------------------------------------
// Browser OS notifications

let _permissionRequested = false;

/** Request Notification permission once. Safe to call multiple times. */
export async function requestNotificationPermission(): Promise<void> {
  if (_permissionRequested) return;
  _permissionRequested = true;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

// Deduplicate: track keys we've already shown a notification for.
const _shown = new Set<string>();

export interface NotifyOptions {
  title: string;
  body?: string;
  /** Unique key — if we've already notified for this key, skip. */
  key: string;
  sound: DrumSound;
}

/**
 * Show a browser OS notification and play the appropriate drum sound.
 * Silently no-ops if permission was denied or the key was already shown.
 * Always records the notification in the in-memory history.
 */
export function notify(opts: NotifyOptions): void {
  if (_shown.has(opts.key)) return;
  _shown.add(opts.key);

  // Record in history (newest first, capped).
  const entry: NotificationEntry = {
    key: opts.key,
    title: opts.title,
    body: opts.body,
    sound: opts.sound,
    at: Date.now(),
  };
  _history.unshift(entry);
  if (_history.length > HISTORY_CAP) _history.length = HISTORY_CAP;

  // Broadcast to any React subscribers.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: entry }));
  }

  playDrum(opts.sound);

  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.key,
      icon: "/favicon.ico",
    });
    // Auto-close after 6 s.
    setTimeout(() => n.close(), 6_000);
  } catch {
    // Non-fatal.
  }
}

export { NOTIFICATION_EVENT };
