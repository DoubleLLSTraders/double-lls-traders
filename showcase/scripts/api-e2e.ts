/**
 * End-to-end check of the public API and MCP endpoint against a running server.
 *   npx tsx showcase/scripts/api-e2e.ts [baseUrl] [phase]
 * phase "all" (default): create key, exercise every route and MCP, leave one session running, print the key.
 * phase "resume <key> <sessionId>": after a server restart, check the key and running session survived, then clean up.
 */
const base = process.argv[2] ?? "http://localhost:5195";
const phase = process.argv[3] ?? "all";

let key = "";
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key && { Authorization: `Bearer ${key}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}
const mcp = (method: string, params: unknown = {}, id: number | null = 1) => api("POST", "/api/mcp", { jsonrpc: "2.0", ...(id !== null && { id }), method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (phase === "all") {
  check("no key rejected", (await api("GET", "/api/v1/me")).status === 401);
  check("key needs an account", (await api("POST", "/api/v1/keys", { name: "anon" })).status === 401);
  const email = `agent${Date.now()}@example.com`;
  const acct = await api("POST", "/api/account/signup", { email, password: "agent password 1", acceptTerms: true });
  check("sign up for keys", acct.status === 201);
  key = acct.data.token;
  const created = await api("POST", "/api/v1/keys", { name: "e2e" });
  check("create key from account", created.status === 201 && created.data.key.startsWith("lls_"), created.data.prefix);
  const spare = await api("POST", "/api/v1/keys", { name: "spare" });
  const listed = await api("GET", "/api/v1/keys");
  check("list account keys", listed.data.keys?.length === 2 && !JSON.stringify(listed.data).includes(created.data.key));
  check("revoke key", (await api("DELETE", `/api/v1/keys/${spare.data.id}`)).status === 200);
  key = spare.data.key;
  check("revoked key rejected", (await api("GET", "/api/v1/me")).status === 401);
  key = created.data.key;
  check("API key can't manage keys", (await api("GET", "/api/v1/keys")).status === 401);
  const accountToken = acct.data.token;

  const me = await api("GET", "/api/v1/me");
  check("me", me.status === 200 && me.data.email === email);
  check("markets", (await api("GET", "/api/v1/markets")).data.symbols.length === 11);
  check("defaults", !!(await api("GET", "/api/v1/settings/defaults")).data.settings);
  check("openapi", (await api("GET", "/api/v1/openapi.json")).data.openapi === "3.1.0");

  const scan = await api("POST", "/api/v1/scan", { symbol: "auto" });
  check("scan live", scan.status === 200 && scan.data.markets.length === 10, `best ${scan.data.best ? `${scan.data.best.market} ${scan.data.best.setup}` : "none"}`);
  const sim = await api("POST", "/api/v1/backtest", { market: "sim-pattern", ticks: 20000, settings: { stake: 1 } });
  check("backtest sim", sim.status === 200 && sim.data.trades > 0, `${sim.data.trades} trades, ${sim.data.winRate}% win, P/L ${sim.data.pnl}`);
  const real = await api("POST", "/api/v1/backtest", { market: "real-recent", settings: { stake: 1, turbo: true } });
  check("backtest real-recent", real.status === 200, `${real.data.ticks} ticks, ${real.data.trades} trades, P/L ${real.data.pnl}`);
  check("bad symbol rejected", (await api("POST", "/api/v1/scan", { symbol: "NOPE" })).status === 400);

  const exp = await api("POST", "/api/v1/export", { format: "python", settings: { stake: 2 } });
  check("export python", exp.status === 200 && exp.data.text.includes('"stake": 2'), exp.data.file);

  const ses = await api("POST", "/api/v1/sessions", { settings: { symbol: "auto", stake: 1, startBalance: 1000, turbo: true } });
  check("start session", ses.status === 201 && ses.data.status === "running", ses.data.id);
  await sleep(15000);
  const got = await api("GET", `/api/v1/sessions/${ses.data.id}`);
  check("session trades live", got.data.trades > 0, `${got.data.trades} trades, P/L ${got.data.pnl}, ${got.data.openPositions} open`);

  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  check("mcp initialize", init.data?.result?.serverInfo?.name === "double-lls-trading-bot");
  const note = await mcp("notifications/initialized", {}, null);
  check("mcp notification 202", note.status === 202);
  const tools = await mcp("tools/list");
  check("mcp tools/list", tools.data.result.tools.length === 11);
  const call = await mcp("tools/call", { name: "list_sessions", arguments: {} });
  check("mcp tools/call", call.data.result.structuredContent.sessions.length === 1);
  const bad = await mcp("tools/call", { name: "get_session", arguments: { id: "ses_missing" } });
  check("mcp tool error", bad.data.result.isError === true);
  key = "lls_wrong";
  check("mcp bad key 401", (await mcp("tools/list")).status === 401);
  key = created.data.key;

  const second = await api("POST", "/api/v1/sessions", { settings: { stake: 1 } });
  const stopped = await api("POST", `/api/v1/sessions/${second.data.id}/stop`);
  check("stop session", stopped.data.status === "stopped");
  check("delete session", (await api("DELETE", `/api/v1/sessions/${second.data.id}`)).status === 200);

  await sleep(1500);
  console.log(`\nRESUME ARGS: resume ${created.data.key} ${ses.data.id} ${accountToken}`);
} else if (phase === "resume") {
  key = process.argv[4];
  const id = process.argv[5];
  const me = await api("GET", "/api/v1/me");
  check("key survived restart", me.status === 200, `${me.data?.requests} requests recorded`);
  await sleep(12000);
  const s = await api("GET", `/api/v1/sessions/${id}`);
  check("session resumed and trading", s.status === 200 && s.data.status === "running" && s.data.trades > 0, `${s.data.trades} trades, P/L ${s.data.pnl}`);
  key = process.argv[6];
  check("delete account", (await api("DELETE", "/api/account")).status === 200);
  key = process.argv[4];
  check("account deletion revoked its keys", (await api("GET", "/api/v1/me")).status === 401);
}
