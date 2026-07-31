import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const STORAGE_KEY = "brick-trader-bot-split";
const MIN_PCT = 28;
const MAX_PCT = 72;
const DEFAULT_PCT = 42;

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = raw === null ? DEFAULT_PCT : Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_PCT;
    return Math.min(MAX_PCT, Math.max(MIN_PCT, value));
  } catch {
    return DEFAULT_PCT;
  }
}

interface ResizableSplitProps {
  left: ReactNode;
  right: ReactNode;
  className?: string;
}

export function ResizableSplit({ left, right, className = "" }: ResizableSplitProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [leftPct, setLeftPct] = useState(readStored);
  const leftPctRef = useRef(leftPct);
  const dragging = useRef(false);
  leftPctRef.current = leftPct;

  const applyClientX = useCallback((clientX: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    const next = Math.min(MAX_PCT, Math.max(MIN_PCT, pct));
    leftPctRef.current = next;
    setLeftPct(next);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      applyClientX(event.clientX);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("is-resizing-split");
      try {
        localStorage.setItem(STORAGE_KEY, String(leftPctRef.current));
      } catch {
        // ignore quota / private mode
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyClientX]);

  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragging.current = true;
    document.body.classList.add("is-resizing-split");
    applyClientX(event.clientX);
  };

  const resetSplit = () => {
    setLeftPct(DEFAULT_PCT);
    try {
      localStorage.setItem(STORAGE_KEY, String(DEFAULT_PCT));
    } catch {
      // ignore
    }
  };

  return (
    <div ref={shellRef} className={`split-layout ${className}`.trim()}>
      <div className="split-layout__pane split-layout__pane--left" style={{ flexBasis: `${leftPct}%` }}>
        {left}
      </div>
      <div
        className="split-layout__handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN_PCT}
        aria-valuemax={MAX_PCT}
        aria-valuenow={Math.round(leftPct)}
        aria-label="Resize analyzer and bot panels"
        tabIndex={0}
        onPointerDown={onHandleDown}
        onDoubleClick={resetSplit}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setLeftPct((value) => Math.max(MIN_PCT, value - 2));
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setLeftPct((value) => Math.min(MAX_PCT, value + 2));
          }
        }}
      >
        <span className="split-layout__grip" aria-hidden="true" />
      </div>
      <div
        className="split-layout__pane split-layout__pane--right"
        style={{ flexBasis: `${100 - leftPct}%` }}
      >
        {right}
      </div>
    </div>
  );
}
