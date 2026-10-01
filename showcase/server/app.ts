import { createAccounts } from "./accounts";
import { createAssistant } from "./assistant";
import type { Kv } from "./kv";
import { createPublicApi } from "./publicApi";
import { createSiteApi } from "./site";

/** Every /api route the site serves. Resolves to null for anything else. */
export function createApp(env: Record<string, string | undefined>, kv: Kv) {
  const assistant = createAssistant(env, kv);
  const accounts = createAccounts(env, kv);
  const publicApi = createPublicApi(env, kv);
  const site = createSiteApi(env, kv);
  // The site handler answers every remaining /api/ path, so it goes last.
  return async (req: Request, ip: string) =>
    (await assistant(req, ip)) ?? (await accounts(req, ip)) ?? (await publicApi(req, ip)) ?? (await site(req, ip));
}
