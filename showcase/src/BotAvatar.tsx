import createGlobe from "cobe";
import { useEffect, useRef } from "react";

interface BotAvatarProps {
  size?: number;
  /** Latest settled trade; the face reacts briefly whenever its id changes. */
  lastTrade?: { id: number; won: boolean } | null;
  /** Holds the face in one mood instead of reacting to trades. */
  mood?: "win" | "loss";
  className?: string;
}

const MOOD_MS = 1400;
const NYC: [number, number] = [40.71, -74.01];
/** Below this the dotted globe turns to mush, so small avatars draw a plain glossy face instead. */
const MINI_MAX = 48;

export function BotAvatar({ size = 120, lastTrade = null, mood: heldMood, className = "" }: BotAvatarProps) {
  const held = useRef(heldMood);
  held.current = heldMood;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eyesRef = useRef<HTMLDivElement>(null);
  const mood = useRef<{ kind: "win" | "loss"; until: number } | null>(null);

  useEffect(() => {
    if (!lastTrade) return;
    mood.current = { kind: lastTrade.won ? "win" : "loss", until: performance.now() + MOOD_MS };
  }, [lastTrade?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mini = size < MINI_MAX;

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const globe = mini || !canvas ? null : createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: size * dpr,
      height: size * dpr,
      phi: 0,
      theta: 0.28,
      dark: 1,
      diffuse: 1.4,
      mapSamples: 9000,
      mapBrightness: 5,
      mapBaseBrightness: 0.02,
      baseColor: [0.32, 0.35, 0.4],
      markerColor: [0.3, 0.85, 0.6],
      glowColor: [0.09, 0.1, 0.12],
      markers: [{ location: NYC, size: 0.06 }],
      scale: 1.22,
      opacity: 0.9,
    });

    const pointer = { x: 0, y: 0, at: -Infinity };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = performance.now();
    };
    window.addEventListener("pointermove", onMove);

    const target = { x: 0, y: 0 };
    const pos = { x: 0, y: 0 };
    let nextWander = 0;
    let blinkStart = -1;
    let nextBlink = performance.now() + 1500;
    let phi = 0;
    let raf = 0;

    const loop = (now: number) => {
      const reach = size * 0.11;
      if (now - pointer.at < 3000) {
        const b = root.getBoundingClientRect();
        const dx = pointer.x - (b.left + b.width / 2);
        const dy = pointer.y - (b.top + b.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 360);
        target.x = (dx / d) * k * reach;
        target.y = (dy / d) * k * reach * 0.75;
      } else if (now > nextWander) {
        target.x = (Math.random() * 2 - 1) * reach * 0.8;
        target.y = (Math.random() * 2 - 1) * reach * 0.45;
        nextWander = now + 1500 + Math.random() * 2200;
      }
      pos.x += (target.x - pos.x) * 0.12;
      pos.y += (target.y - pos.y) * 0.12;

      if (blinkStart < 0 && now > nextBlink) blinkStart = now;
      let open = 1;
      if (blinkStart >= 0) {
        const t = (now - blinkStart) / 180;
        if (t >= 1) {
          blinkStart = -1;
          nextBlink = now + 2600 + Math.random() * 3400;
        } else {
          open = Math.max(0.1, Math.abs(1 - 2 * t));
        }
      }

      const m = held.current ?? (mood.current && mood.current.until > now ? mood.current.kind : null);
      root.dataset.mood = m ?? "idle";
      const squint = m === "win" ? 0.42 : m === "loss" ? 0.72 : 1;
      const eyes = eyesRef.current;
      if (eyes) {
        eyes.style.setProperty("--eye-x", `${pos.x.toFixed(2)}px`);
        eyes.style.setProperty("--eye-y", `${(pos.y + (m === "loss" ? size * 0.03 : 0)).toFixed(2)}px`);
        eyes.style.setProperty("--eye-open", (open * squint).toFixed(3));
      }

      // The globe turns toward where the eyes look, on top of its slow spin.
      if (!still) phi += 0.004;
      globe?.update({ phi: phi + pos.x * 0.01, theta: 0.28 + pos.y * 0.008 });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      globe?.destroy();
    };
  }, [size, mini]);

  return (
    <div
      ref={rootRef}
      className={`orb ${mini ? "mini" : ""} ${className}`}
      style={{ width: size, height: size }}
      data-mood={heldMood ?? "idle"}
      role="img"
      aria-label="Double LLS Trading Bot"
    >
      <div className="orb-body" />
      {!mini && <canvas ref={canvasRef} className="orb-globe" style={{ width: size, height: size }} />}
      <div className="orb-face" />
      <div ref={eyesRef} className="orb-eyes">
        <span />
        <span />
      </div>
      <div className="orb-glass" />
    </div>
  );
}
