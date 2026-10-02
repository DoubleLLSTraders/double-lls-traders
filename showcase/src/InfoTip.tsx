import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface InfoTipProps {
  label: string;
  title: string;
  children: ReactNode;
  align?: "left" | "right";
}

const EDGE = 8;
const GAP = 8;

/**
 * Small "i" button that explains something; hover on desktop, tap on touch screens.
 * The bubble renders on document.body so panels with overflow: hidden can't clip it.
 */
export function InfoTip({ label, title, children, align = "right" }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      if (!rootRef.current || !popRef.current) return;
      const a = rootRef.current.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = popRef.current;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const preferred = align === "right" ? a.right + 6 - w : a.left - 6;
      const left = Math.min(Math.max(EDGE, preferred), Math.max(EDGE, vw - w - EDGE));
      const below = a.bottom + GAP;
      const top = below + h > vh - EDGE && a.top - GAP - h >= EDGE ? a.top - GAP - h : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`infotip${open ? " open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button type="button" className="infotip-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v4M8 4.8v.01" />
        </svg>
      </button>
      {open &&
        createPortal(
          <span
            ref={popRef}
            className={`infotip-pop${pos ? " shown" : ""}`}
            role="tooltip"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
          >
            <strong>{title}</strong>
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
