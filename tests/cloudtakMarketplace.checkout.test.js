"use strict";

/**
 * Proof tests: marketplace must refuse Portal-fabricated leftover trees and only
 * act on a real CloudTAK checkout (api/package.json + compose).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ssh = require("../services/cloudtakMarketplace.ssh");
const marketplace = require("../services/cloudtakMarketplace.service");
const align = require("../services/cloudtakMarketplace.align");

function resolveBash() {
  const candidates = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-c", "echo ok"], { encoding: "utf8" });
    if (probe.status === 0 && /ok/.test(probe.stdout || "")) return bin;
  }
  throw new Error("bash is required for cloudtakMarketplace.checkout tests");
}

const bash = resolveBash();
const helperSrc = path.join(__dirname, "..", "host-helpers", "marketplace-helper");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// COMPOSE_FILE is split on ':', so a Windows "C:\..." path must reach bash as "/c/...".
function toBashPath(p) {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function runBash(script, opts = {}) {
  return spawnSync(bash, ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
  });
}

function makeRealCheckout(root, { layout = "app", absoluteCompose = false } = {}) {
  writeFile(
    path.join(root, "api", "package.json"),
    JSON.stringify({ name: "@tak-ps/CloudTAK.api", version: "13.124.0" }, null, 2) + "\n"
  );
  writeFile(path.join(root, "docker-compose.yml"), "services:\n  api:\n    build: .\n");
  if (layout === "app") {
    writeFile(path.join(root, "app", "package.json"), '{"name":"cloudtak-app"}\n');
    fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "app", "plugins"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(root, "api", "web", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "api", "web", "plugins"), { recursive: true });
  }
  if (absoluteCompose) {
    const abs = path.join(root, "docker-compose.yml");
    writeFile(
      path.join(root, ".env"),
      `COMPOSE_FILE=${abs}:${path.join(root, "docker-compose.override.yml")}\n`
    );
    writeFile(path.join(root, "docker-compose.override.yml"), "services: {}\n");
  }
  return root;
}

/** Exactly what marketplace-helper reclaim / elevate fallback create (no package.json). */
function makeLeftoverTree(root) {
  for (const d of [
    "app/plugins",
    "api/web/plugins",
    "app/src/plugins",
    "api/web/src/plugins",
    "api/stateless/routes",
    "api/stateless/lib",
    "api/stateful/lib",
    "api/test",
    "cloudtak-marketplace-plugins",
  ]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

// --- ctak_checkout_ok ---

{
  const leftover = mkTmp("ctak-leftover-");
  makeLeftoverTree(leftover);
  const script = [
    "set -euo pipefail",
    ssh.ctakCheckoutOkBash(),
    `if ctak_checkout_ok ${JSON.stringify(leftover)}; then echo ACCEPT; else echo REJECT; fi`,
    `echo REASON:$(ctak_checkout_reason ${JSON.stringify(leftover)})`,
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /REJECT/, "proof: reclaim leftover tree must be rejected");
  assert.match(r.stdout, /missing api\/package\.json/);
  fs.rmSync(leftover, { recursive: true, force: true });
}

{
  const modern = mkTmp("ctak-modern-");
  makeRealCheckout(modern, { layout: "app" });
  const script = [
    "set -euo pipefail",
    ssh.ctakCheckoutOkBash(),
    `ctak_checkout_ok ${JSON.stringify(modern)} && echo ACCEPT`,
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ACCEPT/);
  fs.rmSync(modern, { recursive: true, force: true });
}

{
  const legacy = mkTmp("ctak-legacy-");
  makeRealCheckout(legacy, { layout: "legacy" });
  const script = [
    "set -euo pipefail",
    ssh.ctakCheckoutOkBash(),
    `ctak_checkout_ok ${JSON.stringify(legacy)} && echo ACCEPT`,
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ACCEPT/);
  fs.rmSync(legacy, { recursive: true, force: true });
}

{
  const infra = mkTmp("ctak-infra-");
  makeRealCheckout(infra, { absoluteCompose: true });
  // Remove the default-name file from being the only path: keep it, but also verify
  // COMPOSE_FILE absolute entries alone would work if default names were absent.
  const script = [
    "set -euo pipefail",
    ssh.ctakCheckoutOkBash(),
    `ctak_checkout_ok ${JSON.stringify(infra)} && echo ACCEPT`,
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ACCEPT/, "infra-TAK absolute COMPOSE_FILE must be accepted");
  fs.rmSync(infra, { recursive: true, force: true });
}

{
  // COMPOSE_FILE-only checkout (no docker-compose.yml basename — only via .env absolute path)
  const onlyEnv = mkTmp("ctak-envcompose-");
  writeFile(
    path.join(onlyEnv, "api", "package.json"),
    JSON.stringify({ name: "@tak-ps/CloudTAK.api", version: "13.124.0" }) + "\n"
  );
  const composePath = path.join(onlyEnv, "stack-compose.yml");
  writeFile(composePath, "services:\n  api:\n    build: .\n");
  writeFile(path.join(onlyEnv, ".env"), `COMPOSE_FILE=${toBashPath(composePath)}\n`);
  const script = [
    "set -euo pipefail",
    ssh.ctakCheckoutOkBash(),
    `ctak_checkout_ok ${JSON.stringify(toBashPath(onlyEnv))} && echo ACCEPT`,
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ACCEPT/);
  fs.rmSync(onlyEnv, { recursive: true, force: true });
}

// --- detect prefers real tree over leftover listed first ---

{
  const base = mkTmp("ctak-detect-");
  const leftover = path.join(base, "leftover");
  const real = path.join(base, "real");
  makeLeftoverTree(leftover);
  makeRealCheckout(real);
  writeFile(
    path.join(real, "api", "package.json"),
    JSON.stringify({ name: "@tak-ps/CloudTAK.api", version: "13.124.0" }) + "\n"
  );
  const script = [
    "set -eu",
    ssh.ctakCheckoutOkBash(),
    "found=\"\"",
    "consider() {",
    '  local d="$1"',
    '  [ -n "$d" ] || return 1',
    "  d=${d%/}",
    '  if ctak_checkout_ok "$d"; then found="$d"; return 0; fi',
    "  return 1",
    "}",
    `consider ${JSON.stringify(leftover)} || true`,
    `consider ${JSON.stringify(real)} || true`,
    'printf "FOUND=%s\\n" "$found"',
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes(`FOUND=${real}`), r.stdout);
  fs.rmSync(base, { recursive: true, force: true });
}

// --- detectScript prefers docker working_dir when a fake docker is on PATH ---

{
  const base = mkTmp("ctak-docker-detect-");
  const leftover = path.join(base, "CloudTAK");
  const running = path.join(base, "home-takwerx-CloudTAK");
  makeLeftoverTree(leftover);
  makeRealCheckout(running);
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const dockerShim = path.join(bin, "docker");
  // Fake docker: ps lists one container; inspect returns compose labels for working_dir=running.
  writeFile(
    dockerShim,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ps" ]; then
  echo cloudtak-api-1
  exit 0
fi
if [ "\${1:-}" = "inspect" ]; then
  # Format string is the arg after -f
  fmt=""
  while [ "\$#" -gt 0 ]; do
    if [ "\$1" = "-f" ]; then fmt="\$2"; shift 2; continue; fi
    shift || true
  done
  case "\$fmt" in
    *com.docker.compose.service*) echo api ;;
    *com.docker.compose.project.working_dir*) echo ${JSON.stringify(running)} ;;
    *) echo "" ;;
  esac
  exit 0
fi
exit 0
`
  );
  fs.chmodSync(dockerShim, 0o755);
  // Exercise the docker-prefer path from detectScript by extracting the shared helpers
  // and the prefer-running block (full detectScript also walks HOME which we override).
  const script = [
    "set -eu",
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export HOME=${JSON.stringify(leftover)}`,
    ssh.ctakCheckoutOkBash(),
    "found=\"\"",
    "while IFS= read -r c; do",
    '  [ -n "$c" ] || continue',
    `  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c" 2>/dev/null || true)`,
    '  case "$svc" in api|cloudtak-api) ;; *) continue ;; esac',
    `  wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null || true)`,
    '  [ -n "$wd" ] || continue',
    '  if ctak_checkout_ok "$wd" && ctak_package_looks_like_cloudtak "$wd"; then found="$wd"; break; fi',
    "done <<CONTAINERS",
    "$(docker ps --format '{{.Names}}' 2>/dev/null || true)",
    "CONTAINERS",
    'printf "FOUND=%s\\n" "$found"',
  ].join("\n");
  const r = runBash(script);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes(`FOUND=${running}`), "running compose project must win: " + r.stdout);
  fs.rmSync(base, { recursive: true, force: true });
}

