import { useEffect, useRef, useState, type ReactNode } from "react";

interface InfoTipProps {
  label: string;
  title: string;
  children: ReactNode;
  align?: "left" | "right";
}

/** Small "i" button that explains something; hover on desktop, tap on touch screens. */
export function InfoTip({ label, title, children, align = "right" }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
      className={`infotip ${align}${open ? " open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button type="button" className="infotip-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v4M8 4.8v.01" />
        </svg>
      </button>
      <span className="infotip-pop" role="tooltip">
        <strong>{title}</strong>
        {children}
      </span>
    </span>
  );
}
