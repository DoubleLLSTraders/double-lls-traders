/**
 * Smoke checks for Atlas hub wiring (no network required for storage tests).
 * Run: npx tsx scripts/atlas-smoke.ts
 */
import assert from "node:assert/strict";

// Mirror hub storage helpers without importing DOM-heavy modules.
type HubId = "digits" | "atlas";

function storageKey(suffix: string) {
  return `double-lls-${suffix}`;
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const mem = new MemoryStorage();

function getActiveHub(): HubId {
  const saved = mem.getItem(storageKey("active-hub"));
  if (saved === "atlas" || saved === "digits") return saved;
  return "digits";
}

function setActiveHub(hub: HubId) {
  mem.setItem(storageKey("active-hub"), hub);
}

function getHubDisplayName() {
  return mem.getItem(storageKey("hub-display-name"))?.trim() || "Atlas";
}

function setHubDisplayName(name: string) {
  mem.setItem(storageKey("hub-display-name"), name.trim().slice(0, 40) || "Atlas");
}

setActiveHub("atlas");
assert.equal(getActiveHub(), "atlas");
setHubDisplayName("Gold Desk");
assert.equal(getHubDisplayName(), "Gold Desk");
setActiveHub("digits");
assert.equal(getActiveHub(), "digits");

// Strategy / risk unit checks via dynamic import of atlas modules
const { evaluateRisk, DEFAULT_ATLAS_RISK } = await import("../src/hubs/atlas/risk.ts");
const blocked = evaluateRisk(
  { ...DEFAULT_ATLAS_RISK, paused: true },
  {
    equity: 1000,
    dayPnl: 0,
    openTrades: 0,
    consecutiveLosses: 0,
    dayTrades: 0,
  },
  1,
  100,
);
assert.equal(blocked.ok, false);
assert.ok(blocked.reasons.some((r) => /paused/i.test(r)));

const ok = evaluateRisk(
  DEFAULT_ATLAS_RISK,
  {
    equity: 1000,
    dayPnl: 0,
    openTrades: 0,
    consecutiveLosses: 0,
    dayTrades: 0,
  },
  1,
  100,
);
assert.equal(ok.ok, true);

const { buildAtlasSignal } = await import("../src/hubs/atlas/signal.ts");
const bars = Array.from({ length: 120 }, (_, i) => {
  const close = 100 + Math.sin(i / 8) * 2 + i * 0.01;
  return {
    epoch: 1_700_000_000 + i * 3600,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
  };
});
const signal = buildAtlasSignal(bars, 0.00012);
assert.ok(signal);
assert.ok(["buy", "sell", "neutral"].includes(signal!.bias));
assert.ok(signal!.explanation.length > 20);

console.log("atlas-smoke: ok");
