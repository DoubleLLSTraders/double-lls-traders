import * as OTPAuth from "otpauth";
import { APP_AUTH_NAME } from "./constants";

export function createTotpSecret(email: string): { secret: string; uri: string } {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: APP_AUTH_NAME,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyTotpCode(secret: string, token: string): boolean {
  const code = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  return totp.validate({ token: code, window: 1 }) !== null;
}
