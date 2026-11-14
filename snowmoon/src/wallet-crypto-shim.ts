import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";

const webCrypto = globalThis.crypto;

export function createHash(algorithm: string) {
  const alg = algorithm.toLowerCase().replace(/-/g, "");
  const hasher = alg === "sha512" ? sha512.create() : sha256.create();
  return {
    update(data: string | Uint8Array) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      hasher.update(bytes);
      return this;
    },
    digest(encoding?: "hex" | "base64") {
      const out = Buffer.from(hasher.digest());
      if (encoding) return out.toString(encoding);
      return out;
    },
  };
}

export function randomBytes(size: number): Buffer {
  const bytes = new Uint8Array(size);
  webCrypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return webCrypto.getRandomValues(array as unknown as ArrayBufferView<ArrayBuffer>) as unknown as T;
}

export function randomUUID(): string {
  return webCrypto.randomUUID();
}

export const webcrypto = webCrypto;
export const subtle = webCrypto.subtle;

export default {
  createHash,
  randomBytes,
  getRandomValues,
  randomUUID,
  webcrypto,
  subtle,
};