// --- detectScript source contracts ---

{
  const src = ssh.detectScript();
  assert.match(src, /ctak_checkout_ok/);
  assert.doesNotMatch(src, /is_ct\(\)/);
  assert.match(src, /com\.docker\.compose\.project\.working_dir/);
  assert.match(src, /\/opt\/infratak\/\.shims/);
  assert.match(src, /api\/package\.json/);
}

{
  const install = marketplace.installRemoteScript("/root/CloudTAK", {
    id: "air-aware",
    name: "Air Aware",
    repo: "https://github.com/ValleyTacticalSolutions/cloudtak-plugin-air-aware.git",
    ref: "main",
    web: { source: "plugin", dest: "air-aware" },
    routes: { source: "server" },
  });
  assert.match(install, /require_cloudtak_checkout/);
  assert.match(install, /ctak_checkout_ok/);
  const reclaimIdx = install.indexOf("reclaim_cloudtak_plugin_paths");
  const requireIdx = install.indexOf("require_cloudtak_checkout");
  assert.ok(requireIdx !== -1 && reclaimIdx !== -1 && requireIdx < reclaimIdx, "preflight before reclaim");
}

{
  const uninstall = marketplace.uninstallRemoteScript("/root/CloudTAK", "air-aware", [], "air-aware");
  assert.match(uninstall, /require_cloudtak_checkout/);
  const rebuild = marketplace.rebuildRemoteScript("/root/CloudTAK", "api");
  assert.match(rebuild, /require_cloudtak_checkout/);
  const requireIdx = rebuild.indexOf("require_cloudtak_checkout");
  const alignIdx = rebuild.indexOf("align_plugins_to_host");
  assert.ok(requireIdx < alignIdx);
}

