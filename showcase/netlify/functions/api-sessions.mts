import { blobKv } from "../../server/blobKv";
import { advanceAllSessions } from "../../server/publicApi";

/** Keeps every running API paper-trading session in step with the live market, and applies data retention. */
export default async () => {
  await advanceAllSessions(blobKv());
};

export const config = { schedule: "* * * * *" };
