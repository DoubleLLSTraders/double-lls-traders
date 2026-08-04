import type { ContractSide } from "../lib/analysis/signal";

interface OverUnderChooserProps {
  value: ContractSide;
  disabled?: boolean;
  /** When true, the analyzer is driving Over vs Under until you pick one. */
  auto?: boolean;
  onChange: (side: "DIGITOVER" | "DIGITUNDER") => void;
  /** Resume analyzer-driven Over / Under. */
  onEnableAuto?: () => void;
}

export function OverUnderChooser({
  value,
  disabled = false,
  auto = false,
  onChange,
  onEnableAuto,
}: OverUnderChooserProps) {
  const over = value === "DIGITOVER";
  const under = value === "DIGITUNDER";

  return (
    <section className="mode-chooser" aria-label="Choose Over or Under">
      <div className="mode-chooser__head">
        <h3>Mode</h3>
        {auto ? (
          <p>Auto · tap Over or Under to take manual control</p>
        ) : onEnableAuto ? (
          <button type="button" className="mode-chooser__auto" onClick={onEnableAuto}>
            Resume auto · barrier
          </button>
        ) : (
          <p>You choose · bot stays on this side</p>
        )}
      </div>
      <div className="mode-chooser__grid" role="radiogroup" aria-label="Over or Under">
        <button
          type="button"
          role="radio"
          aria-checked={over}
          aria-disabled={disabled || undefined}
          className={`mode-card ${over ? "is-selected" : ""}${auto ? " is-auto" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("DIGITOVER");
          }}
        >
          <strong>Over</strong>
          <span>Last digit &gt; barrier</span>
          <em>
            {over
              ? auto
                ? "Auto · market"
                : "Your pick"
              : auto
                ? "Tap · Over edge"
                : "Tap to use"}
          </em>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={under}
          aria-disabled={disabled || undefined}
          className={`mode-card ${under ? "is-selected" : ""}${auto ? " is-auto" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("DIGITUNDER");
          }}
        >
          <strong>Under</strong>
          <span>Last digit &lt; barrier</span>
          <em>
            {under
              ? auto
                ? "Auto · market"
                : "Your pick"
              : auto
                ? "Tap · Under edge"
                : "Tap to use"}
          </em>
        </button>
      </div>
    </section>
  );
}
