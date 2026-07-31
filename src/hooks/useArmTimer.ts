import { useCallback, useEffect, useRef, useState } from "react";

export interface ArmTimerState {
  /** Whole seconds remaining; null when idle. */
  remaining: number | null;
  /** 0 → 1 how far through the arm window. */
  progress: number;
  arming: boolean;
  start: (seconds: number) => void;
  cancel: () => void;
}

/**
 * Wall-clock countdown that updates ~10×/sec so the UI visibly ticks 15 → 14 → …
 * Fires `onComplete` once when it hits zero.
 */
export function useArmTimer(onComplete: () => void): ArmTimerState {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [armVersion, setArmVersion] = useState(0);

  const endsAtRef = useRef<number | null>(null);
  const totalMsRef = useRef(0);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const cancel = useCallback(() => {
    endsAtRef.current = null;
    completedRef.current = false;
    setRemaining(null);
    setProgress(0);
  }, []);

  const start = useCallback((seconds: number) => {
    const safe = Math.max(1, Math.floor(seconds));
    completedRef.current = false;
    totalMsRef.current = safe * 1000;
    endsAtRef.current = Date.now() + totalMsRef.current;
    setRemaining(safe);
    setProgress(0);
    setArmVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    if (armVersion === 0 || endsAtRef.current === null) return;

    const tick = () => {
      const endsAt = endsAtRef.current;
      if (endsAt === null) return;

      const leftMs = endsAt - Date.now();
      if (leftMs <= 0) {
        endsAtRef.current = null;
        setRemaining(0);
        setProgress(1);
        if (!completedRef.current) {
          completedRef.current = true;
          setRemaining(null);
          onCompleteRef.current();
        }
        return;
      }

      setRemaining(Math.ceil(leftMs / 1000));
      setProgress(1 - leftMs / totalMsRef.current);
    };

    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [armVersion]);

  return {
    remaining,
    progress,
    arming: remaining !== null,
    start,
    cancel,
  };
}
