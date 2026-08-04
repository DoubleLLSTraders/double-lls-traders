import { DIFFERS_FAST_PROFILE_VERSION } from "./differsProfile";
import { MATCHES_FIRM_PROFILE_VERSION } from "./matchesProfile";
import { OVER_UNDER_PROFILE_VERSION } from "./overUnderProfile";

/**
 * Desk settings schema — bump when bot defaults / gates change so stored
 * settings migrate cleanly.
 */
export const BOT_SETTINGS_VERSION = 85;

/** Differs analyzer / entry profile revision. */
export const BOT_PROFILE_VERSION = DIFFERS_FAST_PROFILE_VERSION;

/** Matches firm analyzer / entry profile revision. */
export const MATCHES_PROFILE_VERSION = MATCHES_FIRM_PROFILE_VERSION;

/** Over/Under analyzer / entry profile revision. */
export const OVER_UNDER_VERSION = OVER_UNDER_PROFILE_VERSION;

/** Single line for Settings UI. */
export function botVersionLabel(): string {
  return `Bot v${BOT_SETTINGS_VERSION} · Differs v${BOT_PROFILE_VERSION} · Matches firm v${MATCHES_PROFILE_VERSION} · O/U v${OVER_UNDER_VERSION}`;
}
