// Writes the per-format `package.json` type markers required for a dual
// ESM/CJS package after `tsup` has emitted `dist/esm` and `dist/cjs`.
//
// Without these markers Node would mis-classify the `.js` files:
//   - dist/esm/package.json -> { "type": "module" }
//   - dist/cjs/package.json -> { "type": "commonjs" }
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

const markers = {
  "esm/package.json": JSON.stringify({ type: "module" }, null, 2) + "\n",
  "cjs/package.json": JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
};

for (const [rel, contents] of Object.entries(markers)) {
  const full = resolve(distDir, rel);
  if (!existsSync(dirname(full))) {
    mkdirSync(dirname(full), { recursive: true });
  }
  writeFileSync(full, contents);
  console.log(`wrote ${rel}`);
}
