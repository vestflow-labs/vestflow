const fs = require("fs");
const path = require("path");

const apiDir = path.join(__dirname, "../app/api");
const v1Dir = path.join(apiDir, "v1");

// Recursively find all route.ts files
function findRoutes(dir, prefix = "") {
  const routes = [];
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (file === "v1") {
      continue; // Skip v1 directory itself
    }

    if (stat.isDirectory()) {
      routes.push(...findRoutes(fullPath, prefix + "/" + file));
    } else if (file === "route.ts" || file === "route.js") {
      routes.push({ path: fullPath, prefix });
    }
  }

  return routes;
}

// Generate v1 route file that re-exports from original
function generateV1Route(originalPath, v1Path) {
  const originalDir = path.dirname(originalPath);
  const relativePath = path.relative(
    path.dirname(v1Path),
    originalDir
  );

  const importPath = `./${relativePath}`.replace(/\\/g, "/");
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  const exports = methods.map((m) => `export { ${m} } from "${importPath}"`).join("\n");

  return exports + "\n";
}

const routes = findRoutes(apiDir);

for (const route of routes) {
  const v1Route = path.join(
    v1Dir,
    route.prefix.substring(1),
    "route.ts"
  );

  // Create parent directories if needed
  const v1RouteDir = path.dirname(v1Route);
  if (!fs.existsSync(v1RouteDir)) {
    fs.mkdirSync(v1RouteDir, { recursive: true });
  }

  // Skip if already exists (don't overwrite)
  if (!fs.existsSync(v1Route)) {
    const content = generateV1Route(route.path, v1Route);
    fs.writeFileSync(v1Route, content);
    console.log(`Created ${v1Route}`);
  }
}

console.log(`Generated v1 routes for ${routes.length} endpoints`);
