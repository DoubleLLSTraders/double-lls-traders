import { useMemo, useState } from "react";
import { DigitBars } from "./components/DigitBars";
import { DigitStrip } from "./components/DigitStrip";
import { StatsPanel } from "./components/StatsPanel";
import { StatusBar } from "./components/StatusBar";
import { useDerivFeed } from "./hooks/useDerivFeed";
import { summarise } from "./lib/analysis/digits";
import { config, isConfigured } from "./lib/config";

const WINDOW_SIZES = [50, 100, 250, 500, 1000] as const;
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ100V"] as const;

function SetupNotice() {
  return (
    <main className="app app--setup">
      <h1 className="setup__title">Setup needed</h1>
      <p className="setup__intro">
        Fill these in inside <code>.env</code>, then restart the dev server:
      </p>
      <ul className="setup__list">
        {config.errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
      <p className="setup__hint">
        The app_id comes from the Deriv developer portal. The token comes from your Deriv account
        settings and needs the Read and Trade scopes only.
      </p>
    </main>
  );
}

export default function App() {
  const [symbol, setSymbol] = useState(config.symbol);
  const [windowSize, setWindowSize] = useState<number>(100);
  const [selectedDigit, setSelectedDigit] = useState<number | null>(null);

  const feed = useDerivFeed(symbol);
  const stats = useMemo(
    () => summarise(feed.digits.slice(-windowSize)),
    [feed.digits, windowSize],
  );

  if (!isConfigured) return <SetupNotice />;

  return (
    <main className="app">
      <StatusBar
        state={feed.state}
        symbol={symbol}
        loginId={feed.account?.loginid ?? null}
        isVirtual={feed.account?.is_virtual === 1}
        balance={feed.balance}
        currency={feed.currency}
        mode={config.mode}
        onReconnect={feed.reconnect}
      />

      {feed.error ? <p className="alert">{feed.error}</p> : null}
      {config.warnings.map((warning) => (
        <p key={warning} className="alert alert--warn">
          {warning}
        </p>
      ))}

      <div className="controls">
        <label className="control">
          <span>Market</span>
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {SYMBOLS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          <span>Window</span>
          <select
            value={windowSize}
            onChange={(event) => setWindowSize(Number(event.target.value))}
          >
            {WINDOW_SIZES.map((size) => (
              <option key={size} value={size}>
                last {size}
              </option>
            ))}
          </select>
        </label>

        <span className="control control--readout">
          {feed.ticks.length > 0
            ? feed.ticks[feed.ticks.length - 1].quote.toFixed(
                feed.ticks[feed.ticks.length - 1].pipSize,
              )
            : "—"}
        </span>
      </div>

      <DigitStrip digits={feed.digits} />
      <DigitBars
        stats={stats}
        selectedDigit={selectedDigit}
        onSelectDigit={(digit) => setSelectedDigit(digit === selectedDigit ? null : digit)}
      />
      <StatsPanel stats={stats} selectedDigit={selectedDigit} />
    </main>
  );
}
