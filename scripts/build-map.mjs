/**
 * Build the TypeScript map client → public/dist/
 * Also vendors MapLibre GL (ESM + worker) into public/vendor/maplibre-gl/
 */
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "public", "dist");
const vendorDir = path.join(root, "public", "vendor", "maplibre-gl");
const watch = process.argv.includes("--watch");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function vendorMapLibre() {
  const pkgRoot = path.join(root, "node_modules", "maplibre-gl");
  const dist = path.join(pkgRoot, "dist");
  if (!fs.existsSync(dist)) {
    console.warn("[build-map] maplibre-gl not installed; skip vendor copy");
    return;
  }
  ensureDir(vendorDir);

  const cssSrc = path.join(dist, "maplibre-gl.css");
  if (fs.existsSync(cssSrc)) {
    fs.copyFileSync(cssSrc, path.join(vendorDir, "maplibre-gl.css"));
  }

  // MapLibre 6 is ESM-only (no UMD). Copy runtime modules + a tiny bootstrap that
  // assigns window.maplibregl and points the worker at the vendored worker module.
  const required = ["maplibre-gl.mjs", "maplibre-gl-worker.mjs"];
  for (const name of required) {
    const src = path.join(dist, name);
    if (!fs.existsSync(src)) {
      console.error(`[build-map] missing ${name} in maplibre-gl/dist (need maplibre-gl@>=6.4.1)`);
      process.exit(1);
    }
  }
  for (const ent of fs.readdirSync(dist)) {
    if (ent.endsWith(".map") || ent.includes("-dev.")) continue;
    if (!ent.endsWith(".mjs") && !ent.endsWith(".css")) continue;
    fs.copyFileSync(path.join(dist, ent), path.join(vendorDir, ent));
  }

  const bootstrap = `import maplibregl from "./maplibre-gl.mjs";
maplibregl.setWorkerUrl(new URL("./maplibre-gl-worker.mjs", import.meta.url).href);
globalThis.maplibregl = maplibregl;
export default maplibregl;
`;
  fs.writeFileSync(path.join(vendorDir, "maplibre-bootstrap.mjs"), bootstrap, "utf8");
  console.log("[build-map] vendored MapLibre ESM + bootstrap → public/vendor/maplibre-gl/");
}

ensureDir(distDir);
vendorMapLibre();

const shared = {
  absWorkingDir: root,
  bundle: true,
  format: "iife",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
};

const mainOptions = {
  ...shared,
  entryPoints: [path.join(root, "client/map/main.ts")],
  outfile: path.join(distDir, "map.js"),
  platform: "browser",
  globalName: "TakPortalMap",
};

const workerOptions = {
  ...shared,
  entryPoints: [path.join(root, "client/map/worker/cotStore.worker.ts")],
  outfile: path.join(distDir, "map.worker.js"),
  platform: "browser",
  format: "iife",
};

if (watch) {
  const ctxMain = await esbuild.context(mainOptions);
  const ctxWorker = await esbuild.context(workerOptions);
  await Promise.all([ctxMain.watch(), ctxWorker.watch()]);
  console.log("[build-map] watching client/map …");
} else {
  await Promise.all([esbuild.build(mainOptions), esbuild.build(workerOptions)]);
  console.log("[build-map] wrote public/dist/map.js + map.worker.js");
}
