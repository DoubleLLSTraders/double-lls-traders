import { useEffect, useState, type FormEvent } from "react";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo } from "./account";
import { CodeBlock } from "./CodeBlock";

const MAX_KEYS = 5;
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** The account's API keys: create (shown once), see usage, revoke. */
export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    listApiKeys()
      .then(setKeys)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load your keys."));

  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createApiKey(name.trim() || "My key");
      setFresh(created.key);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a key.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKeyInfo) => {
    if (!confirm(`Revoke "${k.name || k.prefix}"? Apps and agents using it stop working, and its paper sessions are deleted.`)) return;
    try {
      await revokeApiKey(k);
      if (fresh?.startsWith(k.prefix)) setFresh(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the key.");
    }
  };

  const full = (keys?.length ?? 0) >= MAX_KEYS;

  return (
    <div className="co-card">
      <header className="pane-head">
        <span>API keys</span>
        <a className="muted keys-docs" href="#/docs">Read the docs ›</a>
      </header>
      <div className="pane-body keys">
        <p className="keys-intro">Let your own apps and AI agents (Cursor, Claude, ChatGPT…) use the bot: scan markets, backtest, run paper sessions and export bots.</p>

        {fresh && (
          <div className="keys-fresh">
            <strong>Your new key. Copy it now.</strong>
            <span>We only keep a hash, so it can't be shown again.</span>
            <CodeBlock>{fresh}</CodeBlock>
            <a className="btn outline sm" href="#/docs">Connect it to an AI agent ›</a>
          </div>
        )}

        {keys && keys.length > 0 && (
          <ul className="keys-list">
            {keys.map((k) => (
              <li key={k.id}>
                <div>
                  <strong>{k.name || "Unnamed key"}</strong>
                  <code>{k.prefix}…</code>
                </div>
                <span className="muted">
                  Created {when(k.createdAt)} · {k.requests.toLocaleString()} request{k.requests === 1 ? "" : "s"}
                  {k.requests > 0 ? ` · last used ${when(k.lastUsed)}` : ""}
                </span>
                <button type="button" className="btn ghost sm danger" onClick={() => void revoke(k)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}

        <form className="keys-new" onSubmit={create}>
          <input placeholder={full ? `Limit of ${MAX_KEYS} keys reached` : "Key name, e.g. Cursor agent"} value={name} onChange={(e) => setName(e.target.value)} disabled={full || busy} maxLength={80} />
          <button className="btn solid" disabled={full || busy}>{busy ? "Creating…" : "Create key"}</button>
        </form>
        {error && <span className="co-err">{error}</span>}
      </div>
    </div>
  );
}
