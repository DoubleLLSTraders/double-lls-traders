/**
 * Trade result sounds, synthesised with the Web Audio API so the app ships no
 * audio assets.
 *
 * Browsers block audio until the user interacts with the page, so the context
 * is created lazily and resumed on every play — the first sound after a click
 * (Start) unlocks it.
 */

import { storageKey } from "../lib/platform";

const STORAGE_KEY = storageKey("sound");

let context: AudioContext | null = null;
let enabled = readEnabled();

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
    // Private-mode storage failures should never break trading.
  }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** A struck-bell partial: sine tone with a percussive exponential decay. */
function bell(
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  gain: number,
): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, startAt);
  amp.gain.setValueAtTime(0.0001, startAt);
  amp.gain.exponentialRampToValueAtTime(gain, startAt + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Short filtered noise burst — the register drawer / coin rattle. */
function rattle(ctx: AudioContext, startAt: number, duration: number, gain: number): void {
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2600, startAt);
  filter.Q.setValueAtTime(1.2, startAt);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(gain, startAt);

  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(startAt);
  source.stop(startAt + duration);
}

/** Cash-register "cha-ching": drawer rattle, then two bright ascending bells. */
export function playWinSound(): void {
  if (!enabled) return;
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime + 0.01;

  rattle(ctx, now, 0.09, 0.18);

  // "cha"
  bell(ctx, 1046.5, now + 0.02, 0.24, 0.3);
  bell(ctx, 1567.98, now + 0.02, 0.2, 0.16);

  // "ching" — higher and left to ring out
  bell(ctx, 1396.91, now + 0.13, 0.75, 0.32);
  bell(ctx, 2093.0, now + 0.13, 0.6, 0.18);
  bell(ctx, 2793.83, now + 0.13, 0.45, 0.09);
}

/** Loss: a short pitch-drop thud, like a coin falling away. */
export function playLossSound(): void {
  if (!enabled) return;
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime + 0.01;
  const duration = 0.42;

  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(420, now);
  osc.frequency.exponentialRampToValueAtTime(70, now + duration);

  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(0.34, now + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(amp).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);

  // Low body underneath so it lands as a thud rather than a beep.
  const sub = ctx.createOscillator();
  const subAmp = ctx.createGain();
  sub.type = "triangle";
  sub.frequency.setValueAtTime(150, now);
  sub.frequency.exponentialRampToValueAtTime(48, now + duration * 0.8);
  subAmp.gain.setValueAtTime(0.0001, now);
  subAmp.gain.exponentialRampToValueAtTime(0.22, now + 0.03);
  subAmp.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.9);
  sub.connect(subAmp).connect(ctx.destination);
  sub.start(now);
  sub.stop(now + duration);
}
