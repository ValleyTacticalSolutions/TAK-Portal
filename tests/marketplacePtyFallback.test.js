"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const ssh = require("../services/cloudtakMarketplace.ssh");

assert.strictEqual(ssh.isPtyRefusal(new Error("Unable to request a pseudo-terminal")), true);
assert.strictEqual(ssh.isPtyRefusal(new Error("SSH command timed out.")), false);
assert.ok(ssh.SSH_PTY_COLS >= 512, "pty must stay wide when the server allows one");

function fakeConn(onExec) {
  const calls = [];
  const handlers = {};
  const conn = {
    calls,
    on(ev, fn) {
      handlers[ev] = fn;
      return conn;
    },
    connect() {
      process.nextTick(() => {
        if (handlers.ready) handlers.ready();
      });
    },
    end() {},
    destroy() {},
    exec(command, opts, cb) {
      const options = opts && typeof opts === "object" ? opts : {};
      calls.push({ command, pty: !!options.pty, cols: options.pty && options.pty.cols });
      onExec(command, options, cb);
    },
  };
  return conn;
}

function streamWith(stdout, code, stderrText) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => {};
  stream.signal = () => {};
  process.nextTick(() => {
    if (stdout) stream.emit("data", Buffer.from(stdout));
    if (stderrText) stream.stderr.emit("data", Buffer.from(stderrText));
    stream.emit("close", code);
  });
  return stream;
}

const cfg = { host: "127.0.0.1", port: 22, username: "tak" };
const command = "bash /tmp/ctak-mp-uninstall.sh; ec=$?; rm -f /tmp/ctak-mp-uninstall.sh; exit $ec";

(async () => {
  const refused = fakeConn((cmd, options, cb) => {
    if (options.pty) {
      cb(new Error("Unable to request a pseudo-terminal"));
      return;
    }
    cb(null, streamWith("Removing replay from the CloudTAK plugins directory\nUNINSTALL_OK\n", 0));
  });
  const lines = [];
  const ok = await ssh.execOverSsh(
    cfg,
    command,
    5000,
    (line) => lines.push(line),
    () => refused
  );
  assert.strictEqual(ok.ok, true, ok.message);
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(refused.calls.length, 2, "pty refusal must retry once without a pty");
  assert.strictEqual(refused.calls[0].pty, true);
  assert.strictEqual(refused.calls[0].cols, ssh.SSH_PTY_COLS);
  assert.strictEqual(refused.calls[1].pty, false);
  assert.strictEqual(refused.calls[0].command, command);
  assert.strictEqual(refused.calls[1].command, command);
  assert.ok(lines.includes("UNINSTALL_OK"), `missing script output: ${lines.join(" | ")}`);
  assert.match(ok.stdout, /UNINSTALL_OK/);

  const other = fakeConn((cmd, options, cb) => {
    cb(new Error("Unable to open session"));
  });
  const fail = await ssh.execOverSsh(cfg, "true", 5000, null, () => other);
  assert.strictEqual(fail.ok, false);
  assert.match(fail.message, /Unable to open session/);
  assert.strictEqual(other.calls.length, 1, "non-pty failures must not retry");

  const granted = fakeConn((cmd, options, cb) => {
    cb(null, streamWith("ok\n", 0));
  });
  const grantedResult = await ssh.execOverSsh(cfg, "true", 5000, null, () => granted);
  assert.strictEqual(grantedResult.ok, true);
  assert.strictEqual(granted.calls.length, 1);
  assert.strictEqual(granted.calls[0].pty, true);

  const remoteFail = fakeConn((cmd, options, cb) => {
    if (options.pty) {
      cb(new Error("Unable to request a pseudo-terminal"));
      return;
    }
    cb(null, streamWith("", 1, "ERROR: plugin path still present after uninstall\n"));
  });
  const remote = await ssh.execOverSsh(cfg, command, 5000, null, () => remoteFail);
  assert.strictEqual(remote.ok, false);
  assert.match(remote.message, /plugin path still present/);
  assert.doesNotMatch(remote.message, /pseudo-terminal/);
  assert.strictEqual(remote.exitCode, 1);
  assert.strictEqual(remoteFail.calls.length, 2);

  console.log("marketplace pty fallback tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
