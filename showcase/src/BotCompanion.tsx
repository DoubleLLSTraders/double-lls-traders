import { useEffect, useRef } from "react";
import { BotAvatar } from "./BotAvatar";

interface BotCompanionProps {
  lastTrade?: { id: number; won: boolean } | null;
  onOpen?: () => void;
}

const MARGIN = 24;
const INTERACTIVE = "a, button, input, label, select, textarea";
const CARVABLE = ".landing .hero, .landing .nav.overlay, .landing .section, .landing .cta-inner, .landing .site-foot";
/** Clear ring between the bot and the text it cuts through. */
const GAP = 12;

/**
 * The bot's face, drifting over the page and cutting a clean hole through the content beneath it.
 * Hover and click are hit-tested by position so links under the bot keep working.
 */
export function BotCompanion({ lastTrade = null, onOpen }: BotCompanionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const size = typeof window !== "undefined" && window.innerWidth < 640 ? 76 : 104;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pick = () => ({
      x: MARGIN + Math.random() * Math.max(0, window.innerWidth - size - MARGIN * 2),
      y: MARGIN + Math.random() * Math.max(0, window.innerHeight - size - MARGIN * 2),
    });
    const pos = { x: window.innerWidth - size - 40, y: window.innerHeight - size - 40 };
    const vel = { x: 0, y: 0 };
    let target = still ? pos : pick();
    let restUntil = 0;
    let raf = 0;
    let hovered = false;
    let layers: HTMLElement[] = [];
    let nextScan = 0;

    const overBot = (e: { clientX: number; clientY: number; target: EventTarget | null }) => {
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return false;
      return Math.hypot(e.clientX - (pos.x + size / 2), e.clientY - (pos.y + size / 2)) < size / 2;
    };

    const setHover = (on: boolean) => {
      if (on === hovered) return;
      hovered = on;
      el.classList.toggle("hover", on);
      document.documentElement.style.cursor = on ? "pointer" : "";
    };

    const onMove = (e: PointerEvent) => setHover(overBot(e));
    const onClick = (e: MouseEvent) => {
      if (overBot(e)) openRef.current?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("click", onClick);

    const loop = (now: number) => {
      if (!still && !hovered) {
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        if (Math.hypot(dx, dy) < 30 && Math.hypot(vel.x, vel.y) < 0.4) {
          if (!restUntil) restUntil = now + 1800 + Math.random() * 3200;
          else if (now > restUntil) {
            target = pick();
            restUntil = 0;
          }
        }
        vel.x = vel.x * 0.95 + dx * 0.0016;
        vel.y = vel.y * 0.95 + dy * 0.0016;
        const speed = Math.hypot(vel.x, vel.y);
        if (speed > 3.2) {
          vel.x *= 3.2 / speed;
          vel.y *= 3.2 / speed;
        }
        pos.x += vel.x;
        pos.y += vel.y;
      } else if (hovered) {
        vel.x *= 0.85;
        vel.y *= 0.85;
      }
      const tilt = Math.max(-14, Math.min(14, vel.x * 4));
      el.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;

      if (now > nextScan) {
        layers = Array.from(document.querySelectorAll<HTMLElement>(CARVABLE));
        nextScan = now + 1000;
      }
      const cx = pos.x + size / 2;
      const cy = pos.y + size / 2;
      const r = size / 2 + GAP;
      for (const layer of layers) {
        const b = layer.getBoundingClientRect();
        const hit = cx + r > b.left && cx - r < b.right && cy + r > b.top && cy - r < b.bottom;
        if (hit) {
          layer.style.setProperty("--bx", `${(cx - b.left).toFixed(1)}px`);
          layer.style.setProperty("--by", `${(cy - b.top).toFixed(1)}px`);
          layer.style.setProperty("--br", `${r}px`);
        }
        if (hit !== layer.classList.contains("carved")) layer.classList.toggle("carved", hit);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      pos.x = Math.min(pos.x, window.innerWidth - size - MARGIN);
      pos.y = Math.min(pos.y, window.innerHeight - size - MARGIN);
      target = pick();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("click", onClick);
      document.documentElement.style.cursor = "";
      for (const layer of layers) layer.classList.remove("carved");
    };
  }, [size]);

  return (
    <div ref={ref} className="companion" aria-hidden="true">
      <div className="companion-bob">
        <div className="companion-hit">
          <BotAvatar size={size} lastTrade={lastTrade} />
        </div>
      </div>
    </div>
  );
}
