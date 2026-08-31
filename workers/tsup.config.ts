import { defineConfig } from "tsup";

/**
 * Bundles the timeline's Web Worker into `public/workers/`.
 *
 * Next's bundler treats `new Worker(new URL("./x.ts", import.meta.url))` as a
 * plain asset reference and copies the TypeScript source through untouched, so
 * the worker is pre-bundled here instead and loaded from a stable public URL.
 * Bundling (rather than shipping the module as-is) is also what lets the worker
 * share `lib/portfolio/claimable.ts` with the main thread — the vesting math
 * has exactly one definition.
 *
 * Paths are relative to the repository root; run via `npm run worker:build`,
 * which `prebuild` and `predev` invoke automatically.
 */
export default defineConfig({
  entry: {
    "claimable-calculator.worker": "workers/claimable-calculator.worker.ts",
    "sse.worker": "workers/sse.worker.ts",
  },
  outDir: "public/workers",
  // A classic (non-module) worker script, for the widest browser support.
  format: ["iife"],
  outExtension: () => ({ js: ".js" }),
  target: "es2020",
  platform: "browser",
  minify: true,
  clean: true,
  silent: true,
});