// --- helper refuses non-checkout reclaim ---

{
  const leftover = mkTmp("ctak-helper-leftover-");
  makeLeftoverTree(leftover);
  const before = fs.readdirSync(leftover).sort().join(",");
  const r = spawnSync(bash, [helperSrc, "reclaim", toBashPath(leftover), "nobody", "nogroup"], {
    encoding: "utf8",
  });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr || "", /not a CloudTAK checkout|missing api\/package\.json/i);
  const after = fs.readdirSync(leftover).sort().join(",");
  assert.strictEqual(after, before, "helper reclaim must not create dirs on a non-checkout");
  fs.rmSync(leftover, { recursive: true, force: true });
}

{
  const helper = fs.readFileSync(helperSrc, "utf8");
  assert.match(helper, /HELPER_VERSION=6/);
  assert.match(helper, /require_checkout_package_json/);
}

// --- reclaim ownership: root uses checkout owner ---

{
  const priv = marketplace.installRemoteScript("/home/takwerx/CloudTAK", {
    id: "x",
    name: "X",
    repo: "https://example.com/x.git",
    ref: "main",
    web: { source: "plugin", dest: "x" },
  });
  // Source is in pluginPrivilegeBash reclaim — check the generated install embeds owner logic
  assert.match(priv, /owner_u=\$\(cloudtak_owner\)/);
  assert.match(priv, /\[ "\$me" = "root" \]/);
}

