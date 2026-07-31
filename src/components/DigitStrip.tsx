interface DigitStripProps {
  digits: number[];
  count?: number;
}

export function DigitStrip({ digits, count = 40 }: DigitStripProps) {
  const recent = digits.slice(-count);

  return (
    <section className="ticker" aria-label={`Last ${count} digits, newest on the right`}>
      <div className="ticker__label">Stream</div>
      <div className="ticker__track">
        {recent.length === 0 ? (
          <span className="empty">Waiting for ticks…</span>
        ) : (
          recent.map((digit, index) => {
            const isLatest = index === recent.length - 1;
            return (
              <span
                key={`${index}-${digit}-${isLatest ? "live" : "past"}`}
                className={`ticker__chip ${isLatest ? "is-live" : ""} ${
                  digit % 2 === 0 ? "is-even" : "is-odd"
                }`}
              >
                {digit}
              </span>
            );
          })
        )}
      </div>
    </section>
  );
}
