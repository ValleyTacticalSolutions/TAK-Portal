"use strict";

/**
 * Proof: cloudtakMarketplace.align.js and cloudtakMarketplace.patch.js are written ALONE to the
 * CloudTAK host (/tmp/ctak-marketplace-align.cjs etc.) from a heredoc, so they may only require
 * Node built-ins. A relative require (the security wave added ./safeRegex to align.js) threw
 * "Cannot find module './safeRegex'" and failed every marketplace rebuild.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const servicesDir = path.join(__dirname, "..", "services");
const STAGED = ["cloudtakMarketplace.align.js", "cloudtakMarketplace.patch.js"];

for (const name of STAGED) {
  const src = fs.readFileSync(path.join(servicesDir, name), "utf8");

  // Static guard: no relative / absolute-path requires.
  const bad = [...src.matchAll(/require\(\s*["'`]((?:\.{1,2}\/|\/)[^"'`]*)["'`]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(bad, [], `${name} is staged standalone; it must not require ${bad.join(", ")}`);

  // Runtime: exactly how the host runs it — the file alone in an empty directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-standalone-"));
  try {
    const staged = path.join(dir, "staged.cjs");
    fs.writeFileSync(staged, src);
    const r = spawnSync(process.execPath, [staged, path.join(dir, "no-such-checkout")], {
      encoding: "utf8",
      cwd: dir,
    });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    assert.doesNotMatch(out, /Cannot find module|MODULE_NOT_FOUND/, `${name} failed to load standalone:\n${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The inlined escapeRegExp must stay identical to the shared helper.
{
  const shared = require("../services/safeRegex").escapeRegExp;
  const src = fs.readFileSync(path.join(servicesDir, "cloudtakMarketplace.align.js"), "utf8");
  const m = src.match(/function escapeRegExp\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, "align.js must inline escapeRegExp");
  const inlined = new Function(`${m[0]}; return escapeRegExp;`)();
  for (const s of ["a.b*c", "(x|y)[z]\\", "$^{}+?", "plain", "", null, undefined]) {
    assert.strictEqual(inlined(s), shared(s));
  }
}

console.log("cloudtakMarketplace.standaloneScripts tests passed");
