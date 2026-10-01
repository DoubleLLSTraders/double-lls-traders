/**
 * End-to-end check of customer accounts against a running server.
 *   npx tsx showcase/scripts/account-e2e.ts [baseUrl] [phase] [email] [password]
 * phase "all" (default): sign up, save settings and sessions, sign in/out, print resume args.
 * phase "resume": after a server restart, sign in again, check everything survived, then delete the account.
 */
const base = process.argv[2] ?? "http://localhost:5195";
const phase = process.argv[3] ?? "all";

let token = "";
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/account${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const session = (id: string, updatedAt: number, pnl: number) => ({
  id, startedAt: updatedAt - 60_000, updatedAt, running: false, stopReason: "Take profit", mode: "auto", stake: 1,
  startBalance: 1000, endBalance: 1000 + pnl, pnl, trades: 40, wins: 36, totalStaked: 40, maxDrawdown: 3, largestStake: 2,
  byContract: { DIGITDIFF: { trades: 40, wins: 36, pnl } }, equity: [1000, 1001, 1000 + pnl],
  recent: [{ id: 40, digit: 3, label: "Differs 7", stake: 1, pnl: 0.1, won: true }],
});

if (phase === "all") {
  const email = `tester${Date.now()}@example.com`;
  const password = "correct horse 42";
  check("needs terms", (await api("POST", "/signup", { email, password })).status === 400);
  check("short password", (await api("POST", "/signup", { email, password: "abc", acceptTerms: true })).status === 400);
  const up = await api("POST", "/signup", { email, password, name: "Test User", acceptTerms: true });
  check("sign up", up.status === 201 && up.data.token?.startsWith("acc_") && up.data.account.email === email);
  check("duplicate email", (await api("POST", "/signup", { email, password, acceptTerms: true })).status === 409);
  check("wrong password", (await api("POST", "/login", { email, password: "nope nope" })).status === 401);
  check("no token", (await api("GET", "/")).status === 401);
  token = up.data.token;

  const set = await api("PUT", "/settings", { settings: { stake: 2.5, symbol: "auto", turbo: false } });
  check("save settings", set.status === 200 && set.data.settingsAt > 0);
  check("bad setting values fall back to defaults", (await api("PUT", "/settings", { settings: { symbol: 5, stake: "x" } })).status === 200);
  await api("PUT", "/settings", { settings: { stake: 2.5, symbol: "auto" } });
  const now = Date.now();
  const s1 = await api("PUT", "/sessions", { sessions: [session("s-one", now, 4.2), session("s-two", now - 1000, -1.5)] });
  check("save sessions", s1.status === 200 && s1.data.saved === 2);
  await api("PUT", "/sessions", { session: session("s-one", now - 5000, 99) });
  const me = await api("GET", "/");
  check("load account", me.status === 200 && me.data.sessions.length === 2 && me.data.settings.stake === 2.5);
  check("older copy ignored", me.data.sessions.find((s: any) => s.id === "s-one").pnl === 4.2);
  check("unknown licence", (await api("POST", "/licences", { licence: "LLS-NOPE-NOPE-NOPE" })).status === 404);

  const pay = async (path: string, auth: string) => {
    const res = await fetch(`${base}/api/pay/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth && { Authorization: `Bearer ${auth}` }) },
      body: JSON.stringify({ visitorId: "v_e2e_tester_0001", plan: "pro", email: "someone@else.com", phone: "0712345678", method: "card" }),
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as any };
  };
  const anonPay = await pay("paypal/create", "");
  check("purchase needs sign-in (PayPal)", anonPay.status === 401, anonPay.data?.error);
  check("purchase needs sign-in (M-Pesa)", (await pay("mpesa/start", "")).status === 401);
  check("fake token can't purchase", (await pay("paypal/create", "acc_fake")).status === 401);
  const signedPay = await pay("paypal/create", token);
  check("signed-in buyer passes the gate", signedPay.status !== 401, `${signedPay.status} ${signedPay.data?.error ?? "order created"}`);

  token = "";
  const login = await api("POST", "/login", { email: email.toUpperCase(), password });
  check("sign in (case-insensitive email)", login.status === 200 && login.data.sessions.length === 2);
  token = login.data.token;
  check("sign out", (await api("POST", "/logout")).status === 200);
  check("token dead after sign out", (await api("GET", "/")).status === 401);
  token = up.data.token;
  check("other device still signed in", (await api("GET", "/")).status === 200);

  await new Promise((r) => setTimeout(r, 1500));
  console.log(`\nRESUME ARGS: resume ${email} "${password}"`);
} else if (phase === "resume") {
  const [email, password] = [process.argv[4], process.argv[5]];
  const login = await api("POST", "/login", { email, password });
  check("account survived restart", login.status === 200, `${login.data?.sessions?.length} sessions, stake ${login.data?.settings?.stake}`);
  token = login.data.token;
  check("data intact", login.data.sessions.length === 2 && login.data.settings.stake === 2.5);
  check("delete account", (await api("DELETE", "/")).status === 200);
  token = "";
  check("deleted account can't sign in", (await api("POST", "/login", { email, password })).status === 401);
}