async function testEnsureCheckoutPathAndReconcile() {
  const settingsSvc = require("../services/settings.service");
  const store = require("../services/cloudtakMarketplace.store");
  const getSettings = settingsSvc.getSettings;
  const saveSettings = settingsSvc.saveSettings;
  const origRun = ssh.runCommand;
  const origDetect = ssh.detectCheckout;
  const origResolved = ssh.resolvedCheckoutPath;
  const prevInstalled = store.readInstalled();
  let saved = { CLOUDTAK_MARKETPLACE_PATH: "/root/CloudTAK" };
  settingsSvc.getSettings = () => ({ ...saved });
  settingsSvc.saveSettings = (next) => {
    saved = { ...next };
  };

  try {
    // Valid path: probe OK, no detect.
    let detectCalls = 0;
    ssh.resolvedCheckoutPath = () => "/tmp/ctak-valid-checkout-test-" + Date.now();
    const validPath = ssh.resolvedCheckoutPath();
    ssh.resolvedCheckoutPath = () => validPath;
    ssh.runCommand = async () => ({
      ok: true,
      stdout: `CHECKOUT_OK path=${validPath}\n`,
    });
    ssh.detectCheckout = async () => {
      detectCalls += 1;
      return { ok: true, path: "/should-not-run" };
    };
    const a = await marketplace.ensureCheckoutPath();
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.path, validPath);
    assert.strictEqual(detectCalls, 0, "valid path must not call detect");

    // SSH / probe error: leave settings untouched
    saved = { CLOUDTAK_MARKETPLACE_PATH: "/root/CloudTAK-probe-err" };
    ssh.resolvedCheckoutPath = () => "/root/CloudTAK-probe-err";
    ssh.runCommand = async () => ({ ok: false, message: "SSH connection refused" });
    const errProbe = await marketplace.ensureCheckoutPath();
    assert.strictEqual(errProbe.ok, false);
    assert.match(errProbe.message || "", /SSH|probe|Could not verify/i);
    assert.strictEqual(saved.CLOUDTAK_MARKETPLACE_PATH, "/root/CloudTAK-probe-err");

    // Invalid saved path heals to detect result
    detectCalls = 0;
    saved = { CLOUDTAK_MARKETPLACE_PATH: "/root/CloudTAK-heal" };
    ssh.resolvedCheckoutPath = () => "/root/CloudTAK-heal";
    ssh.runCommand = async () => ({
      ok: true,
      stdout: "CHECKOUT_INVALID path=/root/CloudTAK-heal reason=missing api/package.json\n",
    });
    ssh.detectCheckout = async () => {
      detectCalls += 1;
      return {
        ok: true,
        path: "/home/takwerx/CloudTAK",
        composeService: "api",
        composeFile: "docker-compose.yml",
      };
    };
    const healed = await marketplace.ensureCheckoutPath();
    assert.strictEqual(healed.ok, true);
    assert.strictEqual(healed.path, "/home/takwerx/CloudTAK");
    assert.strictEqual(healed.healedFrom, "/root/CloudTAK-heal");
    assert.strictEqual(detectCalls, 1);
    assert.strictEqual(saved.CLOUDTAK_MARKETPLACE_PATH, "/home/takwerx/CloudTAK");

    // Reconcile after heal: prune plugins missing from the new tree.
    store.writeInstalled({
      plugins: {
        "air-aware": { sha: "abc", dest: "air-aware", installedAt: "2026-01-01T00:00:00.000Z" },
        keepme: { sha: "def", dest: "keepme", installedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const pruned = marketplace.reconcileInstalledAfterPathHeal({
      ok: true,
      path: "/home/takwerx/CloudTAK",
      plugins: [{ catalogId: "keepme", dest: "keepme" }],
    });
    assert.ok(pruned.includes("air-aware"), "missing plugin on new tree must be pruned");
    assert.ok(!pruned.includes("keepme"));
    const after = store.readInstalled();
    assert.ok(!after.plugins["air-aware"]);
    assert.ok(after.plugins.keepme);
  } finally {
    ssh.runCommand = origRun;
    ssh.detectCheckout = origDetect;
    ssh.resolvedCheckoutPath = origResolved;
    settingsSvc.getSettings = getSettings;
    settingsSvc.saveSettings = saveSettings;
    store.writeInstalled(prevInstalled);
  }
}

// --- change set B: Dockerfile.dockerignore ---

{
  const root = mkTmp("ctak-di-");
  makeRealCheckout(root, { layout: "app" });
  fs.mkdirSync(path.join(root, "app", "plugins", "air-aware"), { recursive: true });
  writeFile(
    path.join(root, ".dockerignore"),
    ["app/plugins/*", "!app/plugins/*.ts", "!app/plugins/README.md"].join("\n") + "\n"
  );
  const changes = align.ensurePluginsInBuildContext(root);
  assert.ok(changes.some((c) => /Dockerfile\.dockerignore/.test(c)), changes.join("; "));
  const out = fs.readFileSync(path.join(root, "Dockerfile.dockerignore"), "utf8");
  assert.match(out, /TAK Portal marketplace/);
  assert.match(out, /!app\/plugins\/\*/);
  assert.match(out, /!app\/plugins\/air-aware/);

  // infra-TAK marked file left alone
  writeFile(
    path.join(root, "Dockerfile.dockerignore"),
    align.INFRATAK_DOCKERIGNORE_MARK + "\napp/plugins/*\n!app/plugins/only-infra\n"
  );
  const left = align.ensurePluginsInBuildContext(root);
  assert.strictEqual(left.length, 0);
  assert.match(fs.readFileSync(path.join(root, "Dockerfile.dockerignore"), "utf8"), /infra-TAK/);

  // Operator file left alone
  writeFile(path.join(root, "Dockerfile.dockerignore"), "# my own ignore\napp/plugins/*\n");
  const left2 = align.ensurePluginsInBuildContext(root);
  assert.strictEqual(left2.length, 0);

  // Portal file removed when upstream no longer excludes plugins
  writeFile(path.join(root, ".dockerignore"), "node_modules\n");
  writeFile(
    path.join(root, "Dockerfile.dockerignore"),
    align.PORTAL_DOCKERIGNORE_MARK + "\n!app/plugins/*\n"
  );
  const removed = align.ensurePluginsInBuildContext(root);
  assert.ok(removed.some((c) => /removed/.test(c)));
  assert.ok(!fs.existsSync(path.join(root, "Dockerfile.dockerignore")));
  fs.rmSync(root, { recursive: true, force: true });
}

// Upstream .dockerignore at 13.124.0 leaves app/plugins out (source-level repro for change set B).
{
  const ignore = ["app/plugins/*", "!app/plugins/*.ts", "!app/plugins/README.md"].join("\n");
  assert.match(ignore, /^app\/plugins\/\*$/m);
  assert.doesNotMatch(ignore, /^!app\/plugins\/\*$/m);
}

testEnsureCheckoutPathAndReconcile()
  .then(() => {
    console.log("cloudtakMarketplace.checkout tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
