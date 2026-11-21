"use strict";

// #146: out-of-range installed plugins (Replay) must not poison every marketplace
// rebuild after align strips lint exemptions; failed rebuilds restore the tree;
// batch CSP recreates api once; failures name the culprit plugin.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const align = require("../services/cloudtakMarketplace.align");
const marketplace = require("../services/cloudtakMarketplace.service");

function write(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

{
  // Out-of-range Replay keeps OXLint ignores and @ts-nocheck; in-range paths still strip.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-146-align-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "CloudTAK", version: "13.125.0" }) + "\n");
    write(root, "app/package.json", JSON.stringify({ name: "cloudtak-app", version: "13.125.0" }) + "\n");
    write(root, "api/package.json", JSON.stringify({ name: "cloudtak-api", version: "13.125.0" }) + "\n");
    write(
      root,
      "api/.oxlintrc.json",
      JSON.stringify(
        {
          ignorePatterns: [
            "dist/**",
            "stateless/routes/replay.ts",
            "stateless/lib/retention/replay.ts",
            "stateless/routes/plugin-*.ts",
          ],
        },
        null,
        4
      ) + "\n"
    );
    write(
      root,
      "api/stateless/lib/retention/replay.ts",
      "// @ts-nocheck\nexport const days = 1;\nexport const msg = String(days);\n"
    );
    write(root, "api/stateless/routes/plugin-demo.ts", "// @ts-nocheck\nexport const ok = 1;\n");
    write(
      root,
      "cloudtak-marketplace-plugins/replay/install.sh",
      "#!/bin/bash\n# Supported CloudTAK: v13.109.3 through v13.122.8 (every release in that range)\necho replay\n"
    );
    write(root, "app/plugins/replay/index.ts", "export {};\n");
    write(root, "app/src/base/subscription.ts", "export {};\n");

    const outOfRange = align.listOutOfRangeInstalledPlugins(root, ["replay"]);
    assert.strictEqual(outOfRange.length, 1, "replay is out of range on 13.125.0");
    assert.strictEqual(outOfRange[0].name, "replay");
    assert.strictEqual(outOfRange[0].mismatch, "above");

    const changes = align.clearMarketplaceServerLintSkips(path.join(root, "api"), {
      quarantinePatterns: outOfRange[0].patterns,
      quarantinePluginNames: ["replay"],
    });
    assert.ok(
      changes.some((c) => c.includes("left out-of-range plugin API files out of image lint")),
      "re-adds OXLint ignores for quarantined replay"
    );
    assert.ok(
      changes.some((c) => c.includes("plugin-demo.ts") && c.includes("stripped @ts-nocheck")),
      "still strips @ts-nocheck from in-range plugin routes"
    );

    const ox = JSON.parse(fs.readFileSync(path.join(root, "api", ".oxlintrc.json"), "utf8"));
    assert.ok(ox.ignorePatterns.includes("stateless/lib/retention/replay.ts"), "replay retention stays ignored");
    assert.ok(ox.ignorePatterns.includes("stateless/routes/replay.ts"), "replay route stays ignored");
    assert.ok(!ox.ignorePatterns.includes("stateless/routes/plugin-*.ts"), "blanket plugin-* ignore still cleared");

    assert.match(
      fs.readFileSync(path.join(root, "api/stateless/lib/retention/replay.ts"), "utf8"),
      /@ts-nocheck/,
      "does not strip @ts-nocheck from quarantined replay"
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, "api/stateless/routes/plugin-demo.ts"), "utf8"),
      /@ts-nocheck/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // In-range host: legacy ignores still cleared (no quarantine).
  const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-146-inrange-"));
  try {
    write(
      apiDir,
      ".oxlintrc.json",
      JSON.stringify(
        { ignorePatterns: ["dist/**", "stateless/routes/replay.ts", "stateless/lib/retention/replay.ts"] },
        null,
        4
      ) + "\n"
    );
    write(apiDir, "stateless/lib/retention/replay.ts", "// @ts-nocheck\nexport {};\n");
    const changes = align.clearMarketplaceServerLintSkips(apiDir, {
      quarantinePatterns: [],
      quarantinePluginNames: [],
    });
    assert.ok(changes.some((c) => c.includes("removed marketplace server-route lint ignores")));
    assert.ok(changes.some((c) => c.includes("stripped @ts-nocheck")));
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(apiDir, ".oxlintrc.json"), "utf8")).ignorePatterns,
      ["dist/**"]
    );
  } finally {
    fs.rmSync(apiDir, { recursive: true, force: true });
  }
}

