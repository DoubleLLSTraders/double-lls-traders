import { DIFFERS_FAST_PROFILE_VERSION } from "./differsProfile";

/**
 * Desk settings schema — bump when bot defaults / gates change so stored
 * settings migrate cleanly.
 */
export const BOT_SETTINGS_VERSION = 42;

/** Differs analyzer / entry profile revision. */
export const BOT_PROFILE_VERSION = DIFFERS_FAST_PROFILE_VERSION;

/** Single line for Settings UI. */
export function botVersionLabel(): string {
  return `Bot v${BOT_SETTINGS_VERSION} · Differs profile v${BOT_PROFILE_VERSION}`;
}
