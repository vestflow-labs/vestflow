import { defineConfig } from "tsup";

// ESM build → dist/esm
// Emits index.js + index.d.ts (ES modules). A `package.json` with
// `"type": "module"` is written next to the output by scripts/finalize-dist.mjs.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: "dist/esm",
  external: ["@stellar/freighter-api"],
  outExtension() {
    return { js: ".js" };
  },
});
