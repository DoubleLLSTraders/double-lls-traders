/** GitHub org + repo — keep in sync with Settings → General on GitHub. */
export const GITHUB_ORG = "DoubleLLSTraders";
export const GITHUB_REPO = "double-lls-traders";

export const GITHUB_REPO_URL = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}`;
export const GITHUB_PAGES_HOST = `${GITHUB_ORG.toLowerCase()}.github.io`;
export const GITHUB_PAGES_BASE = `/${GITHUB_REPO}/`;
export const GITHUB_PAGES_URL = `https://${GITHUB_PAGES_HOST}${GITHUB_PAGES_BASE}`;

/** localStorage prefix — migrated once from legacy storage keys. */
export const STORAGE_PREFIX = "double-lls";

export function storageKey(suffix: string): string {
  return `${STORAGE_PREFIX}-${suffix}`;
}

const LEGACY_PREFIX = "brick-trader";

/** Copy legacy keys to double-lls-* on first run after rebrand. */
export function migrateLegacyStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (!key.startsWith(`${LEGACY_PREFIX}-`)) continue;
      const next = key.replace(`${LEGACY_PREFIX}-`, `${STORAGE_PREFIX}-`);
      if (localStorage.getItem(next) === null) {
        const value = localStorage.getItem(key);
        if (value !== null) localStorage.setItem(next, value);
      }
    }
  } catch {
    // private mode
  }
}
