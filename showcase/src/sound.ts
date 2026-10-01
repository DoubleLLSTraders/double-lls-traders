/** Win / loss sounds. Browsers only allow audio after a click, so the context is resumed on the first pointer press. */

const STORAGE_KEY = "lls-sound";
/** At most one result sound per this many ms, so turbo doesn't turn into noise. */
const MIN_GAP_MS = 350;

let ctx: AudioContext | null = null;
let enabled = typeof localStorage === "undefined" || localStorage.getItem(STORAGE_KEY) !== "off";
let lastPlay = 0;
const listeners = new Set<() => void>();

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => void context()?.resume().catch(() => {}), { capture: true });
}

export const isSoundOn = () => enabled;

export function setSoundOn(next: boolean) {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
  if (next) void context()?.resume().catch(() => {});
  listeners.forEach((l) => l());
}

export function subscribeSound(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function tone(c: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType) {
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  amp.gain.setValueAtTime(0, at);
  amp.gain.linearRampToValueAtTime(gain, at + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(amp).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function play(fn: (c: AudioContext, now: number) => void) {
  if (!enabled) return;
  const nowMs = performance.now();
  if (nowMs - lastPlay < MIN_GAP_MS) return;
  const c = context();
  if (!c || c.state !== "running") return;
  lastPlay = nowMs;
  fn(c, c.currentTime + 0.01);
}

/** Bright two-note chime. */
export function playWin() {
  play((c, t) => {
    tone(c, 1046, t, 0.16, 0.22, "triangle");
    tone(c, 1568, t + 0.08, 0.28, 0.24, "triangle");
    tone(c, 2093, t + 0.08, 0.22, 0.06, "sine");
  });
}

/** Low soft thud. */
export function playLoss() {
  play((c, t) => {
    tone(c, 220, t, 0.22, 0.3, "triangle");
    tone(c, 147, t + 0.07, 0.32, 0.28, "sine");
  });
}
