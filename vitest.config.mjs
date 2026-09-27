import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    // A session started directly on a host no longer publishes itself; tests spin
    // hosts up directly, so they opt in. The mounting tests clear this to verify
    // the default.
    env: { PINET_AUTO_MOUNT: "1" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
