/**
 * Trade / analyzer sounds.
 *
 * Browsers block audio until a real click/tap. Unlock from Start or 🔔 Sound,
 * then Trade now / win / loss can play. If a beep is blocked, it is queued and
 * played on the next unlock gesture — never throw.
 */

import { storageKey } from "./platform";

const STORAGE_KEY = storageKey("sound");
const VOLUME_STORAGE_KEY = storageKey("sound-volume");

export type SoundVolume = "low" | "medium" | "high";

const VOLUME_GAIN: Record<SoundVolume, number> = {
  low: 0.32,
  medium: 0.62,
  high: 1,
};

const settingsListeners = new Set<() => void>();

function readEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

function readVolume(): SoundVolume {
  if (typeof localStorage === "undefined") return "high";
  const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return "high";
}

let context: AudioContext | null = null;
let enabled = readEnabled();
let volume = readVolume();
let unlocked = false;
/** Replay buffer for beeps that hit a suspended context. */
let pendingPlay: (() => void) | null = null;
/** HTMLAudio fallback primed during a user gesture (helps mobile / Pages). */
let htmlBeep: HTMLAudioElement | null = null;

function notifySettings(): void {
  for (const listener of settingsListeners) listener();
}

function volumeGain(): number {
  return VOLUME_GAIN[volume];
}

export function subscribeSoundSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export function getSoundVolume(): SoundVolume {
  return volume;
}

export function setSoundVolume(next: SoundVolume): void {
  volume = next;
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, next);
  } catch {
    // ignore
  }
  syncHtmlBeepVolume();
  notifySettings();
}

export function getSoundVolumeGain(): number {
  return volumeGain();
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // ignore
  }
  notifySettings();
}

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context ??= new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** Tiny WAV (short square beep) — playable via HTMLAudio after a gesture. */
function buildBeepDataUri(): string {
  // 16-bit mono PCM, 22050 Hz, ~0.22s of 880Hz-ish tone
  const sampleRate = 22050;
  const duration = 0.22;
  const samples = Math.floor(sampleRate * duration);
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, i / 200) * Math.min(1, (samples - i) / 800);
    const sample = Math.sin(2 * Math.PI * 988 * t) * 0.85 * env;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function syncHtmlBeepVolume(): void {
  if (!htmlBeep) return;
  htmlBeep.volume = Math.min(1, volumeGain());
}

function primeHtmlBeep(): void {
  if (typeof Audio === "undefined") return;
  try {
    htmlBeep ??= new Audio(buildBeepDataUri());
    syncHtmlBeepVolume();
    // Play+pause during gesture so later play() is allowed on many mobiles.
    const p = htmlBeep.play();
    if (p && typeof p.then === "function") {
      void p
        .then(() => {
          try {
            htmlBeep?.pause();
            if (htmlBeep) htmlBeep.currentTime = 0;
          } catch {
            // ignore
          }
        })
        .catch(() => {
          // ignore — Web Audio may still work
        });
    }
  } catch {
    // ignore
  }
}

function playHtmlFallback(): boolean {
  if (!htmlBeep) return false;
  try {
    htmlBeep.currentTime = 0;
    syncHtmlBeepVolume();
    void htmlBeep.play();
    return true;
  } catch {
    return false;
  }
}

function flushPending(): void {
  const next = pendingPlay;
  pendingPlay = null;
  if (next) {
    try {
      next();
    } catch {
      // ignore
    }
  }
}

/**
 * Must run inside a click/tap handler (Start / 🔔 Sound).
 * Returns whether the audio context is running.
 */
