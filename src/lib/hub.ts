import { storageKey } from "./platform";

export type HubId = "digits" | "atlas";

const HUB_KEY = storageKey("active-hub");
const HUB_NAME_KEY = storageKey("hub-display-name");

const DEFAULT_ATLAS_NAME = "Atlas";

export function getActiveHub(): HubId {
  try {
    const saved = localStorage.getItem(HUB_KEY);
    if (saved === "atlas" || saved === "digits") return saved;
  } catch {
    /* private mode */
  }
  return "digits";
}

export function setActiveHub(hub: HubId): void {
  try {
    localStorage.setItem(HUB_KEY, hub);
  } catch {
    /* private mode */
  }
}

export function getHubDisplayName(): string {
  try {
    const saved = localStorage.getItem(HUB_NAME_KEY)?.trim();
    if (saved) return saved;
  } catch {
    /* private mode */
  }
  return DEFAULT_ATLAS_NAME;
}

export function setHubDisplayName(name: string): void {
  const cleaned = name.trim().slice(0, 40) || DEFAULT_ATLAS_NAME;
  try {
    localStorage.setItem(HUB_NAME_KEY, cleaned);
  } catch {
    /* private mode */
  }
}

export function hubLabel(hub: HubId): string {
  return hub === "atlas" ? getHubDisplayName() : "Digits desk";
}
