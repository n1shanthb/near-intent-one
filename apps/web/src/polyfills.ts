/**
 * Must load before any @ledgerhq / near-js modules.
 * Ledger WebHID references global Buffer at module init.
 */
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & {
  Buffer: typeof Buffer;
  global?: typeof globalThis;
};

g.Buffer = Buffer;
g.global = g;

if (typeof window !== "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export {};
