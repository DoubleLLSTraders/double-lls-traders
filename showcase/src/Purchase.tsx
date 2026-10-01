import { useState, type ChangeEvent } from "react";
import { MODES, type BotSettings } from "./bot";
import { DEFAULT_EXPORT_META, EXPORTS, downloadBot, parseBotJson, type ExportFormat, type ExportMeta } from "./exports";
import { symbolName } from "./market";
import { saveLicence, track, useLicence, useRelease } from "./siteClient";

/** Browsers drop rapid back-to-back downloads, so files are spaced out. */
const DOWNLOAD_GAP_MS = 450;

interface LicenceFilesProps {
  settings: BotSettings;
  onSettings: (next: BotSettings) => void;
  formats: readonly ExportFormat[];
}

export function LicenceFiles({ settings, onSettings, formats }: LicenceFilesProps) {
  const [importError, setImportError] = useState<string | null>(null);
  const licence = useLicence();
  const release = useRelease();
  const available = EXPORTS.filter((x) => formats.includes(x.format));
  const meta: ExportMeta = {
    version: release?.version ?? licence?.version ?? DEFAULT_EXPORT_META.version,
    licence: licence?.licence ?? "",
    updateUrl: `${window.location.origin}/api/bot/version`,
  };

  const download = (format: ExportFormat) => {
    downloadBot(format, settings, meta);
    track("download", `${format} v${meta.version}`);
    if (licence && licence.version !== meta.version) saveLicence({ ...licence, version: meta.version });
  };

  const downloadAll = () => {
    available.forEach((x, i) => window.setTimeout(() => download(x.format), i * DOWNLOAD_GAP_MS));
  };

  const importSettings = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      onSettings(parseBotJson(await file.text()));
      setImportError(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not read that file.");
    }
  };

  return (
    <>
      <dl className="meta-row">
        <div><dt>Version</dt><dd>v{meta.version}</dd></div>
        {licence && <div><dt>Licence</dt><dd className="mono">{licence.licence}</dd></div>}
        <div><dt>Mode</dt><dd>{MODES.find((m) => m.id === settings.mode)?.label}</dd></div>
        <div><dt>Stake</dt><dd>${settings.stake.toFixed(2)}</dd></div>
        <div><dt>Take profit</dt><dd>{settings.takeProfit ? `$${settings.takeProfit}` : "Off"}</dd></div>
        <div><dt>Stop loss</dt><dd>{settings.stopLoss ? `$${settings.stopLoss}` : "Off"}</dd></div>
        <div><dt>Symbol</dt><dd>{symbolName(settings.symbol)}</dd></div>
      </dl>
      <div className="downloads-head">
        <span>Every format is yours. Use whichever fits your device.</span>
        <button className="btn solid sm" onClick={downloadAll}>Download all</button>
      </div>
      <table className="tbl downloads">
        <tbody>
          {available.map((x) => (
            <tr key={x.format}>
              <td>
                <strong>{x.label}</strong>
                <span>{x.hint}</span>
                <span className="runs-on">Runs on: {x.runsOn}</span>
              </td>
              <td className="num">
                <button className="btn outline sm" onClick={() => download(x.format)}>Download</button>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Import settings (.json)</strong>
              <span>Load a parameter file shared with you.</span>
            </td>
            <td className="num">
              <label className="btn outline sm">
                Choose file
                <input type="file" accept=".json,application/json" onChange={importSettings} hidden />
              </label>
            </td>
          </tr>
        </tbody>
      </table>
      {importError && <p className="notice">{importError}</p>}
      <p className="fine">
        Files are generated from the settings above. The JavaScript and Python bots tell you when a new version is out. Run them on a Deriv demo
        account first before trading real funds.
      </p>
    </>
  );
}
