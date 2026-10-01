import { useEffect, useState, type ReactNode } from "react";
import { savedApiKey, useAccount } from "./account";
import { DEFAULT_SETTINGS, type BotSettings } from "./bot";
import { CodeBlock } from "./CodeBlock";

const SECTIONS = [
  ["overview", "Overview"],
  ["key", "Get your API key"],
  ["auth", "Authentication"],
  ["quickstart", "Quick start"],
  ["agents", "Connect an AI agent"],
  ["endpoints", "Endpoints"],
  ["sessions", "How paper sessions work"],
  ["settings", "Bot settings"],
  ["limits", "Limits and errors"],
  ["real", "Trading a real account"],
  ["legal", "Terms and privacy"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

const SETTINGS_DOC: [keyof BotSettings, string][] = [
  ["symbol", '"auto" scans all 10 volatility indices and trades the strongest; or one symbol such as "1HZ75V". See GET /markets.'],
  ["mode", '"auto" picks the best contract type; or limit it to "differs", "matches", "overunder" or "evenodd".'],
  ["stake", "Base stake per trade, in USD (0.35 minimum)."],
  ["startBalance", "Demo balance a paper session starts with."],
  ["takeProfit", "Stop when session profit reaches this. 0 = off."],
  ["stopLoss", "Stop when session loss reaches this. 0 = off."],
  ["window", "Ticks of history each setup is scored on."],
  ["confirmWindow", "Recent ticks the setup must also beat break-even on."],
  ["minConfidence", "How many standard errors the win rate must sit above break-even."],
  ["minWinRate", "Only trade setups whose win rate is at least this %. 0 = off."],
  ["persistTicks", "A setup must stay qualified this many ticks in a row before entry."],
  ["martingale", "After a loss, size up to win back the losing streak."],
  ["autoMartingale", "Let the bot size recovery from balance, payout and stop loss."],
  ["maxMartingaleSteps", "Recovery attempts before the loss is accepted."],
  ["maxStakePercent", "Hard cap on any single stake, as % of balance."],
  ["stackStakes", "Buy extra stake units when confidence is far above the bar."],
  ["maxStack", "Most stake units one entry may use."],
  ["turbo", "Trade every tick of every market, one position per market. Fast and high-risk."],
  ["maxConsecutiveLosses", "Stop after this many losses in a row. 0 = off."],
  ["cooldownTicks", "Ticks to wait after each trade."],
  ["lossCooldown", "Extra ticks to wait after a loss."],
  ["kellySizing", "Size stakes from the measured edge (fractional Kelly)."],
  ["kellyFraction", "Share of the full Kelly stake, 0–1."],
  ["drawdownBrake", "Halve stakes while down this % from the peak. 0 = off."],
  ["randomnessFilter", "Only trade when the digit mix is measurably uneven."],
  ["regimeGuard", "Skip entries when the latest digits break sharply from the window."],
  ["strictStats", "Raise the bar to allow for scanning many setups at once."],
];

const ENDPOINTS: { method: "GET" | "POST" | "DELETE"; path: string; what: string; body?: string; returns: string }[] = [
  { method: "GET", path: "/me", what: "This key's details, usage and limits.", returns: "{ id, prefix, email, requests, runningSessions, storedSessions, limits }" },
  { method: "DELETE", path: "/me", what: "Delete this key and every session stored for it.", returns: "{ deleted: true }" },
  { method: "GET", path: "/markets", what: "Volatility indices, strategy modes and contract types.", returns: "{ symbols: [{ id, name }], modes, contracts }" },
  { method: "GET", path: "/settings/defaults", what: "Default settings and the tested presets (careful, balanced, active).", returns: "{ settings, presets }" },
  { method: "POST", path: "/scan", what: "Score every digit setup on the latest live ticks of each market.", body: '{ "symbol": "auto", "settings": { "mode": "auto" } }', returns: "{ at, best: { market, setup, winRate, confidence, qualified, … } | null, markets: [{ market, lastDigits, top }] }" },
  { method: "POST", path: "/backtest", what: "Run the bot on a simulated market or on the last 1,000 real ticks of each index.", body: '{ "market": "real-recent", "settings": { "stake": 1 } }', returns: "{ market, ticks, trades, winRate, pnl, maxDrawdown, equity }" },
  { method: "POST", path: "/sessions", what: "Start a paper-trading bot on the live feed with demo money.", body: '{ "settings": { "symbol": "auto", "stake": 1, "startBalance": 1000 } }', returns: "Session (see below), status 201" },
  { method: "GET", path: "/sessions", what: "All your sessions, brought up to date with the market.", returns: "{ sessions: [Session] }" },
  { method: "GET", path: "/sessions/{id}", what: "One session in full: settings, recent trades and equity curve.", returns: "Session + { settings, recentTrades, equity }" },
  { method: "POST", path: "/sessions/{id}/stop", what: "Stop a running session.", returns: "Session" },
  { method: "DELETE", path: "/sessions/{id}", what: "Delete a session and its results.", returns: "{ deleted: id }" },
  { method: "POST", path: "/export", what: "A runnable bot file for your own Deriv account.", body: '{ "format": "python", "settings": { "stake": 1 } }', returns: "{ file, text }" },
];

const TOOLS: [string, string][] = [
  ["get_markets", "Indices, modes and contract types"],
  ["get_default_settings", "Defaults and tested presets"],
  ["scan_markets", "Live scan of every setup"],
  ["backtest", "Simulated or recent-real backtest"],
  ["start_session", "Start a live paper bot"],
  ["list_sessions", "Your sessions, up to date"],
  ["get_session", "One session in full"],
  ["stop_session", "Stop a session"],
  ["delete_session", "Delete a session"],
  ["export_bot", "Runnable bot file"],
  ["get_account", "Key usage and limits"],
];

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section id={`doc-${id}`} className="doc-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Docs() {
  const account = useAccount();
  const [active, setActive] = useState<SectionId>("overview");
  const origin = window.location.origin;
  const base = `${origin}/api/v1`;
  const key = savedApiKey() || "lls_YOUR_KEY";

  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(`doc-${id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.slice(4) as SectionId);
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const go = (id: SectionId) => document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const keyCta = (
    <a className="btn solid" href="#/account">{account ? "Open API keys in your account" : "Sign in to get your key"}</a>
  );

  return (
    <div className="co docs">
      <div className="co-glow" />
      <nav className="co-nav">
        <a className="btn ghost" href="#/">‹ Back</a>
        <span className="wordmark">DOUBLE LLS<span>DOCS</span></span>
        <a className="btn outline sm" href="#/account">{account ? "API keys" : "Sign in"}</a>
      </nav>

      <div className="docs-layout">
        <aside className="docs-side">
          <span className="docs-side-label">API v1</span>
          {SECTIONS.map(([id, title]) => (
            <button key={id} type="button" className={active === id ? "on" : ""} onClick={() => go(id)}>{title}</button>
          ))}
        </aside>

        <main className="docs-main">
          <header className="docs-hero">
            <span className="dev-eyebrow">Developers</span>
            <h1>Let any app or AI agent run the bot</h1>
            <p>
              Scan live Deriv markets, backtest, run paper-trading bots that keep going on our servers, and export
              runnable bots. Use it from your own code over REST, or plug it into an AI agent as an MCP server.
            </p>
          </header>

          <Section id="overview" title="Overview">
            <div className="doc-cards">
              <div><b>REST API</b><span>JSON over HTTPS at <code>{base}</code>. Works from any language.</span></div>
              <div><b>MCP server</b><span>One URL, <code>{origin}/api/mcp</code>, gives agents 11 ready-made tools.</span></div>
              <div><b>OpenAPI</b><span>Full spec at <code>/api/v1/openapi.json</code> for ChatGPT Actions and code generators.</span></div>
            </div>
            <p>Everything runs on demo money. Real trading happens only in exported bot files that you run with your own Deriv token.</p>
          </Section>

          <Section id="key" title="Get your API key">
            <ol className="doc-steps">
              <li><b>Create a free account</b> or sign in.</li>
              <li>Open your <b>account page</b> and find <b>API keys</b>.</li>
              <li>Name the key (for example "Cursor agent") and press <b>Create key</b>.</li>
              <li><b>Copy it straight away.</b> It starts with <code>lls_</code> and is shown once: we only store a hash.</li>
            </ol>
            <p>You can have up to 5 keys and revoke any of them at any time. Revoking a key also deletes its paper sessions.</p>
            {keyCta}
          </Section>

          <Section id="auth" title="Authentication">
            <p>Send your key on every request in the <code>Authorization</code> header. <code>X-Api-Key: lls_…</code> also works.</p>
            <CodeBlock>{`Authorization: Bearer ${key}`}</CodeBlock>
            <p className="muted">Keep keys secret: anyone with a key can use your sessions. Never put one in a public repo, a URL or front-end code.</p>
          </Section>

          <Section id="quickstart" title="Quick start">
            <p><b>1. Scan the markets now.</b> Returns the strongest setup per index and the best one overall.</p>
            <CodeBlock>{`curl -X POST ${base}/scan \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"symbol":"auto"}'`}</CodeBlock>
            <p><b>2. Start a paper bot.</b> It trades the live feed with a demo balance until it hits a limit or you stop it.</p>
            <CodeBlock>{`curl -X POST ${base}/sessions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"settings":{"symbol":"auto","stake":1,"startBalance":1000,"takeProfit":10,"stopLoss":50}}'`}</CodeBlock>
            <p><b>3. Check on it</b> whenever you like, using the <code>id</code> from step 2.</p>
            <CodeBlock>{`curl ${base}/sessions/ses_xxxxxxxx \\
  -H "Authorization: Bearer ${key}"`}</CodeBlock>
            <p>The same in JavaScript:</p>
            <CodeBlock label="JavaScript">{`const api = (path, body) =>
  fetch("${base}" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer ${key}", "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

const session = await api("/sessions", { settings: { symbol: "auto", stake: 1, startBalance: 1000 } });
const latest = await api(\`/sessions/\${session.id}\`);
console.log(latest.trades, latest.pnl, latest.winRate);`}</CodeBlock>
          </Section>

          <Section id="agents" title="Connect an AI agent">
            <p>The MCP server lets an agent use the bot by itself: scan, backtest, start and follow sessions, and hand you a bot file. Pick your tool:</p>
            <CodeBlock label="Cursor · .cursor/mcp.json">{JSON.stringify({ mcpServers: { "double-lls": { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}</CodeBlock>
            <CodeBlock label="Claude Code">{`claude mcp add --transport http double-lls ${origin}/api/mcp \\
  --header "Authorization: Bearer ${key}"`}</CodeBlock>
            <p><b>ChatGPT and other OpenAPI tools:</b> import <code>{base}/openapi.json</code> as an Action and choose API key auth, type Bearer.</p>
            <p>Then just ask, for example: <i>"Scan the markets, backtest the best settings on real ticks, and start a paper session with a $1 stake."</i></p>
            <div className="doc-tools">
              {TOOLS.map(([name, what]) => (
                <div key={name}><code>{name}</code><span>{what}</span></div>
              ))}
            </div>
          </Section>

          <Section id="endpoints" title="Endpoints">
            <p>Base URL <code>{base}</code>. Bodies and responses are JSON. Any setting you leave out uses its default.</p>
            <div className="doc-endpoints">
              {ENDPOINTS.map((e) => (
                <details key={e.method + e.path}>
                  <summary>
                    <b className={`dev-method ${e.method.toLowerCase()}`}>{e.method}</b>
                    <code>{e.path}</code>
                    <span>{e.what}</span>
                  </summary>
                  <div className="doc-endpoint-body">
                    {e.body && <><small>Body</small><pre>{e.body}</pre></>}
                    <small>Returns</small>
                    <pre>{e.returns}</pre>
                  </div>
                </details>
              ))}
            </div>
            <p><b>Session object:</b></p>
            <CodeBlock>{`{
  "id": "ses_3f9a…", "status": "running" | "stopped", "stopReason": null,
  "symbol": "auto", "mode": "auto", "turbo": false,
  "startBalance": 1000, "balance": 1004.2, "pnl": 4.2,
  "trades": 46, "wins": 42, "losses": 4, "winRate": 91.3,
  "maxDrawdown": 3.1, "largestStake": 2, "openPositions": 1,
  "createdAt": "…", "updatedAt": "…"
}`}</CodeBlock>
          </Section>

          <Section id="sessions" title="How paper sessions work">
            <ul className="doc-list">
              <li>A session is the real bot trading the <b>live Deriv feed</b> with a demo balance. No real money moves.</li>
              <li>It keeps running on our servers while you're away: every minute, and whenever you read it, it catches up on every real tick since it last ran, in order. Results match a bot that watched every tick live.</li>
              <li>It stops when it hits take profit, stop loss or another limit you set, when you stop it, or after 24 hours. <code>stopReason</code> says why.</li>
              <li>Stopped sessions are kept for 30 days, then deleted.</li>
            </ul>
          </Section>

          <Section id="settings" title="Bot settings">
            <p>Pass any of these in <code>settings</code>. Get the full current set, plus the tested presets, from <code>GET /settings/defaults</code>.</p>
            <div className="doc-settings">
              {SETTINGS_DOC.map(([k, what]) => (
                <div key={k}>
                  <code>{k}</code>
                  <span>{what}</span>
                  <em>{JSON.stringify(DEFAULT_SETTINGS[k])}</em>
                </div>
              ))}
            </div>
          </Section>

          <Section id="limits" title="Limits and errors">
            <div className="doc-cards four">
              <div><b>120</b><span>requests a minute per key</span></div>
              <div><b>3</b><span>running sessions per key</span></div>
              <div><b>50</b><span>stored sessions per key</span></div>
              <div><b>5</b><span>keys per account</span></div>
            </div>
            <p>Errors come back as <code>{`{ "error": "What went wrong" }`}</code> with a status code:</p>
            <div className="doc-errors">
              <div><code>400</code><span>Invalid input, such as an unknown symbol or format.</span></div>
              <div><code>401</code><span>Missing, wrong or revoked key.</span></div>
              <div><code>404</code><span>No such session or route.</span></div>
              <div><code>413</code><span>Request body too large.</span></div>
              <div><code>429</code><span>Rate limit or session limit reached. Wait or stop a session.</span></div>
            </div>
          </Section>

          <Section id="real" title="Trading a real account">
            <p>
              Use <code>POST /export</code> (or the <code>export_bot</code> tool) to get a bot file in <code>javascript</code>, <code>python</code>,
              <code> dbot-xml</code> or <code>json</code>. Run it on your own machine with your own Deriv API token. We never ask for, receive or store
              Deriv tokens, and the API itself never places real trades.
            </p>
          </Section>

          <Section id="legal" title="Terms and privacy">
            <p>
              Using the API means you accept the <a href="#/terms">Terms of Use</a>. The <a href="#/privacy">Privacy Policy</a> lists what we store
              for keys and sessions and how to delete it. Deleting your account deletes all its keys and sessions straight away.
            </p>
          </Section>
        </main>
      </div>
    </div>
  );
}
