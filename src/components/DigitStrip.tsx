interface DigitStripProps {
  digits: number[];
  count?: number;
}

export function DigitStrip({ digits, count = 24 }: DigitStripProps) {
  const recent = digits.slice(-count);

  return (
    <section className="panel">
      <h2 className="panel__title">
        Last {recent.length} digits
        <span className="panel__hint">newest on the right</span>
      </h2>
      <div className="digit-strip">
        {recent.map((digit, index) => {
          const isLatest = index === recent.length - 1;
          return (
            <span
              key={`${index}-${digit}`}
              className={`digit-chip ${isLatest ? "digit-chip--latest" : ""} ${
                digit % 2 === 0 ? "digit-chip--even" : "digit-chip--odd"
              }`}
            >
              {digit}
            </span>
          );
        })}
        {recent.length === 0 ? <span className="panel__empty">Waiting for ticks…</span> : null}
      </div>
    </section>
  );
}
