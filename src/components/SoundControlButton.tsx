import { useEffect, useRef, useState } from "react";
import {
  getSoundVolume,
  isAudioUnlocked,
  isSoundEnabled,
  playGoodSetupSound,
  setSoundEnabled,
  setSoundVolume,
  subscribeSoundSettings,
  unlockAudio,
  type SoundVolume,
} from "../lib/sound";

interface SoundControlButtonProps {
  className?: string;
  labelOn?: string;
  labelOff?: string;
}

const VOLUME_OPTIONS: Array<{ id: SoundVolume; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
];

function readUiSettings() {
  return {
    enabled: isSoundEnabled(),
    volume: getSoundVolume(),
    unlocked: isAudioUnlocked(),
  };
}

export function SoundControlButton({
  className = "",
  labelOn = "Sound on",
  labelOff = "Tap for sound",
}: SoundControlButtonProps) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(readUiSettings);

  useEffect(() => {
    return subscribeSoundSettings(() => {
      setSettings(readUiSettings());
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const buttonClass = [
    className,
    settings.enabled && settings.unlocked ? "digit-map__alert-btn--on" : "",
    !settings.unlocked ? "digit-map__alert-btn--need" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleTestSound() {
    if (!settings.enabled) return;
    unlockAudio();
    playGoodSetupSound();
    setSettings(readUiSettings());
  }

  return (
    <div className="sound-control" ref={anchorRef}>
      <button
        type="button"
        className={buttonClass}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={settings.unlocked ? "Sound settings" : "Open sound settings to enable browser audio"}
        onClick={() => setOpen((value) => !value)}
      >
        {settings.enabled && settings.unlocked ? `🔔 ${labelOn}` : `🔔 ${labelOff}`}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="sound-control__scrim"
            aria-label="Close sound settings"
            onClick={() => setOpen(false)}
          />
          <div
            ref={popoverRef}
            className="sound-control__popover"
            role="dialog"
            aria-modal="true"
            aria-label="Sound settings"
          >
            <header className="sound-control__head">
              <h3>Trade sounds</h3>
              <button
                type="button"
                className="sound-control__close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>

            <div className="sound-control__row">
              <span className="sound-control__label">Alerts</span>
              <div className="sound-control__toggle" role="group" aria-label="Sound alerts">
                <button
                  type="button"
                  className={settings.enabled ? "is-active" : ""}
                  aria-pressed={settings.enabled}
                  onClick={() => {
                    setSoundEnabled(true);
                    unlockAudio();
                    setSettings(readUiSettings());
                  }}
                >
                  On
                </button>
                <button
                  type="button"
                  className={!settings.enabled ? "is-active" : ""}
                  aria-pressed={!settings.enabled}
                  onClick={() => {
                    setSoundEnabled(false);
                    setSettings(readUiSettings());
                  }}
                >
                  Off
                </button>
              </div>
            </div>

            <div className="sound-control__row">
              <span className="sound-control__label">Volume</span>
              <div className="sound-control__volume" role="group" aria-label="Alert volume">
                {VOLUME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={settings.volume === option.id ? "is-active" : ""}
                    aria-pressed={settings.volume === option.id}
                    disabled={!settings.enabled}
                    onClick={() => {
                      setSoundVolume(option.id);
                      if (settings.enabled) {
                        unlockAudio();
                        playGoodSetupSound();
                      }
                      setSettings(readUiSettings());
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="sound-control__test"
              disabled={!settings.enabled}
              onClick={handleTestSound}
            >
              Test alert sound
            </button>

            <p className="sound-control__note">
              {settings.unlocked
                ? "Trade now, win, and loss alerts use this volume."
                : "Tap Test once so your browser allows audio on this device."}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
