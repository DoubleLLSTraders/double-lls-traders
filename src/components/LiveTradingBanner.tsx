import type { ConnectionState } from "../lib/deriv/types";
import type { AppConfig } from "../lib/config";
import { resolveLiveStake } from "../lib/bot/liveProfile";
import type { BotSettings } from "../lib/bot/types";

interface LiveTradingBannerProps {
  mode: AppConfig["mode"];
  isVirtual: boolean;
  connectionState: ConnectionState;
  balance: number | null;
  currency: string;
  symbol: string;
  botSettings: Pick<BotSettings, "stake" | "contracts" | "maxExposurePercent">;
}

export function LiveTradingBanner({
  mode,
  isVirtual,
  connectionState,
  balance,
  currency,
  symbol,
  botSettings,
}: LiveTradingBannerProps) {
  if (mode !== "live") return null;

  const resolved =
    balance !== null
      ? resolveLiveStake(botSettings, balance, isVirtual)
      : {
          stake: botSettings.stake,
          maxExposurePercent: botSettings.maxExposurePercent,
        };
  const socketReady = connectionState === "ready";
  const accountLabel = isVirtual ? "Demo account · virtual money" : "Real account · real money";
  const accountClass = isVirtual ? "live-banner--demo" : "live-banner--real";

  return (
    <div className={`live-banner ${accountClass}`} role="status" aria-live="polite">
      <div className="live-banner__head">
        <strong>Live trading on</strong>
        <span className="live-banner__tag">{isVirtual ? "Demo" : "Real"}</span>
        {!socketReady ? (
          <span className="live-banner__warn">Waiting for socket…</span>
        ) : null}
      </div>
      <p className="live-banner__copy">
        {accountLabel}. Orders go to Deriv as{" "}
        <strong>
          {resolved.stake.toFixed(2)} {currency}
        </strong>{" "}
        on <strong>{symbol}</strong>
        {botSettings.contracts > 1 ? (
          <>
            {" "}
            · <strong>{botSettings.contracts}× bulk</strong>
          </>
        ) : null}
        {resolved.maxExposurePercent > 0
          ? ` · ${resolved.maxExposurePercent}% cap`
          : " · cap off (small balance)"}
        . You can press Stop anytime; open orders keep settling on Deriv.
      </p>
    </div>
  );
}