export function unlockAudio(): boolean {
  if (!enabled) {
    enabled = true;
    try {
      localStorage.setItem(STORAGE_KEY, "on");
    } catch {
      // ignore
    }
  }
  const ctx = getContext();
  primeHtmlBeep();
  if (!ctx) {
    unlocked = playHtmlFallback();
    flushPending();
    notifySettings();
    return unlocked;
  }
  const finish = (ok: boolean) => {
    unlocked = ok;
    if (ok) flushPending();
    notifySettings();
  };
  try {
    if (ctx.state === "suspended") {
      void ctx.resume().then(() => {
        finish(ctx.state === "running");
        if (ctx.state === "running") {
          // Audible unlock chirp so the user knows sound works.
          try {
            tone(ctx, 1175, ctx.currentTime + 0.01, 0.12, 0.55, "square");
            tone(ctx, 1568, ctx.currentTime + 0.12, 0.18, 0.6, "square");
          } catch {
            // ignore
          }
        }
      });
    } else {
      finish(true);
      try {
        tone(ctx, 1175, ctx.currentTime + 0.01, 0.12, 0.55, "square");
        tone(ctx, 1568, ctx.currentTime + 0.12, 0.18, 0.6, "square");
      } catch {
        // ignore
      }
      flushPending();
    }
  } catch {
    finish(playHtmlFallback());
  }
  unlocked = true;
  notifySettings();
  return true;
}

function tone(
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  gain: number,
  type: OscillatorType = "square",
): void {
  const scaledGain = gain * volumeGain();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  amp.gain.setValueAtTime(0, startAt);
  amp.gain.linearRampToValueAtTime(scaledGain, startAt + 0.015);
  amp.gain.linearRampToValueAtTime(scaledGain * 0.75, startAt + duration * 0.5);
  amp.gain.linearRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.04);
}

async function withAudio(
  play: (ctx: AudioContext, now: number) => void,
  queueOnBlock = true,
): Promise<boolean> {
  if (!enabled) return false;
  const ctx = getContext();
  if (!ctx) {
    const ok = playHtmlFallback();
    if (!ok && queueOnBlock) {
      pendingPlay = () => {
        void withAudio(play, false);
      };
    }
    return ok;
  }
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (ctx.state !== "running") {
      const htmlOk = playHtmlFallback();
      if (!htmlOk && queueOnBlock) {
        pendingPlay = () => {
          void withAudio(play, false);
        };
      }
      return htmlOk;
    }
    unlocked = true;
    play(ctx, ctx.currentTime + 0.01);
    return true;
  } catch {
    const htmlOk = playHtmlFallback();
    if (!htmlOk && queueOnBlock) {
      pendingPlay = () => {
        void withAudio(play, false);
      };
    }
    return htmlOk;
  }
}

/** Cash-register win. */
export function playWinSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 1046, now, 0.2, 0.45, "sine");
    tone(ctx, 1568, now + 0.12, 0.45, 0.5, "sine");
    tone(ctx, 2093, now + 0.12, 0.35, 0.3, "sine");
  });
}

/** Digits Good / Trade now — loud triple beep, hard to miss. */
export function playGoodSetupSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 880, now, 0.2, 0.72, "square");
    tone(ctx, 1175, now + 0.2, 0.22, 0.72, "square");
    tone(ctx, 1568, now + 0.44, 0.4, 0.78, "square");
    tone(ctx, 2349, now + 0.44, 0.45, 0.4, "sine");
    tone(ctx, 880, now + 0.95, 0.18, 0.68, "square");
    tone(ctx, 1568, now + 1.15, 0.45, 0.72, "square");
  }).then((ok) => {
    if (!ok) playHtmlFallback();
  });
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate([80, 40, 80, 40, 120]);
    }
  } catch {
    // ignore
  }
}

/** Almost — two soft beeps. */
export function playAlmostSetupSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 740, now, 0.14, 0.4, "square");
    tone(ctx, 988, now + 0.16, 0.22, 0.48, "square");
  });
}

/** Loss thud. */
export function playLossSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 220, now, 0.35, 0.55, "triangle");
    tone(ctx, 110, now + 0.05, 0.4, 0.45, "sine");
  });
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

/** Resume after tab sleep if we already unlocked once. */
export function resumeAudioIfNeeded(): void {
  if (!enabled || !unlocked) return;
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => {
      if (ctx.state === "running") flushPending();
    });
  }
}
