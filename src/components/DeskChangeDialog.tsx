import type { TradeDesk } from "../lib/analysis/contractSide";

export type DeskChangePhase = "confirm" | "syncing" | "error";

export interface DeskChangeState {
  target: TradeDesk;
  phase: DeskChangePhase;
  detail: string;
}

interface DeskChangeDialogProps {
  state: DeskChangeState;
  onConfirm: () => void;
  onCancel: () => void;
}

function deskTitle(desk: TradeDesk): string {
  return desk === "overunder" ? "Over/Under" : "Digits";
}

function deskBlurb(desk: TradeDesk): string {
  return desk === "overunder"
    ? "Barrier last-digit contracts (Over / Under). Syncs live ticks and verifies DIGITOVER / DIGITUNDER on Deriv before the desk goes live."
    : "Matches / Differs digit contracts. Syncs live ticks and verifies the Digits market on Deriv before the desk goes live.";
}

export function DeskChangeDialog({
  state,
  onConfirm,
  onCancel,
}: DeskChangeDialogProps) {
  const title = deskTitle(state.target);
  const syncing = state.phase === "syncing";

  return (
    <div className="desk-change" role="dialog" aria-modal="true" aria-labelledby="desk-change-title">
      <button
        type="button"
        className="desk-change__scrim"
        aria-label="Cancel desk switch"
        disabled={syncing}
        onClick={onCancel}
      />
      <div className="desk-change__card">
        <div className="desk-change__head">
          <h3 id="desk-change-title">
            {syncing
              ? `Syncing ${title}…`
              : state.phase === "error"
                ? `Could not switch to ${title}`
                : `Switch to ${title}?`}
          </h3>
          <p>{deskBlurb(state.target)}</p>
        </div>

        <div
          className={`desk-change__status desk-change__status--${state.phase}`}
          aria-live="polite"
        >
          {syncing ? (
            <span className="desk-change__spinner" aria-hidden="true" />
          ) : null}
          <strong>
            {state.phase === "confirm"
              ? "Confirm to sync with Deriv realtime"
              : state.phase === "syncing"
                ? "Connecting to Deriv…"
                : "Sync failed"}
          </strong>
          <em>{state.detail}</em>
        </div>

        <div className="desk-change__actions">
          {state.phase === "confirm" || state.phase === "error" ? (
            <>
              <button type="button" className="desk-change__btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="desk-change__btn desk-change__btn--primary"
                onClick={onConfirm}
              >
                {state.phase === "error" ? "Retry sync" : `Confirm · ${title}`}
              </button>
            </>
          ) : (
            <button type="button" className="desk-change__btn" disabled>
              Please wait…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
