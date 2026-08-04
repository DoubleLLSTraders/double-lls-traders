import type { TradeDesk } from "../lib/analysis/contractSide";

interface DeskSwitchProps {
  value: TradeDesk;
  disabled?: boolean;
  onChange: (desk: TradeDesk) => void;
}

export function DeskSwitch({
  value,
  disabled = false,
  onChange,
}: DeskSwitchProps) {
  return (
    <section className="desk-switch" aria-label="Choose Digits or Over/Under desk">
      <div className="desk-switch__head">
        <h3>Desk</h3>
        <p>Switch market type · each desk has its own bot and analyzer</p>
      </div>
      <div className="desk-switch__grid" role="radiogroup" aria-label="Trade desk">
        <button
          type="button"
          role="radio"
          aria-checked={value === "digits"}
          aria-disabled={disabled || undefined}
          className={`mode-card ${value === "digits" ? "is-selected" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("digits");
          }}
        >
          <strong>Digits</strong>
          <span>Matches / Differs</span>
          <em>{value === "digits" ? "Active desk" : "Tap to use"}</em>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "overunder"}
          aria-disabled={disabled || undefined}
          className={`mode-card ${value === "overunder" ? "is-selected" : ""}`}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            onChange("overunder");
          }}
        >
          <strong>Over/Under</strong>
          <span>Barrier last digit</span>
          <em>{value === "overunder" ? "Active desk" : "Tap to use"}</em>
        </button>
      </div>
    </section>
  );
}
