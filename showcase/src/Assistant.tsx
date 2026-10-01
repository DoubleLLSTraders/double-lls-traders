import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BotAvatar } from "./BotAvatar";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  error?: boolean;
}

interface AssistantProps {
  /** Short plain-text summary of the dashboard, sent along so answers can refer to it. */
  context: string;
  lastTrade?: { id: number; won: boolean } | null;
}

interface Quota {
  remaining: number;
  limit: number;
}

const CAPABILITIES = [
  { tone: "green", icon: "M2 12l4-4 3 3 5-6", title: "Live prices", body: "Crypto, forex and stocks, right now.", ask: "Bitcoin and Ethereum price right now" },
  { tone: "blue", icon: "M3 4h10M3 8h10M3 12h6", title: "Market news", body: "What is moving and why.", ask: "Top crypto headlines today" },
  { tone: "amber", icon: "M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z", title: "Strategy & risk", body: "Stake sizing, martingale, limits.", ask: "How should I size stakes on a $10,000 account?" },
  { tone: "violet", icon: "M6 6.5v3M10 6.5v3M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z", title: "Your bot", body: "Reads this dashboard live.", ask: "How is my bot doing this session?" },
];

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (/^https?:\/\//.test(part)) return <a key={i} href={part} target="_blank" rel="noreferrer">{host(part)}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function renderText(text: string): ReactNode {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{renderInline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(heading ? <h4 key={blocks.length}>{renderInline(heading[1])}</h4> : <p key={blocks.length}>{renderInline(line)}</p>);
  }
  flush();
  return blocks;
}

export function Assistant({ context, lastTrade = null }: AssistantProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const out = quota !== null && quota.remaining <= 0;

  useEffect(() => {
    fetch("/api/assistant")
      .then((r) => r.json())
      .then((q: Quota) => typeof q.remaining === "number" && setQuota({ remaining: q.remaining, limit: q.limit }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return;
    const focus = setTimeout(() => inputRef.current?.focus(), 260);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      clearTimeout(focus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy || out) return;
    const next: Message[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context,
          messages: next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Quota> & { reply?: string; sources?: string[]; error?: string };
      if (typeof data.remaining === "number" && typeof data.limit === "number") {
        setQuota({ remaining: data.remaining, limit: data.limit });
      }
      setMessages((m) => [
        ...m,
        res.ok && data.reply
          ? { role: "assistant", content: data.reply, sources: data.sources }
          : { role: "assistant", content: data.error || "The assistant is unavailable right now.", error: true },
      ]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Could not reach the assistant. Check your connection.", error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  const credits = quota ? `${quota.remaining}/${quota.limit} free today` : "Free daily";

  return (
    <div ref={rootRef} className={`assist ${open ? "open" : ""}`}>
      <button type="button" className="assist-tab" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="assist-spark" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" /></svg>
        </span>
        <span>Ask AI</span>
        {quota && !open && <em>{quota.remaining}</em>}
      </button>
      <div className="assist-scrim" onClick={() => setOpen(false)} />
      <div className="assist-sheet" aria-hidden={!open}>
        <div className="assist-inner">
          <header className="assist-head">
            <div className="assist-title">
              <strong>Double LLS</strong>
              <span className="assist-ai">AI</span>
            </div>
            <span className={`assist-credits ${out ? "out" : ""}`}><i />{credits}</span>
            <button type="button" className="assist-close" onClick={() => setOpen(false)} aria-label="Close" tabIndex={open ? 0 : -1}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </header>

          <div ref={logRef} className="assist-log">
            {messages.length === 0 && (
              <div className="assist-empty">
                <div className="assist-hero">
                  <div className="assist-halo" />
                  {open && <BotAvatar size={72} lastTrade={lastTrade} />}
                </div>
                <h3>What can I help with?</h3>
                <p>Live markets, crypto news, strategy, or how your bot is doing right now.</p>
                <div className="assist-caps">
                  {CAPABILITIES.map((c) => (
                    <button key={c.title} type="button" className={c.tone} onClick={() => void ask(c.ask)} disabled={busy || out} tabIndex={open ? 0 : -1}>
                      <span className="assist-icon">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={c.icon} /></svg>
                      </span>
                      <span className="assist-cap-text">{c.ask}</span>
                      <span className="assist-cap-tag">{c.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`assist-msg ${m.role} ${m.error ? "error" : ""}`}>
                {m.role === "assistant" ? renderText(m.content) : <p>{m.content}</p>}
                {m.sources && m.sources.length > 0 && (
                  <div className="assist-sources">
                    {m.sources.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer">{host(url)}</a>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="assist-msg assistant thinking"><i /><i /><i /></div>}
          </div>

          <form className="assist-input" onSubmit={submit}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={out ? "Free questions used for today" : "Ask about prices, news, strategy or your bot…"}
              maxLength={600}
              disabled={out}
              tabIndex={open ? 0 : -1}
              aria-label="Ask the assistant"
            />
            {messages.length > 0 && (
              <button type="button" className="btn ghost" onClick={() => setMessages([])} tabIndex={open ? 0 : -1}>Clear</button>
            )}
            <button className="assist-send" type="submit" disabled={busy || out || !input.trim()} aria-label="Send" tabIndex={open ? 0 : -1}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
            </button>
          </form>
          <p className="assist-note">Answers can be wrong and are not financial advice.</p>
        </div>
      </div>
    </div>
  );
}
