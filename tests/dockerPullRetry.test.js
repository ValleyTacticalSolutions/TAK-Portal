"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const marketplace = require("../services/cloudtakMarketplace.service");
const ssh = require("../services/cloudtakMarketplace.ssh");

const RATE = "Docker Hub is limiting pulls from this address, try again later.";
assert.strictEqual(marketplace.DOCKER_HUB_RATE_LIMIT_MESSAGE, RATE);
assert.ok(ssh.SSH_PTY_COLS >= 512, "pty must be wide enough to keep the HTTP status");

const head =
  'failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://registry-1.docker.io/v2/postgis/postgis/blobs/sha256/';
const long503 = `${head}${"a".repeat(360)}": 503 Service Unavailable`;
assert.ok(long503.length > 400, "fixture must be past the old 400-char skip");
assert.ok(long503.indexOf("503") > 220, "status must sit past the old 220-char clip");

const summary503 = marketplace.summarizeCommandError(`ERROR: process failed\n${long503}`);
assert.strictEqual(summary503, long503);
assert.ok(!summary503.endsWith("..."));

const long429 = `${head}${"b".repeat(240)}": 429 Too Many Requests`;
assert.ok(long429.indexOf("429") > 220);
assert.strictEqual(marketplace.summarizeCommandError(long429), RATE);
const logged429 = marketplace.pullFailureLogLines(long429);
assert.ok(logged429.some((line) => line.includes("429 Too Many Requests") && line.length > 220));

const wrapped = [
  "failed to copy: unexpected status from HEAD request to https://registry-1.docker.io/v2/postgis/postgis/manifests/16-3.4",
  "503 Service Unavailable",
].join("\n");
assert.strictEqual(marketplace.classifyDockerPullFailure(wrapped), "transient");
const wrappedSummary = marketplace.summarizeCommandError(wrapped);
assert.match(wrappedSummary, /registry-1\.docker\.io/);
assert.match(wrappedSummary, /503 Service Unavailable/);

assert.strictEqual(
  marketplace.classifyDockerPullFailure(
    'failed to copy: Get "https://registry-1.docker.io/v2/blobs/sha256:abc429def": unexpected EOF'
  ),
  "transient"
);
assert.strictEqual(
  marketplace.classifyDockerPullFailure(
    "Error response from daemon: received unexpected HTTP status: 503 Service Unavailable"
  ),
  "transient"
);
assert.strictEqual(
  marketplace.classifyDockerPullFailure(
    "unexpected status from HEAD request to https://registry-1.docker.io/v2/postgis/postgis/manifests/16-3.4: 404 Not Found"
  ),
  "other"
);
assert.strictEqual(
  marketplace.summarizeCommandError("service \"cloudtak-print\" depends on undefined service \"cloudtak-store\": invalid compose project"),
  "service \"cloudtak-print\" depends on undefined service \"cloudtak-store\": invalid compose project"
);

const rebuild = marketplace.rebuildRemoteScript("/root/CloudTAK", "api");
assert.match(rebuild, /docker_compose_with_pull_retry docker compose --progress=plain/);
assert.match(rebuild, /stdbuf -oL -eL tee/);
assert.match(rebuild, /Docker Hub is limiting pulls from this address, try again later\./);

const install = marketplace.installRemoteScript("/root/CloudTAK", {
  id: "search-containment",
  repo: "https://github.com/clptak/cloudtak-plugin-search-containment.git",
  ref: "main",
  web: { dest: "search-containment", source: "." },
});
assert.match(install, /docker_compose_with_pull_retry docker compose --progress=plain/);

const helper = fs.readFileSync(path.join(__dirname, "..", "host-helpers", "marketplace-helper"), "utf8");
const rebuildFn = helper.slice(helper.indexOf("cmd_rebuild()"), helper.indexOf("cmd_write_caddy_route"));
assert.match(rebuildFn, /docker_compose_with_pull_retry docker compose --progress=plain "\$\{args\[@\]\}" build --no-cache/);
assert.match(rebuildFn, /docker_compose_with_pull_retry docker compose --progress=plain "\$\{args\[@\]\}" up -d --force-recreate/);
assert.doesNotMatch(rebuildFn, /\| stdbuf -oL -eL cat/);

