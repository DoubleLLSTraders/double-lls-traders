import { useRef } from "react";

export const MARKETS = [
  { symbol: "1HZ100V", number: "100", name: "Volatility 100 (1s) Index", oneSecond: true },
  { symbol: "1HZ10V", number: "10", name: "Volatility 10 (1s) Index", oneSecond: true },
  { symbol: "1HZ25V", number: "25", name: "Volatility 25 (1s) Index", oneSecond: true },
  { symbol: "1HZ50V", number: "50", name: "Volatility 50 (1s) Index", oneSecond: true },
  { symbol: "1HZ75V", number: "75", name: "Volatility 75 (1s) Index", oneSecond: true },
  { symbol: "R_10", number: "10", name: "Volatility 10 Index", oneSecond: false },
  { symbol: "R_100", number: "100", name: "Volatility 100 Index", oneSecond: false },
  { symbol: "R_25", number: "25", name: "Volatility 25 Index", oneSecond: false },
  { symbol: "R_50", number: "50", name: "Volatility 50 Index", oneSecond: false },
  { symbol: "R_75", number: "75", name: "Volatility 75 Index", oneSecond: false },
] as const;

export function marketLabel(symbol: string): string {
  return MARKETS.find((market) => market.symbol === symbol)?.name ?? symbol;
}

/** Compact index tag for Digits / Start notes — e.g. V75 or V50·1s. */
export function volatilityTag(symbol: string): string {
  const market = MARKETS.find((entry) => entry.symbol === symbol);
  if (!market) return symbol;
  return market.oneSecond ? `V${market.number}·1s` : `V${market.number}`;
}

interface MarketSelectProps {
  value: string;
  onChange: (symbol: string) => void;
}

function MarketIcon({ number, oneSecond }: { number: string; oneSecond: boolean }) {
  return (
    <span className="market-icon" aria-hidden="true">
      <span className="market-icon__number">{number}</span>
      {oneSecond ? <span className="market-icon__speed">1s</span> : null}
      <span className="market-icon__candles">
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function MarketSelect({ value, onChange }: MarketSelectProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selected = MARKETS.find((market) => market.symbol === value) ?? MARKETS[6];

  return (
    <label className="control market-control">
      <span>Market</span>
      <details className="market-select" ref={detailsRef}>
        <summary className="market-select__trigger">
          <MarketIcon number={selected.number} oneSecond={selected.oneSecond} />
          <span className="market-select__trigger-copy">
            <strong>{selected.name}</strong>
          </span>
          <span className="market-select__chevron" aria-hidden="true">⌄</span>
        </summary>

        <div className="market-menu">
          <div className="market-menu__head">Volatility indices</div>
          <div className="market-menu__list">
            {MARKETS.map((market) => (
              <button
                type="button"
                key={market.symbol}
                className={`market-option ${market.symbol === value ? "market-option--selected" : ""}`}
                onClick={() => {
                  onChange(market.symbol);
                  detailsRef.current?.removeAttribute("open");
                }}
              >
                <MarketIcon number={market.number} oneSecond={market.oneSecond} />
                <span className="market-option__name">{market.name}</span>
                <span className="market-option__star" aria-hidden="true">☆</span>
              </button>
            ))}
          </div>
        </div>
      </details>
    </label>
  );
}
