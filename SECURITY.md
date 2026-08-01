# Security — Double LLS Traders

## Public repository — what that means

The **source code** on GitHub is public. That is normal for a web app. What must stay private:

| Never commit | Where it lives |
|--------------|----------------|
| `.env` | Your machine only |
| Deriv PATs | `.env` + GitHub Actions **Secrets** |
| OAuth client **secret** JSON | Google Cloud (download once, keep offline) |
| 2FA recovery codes | Password manager / encrypted vault |
| Firebase Admin keys | Server only (this app does not use them in the browser) |

Run before every push:

```bash
npm run check-repo-safe
```

## Operator checklist

- [ ] `npm run check-repo-safe` passes
- [ ] `.env` never committed (see `.gitignore`)
- [ ] OAuth **client secret** JSON never committed — Web clients use Client ID / Firebase Auth only
- [ ] **Firebase Authentication → Google** enabled (same Cloud project as Firestore)
- [ ] Firebase **Authorized domains** include `localhost` and `doublellstraders.github.io`
- [ ] Firestore rules published (`firebase deploy --only firestore:rules`)
- [ ] Only allowlisted emails can sign in (see `src/lib/auth/constants.ts` + `firestore.rules`)
- [ ] Recovery codes stored offline — never in git or chat
- [ ] **Rotate Deriv demo PAT** if it was ever baked into a public build you did not intend
- [ ] GitHub **branch protection** on `master` (Settings → Branches → require PR or restrict pushes)

## What is protected

1. **Google sign-in** — Firebase Auth popup; email must be on the allowlist.
2. **Firebase Auth binding** — Firestore TOTP docs require `request.auth.token.email` to match the document id.
3. **TOTP** — 6-digit Google Authenticator; secret stored in Firestore per email.
4. **Recovery codes** — Shown once at setup; only **SHA-256 hashes** stored in Firestore.
5. **Session** — 8-hour expiry; browser fingerprint binding; cleared on sign-out.
6. **Live trading gate** — Demo → Live requires fresh Authenticator verification (30-minute window).
7. **Lockout** — 5 failed 2FA attempts → 15-minute lockout.
8. **Runtime checks** — Every 60s: Firebase Auth must match session; expired Live access drops to Demo.

## What is NOT protected (limitations)

This is a **client-side SPA**. Values injected at build time (`VITE_*`) are visible in the hosted JavaScript bundle. Anyone can read them from GitHub Pages.

Do not treat client-side auth as bank-grade security. It stops casual access, protects TOTP via Firestore rules, and enforces 2FA for operators.

**Mitigation:** use a **demo-only** PAT with minimal balance; never deploy `VITE_DERIV_TOKEN_REAL` to public hosting; rotate PAT after any suspected leak.

## Rotating credentials

| Credential | Action |
|------------|--------|
| Deriv PAT | Regenerate on Deriv → update `.env` / GitHub secrets → redeploy |
| Google OAuth | Rotate client in Cloud Console → update Firebase Auth |
| TOTP | Delete `totp_secrets/{email}` in Firestore → sign in again to re-enroll |
| Recovery codes | Same as TOTP reset |

## Reporting

If you suspect unauthorized access: sign out all sessions, rotate PAT, reset Firestore TOTP docs, regenerate recovery codes.
