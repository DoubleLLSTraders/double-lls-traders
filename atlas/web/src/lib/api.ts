/**
 * Thin Atlas API client for the optional FastAPI service on :8787.
 * The embedded dashboard primarily uses the browser Deriv client.
 */
export const ATLAS_API_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: { VITE_ATLAS_API?: string } }).env?.VITE_ATLAS_API) ||
  "http://127.0.0.1:8787";

export async function atlasHealth(): Promise<{ ok: boolean; service?: string }> {
  const res = await fetch(`${ATLAS_API_BASE}/health`);
  if (!res.ok) throw new Error(`Atlas API ${res.status}`);
  return res.json();
}

export async function atlasSymbols() {
  const res = await fetch(`${ATLAS_API_BASE}/symbols`);
  if (!res.ok) throw new Error(`Atlas API ${res.status}`);
  return res.json();
}
