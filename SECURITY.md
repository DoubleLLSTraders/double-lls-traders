# Security — Double LLS Traders

## Operator checklist

- [ ] Repo is **private** on GitHub
- [ ] `.env` never committed (see `.gitignore`)
- [ ] OAuth **client secret** JSON never committed — Web clients use Client ID only in the browser
- [ ] Firestore rules published (`firestore.rules`)
- [ ] Google OAuth consent screen lists authorized test users
- [ ] Recovery codes downloaded and stored offline (password manager or encrypted vault)
- [ ] Deriv PAT rotated if leaked via a public build

## What is protected

1. **Google sign-in** — JWT from Google; email must be on the allowlist in `src/lib/auth/constants.ts`.
2. **TOTP** — 6-digit Google Authenticator codes; secret stored in Firestore per email.
3. **Recovery codes** — Plain codes shown once at setup; only **SHA-256 hashes** stored in Firestore. Each code works once.
4. **Session** — 8-hour expiry; bound to browser fingerprint; cleared on sign-out.
5. **Lockout** — 5 failed 2FA attempts → 15-minute lockout on that browser.

## What is NOT protected (limitations)

This is a **client-side SPA**. A determined attacker with full browser/devtools access could bypass UI gates. True server-side enforcement would require a backend verifying Google tokens and TOTP on every API call.

Do not treat client-side auth as equivalent to bank-grade security. It stops casual unauthorized access and enforces 2FA for operators.

## Rotating credentials

| Credential | Action |
|------------|--------|
| Deriv PAT | Regenerate on Deriv → update `.env` / GitHub secrets → redeploy |
| Google OAuth | Rotate client in Cloud Console → update `VITE_GOOGLE_CLIENT_ID` |
| TOTP | Delete `totp_secrets/{email}` doc in Firestore → sign in again to re-enroll |
| Recovery codes | Same as TOTP reset, or sign in and complete recovery-only flow |

## Reporting

If you suspect unauthorized access, sign out all sessions, rotate PAT, reset Firestore TOTP docs, and regenerate recovery codes.
