import { useState } from "react";
import { fetchReceipt } from "./siteClient";

/** Fetches the order for a licence and downloads it as a PDF receipt. */
export function ReceiptButton({ licence, className = "btn outline sm" }: { licence: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const [data, { downloadReceipt }] = await Promise.all([fetchReceipt(licence), import("./receipt")]);
      await downloadReceipt(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make the receipt.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className} onClick={() => void download()} disabled={busy}>
        {busy ? "Preparing…" : "Receipt PDF"}
      </button>
      {error && <span className="co-err receipt-err">{error}</span>}
    </>
  );
}
