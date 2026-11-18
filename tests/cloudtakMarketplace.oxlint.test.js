"use strict";

// CloudTAK 13.124+ lints the API with OXLint (api/.oxlintrc.json), not ESLint.
// The marketplace lint skip must write its ignores there too (#133).
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
  write(".oxlintrc.json", JSON.stringify({ ignorePatterns: ["dist/**"], rules: { "no-var": "error" } }, null, 4) + "\n");
  write("stateless/routes/plugin-x.ts", "// @ts-nocheck\nexport {};\n");
  write("stateless/lib/d4h-sync.ts", "// @ts-nocheck\nexport {};\n");
  write("stateless/lib/stock.ts", "export {};\n");

  const first = align.relaxMarketplaceServerRoutes(apiDir);
  assert.ok(first.some((c) => c.startsWith("api/.oxlintrc.json")), "first run edits .oxlintrc.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(apiDir, ".oxlintrc.json"), "utf8"));
  assert.strictEqual(cfg.ignorePatterns[0], "dist/**", "keeps existing ignores");
  assert.ok(cfg.ignorePatterns.includes("stateless/routes/plugin-*.ts"));
  assert.ok(cfg.ignorePatterns.includes("stateless/lib/d4h-sync.ts"), "ts-nocheck file ignored");
  assert.ok(!cfg.ignorePatterns.includes("stateless/lib/stock.ts"), "normal file not ignored");
  assert.strictEqual(cfg.rules["no-var"], "error", "other keys kept");

  assert.deepStrictEqual(align.relaxMarketplaceServerRoutes(apiDir), [], "second run changes nothing");
} finally {
  fs.rmSync(apiDir, { recursive: true, force: true });
}
{
  // Older tree with neither config: no crash, no changes.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-empty-"));
  assert.deepStrictEqual(align.relaxMarketplaceServerRoutes(empty), []);
  fs.rmSync(empty, { recursive: true, force: true });
}
assert.ok(marketplace.MARKETPLACE_GIT_RESTORE_PATHS.includes("api/.oxlintrc.json"), "restore list has .oxlintrc.json");
console.log("cloudtakMarketplace.oxlint.test.js ok");