function runRetry(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-pull-retry-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const attempts = path.join(dir, "attempts");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
n=0
if [ -f ${JSON.stringify(attempts)} ]; then n=$(cat ${JSON.stringify(attempts)}); fi
n=$((n + 1))
printf '%s\\n' "$n" > ${JSON.stringify(attempts)}
mode=${JSON.stringify(mode)}
if [ "$mode" = ratelimit ]; then
  echo '${head.replace(/'/g, "'\\''")}${"c".repeat(80)}": 429 Too Many Requests'
  exit 1
fi
if [ "$mode" = eof ]; then
  if [ "$n" -lt 3 ]; then
    echo 'failed to copy: httpReadSeeker: failed open: unexpected EOF'
    exit 1
  fi
  echo pulled
  exit 0
fi
if [ "$mode" = always502 ]; then
  echo 'failed to copy: unexpected status from HEAD request to https://registry-1.docker.io/v2/postgis/postgis/manifests/16-3.4: 502 Bad Gateway'
  exit 1
fi
if [ "$mode" = daemon503 ]; then
  if [ "$n" -lt 3 ]; then
    echo 'Error response from daemon: received unexpected HTTP status: 503 Service Unavailable'
    exit 1
  fi
  echo pulled
  exit 0
fi
echo 'service "postgis" depends on undefined service "missing": invalid compose project'
exit 1
`,
    { mode: 0o755 }
  );
  const blockStart = helper.indexOf("# BEGIN docker_pull_retry");
  const blockEnd = helper.indexOf("# END docker_pull_retry");
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const script = path.join(dir, "run.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      helper.slice(blockStart, blockEnd + "# END docker_pull_retry".length),
      "export DOCKER_PULL_RETRY_SLEEP=0",
      `export PATH=${JSON.stringify(bin)}:$PATH`,
      "if docker_compose_with_pull_retry docker compose pull postgis; then",
      "  printf '%s\\n' OK",
      "else",
      "  printf '%s\\n' FAIL",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const result = spawnSync("bash", [script], { encoding: "utf8" });
  const count = Number(fs.readFileSync(attempts, "utf8").trim());
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    count,
  };
}

const limited = runRetry("ratelimit");
assert.strictEqual(limited.status, 0, limited.stderr);
assert.match(limited.stdout, /FAIL/);
assert.match(limited.stderr, new RegExp(RATE.replace(/[.]/g, "\\.")));
assert.strictEqual(limited.count, 1, "a 429 must not be retried");

const dropped = runRetry("eof");
assert.strictEqual(dropped.status, 0, dropped.stderr);
assert.match(dropped.stdout, /OK/);
assert.match(dropped.stdout, /pulled/);
assert.match(dropped.stderr, /retrying \(attempt 1 of 3\)/);
assert.match(dropped.stderr, /retrying \(attempt 2 of 3\)/);
assert.strictEqual(dropped.count, 3, "a dropped layer is retried twice");

const gateway = runRetry("always502");
assert.strictEqual(gateway.status, 0, gateway.stderr);
assert.match(gateway.stdout, /FAIL/);
assert.match(gateway.stdout, /502 Bad Gateway/);
assert.doesNotMatch(gateway.stderr, /limiting pulls/);
assert.strictEqual(gateway.count, 3, "a Hub 5xx is retried twice");

const daemon503 = runRetry("daemon503");
assert.strictEqual(daemon503.status, 0, daemon503.stderr);
assert.match(daemon503.stdout, /OK/);
assert.match(daemon503.stdout, /pulled/);
assert.match(daemon503.stderr, /retrying \(attempt 1 of 3\)/);
assert.match(daemon503.stderr, /retrying \(attempt 2 of 3\)/);
assert.strictEqual(daemon503.count, 3, "daemon HTTP 503 wording is retried twice");

const compose = runRetry("other");
assert.strictEqual(compose.status, 0, compose.stderr);
assert.match(compose.stdout, /FAIL/);
assert.match(compose.stdout, /invalid compose project/);
assert.doesNotMatch(compose.stderr, /limiting pulls/);
assert.strictEqual(compose.count, 1, "a compose error is not a pull retry");

console.log("dockerPullRetry tests passed");
