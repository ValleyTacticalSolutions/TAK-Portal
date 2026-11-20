"use strict";

// CloudTAK 13.124+ lints the API with OXLint. Marketplace must not opt plugin
// server routes out of that lint (no @ts-nocheck injection, no ignorePatterns).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const align = require("../services/cloudtakMarketplace.align");
const marketplace = require("../services/cloudtakMarketplace.service");

const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-"));
try {
  const write = (rel, text) => {
    const f = path.join(apiDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  write(
    ".oxlintrc.json",
    JSON.stringify(
      {
        ignorePatterns: [
          "dist/**",
          "stateless/routes/plugin-*.ts",
          "stateless/routes/replay.ts",
          "stateless/lib/d4h-sync.ts",
        ],
        rules: { "no-var": "error" },
      },
      null,
      4
    ) + "\n"
  );
  write(
    "eslint.config.js",
    "export default tseslint.config(\n" +
      "    /* cloudtak-marketplace-routes */\n" +
      "    { ignores: ['stateless/routes/plugin-*.ts', 'stateless/routes/replay.ts'] },\n" +
      "    eslint.configs.recommended,\n" +
      ");\n"
  );
  write("stateless/routes/plugin-x.ts", "export {};\n");
  write("stateless/lib/d4h-sync.ts", "export {};\n");
  write(".marketplace-owned-ts", "api/stateless/lib/d4h-sync.ts\n");

  const first = align.clearMarketplaceServerLintSkips(apiDir);
  assert.ok(first.some((c) => c.startsWith("api/.oxlintrc.json")), "clears oxlint marketplace ignores");
  assert.ok(first.some((c) => c.startsWith("api/eslint.config.js")), "clears eslint marketplace ignores");
  assert.ok(first.some((c) => c.includes(".marketplace-owned-ts")), "drops owned-ts marker");

  const cfg = JSON.parse(fs.readFileSync(path.join(apiDir, ".oxlintrc.json"), "utf8"));
  assert.deepStrictEqual(cfg.ignorePatterns, ["dist/**", "stateless/lib/d4h-sync.ts"]);
  assert.strictEqual(cfg.rules["no-var"], "error", "other keys kept");

  const eslint = fs.readFileSync(path.join(apiDir, "eslint.config.js"), "utf8");
  assert.doesNotMatch(eslint, /cloudtak-marketplace-routes/);
  assert.doesNotMatch(eslint, /plugin-\*\.ts/);

  const route = fs.readFileSync(path.join(apiDir, "stateless", "routes", "plugin-x.ts"), "utf8");
  assert.doesNotMatch(route, /@ts-nocheck/);
  assert.ok(!fs.existsSync(path.join(apiDir, ".marketplace-owned-ts")));

  assert.deepStrictEqual(align.clearMarketplaceServerLintSkips(apiDir), [], "second run changes nothing");
  assert.deepStrictEqual(align.relaxMarketplaceServerRoutes(apiDir), [], "legacy alias is clear-only");
} finally {
  fs.rmSync(apiDir, { recursive: true, force: true });
}
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-empty-"));
  assert.deepStrictEqual(align.clearMarketplaceServerLintSkips(empty), []);
  fs.rmSync(empty, { recursive: true, force: true });
}
{
  // Clean host: align must not inject @ts-nocheck or add OXLint ignores.
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-clean-"));
  const routes = path.join(clean, "stateless", "routes");
  fs.mkdirSync(routes, { recursive: true });
  fs.writeFileSync(
    path.join(clean, ".oxlintrc.json"),
    JSON.stringify({ ignorePatterns: ["dist/**"] }, null, 4) + "\n"
  );
  fs.writeFileSync(path.join(routes, "plugin-demo.ts"), "export const ok = 1;\n");
  assert.deepStrictEqual(align.clearMarketplaceServerLintSkips(clean), []);
  assert.strictEqual(
    fs.readFileSync(path.join(routes, "plugin-demo.ts"), "utf8"),
    "export const ok = 1;\n"
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(clean, ".oxlintrc.json"), "utf8")).ignorePatterns,
    ["dist/**"]
  );
  fs.rmSync(clean, { recursive: true, force: true });
}
assert.ok(marketplace.MARKETPLACE_GIT_RESTORE_PATHS.includes("api/.oxlintrc.json"), "restore list has .oxlintrc.json");
console.log("cloudtakMarketplace.oxlint.test.js ok");
