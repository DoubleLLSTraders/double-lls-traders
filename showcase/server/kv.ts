import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Key-value storage behind the site API: a JSON file locally, Netlify Blobs when deployed. */
export interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Values of every key starting with prefix. */
  list<T>(prefix: string): Promise<T[]>;
  /** Read-modify-write. fn may mutate the value in place or return a new one; conflicting writes are retried. */
  update<T>(key: string, fallback: () => T, fn: (value: T) => T | void): Promise<T>;
}

const SAVE_DELAY_MS = 400;

export function fileKv(file: string): Kv {
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = {};
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(data));
        renameSync(`${file}.tmp`, file);
      } catch (err) {
        console.error("[kv] could not save", err);
      }
    }, SAVE_DELAY_MS);
  };
  const copy = <T>(v: unknown) => (v === undefined ? null : (structuredClone(v) as T));

  return {
    async get<T>(key: string) {
      return copy<T>(data[key]);
    },
    async set(key, value) {
      data[key] = structuredClone(value);
      save();
    },
    async delete(key) {
      delete data[key];
      save();
    },
    async list<T>(prefix: string) {
      return Object.keys(data).filter((k) => k.startsWith(prefix) && data[k] !== null).map((k) => copy<T>(data[k]) as T);
    },
    async update<T>(key: string, fallback: () => T, fn: (value: T) => T | void) {
      const current = copy<T>(data[key]) ?? fallback();
      const next = fn(current) ?? current;
      if (next === null || next === undefined) {
        if (key in data) {
          delete data[key];
          save();
        }
        return next;
      }
      data[key] = structuredClone(next);
      save();
      return next;
    },
  };
}
