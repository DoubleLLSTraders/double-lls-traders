/**
 * Trade / analyzer sounds via Web Audio API.
 * Browsers block audio until a user gesture — call unlockAudio() from Start.
 */

import { storageKey } from "./platform";

const STORAGE_KEY = storageKey("sound");

let context: AudioContext | null = null;
let enabled = readEnabled();
let unlocked = false;

function readEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(STORAGE_KEY) !== "off";
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
}

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/** Must run inside a click/tap handler (Start / speaker). */
export function unlockAudio(): void {
  setSoundEnabled(true);
  enabled = true;
  const ctx = getContext();
  if (!ctx) return;
  void ctx.resume().then(() => {
    unlocked = true;
  });
  // Silent blip so Safari marks the context as user-activated.
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.value = 440;
    amp.gain.value = 0.0001;
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
    unlocked = true;
  } catch {
    // ignore
  }
}

function tone(
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  gain: number,
  type: OscillatorType = "square",
): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  amp.gain.setValueAtTime(0, startAt);
  amp.gain.linearRampToValueAtTime(gain, startAt + 0.02);
  amp.gain.linearRampToValueAtTime(gain * 0.7, startAt + duration * 0.5);
  amp.gain.linearRampToValueAtTime(0, startAt + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

async function withAudio(
  play: (ctx: AudioContext, now: number) => void,
): Promise<boolean> {
  if (!enabled) return false;
  const ctx = getContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
      // Still suspended = browser blocked us — no silent fail.
      if (ctx.state === "suspended") return false;
    }
    unlocked = true;
    play(ctx, ctx.currentTime + 0.02);
    return true;
  } catch {
    return false;
  }
}

/** Cash-register win. */
export function playWinSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 1046, now, 0.2, 0.35, "sine");
    tone(ctx, 1568, now + 0.12, 0.45, 0.4, "sine");
    tone(ctx, 2093, now + 0.12, 0.35, 0.22, "sine");
  });
}

/** Digits Good / Trade now — loud triple beep, hard to miss. */
export function playGoodSetupSound(): void {
  void withAudio((ctx, now) => {
    // Three bright square beeps + high ring
    tone(ctx, 880, now, 0.18, 0.55, "square");
    tone(ctx, 1175, now + 0.2, 0.2, 0.55, "square");
    tone(ctx, 1568, now + 0.42, 0.35, 0.6, "square");
    tone(ctx, 2349, now + 0.42, 0.4, 0.28, "sine");
    // Repeat once so it cuts through
    tone(ctx, 880, now + 0.9, 0.16, 0.5, "square");
    tone(ctx, 1568, now + 1.1, 0.4, 0.55, "square");
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
    tone(ctx, 740, now, 0.14, 0.35, "square");
    tone(ctx, 988, now + 0.16, 0.22, 0.4, "square");
  });
}

/** Loss thud. */
export function playLossSound(): void {
  void withAudio((ctx, now) => {
    tone(ctx, 220, now, 0.35, 0.45, "triangle");
    tone(ctx, 110, now + 0.05, 0.4, 0.35, "sine");
  });
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}
