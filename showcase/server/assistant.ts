import type { Kv } from "./kv";

const XAI_URL = "https://api.x.ai/v1/responses";
const MAX_HISTORY = 6;
const MAX_USER_CHARS = 600;
const MAX_ASSISTANT_CHARS = 1200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 6;
const CACHE_MS = 15 * 60_000;

const SYSTEM_PROMPT = `You are the assistant inside Double LLS Trading Bot, a trading-bot dashboard.
Help with markets: crypto, forex, stocks, indices, synthetic indices, Deriv digit contracts (Matches, Differs, Over/Under, Even/Odd), strategy, risk and money management, and the bot itself.
When search results are available, use them for prices and news and name the source.
Answer in at most 120 words unless asked for more. Short bullets or short paragraphs. No hype.
Never promise profit. For buy/sell questions explain the factors and risks instead of giving personal financial advice.
The dashboard runs on a simulated market with a balance the user chooses (default $10,000); its results do not predict real-market results.
Pricing (one-off licence price, no setup fee; setup help is included free): Starter $29 (was $59); Pro $79 (was $149, most popular); Lifetime $149 (was $299).
Payment: debit or credit card (through PayPal), PayPal, or M-Pesa.
Every plan includes all formats: Deriv Bot XML (runs in any browser on phone, tablet or PC), JavaScript (Node.js) and Python (Windows, macOS, Linux or a VPS), plus a settings JSON. Plans differ by updates, support and setup level. 7-day money-back guarantee.`;

/** Live search is the expensive part, so it only runs when the question needs fresh data. */
const NEEDS_SEARCH =
  /\b(price|prices|priced|news|today|tonight|now|latest|current(ly)?|this (week|month|year)|yesterday|recent(ly)?|breaking|headlines?|trending|happening|moving|pump(ing)?|dump(ing)?|rally|crash(ing)?|etf|fed|fomc|cpi|inflation|rate cut|earnings|forecast|outlook|sentiment|market cap|ath|all[- ]time high|20[2-3]\d)\b/i;
const NEEDS_X = /\b(twitter|tweets?|x posts?|sentiment|people saying|community)\b/i;
const PERSONAL = /\b(my|bot|balance|stake|trades?|win ?rate|session|drawdown|martingale)\b/i;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ResponsesOutput {
  type: string;
  content?: { type: string; text?: string; annotations?: { type: string; url?: string }[] }[];
}

interface DayUsage {
  count: number;
  byIp: Record<string, number>;
}

const today = () => new Date().toISOString().slice(0, 10);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function extract(output: ResponsesOutput[] = []) {
  const parts = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const text = parts
    .map((p) => p.text ?? "")
    .join("\n")
    .replace(/\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/g, "[$1]($2)")
    .trim();
  const sources = [...new Set(parts.flatMap((p) => p.annotations ?? []).map((a) => a.url).filter((u): u is string => !!u))];
  return { text, sources };
}

/** /api/assistant: GET returns the caller's free questions left, POST asks Grok. The xAI key never leaves the server. */
export function createAssistant(env: Record<string, string | undefined>, kv: Kv) {
  const apiKey = env.XAI_API_KEY ?? "";
  const model = env.XAI_MODEL || "grok-4.3";
  const freePerDay = Math.max(0, Number(env.XAI_FREE_QUESTIONS ?? 5));
  const dailyBudget = Math.max(0, Number(env.XAI_DAILY_BUDGET ?? 200));
  const hits = new Map<string, number[]>();
  const cache = new Map<string, { at: number; reply: string; sources: string[] }>();

  const usage = async () => (await kv.get<DayUsage>(`ai/${today()}`)) ?? { count: 0, byIp: {} };
  const charge = (ip: string) =>
    kv.update<DayUsage>(`ai/${today()}`, () => ({ count: 0, byIp: {} }), (u) => {
      u.count += 1;
      u.byIp[ip] = (u.byIp[ip] ?? 0) + 1;
    });
  const rateLimited = (ip: string) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > RATE_MAX;
  };

  return async (req: Request, ip: string): Promise<Response | null> => {
    if (!new URL(req.url).pathname.startsWith("/api/assistant")) return null;
    const u = await usage();
    const remaining = Math.max(0, freePerDay - (u.byIp[ip] ?? 0));
    const quota = { remaining, limit: freePerDay };

    if (req.method === "GET") return json(200, { ...quota, configured: !!apiKey });
    if (req.method !== "POST") return json(405, { error: "Use GET or POST." });
    if (!apiKey) return json(503, { error: "The assistant is not set up yet.", ...quota });
    if (rateLimited(ip)) return json(429, { error: "Slow down a little and try again in a minute.", ...quota });

    try {
      const raw = await req.text();
      if (raw.length > 32_000) return json(413, { error: "Message too long.", ...quota });
      const { messages, context } = JSON.parse(raw || "{}") as { messages?: ChatMessage[]; context?: string };
      const history = (Array.isArray(messages) ? messages : [])
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS) }));
      const question = history[history.length - 1];
      if (!question || question.role !== "user" || !question.content.trim()) {
        return json(400, { error: "Ask a question first.", ...quota });
      }

      const cacheKey = history.length === 1 && !PERSONAL.test(question.content)
        ? question.content.toLowerCase().replace(/[^a-z0-9$% ]+/g, " ").replace(/\s+/g, " ").trim()
        : null;
      const cached = cacheKey ? cache.get(cacheKey) : undefined;
      if (cached && Date.now() - cached.at < CACHE_MS) return json(200, { reply: cached.reply, sources: cached.sources, ...quota });

      if (remaining <= 0) return json(402, { error: "You have used today's free questions. They reset tomorrow.", ...quota });
      if (u.count >= dailyBudget) return json(503, { error: "The assistant has reached today's limit. Try again tomorrow.", ...quota });

      const search = NEEDS_SEARCH.test(question.content);
      const tools = search ? [{ type: "web_search" }, ...(NEEDS_X.test(question.content) ? [{ type: "x_search" }] : [])] : [];
      const system = PERSONAL.test(question.content) && context
        ? `${SYSTEM_PROMPT}\n\nLive dashboard state:\n${String(context).slice(0, 800)}`
        : SYSTEM_PROMPT;

      const upstream = await fetch(XAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [{ role: "system", content: system }, ...history],
          max_output_tokens: search ? 900 : 500,
          reasoning: { effort: search ? "low" : "none" },
          ...(tools.length ? { tools, max_tool_calls: 2 } : {}),
        }),
      });
      const text = await upstream.text();
      let data: { output?: ResponsesOutput[]; error?: string | { message?: string } } = {};
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300) };
      }
      if (!upstream.ok) {
        const message = typeof data.error === "string" ? data.error : data.error?.message;
        return json(502, { error: message || `The assistant returned ${upstream.status}.`, ...quota });
      }

      const out = extract(data.output);
      if (!out.text) return json(502, { error: "No answer came back. Try rephrasing.", ...quota });
      await charge(ip);
      const reply = { reply: out.text, sources: out.sources.slice(0, 5) };
      if (cacheKey) cache.set(cacheKey, { at: Date.now(), ...reply });
      return json(200, { ...reply, remaining: Math.max(0, remaining - 1), limit: freePerDay });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : "Assistant failed.", ...quota });
    }
  };
}
