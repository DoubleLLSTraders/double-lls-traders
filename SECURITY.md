# Security — Double LLS Traders

## Operator checklist

- [ ] Repo is **private** on GitHub
- [ ] `.env` never committed (see `.gitignore`)
- [ ] OAuth **client secret** JSON never committed — Web clients use Client ID only in the browser
- [ ] **Firebase Authentication → Google** enabled (same Cloud project as Firestore)
- [ ] Firestore rules published (`firebase deploy --only firestore:rules`)
- [ ] Google OAuth consent screen lists authorized test users
- [ ] Recovery codes downloaded and stored offline (password manager or encrypted vault)
- [ ] Deriv PAT rotated if leaked via a public build

## What is protected

1. **Google sign-in** — JWT from Google; email must be on the allowlist in `src/lib/auth/constants.ts`.
2. **Firebase Auth binding** — Firestore TOTP docs require `request.auth.token.email` to match the document id. Forged localStorage sessions cannot read secrets without a valid Google Firebase session.
3. **TOTP** — 6-digit Google Authenticator codes; secret stored in Firestore per email.
4. **Recovery codes** — Plain codes shown once at setup; only **SHA-256 hashes** stored in Firestore. Each code works once.
5. **Session** — 8-hour expiry; bound to browser fingerprint; cleared on sign-out.
6. **Live trading gate** — Demo → Live requires fresh Authenticator verification (30-minute window); localStorage cannot persist Live without it.
7. **Lockout** — 5 failed 2FA attempts → 15-minute lockout on that browser.
8. **Runtime checks** — Every 60s: Firebase Auth must still match session email; expired Live access drops back to Demo.

## What is NOT protected (limitations)

This is a **client-side SPA**. Deriv PATs and Firebase web config are embedded in the production bundle. A determined attacker with devtools can still extract tokens and call APIs directly.

Do not treat client-side auth as bank-grade security. It stops casual unauthorized access, protects TOTP secrets via Firebase Auth rules, and enforces 2FA for operators.

## Rotating credentials

| Credential | Action |
|------------|--------|
| Deriv PAT | Regenerate on Deriv → update `.env` / GitHub secrets → redeploy |
| Google OAuth | Rotate client in Cloud Console → update `VITE_GOOGLE_CLIENT_ID` |
| TOTP | Delete `totp_secrets/{email}` doc in Firestore → sign in again to re-enroll |
| Recovery codes | Same as TOTP reset, or sign in and complete recovery-only flow |

## Reporting

If you suspect unauthorized access, sign out all sessions, rotate PAT, reset Firestore TOTP docs, and regenerate recovery codes.
