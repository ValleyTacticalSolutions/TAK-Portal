"use strict";

/**
 * Proof tests: marketplace jobs failed with "FAILED CHECKOUT_OK path=..." because the
 * checkout probe ran under `bash -lc` with `set -eu`. On exit the login shell ran
 * ~/.bash_logout (clear_console -q), which returned 1 over SSH, and errexit turned
 * that into the shell's exit status. The SSH layer then reported the probe's own
 * success line as the error.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ssh = require("../services/cloudtakMarketplace.ssh");
const marketplace = require("../services/cloudtakMarketplace.service");

function resolveBash() {
  const candidates = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["-c", "echo ok"], { encoding: "utf8" });
    if (probe.status === 0 && /ok/.test(probe.stdout || "")) return bin;
  }
  throw new Error("bash is required for cloudtakMarketplace.loginShellExit tests");
}

function toBashPath(p) {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const bash = resolveBash();

// --- real bash: a failing ~/.bash_logout must not poison the probe's exit status ---

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-logout-"));
  const home = path.join(base, "home");
  const ct = path.join(base, "CloudTAK");
  writeFile(path.join(home, ".bash_profile"), "");
  writeFile(path.join(home, ".bash_logout"), "false\n"); // stands in for clear_console -q → 1
  writeFile(path.join(ct, "api", "package.json"), JSON.stringify({ name: "@tak-ps/CloudTAK.api" }) + "\n");
  writeFile(path.join(ct, "docker-compose.yml"), "services:\n  api:\n    build: .\n");
  fs.mkdirSync(path.join(ct, "app", "plugins"), { recursive: true });

  // Sanity: this environment really reproduces the poison for a plain set -e script.
  const poisoned = spawnSync(bash, ["-lc", "set -eu; printf 'X\\n'; exit 0"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.strictEqual(poisoned.status, 1, "repro: login shell + set -e + failing logout exits 1");

  const script = ssh.probeCheckoutScript(toBashPath(ct));
  const r = spawnSync(bash, ["-lc", script], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(r.stdout, /CHECKOUT_OK/, r.stderr || r.stdout);
  assert.strictEqual(r.status, 0, "probe must exit 0 even under a login shell with a failing logout");

  const invalid = spawnSync(bash, ["-lc", ssh.probeCheckoutScript(toBashPath(home))], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.match(invalid.stdout, /CHECKOUT_INVALID/, invalid.stderr || invalid.stdout);
  assert.strictEqual(invalid.status, 0, "invalid verdict must also exit 0");

  fs.rmSync(base, { recursive: true, force: true });
}

// --- host scan (set -eu, bash -lc) survives a failing ~/.bash_logout ---

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-scan-logout-"));
  const home = path.join(base, "home");
  const ct = path.join(base, "CloudTAK");
  writeFile(path.join(home, ".bash_profile"), "");
  writeFile(path.join(home, ".bash_logout"), "false\n");
  fs.mkdirSync(path.join(ct, "api"), { recursive: true });
  fs.mkdirSync(path.join(ct, "app", "plugins"), { recursive: true });

  const script = marketplace.scanRemoteScript(toBashPath(ct), []);
  const r = spawnSync(bash, ["-lc", script], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(r.stdout, /^SCAN_END$/m, r.stderr || r.stdout);
  assert.strictEqual(r.status, 0, "scan must exit 0 under a login shell with a failing logout");
  fs.rmSync(base, { recursive: true, force: true });

  const scanSrc = marketplace.scanHost.toString();
  assert.match(scanSrc, /SCAN_END/, "scanHost must trust the SCAN_END marker");
  assert.match(scanSrc, /completedRun/, "scanHost must require a completed run before trusting it");
}

// --- detect script ends by dropping errexit before exit 0 ---

{
  const src = ssh.detectScript();
  assert.match(src, /DETECT_OK[^\n]*\n(#[^\n]*\n)?set \+e\nexit 0$/, "detectScript must end with set +e; exit 0");
}

// --- probe / detect / test-connection use a non-login shell ---

{
  const detectSrc = ssh.detectCheckout.toString();
  assert.match(detectSrc, /`bash -c \$\{shellQuote\(detectScript\(\)\)\}`/);
  assert.doesNotMatch(detectSrc, /bash -lc/);
  const testSrc = ssh.testConnection.toString();
  assert.match(testSrc, /`bash -c \$\{shellQuote\(probeCheckoutScript\(override\)\)\}`/);
  assert.doesNotMatch(testSrc, /bash -lc/);
}

// --- probeSavedCheckout trusts the probe's verdict, not just the exit code ---

async function testProbeSavedCheckout() {
  const origRun = ssh.runCommand;
  try {
    const commands = [];

    // Exact failure from the field: exit 1, stdout = success line, message = stdout.
    const okPath = "/home/taktoolsadmin/CloudTAK-" + Date.now();
    ssh.runCommand = async (cmd) => {
      commands.push(cmd);
      return {
        ok: false,
        exitCode: 1,
        stdout: `CHECKOUT_OK path=${okPath}\n`,
        stderr: "",
        message: `CHECKOUT_OK path=${okPath}`,
      };
    };
    const a = await marketplace.probeSavedCheckout(okPath);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.strictEqual(a.valid, true);
    assert.ok(!a.sshError);
    assert.ok(commands[0].startsWith("bash -c "), "probe must not use a login shell: " + commands[0].slice(0, 20));

    // Same poison on an invalid verdict must still allow heal (valid:false, no sshError).
    const badPath = "/root/CloudTAK-bad-" + Date.now();
    ssh.runCommand = async () => ({
      ok: false,
      exitCode: 1,
      stdout: `CHECKOUT_INVALID path=${badPath} reason=missing api/package.json\n`,
      stderr: "",
      message: "x",
    });
    const b = await marketplace.probeSavedCheckout(badPath);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.valid, false);
    assert.strictEqual(b.reason, "missing api/package.json");
    assert.ok(!b.sshError);

    // Connect failure (no exit code) stays an SSH error.
    const connPath = "/root/CloudTAK-conn-" + Date.now();
    ssh.runCommand = async () => ({ ok: false, exitCode: null, stdout: "", stderr: "", message: "ECONNREFUSED" });
    const c = await marketplace.probeSavedCheckout(connPath);
    assert.strictEqual(c.sshError, true);
    assert.strictEqual(c.message, "ECONNREFUSED");

    // Non-zero exit with no verdict line stays an SSH error.
    const noMarker = "/root/CloudTAK-nomarker-" + Date.now();
    ssh.runCommand = async () => ({ ok: false, exitCode: 2, stdout: "boom\n", stderr: "bad", message: "bad" });
    const d = await marketplace.probeSavedCheckout(noMarker);
    assert.strictEqual(d.sshError, true);

    // Cancelled run is never trusted, even if a marker made it out.
    const cancelPath = "/root/CloudTAK-cancel-" + Date.now();
    ssh.runCommand = async () => ({
      ok: false,
      cancelled: true,
      exitCode: null,
      stdout: `CHECKOUT_OK path=${cancelPath}\n`,
      message: "Cancelled.",
    });
    const e = await marketplace.probeSavedCheckout(cancelPath);
    assert.strictEqual(e.sshError, true);
  } finally {
    ssh.runCommand = origRun;
  }
}

testProbeSavedCheckout()
  .then(() => {
    console.log("cloudtakMarketplace.loginShellExit tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
