import { useState } from "react";
import type { BotSettings } from "./bot";
import { BOT_NAME, type ExportFormat } from "./exports";
import { LicenceFiles } from "./Purchase";
import { compareVersions, lookupLicence, saveLicence, useLicence, useRelease } from "./siteClient";

const ALL_FORMATS: ExportFormat[] = ["dbot-xml", "javascript", "python", "json"];

interface LicencePageProps {
  settings: BotSettings;
  onSettings: (next: BotSettings) => void;
  onBack: () => void;
}

export function LicencePage({ settings, onSettings, onBack }: LicencePageProps) {
  const licence = useLicence();
  const release = useRelease();
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const outdated = licence && release && compareVersions(release.version, licence.version) > 0;

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await lookupLicence(key.trim(), email.trim());
      saveLicence({ ...found, version: "0.0.0" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not find that licence.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="co">
      <div className="co-glow" />
      <nav className="co-nav">
        <button className="btn ghost" onClick={onBack}>‹ Back</button>
        <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>
        <span />
      </nav>

      <section className="co-success licence-page">
        <h1>Your licence</h1>
        {!licence ? (
          <>
            <p>Enter the licence key from your receipt and the email you paid with to get your files and updates on this device.</p>
            <div className="co-card licence-find">
              <div className="pane-body">
                <label className="co-field">
                  <span>Licence key</span>
                  <input placeholder="LLS-XXXX-XXXX-XXXX" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />
                </label>
                <label className="co-field">
                  <span>Email</span>
                  <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                {error && <span className="co-err">{error}</span>}
                <button className="btn solid lg" onClick={find} disabled={busy || !key.trim() || !email.trim()}>
                  {busy ? "Checking…" : "Find my licence"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p>
              {BOT_NAME} · {licence.plan} licence for <strong>{licence.email}</strong>.
            </p>
            {outdated ? (
              <div className="co-card update-card">
                <header className="pane-head"><span>Update available · v{release.version}</span><span className="co-paid">New</span></header>
                <div className="pane-body">
                  <p>{release.notes || "A newer version of the bot is ready."}</p>
                  <p className="muted">Download your files again below. Replace the old file and run it the same way as before.</p>
                </div>
              </div>
            ) : (
              release && <p className="muted">You have the latest version, v{release.version}.</p>
            )}
            <div className="co-card co-files">
              <header className="pane-head"><span>Your files</span></header>
              <div className="pane-body">
                <LicenceFiles settings={settings} onSettings={onSettings} formats={ALL_FORMATS} />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
