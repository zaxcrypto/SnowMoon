import { Buffer } from "buffer";

const g = globalThis as unknown as {
  Buffer?: unknown;
  process?: {
    env: Record<string, string | undefined>;
    browser: boolean;
    version: string;
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void;
  };
};

if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}

if (typeof g.process === "undefined") {
  g.process = {
    env: {},
    browser: true,
    version: "v20.0.0",
    nextTick: (fn, ...args) => {
      Promise.resolve().then(() => fn(...args));
    },
  };
}


