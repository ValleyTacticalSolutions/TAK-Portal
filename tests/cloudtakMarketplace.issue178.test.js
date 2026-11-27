"use strict";

// #178: the Marketplace host shell must not probe `$CTAK_PRIV -n true`. Narrow
// sudoers refuse /usr/bin/true (mail_badpass noise + false negative). Try the real
// command with -n instead and only fall back on the privilege tool's refusal text.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const src = fs.readFileSync(path.join(__dirname, "../services/cloudtakMarketplace.service.js"), "utf8").replace(/\r\n/g, "\n"); // Windows autocrlf checkouts

// 1. No code line probes `-n true` (comments excluded).
const probes = src.split("\n").filter((l) => /"\$CTAK_PRIV"\s+-n\s+(-u\s+\S+\s+)?true\b/.test(l) && !/^\s*#/.test(l));
assert.deepStrictEqual(
  probes.filter((l) => !/-u "\$owner"/.test(l)),
  [],
  "no `$CTAK_PRIV -n true` probes may remain",
);

// 2. Behavior of the generated elevate_run with a fake privilege tool.
const m = src.match(/\n\s*"elevate_run\(\) \{",\n([\s\S]*?)\n\s*"\}",\n/);
assert.ok(m, "elevate_run block found");
const body = new Function(`return [${m[1]}];`)();
const fn = ["elevate_run() {", ...body, "}"].join("\n");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak178-"));
const log = path.join(dir, "calls.log");
const priv = path.join(dir, "fakepriv");
// Narrow grants: refuses everything except `bash -lc` payloads that say GRANTED; -S reads stdin.
fs.writeFileSync(
  priv,
  `#!/bin/bash
echo "$*" >> "${log}"
if [ "$1" = "-n" ] && [ "$2" = "true" ]; then echo "sudo: a password is required" >&2; exit 1; fi
if [ "$1" = "-n" ]; then
  case "$4" in
    *GRANTED*) eval "$4"; exit $? ;;
    *FAILS*) echo "real failure" >&2; exit 3 ;;
    *) echo "sudo: a password is required" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "-S" ]; then read -r _; shift 3; [ "$1" = "true" ] && exit 0; eval "$3"; exit $?; fi
`,
  { mode: 0o755 },
);

function run(cmd, pass) {
  const script = `${fn}\nCTAK_PRIV='${priv}'\nCTAK_SUDO_PASS='${pass}'\nelevate_run ${JSON.stringify(cmd)}\necho "rc=$?"`;
  fs.writeFileSync(log, "");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { out: r.stdout + r.stderr, calls: fs.readFileSync(log, "utf8") };
}

const granted = run("echo GRANTED-ran", "");
assert.match(granted.out, /GRANTED-ran/);
assert.match(granted.out, /rc=0/);
assert.ok(!/^-n true$/m.test(granted.calls), "granted command must not be preceded by a true probe");

// A genuine command failure is returned as-is, not retried with the password.
const failing = run("echo FAILS", "pw");
assert.match(failing.out, /rc=3/);
assert.ok(!/^-S/m.test(failing.calls), "real failure must not trigger the password path");

// Refusal text falls through to the stored password.
const refused = run("echo other", "pw");
assert.match(refused.out, /stored password/);
assert.ok(/^-S/m.test(refused.calls));
assert.ok(!/^-n true$/m.test(refused.calls));

fs.rmSync(dir, { recursive: true, force: true });

// 3. Follow-up: no `-S ... true` password probes either (narrow grants refuse them too).
const passProbes = src.split("\n").filter((l) => /"\$CTAK_PRIV"\s+-S\s+-p\s+\S+\s+true\b/.test(l) && !/^\s*#/.test(l));
assert.deepStrictEqual(passProbes, [], "no `$CTAK_PRIV -S -p '' true` probes may remain");

// 4. Helper refresh: never `-n cp` over the helper (narrow grants only allow running it,
// so each refused cp mailed root, 7x per update-all). Skip identical files, try once per
// run, update through the helper's own self-install verb, leave an old helper alone on infra-TAK.
const helperFile = path.join(__dirname, "../host-helpers/marketplace-helper");
const helperSource = fs.readFileSync(helperFile, "utf8");
const rf = src.match(/\nmarketplace_refresh_helper\(\) \{\n[\s\S]*?\n\}\n/);
assert.ok(rf, "marketplace_refresh_helper found");
const refreshFn = new Function(`return \`${rf[0]}\`;`)();
assert.doesNotMatch(refreshFn, /-n cp\b/, "refresh must not try a passwordless cp");
const installFn = src.match(/\ninstall_marketplace_helper\(\) \{\n[\s\S]*?\n\}\n/)[0];
assert.doesNotMatch(installFn, /"\$CTAK_PRIV" -n (cp|chmod)\b/);

const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak178r-"));
fs.writeFileSync(path.join(rdir, "fakepriv"), `#!/bin/bash
echo "$*" >> calls.log
[ "$1" = "-n" ] || { echo "sudo: a password is required" >&2; exit 1; }
shift
case "$1" in */helper) exec bash "$@" ;; esac
echo "sudo: a password is required" >&2; exit 1
`, { mode: 0o755 });

// infratak: 0/1 stub for marketplace_is_infratak. Runs refresh twice to prove once-per-run.
function refresh({ installed, staged, infratak = true }) {
  fs.writeFileSync(path.join(rdir, "helper"), installed, { mode: 0o755 });
  fs.writeFileSync(path.join(rdir, "staged.src"), staged, { mode: 0o644 });
  fs.writeFileSync(path.join(rdir, "calls.log"), "");
  const script = [
    refreshFn,
    `marketplace_is_infratak() { return ${infratak ? 0 : 1}; }`,
    'CTAK_PRIV="$PWD/fakepriv"; CTAK_SUDO_PASS=""',
    'CTAK_MARKETPLACE_HELPER="$PWD/helper"; CTAK_MARKETPLACE_HELPER_SRC="$PWD/staged.src"',
    "marketplace_refresh_helper; marketplace_refresh_helper; echo rc=$?",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { cwd: rdir, encoding: "utf8" });
  return {
    out: r.stdout + r.stderr,
    calls: fs.readFileSync(path.join(rdir, "calls.log"), "utf8").trim().split("\n").filter(Boolean),
    helper: fs.readFileSync(path.join(rdir, "helper"), "utf8"),
  };
}

// Same file: no privileged call at all.
const same = refresh({ installed: helperSource, staged: helperSource });
assert.deepStrictEqual(same.calls, [], "identical helper must not be refreshed");

// Older helper that knows self-install (v6 shape, lower version): updated in-band, once.
const olderWithVerb = helperSource.replace(/^HELPER_VERSION=\d+$/m, "HELPER_VERSION=1");
const updated = refresh({ installed: olderWithVerb, staged: helperSource });
assert.strictEqual(updated.calls.length, 1, updated.out);
assert.match(updated.calls[0], /^-n .*\/helper self-install .*\/staged\.src$/);
assert.match(updated.out, /refreshed marketplace helper from staged source \(self-install\)/);
assert.strictEqual(updated.helper, helperSource);

// Helper that predates self-install on infra-TAK: left alone, one quiet attempt, no cp.
const preVerb = '#!/bin/bash\n# TAK Portal CloudTAK marketplace helper\necho "marketplace-helper: unknown verb: $1" >&2; exit 1\n';
const old = refresh({ installed: preVerb, staged: helperSource });
assert.strictEqual(old.calls.length, 1, old.out);
assert.ok(!old.calls.some((c) => /\bcp\b/.test(c)));
assert.match(old.out, /update it through infra-TAK/);
assert.match(old.out, /rc=0/);
assert.strictEqual(old.helper, preVerb);

// Same on a Portal-managed host without a stored password: points at the SSH handshake.
const oldPortal = refresh({ installed: preVerb, staged: helperSource, infratak: false });
assert.ok(!oldPortal.calls.some((c) => /\bcp\b/.test(c)));
assert.match(oldPortal.out, /re-run the TAK Portal SSH handshake/);

// 5. The helper's self-install verb validates what it installs.
function selfInstall(staged, mode = 0o644) {
  fs.writeFileSync(path.join(rdir, "helper"), helperSource, { mode: 0o755 });
  fs.writeFileSync(path.join(rdir, "staged.src"), staged);
  fs.chmodSync(path.join(rdir, "staged.src"), mode);
  const r = spawnSync("bash", ["-c", 'bash ./helper self-install "$PWD/staged.src"'], { cwd: rdir, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr, helper: fs.readFileSync(path.join(rdir, "helper"), "utf8") };
}
const newer = helperSource.replace(/^HELPER_VERSION=(\d+)$/m, (_, v) => `HELPER_VERSION=${Number(v) + 1}`);
const ok = selfInstall(newer);
assert.strictEqual(ok.status, 0, ok.out);
assert.match(ok.out, /SELF_INSTALL_OK/);
assert.strictEqual(ok.helper, newer);

const down = selfInstall(olderWithVerb);
assert.notStrictEqual(down.status, 0);
assert.match(down.out, /refusing downgrade/);
assert.strictEqual(down.helper, helperSource);

const notHelper = selfInstall("#!/bin/bash\necho pwned\n");
assert.notStrictEqual(notHelper.status, 0);
assert.match(notHelper.out, /not a TAK Portal marketplace helper/);
assert.strictEqual(notHelper.helper, helperSource);

const badSyntax = selfInstall(`${helperSource}\nif then fi (\n`);
assert.notStrictEqual(badSyntax.status, 0);
assert.match(badSyntax.out, /syntax check/);

const relPath = spawnSync("bash", ["-c", "bash ./helper self-install staged.src"], { cwd: rdir, encoding: "utf8" });
assert.notStrictEqual(relPath.status, 0);

if (process.platform !== "win32") {
  const worldWritable = selfInstall(newer, 0o666);
  assert.notStrictEqual(worldWritable.status, 0);
  assert.match(worldWritable.out, /group or world writable/);
  assert.strictEqual(worldWritable.helper, helperSource);
}
assert.deepStrictEqual(fs.readdirSync(rdir).filter((f) => f.startsWith(".marketplace-helper.")), [], "no temp files left");

fs.rmSync(rdir, { recursive: true, force: true });
console.log("cloudtakMarketplace.issue178 tests passed");
