import { getStore } from "@netlify/blobs";
import type { Kv } from "./kv";

const MAX_TRIES = 8;

/** Netlify Blobs storage with strong consistency; updates use ETag compare-and-set so concurrent writers never lose data. */
export function blobKv(name = "llsbot"): Kv {
  const store = getStore({ name, consistency: "strong" });
  return {
    async get<T>(key: string) {
      return ((await store.get(key, { type: "json" })) as T | null) ?? null;
    },
    async set(key, value) {
      await store.setJSON(key, value);
    },
    async delete(key) {
      await store.delete(key);
    },
    async list<T>(prefix: string) {
      const { blobs } = await store.list({ prefix });
      const values = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<T | null>));
      return values.filter((v): v is Awaited<T> => v !== null) as T[];
    },
    async update<T>(key: string, fallback: () => T, fn: (value: T) => T | void) {
      for (let i = 0; i < MAX_TRIES; i++) {
        const current = await store.getWithMetadata(key, { type: "json" });
        const value = (current?.data as T | undefined) ?? fallback();
        const next = fn(value) ?? value;
        if (next === null || next === undefined) {
          if (current) await store.delete(key);
          return next;
        }
        const res = await store.setJSON(key, next, current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
        if (res.modified) return next;
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (i + 1)));
      }
      throw Object.assign(new Error("The server is busy. Try again."), { status: 503 });
    },
  };
}
