/**
 * Pre-push guard — fails if secret files are tracked or staged.
 * Run: npm run check-repo-safe
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const TRACKED = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const BLOCKED_PATTERNS: Array<{ test: (path: string) => boolean; reason: string }> = [
  { test: (p) => p === ".env" || (/^\.env\./.test(p) && p !== ".env.example"), reason: "environment file" },
  { test: (p) => /client_secret.*\.json$/i.test(p), reason: "Google OAuth client secret JSON" },
  { test: (p) => /recovery-codes/i.test(p), reason: "2FA recovery codes" },
  { test: (p) => p.endsWith(".token"), reason: "token file" },
];

const hits = TRACKED.flatMap((path) =>
  BLOCKED_PATTERNS.filter(({ test }) => test(path)).map(({ reason }) => ({ path, reason })),
);

if (hits.length > 0) {
  console.error("SECURITY: blocked files are tracked in git:\n");
  for (const { path, reason } of hits) {
    console.error(`  • ${path} (${reason})`);
  }
  console.error("\nRemove with: git rm --cached <file>");
  process.exit(1);
}

for (const path of ["client_secret*.json", "double-lls-traders-recovery-codes.txt", ".env"]) {
  if (path.includes("*")) continue;
  if (existsSync(path)) {
    console.log(`OK: ${path} exists locally but is not tracked.`);
  }
}

console.log("OK: no secret files tracked in git.");
