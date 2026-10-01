import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CONTRACT_NAMES, MODES, type ContractTally, type ContractType } from "./bot";
import { HISTORY_EVENT, clearHistory, loadHistory, type SessionRecord, type SessionTrade } from "./sessionStore";
import { Sparkline } from "./Sparkline";
import { NEGATIVE, POSITIVE, pct, signedUsd, usd } from "./ui";

const LIVE_WINDOW_MS = 10_000;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Tab = "overview" | "sessions" | "trades" | "contracts";
type SortKey = "startedAt" | "duration" | "trades" | "winRate" | "totalStaked" | "maxDrawdown" | "pnl";
type Outcome = "all" | "up" | "down";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "M2.5 13.5h11M4 11V7M8 11V3.5M12 11V8" },
  { id: "sessions", label: "Sessions", icon: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" },
  { id: "trades", label: "Trades", icon: "M3 4h10M3 8h10M3 12h10" },
  { id: "contracts", label: "Contracts", icon: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" },
];

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");
const winRateOf = (r: { trades: number; wins: number }) => (r.trades ? (r.wins / r.trades) * 100 : 0);
const modeLabel = (r: SessionRecord) => MODES.find((m) => m.id === r.mode)?.label ?? r.mode;
const isLive = (r: SessionRecord) => r.running && Date.now() - r.updatedAt < LIVE_WINDOW_MS;
const contractOf = (label: string) => label.split(" ")[0];

function sortValue(r: SessionRecord, key: SortKey): number {
  if (key === "duration") return r.updatedAt - r.startedAt;
  if (key === "winRate") return winRateOf(r);
  return r[key];
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((row) => row.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d={d} /></svg>;
}

function Kpi({ label, value, className = "", sub }: { label: string; value: string; className?: string; sub?: string }) {
  return (
    <div className="hp-kpi">
      <span>{label}</span>
      <strong className={className}>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function ContractTable({ rows }: { rows: [string, ContractTally][] }) {
  if (!rows.length) return <p className="hp-empty">No contracts traded yet.</p>;
  const max = Math.max(...rows.map(([, v]) => Math.abs(v.pnl)), 0.01);
  return (
    <table className="hp-table">
      <thead>
        <tr><th>Contract</th><th className="num">Trades</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Win rate</th><th>Share of P/L</th><th className="num">P/L</th></tr>
      </thead>
      <tbody>
        {rows.map(([name, v]) => (
          <tr key={name}>
            <td><strong>{name}</strong></td>
            <td className="num">{v.trades.toLocaleString()}</td>
            <td className="num">{v.wins.toLocaleString()}</td>
            <td className="num">{(v.trades - v.wins).toLocaleString()}</td>
            <td className="num">{pct(winRateOf(v))}</td>
            <td><span className="hp-bar"><i className={tone(v.pnl)} style={{ width: `${(Math.abs(v.pnl) / max) * 100}%` }} /></span></td>
            <td className={`num ${tone(v.pnl)}`}>{signedUsd(v.pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradeTable({ trades, showSession }: { trades: (SessionTrade & { session?: SessionRecord })[]; showSession?: boolean }) {
  if (!trades.length) return <p className="hp-empty">No trades match.</p>;
  return (
    <table className="hp-table">
      <thead>
        <tr>
          {showSession && <th>Session</th>}
          <th>#</th><th>Contract</th><th className="num">Exit digit</th><th className="num">Stake</th><th>Result</th><th className="num">P/L</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => (
          <tr key={i}>
            {showSession && <td className="muted">{t.session ? dateFmt.format(t.session.startedAt) : ""}</td>}
            <td className="muted">{t.id ?? "—"}</td>
            <td><strong>{t.label}</strong></td>
            <td className="num">{t.digit ?? "—"}</td>
            <td className="num">{usd(t.stake)}</td>
            <td><span className={`hp-pill ${t.won ? "up" : "down"}`}>{t.won ? "Won" : "Lost"}</span></td>
            <td className={`num ${t.won ? "up" : "down"}`}>{signedUsd(t.pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SessionDetail({ r, onBack }: { r: SessionRecord; onBack: () => void }) {
  const contracts = (Object.entries(r.byContract) as [ContractType, ContractTally][])
    .map(([k, v]) => [CONTRACT_NAMES[k], v] as [string, ContractTally])
    .sort((a, b) => b[1].pnl - a[1].pnl);
  return (
    <>
      <button type="button" className="hp-crumb" onClick={onBack}>‹ All sessions</button>
      <div className="hp-head">
        <div>
          <h1>{dateFmt.format(r.startedAt)}</h1>
          <p>
            {isLive(r) ? <><i className="live-dot" /> Live now</> : duration(r.updatedAt - r.startedAt)} · {modeLabel(r)} · {usd(r.stake)} stake
            {r.stopReason && <> · {r.stopReason}</>}
          </p>
        </div>
        <strong className={`hp-big ${tone(r.pnl)}`}>{signedUsd(r.pnl)}</strong>
      </div>
      <div className="hp-kpis">
        <Kpi label="Start balance" value={usd(r.startBalance)} />
        <Kpi label="End balance" value={usd(r.endBalance)} />
        <Kpi label="Trades" value={r.trades.toLocaleString()} sub={`${r.wins} won · ${r.trades - r.wins} lost`} />
        <Kpi label="Win rate" value={pct(winRateOf(r))} />
        <Kpi label="Money in" value={`−${usd(r.totalStaked)}`} className="down" />
        <Kpi label="Money out" value={`+${usd(r.totalStaked + r.pnl)}`} className="up" />
        <Kpi label="Largest stake" value={usd(r.largestStake)} />
        <Kpi label="Max drawdown" value={`−${usd(r.maxDrawdown)}`} className="down" />
      </div>
      <section className="hp-card">
        <header><h2>Equity curve</h2></header>
        <Sparkline values={[0, ...r.equity]} baseline={0} stroke={r.pnl >= 0 ? POSITIVE : NEGATIVE} height={160} />
      </section>
      <section className="hp-card">
        <header><h2>By contract</h2></header>
        <ContractTable rows={contracts} />
      </section>
      <section className="hp-card">
        <header>
          <h2>Trades</h2>
          <span className="muted">Last {r.recent.length} of {r.trades.toLocaleString()}</span>
        </header>
        <TradeTable trades={r.recent} />
      </section>
    </>
  );
}

function HistoryPage({ sessions, onClose }: { sessions: SessionRecord[]; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "startedAt", desc: true });
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [tradeOutcome, setTradeOutcome] = useState<Outcome>("all");
  const [contract, setContract] = useState("all");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("hp-lock");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("hp-lock");
    };
  }, [onClose]);

  const totals = useMemo(
    () => sessions.reduce(
      (a, r) => ({ pnl: a.pnl + r.pnl, trades: a.trades + r.trades, wins: a.wins + r.wins, staked: a.staked + r.totalStaked, time: a.time + (r.updatedAt - r.startedAt) }),
      { pnl: 0, trades: 0, wins: 0, staked: 0, time: 0 },
    ),
    [sessions],
  );
  const chrono = useMemo(() => [...sessions].sort((a, b) => a.startedAt - b.startedAt), [sessions]);
  const cumulative = useMemo(() => {
    let run = 0;
    return [0, ...chrono.map((r) => (run += r.pnl))];
  }, [chrono]);
  const best = sessions.reduce<SessionRecord | null>((b, r) => (!b || r.pnl > b.pnl ? r : b), null);
  const worst = sessions.reduce<SessionRecord | null>((b, r) => (!b || r.pnl < b.pnl ? r : b), null);
  const winning = sessions.filter((r) => r.pnl > 0).length;

  const contractRows = useMemo(() => {
    const agg = new Map<string, ContractTally>();
    for (const r of sessions) {
      for (const [k, v] of Object.entries(r.byContract) as [ContractType, ContractTally][]) {
        const name = CONTRACT_NAMES[k];
        const a = agg.get(name) ?? { trades: 0, wins: 0, pnl: 0 };
        agg.set(name, { trades: a.trades + v.trades, wins: a.wins + v.wins, pnl: a.pnl + v.pnl });
      }
    }
    return [...agg.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  }, [sessions]);

  const sortedSessions = useMemo(() => {
    const list = sessions.filter((r) => outcome === "all" || (outcome === "up" ? r.pnl > 0 : r.pnl <= 0));
    return list.sort((a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * (sort.desc ? -1 : 1));
  }, [sessions, outcome, sort]);

  const allTrades = useMemo(() => sessions.flatMap((r) => r.recent.map((t) => ({ ...t, session: r }))), [sessions]);
  const tradeContracts = useMemo(() => [...new Set(allTrades.map((t) => contractOf(t.label)))].sort(), [allTrades]);
  const trades = allTrades.filter(
    (t) => (tradeOutcome === "all" || (tradeOutcome === "up") === t.won) && (contract === "all" || contractOf(t.label) === contract),
  );

  const selectedSession = selected ? sessions.find((r) => r.id === selected) ?? null : null;
  const openSession = (id: string) => {
    setSelected(id);
    setTab("sessions");
  };

  const th = (key: SortKey, label: string, num = true) => (
    <th className={`${num ? "num " : ""}sortable${sort.key === key ? " on" : ""}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
      {label}{sort.key === key && <i>{sort.desc ? "↓" : "↑"}</i>}
    </th>
  );

  const exportSessions = () =>
    downloadCsv("double-lls-sessions.csv", [
      ["Started", "Duration (min)", "Mode", "Stake", "Trades", "Wins", "Win rate %", "Money in", "Money out", "Max drawdown", "Start balance", "End balance", "P/L", "Stop reason"],
      ...sortedSessions.map((r) => [
        new Date(r.startedAt).toISOString(), Math.round((r.updatedAt - r.startedAt) / 60_000), modeLabel(r), r.stake, r.trades, r.wins,
        winRateOf(r).toFixed(2), r.totalStaked.toFixed(2), (r.totalStaked + r.pnl).toFixed(2), r.maxDrawdown.toFixed(2),
        r.startBalance.toFixed(2), r.endBalance.toFixed(2), r.pnl.toFixed(2), r.stopReason ?? "",
      ]),
    ]);

  const exportTrades = () =>
    downloadCsv("double-lls-trades.csv", [
      ["Session", "#", "Contract", "Exit digit", "Stake", "Won", "P/L"],
      ...trades.map((t) => [new Date(t.session.startedAt).toISOString(), t.id ?? "", t.label, t.digit ?? "", t.stake.toFixed(2), t.won ? "yes" : "no", t.pnl.toFixed(2)]),
    ]);

  const onClear = () => {
    if (window.confirm("Delete all saved sessions from this device?")) {
      clearHistory();
      setSelected(null);
    }
  };

  return createPortal(
    <div className="hp" role="dialog" aria-label="History">
      <nav className="hp-nav">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to the tester">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
        </button>
        <span className="hp-title">History</span>
        <span className="hp-saved">Saved on this device</span>
        <span className="hp-nav-gap" />
        {sessions.length > 0 && <button type="button" className="hp-clear" onClick={onClear}>Clear history</button>}
      </nav>

      <div className="hp-shell">
        <aside className="hp-side">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "on" : ""}
              onClick={() => {
                setTab(t.id);
                setSelected(null);
              }}
            >
              <Icon d={t.icon} />
              <span>{t.label}</span>
              {t.id === "sessions" && <em>{sessions.length}</em>}
              {t.id === "trades" && <em>{allTrades.length}</em>}
            </button>
          ))}
          <p className="hp-side-note">Kept in this browser only. Clearing site data removes it.</p>
        </aside>

        <main className="hp-main">
          {sessions.length === 0 ? (
            <div className="hp-blank">
              <h1>No sessions yet</h1>
              <p>Start the bot and every run is saved here automatically.</p>
              <button type="button" className="btn solid" onClick={onClose}>Back to the tester</button>
            </div>
          ) : tab === "overview" ? (
            <>
              <div className="hp-head">
                <div>
                  <h1>Overview</h1>
                  <p>{sessions.length} sessions · {duration(totals.time)} of trading</p>
                </div>
                <strong className={`hp-big ${tone(totals.pnl)}`}>{signedUsd(totals.pnl)}</strong>
              </div>
              <div className="hp-kpis">
                <Kpi label="Sessions" value={String(sessions.length)} sub={`${winning} up · ${sessions.length - winning} down`} />
                <Kpi label="Trades" value={totals.trades.toLocaleString()} sub={`${totals.wins.toLocaleString()} won`} />
                <Kpi label="Win rate" value={pct(winRateOf(totals))} />
                <Kpi label="Money in" value={`−${usd(totals.staked)}`} className="down" />
                <Kpi label="Money out" value={`+${usd(totals.staked + totals.pnl)}`} className="up" />
                <Kpi label="Best session" value={best ? signedUsd(best.pnl) : "—"} className={best ? tone(best.pnl) : ""} sub={best ? dateFmt.format(best.startedAt) : undefined} />
                <Kpi label="Worst session" value={worst ? signedUsd(worst.pnl) : "—"} className={worst ? tone(worst.pnl) : ""} sub={worst ? dateFmt.format(worst.startedAt) : undefined} />
                <Kpi label="Avg per session" value={signedUsd(totals.pnl / sessions.length)} className={tone(totals.pnl)} />
              </div>
              <section className="hp-card">
                <header><h2>Cumulative earnings</h2><span className="muted">Across all sessions, oldest to newest</span></header>
                <Sparkline values={cumulative} baseline={0} stroke={totals.pnl >= 0 ? POSITIVE : NEGATIVE} height={180} />
              </section>
              <section className="hp-card">
                <header>
                  <h2>Recent sessions</h2>
                  <button type="button" className="btn ghost sm" onClick={() => setTab("sessions")}>View all ›</button>
                </header>
                <table className="hp-table">
                  <thead><tr><th>Started</th><th>Mode</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">P/L</th></tr></thead>
                  <tbody>
                    {sessions.slice(0, 5).map((r) => (
                      <tr key={r.id} className="click" onClick={() => openSession(r.id)}>
                        <td><strong>{dateFmt.format(r.startedAt)}</strong>{isLive(r) && <span className="hp-live"><i className="live-dot" />Live</span>}</td>
                        <td>{modeLabel(r)}</td>
                        <td className="num">{r.trades.toLocaleString()}</td>
                        <td className="num">{pct(winRateOf(r))}</td>
                        <td className={`num ${tone(r.pnl)}`}>{signedUsd(r.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          ) : tab === "sessions" && selectedSession ? (
            <SessionDetail r={selectedSession} onBack={() => setSelected(null)} />
          ) : tab === "sessions" ? (
            <>
              <div className="hp-head">
                <div><h1>Sessions</h1><p>Click a session for its full breakdown.</p></div>
              </div>
              <div className="hp-tools">
                <div className="segmented">
                  {(["all", "up", "down"] as Outcome[]).map((o) => (
                    <button key={o} className={outcome === o ? "on" : ""} onClick={() => setOutcome(o)}>{o === "all" ? "All" : o === "up" ? "Profitable" : "Losing"}</button>
                  ))}
                </div>
                <button type="button" className="btn outline sm" onClick={exportSessions}>Export CSV</button>
              </div>
              <section className="hp-card flush">
                <div className="hp-scroll">
                  <table className="hp-table">
                    <thead>
                      <tr>
                        {th("startedAt", "Started", false)}
                        {th("duration", "Duration")}
                        <th>Mode</th>
                        <th className="num">Stake</th>
                        {th("trades", "Trades")}
                        {th("winRate", "Win rate")}
                        {th("totalStaked", "Money in")}
                        {th("maxDrawdown", "Max DD")}
                        <th className="num">End balance</th>
                        <th>Curve</th>
                        {th("pnl", "P/L")}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSessions.map((r) => (
                        <tr key={r.id} className="click" onClick={() => setSelected(r.id)}>
                          <td><strong>{dateFmt.format(r.startedAt)}</strong>{isLive(r) && <span className="hp-live"><i className="live-dot" />Live</span>}</td>
                          <td className="num">{duration(r.updatedAt - r.startedAt)}</td>
                          <td>{modeLabel(r)}</td>
                          <td className="num">{usd(r.stake)}</td>
                          <td className="num">{r.trades.toLocaleString()}</td>
                          <td className="num">{pct(winRateOf(r))}</td>
                          <td className="num">{usd(r.totalStaked)}</td>
                          <td className="num down">−{usd(r.maxDrawdown)}</td>
                          <td className="num">{usd(r.endBalance)}</td>
                          <td className="hp-spark"><Sparkline values={[0, ...r.equity]} baseline={0} stroke={r.pnl >= 0 ? POSITIVE : NEGATIVE} height={28} grid={0} /></td>
                          <td className={`num ${tone(r.pnl)}`}><strong>{signedUsd(r.pnl)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : tab === "trades" ? (
            <>
              <div className="hp-head">
                <div><h1>Trades</h1><p>The latest trades from every session, newest first.</p></div>
              </div>
              <div className="hp-tools">
                <div className="segmented">
                  {(["all", "up", "down"] as Outcome[]).map((o) => (
                    <button key={o} className={tradeOutcome === o ? "on" : ""} onClick={() => setTradeOutcome(o)}>{o === "all" ? "All" : o === "up" ? "Won" : "Lost"}</button>
                  ))}
                </div>
                <div className="segmented">
                  {["all", ...tradeContracts].map((c) => (
                    <button key={c} className={contract === c ? "on" : ""} onClick={() => setContract(c)}>{c === "all" ? "All contracts" : c}</button>
                  ))}
                </div>
                <span className="hp-count">{trades.length.toLocaleString()} trades</span>
                <button type="button" className="btn outline sm" onClick={exportTrades}>Export CSV</button>
              </div>
              <section className="hp-card flush">
                <div className="hp-scroll">
                  <TradeTable trades={trades} showSession />
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="hp-head">
                <div><h1>Contracts</h1><p>How each contract type has performed across all sessions.</p></div>
              </div>
              <section className="hp-card flush">
                <ContractTable rows={contractRows} />
              </section>
            </>
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}

/** Nav button that opens the full-page history; records live in this browser's local storage. */
export function History() {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>(loadHistory);

  useEffect(() => {
    const sync = () => setSessions(loadHistory());
    window.addEventListener(HISTORY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(HISTORY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return (
    <div className="assist hist">
      <button type="button" className="assist-tab" onClick={() => setOpen(true)}>
        <span className="hist-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" /></svg>
        </span>
        <span>History</span>
        {sessions.length > 0 && <em>{sessions.length}</em>}
      </button>
      {open && <HistoryPage sessions={sessions} onClose={() => setOpen(false)} />}
    </div>
  );
}
