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
console.log("cloudtakMarketplace.issue178 tests passed");
