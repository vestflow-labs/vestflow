import { defineConfig } from "tsup";

// CJS build → dist/cjs
// Emits index.js + index.d.ts (CommonJS). A `package.json` with
// `"type": "commonjs"` is written next to the output by scripts/finalize-dist.mjs.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: "dist/cjs",
  external: ["@stellar/freighter-api"],
  outExtension() {
    return { js: ".js" };
  },
});