{
  const attributed = marketplace.attributeRebuildFailure(
    [
      " => [api 21/24] RUN npm run lint && npm run build",
      "api/stateless/lib/retention/replay.ts:22:94 - error: Unexpected any",
      "✖ 2 problems (2 errors)",
      'failed to solve: process "/bin/sh -c cd api && npm run lint && npm run build" did not complete successfully: exit code: 1',
    ].join("\n")
  );
  assert.ok(attributed);
  assert.strictEqual(attributed.pluginId, "replay");
  assert.match(attributed.summary, /blocked by installed plugin "replay"/i);
  assert.match(
    marketplace.summarizeCommandError(attributed.summary + "\n" + "api/stateless/lib/retention/replay.ts:22:94"),
    /replay/i
  );
  assert.strictEqual(
    marketplace.pluginIdFromApiLintPath("api/stateless/lib/retention/replay.ts"),
    "replay"
  );
}

{
  const install = marketplace.installRemoteScript("/root/CloudTAK", {
    id: "air-aware",
    name: "Air Aware",
    repo: "https://example.invalid/air-aware.git",
    ref: "main",
    web: { dest: "air-aware" },
  });
  assert.match(install, /skip_recreate="\$\{6:-\}"/);
  assert.match(install, /apply_plugin_csp "\$ID" "\$CT" "\$CT_COMPOSE_SVC" \/tmp\/ctak-csp-\$ID\.spec "" 1/);
  assert.match(install, /deferring \$api_svc recreate until CloudTAK rebuild/);
  assert.match(install, /marketplace_snapshot_api_lint_tree/);
  assert.match(install, /marketplace_restore_api_lint_tree/);
  assert.match(install, /_ctak_install_cleanup/);

  const uninstall = marketplace.uninstallRemoteScript("/root/CloudTAK", "air-aware", [], "air-aware");
  assert.match(uninstall, /apply_plugin_csp "\$ID" "\$CT" "\$CT_COMPOSE_SVC" "" 1 1/);

  const rebuild = marketplace.rebuildRemoteScript("/root/CloudTAK", "api");
  assert.match(rebuild, /marketplace_snapshot_api_lint_tree/);
  assert.match(rebuild, /marketplace_rebuild_fail/);
  assert.match(rebuild, /marketplace_restore_api_lint_tree/);
  assert.match(rebuild, /marketplace_clear_api_lint_tree_snapshot/);
  assert.match(rebuild, /marketplace_api_lint_preflight "\$CT" "\$SVC"/);
  assert.match(rebuild, /API lint preflight failed/);
  const guard = marketplace.marketplaceApiLintTreeGuardBash();
  assert.match(guard, /pre-align-snapshot/);
  assert.match(guard, /marketplace_api_lint_preflight/);
  assert.match(guard, /npm run lint/);
  assert.match(guard, /plugin: \$plugin/);
}

{
  // #146 Rubber Sheet: vendored PDF.js → drop host pdfjs-dist; never re-add.
  const deps = marketplace.ensureMarketplaceHostNpmDepsBash();
  assert.match(deps, /lib\/vendor\/pdfjs/);
  assert.match(deps, /_ctak_drop_pdfjs_dep/);
  assert.match(deps, /Removed leftover host pdfjs-dist/);
  assert.match(deps, /legacy Rubber Sheet without vendored PDF\.js/);
  assert.ok(
    deps.indexOf('if [ -d "$plugin/lib/vendor/pdfjs" ]') < deps.indexOf("_ctak_write_pdfjs_dep"),
    "vendor check runs before legacy pdfjs-dist seed"
  );
}

console.log("cloudtakMarketplace.issue146.test.js ok");
