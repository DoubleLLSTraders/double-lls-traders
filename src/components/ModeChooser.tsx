import type { ContractSide } from "../lib/analysis/signal";

interface ModeChooserProps {
  value: ContractSide;
  disabled?: boolean;
  /** When true, the live market is driving the side until you pick one. */
  auto?: boolean;
  onChange: (side: ContractSide) => void;
  /** Resume market-driven Matches / Differs. */
  onEnableAuto?: () => void;
}

export function ModeChooser({
  value,
  disabled = false,
  auto = false,
  onChange,
  onEnableAuto,
}: ModeChooserProps) {
  return (
    <section className="mode-chooser" aria-label="Choose Matches or Differs">
      <div className="mode-chooser__head">
        <h3>Mode</h3>
        {auto ? (
          <p>Auto · tap Differs or Matches to take manual control</p>
        ) : onEnableAuto ? (
          <button type="button" className="mode-chooser__auto" onClick={onEnableAuto}>
            Resume auto · market
          </button>
        ) : (
          <p>You choose · bot stays on this side</p>
        )}
      </div>
      <div className="mode-chooser__grid" role="radiogroup" aria-label="Contract mode">
        <button
          type="button"
          role="radio"
          aria-checked={value === "DIGITMATCH"}
          aria-disabled={disabled || undefined}
          className={`mode-card ${value === "DIGITMATCH" ? "is-selected" : ""}${auto ? " is-auto" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("DIGITMATCH");
          }}
        >
          <strong>Matches</strong>
          <span>Equals pick · ~10%</span>
          <em>
            {value === "DIGITMATCH"
              ? auto
                ? "Auto · market"
                : "Your pick"
              : auto
                ? "Tap · hot digit"
                : "Tap to use"}
          </em>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "DIGITDIFF"}
          aria-disabled={disabled || undefined}
          className={`mode-card ${value === "DIGITDIFF" ? "is-selected" : ""}${auto ? " is-auto" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("DIGITDIFF");
          }}
        >
          <strong>Differs</strong>
          <span>Not pick · ~90%</span>
          <em>
            {value === "DIGITDIFF"
              ? auto
                ? "Auto · market"
                : "Your pick"
              : auto
                ? "Tap · cold barrier"
                : "Tap to use"}
          </em>
        </button>
      </div>
    </section>
  );
}
