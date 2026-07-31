import { useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { isSoundEnabled, playWinSound, setSoundEnabled } from "../lib/sound";
import logoDark from "../assets/logo.png";
import logoLight from "../assets/logo-light.png";

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
      {on ? (
        <>
          <path d="M15.6 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
        </>
      ) : (
        <>
          <path d="M16.2 9.8l4.4 4.4" />
          <path d="M20.6 9.8l-4.4 4.4" />
        </>
      )}
    </svg>
  );
}

export function BrandStamp() {
  const { theme } = useTheme();
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());

  return (
    <div className="brand-stamp" aria-label="Brick Trader notice">
      <div className="brand-stamp__inner">
        <img
          src={theme === "light" ? logoLight : logoDark}
          alt=""
          className="brand-stamp__logo"
        />
        <div className="brand-stamp__body">
          <div className="brand-stamp__head">
            <strong className="brand-stamp__name">Brick Trader</strong>
            <span className="brand-stamp__badge">Disclaimer</span>
            <button
              type="button"
              className="brand-stamp__sound"
              aria-pressed={soundOn}
              aria-label={soundOn ? "Mute trade sounds" : "Unmute trade sounds"}
              title={soundOn ? "Trade sounds on" : "Trade sounds off"}
              onClick={() => {
                const next = !soundOn;
                setSoundEnabled(next);
                setSoundOn(next);
                if (next) playWinSound();
              }}
            >
              <SpeakerIcon on={soundOn} />
            </button>
          </div>
          <p className="brand-stamp__disclaimer">
            For analysis and education only. Not financial advice. Digit patterns
            on synthetic indices do not guarantee future results. Trade only with
            funds you can afford to lose.
          </p>
        </div>
      </div>
    </div>
  );
}
