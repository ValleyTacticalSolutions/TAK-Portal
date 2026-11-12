"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const ssh = require("../services/cloudtakMarketplace.ssh");

assert.strictEqual(ssh.isPtyRefusal(new Error("Unable to request a pseudo-terminal")), true);
assert.strictEqual(ssh.isPtyRefusal(new Error("SSH command timed out.")), false);
assert.ok(ssh.SSH_PTY_COLS >= 512, "pty must stay wide when the server allows one");
assert.match(ssh.PTY_FALLBACK_LOG, /refused a pseudo-terminal/i);

function fakeConn(onExec) {
  const calls = [];
  const handlers = {};
  const conn = {
    calls,
    destroyed: false,
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
    destroy() {
      conn.destroyed = true;
    },
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
  ssh.resetSshPtyPreference();

  // Same-connection retry after PTY refusal is flaky; reconnect on a fresh client.
  const clients = [];
  const createReconnecting = () => {
    const n = clients.length;
    if (n === 0) {
      const first = fakeConn((cmd, options, cb) => {
        if (options.pty) {
          cb(new Error("Unable to request a pseudo-terminal"));
          return;
        }
        // If we wrongly reused this connection, fail the way real OpenSSH can.
        cb(new Error("Unable to open channel"));
      });
      clients.push(first);
      return first;
    }
    const second = fakeConn((cmd, options, cb) => {
      assert.strictEqual(!!options.pty, false, "reconnect must not request a pty");
      cb(null, streamWith("Removing replay from the CloudTAK plugins directory\nUNINSTALL_OK\n", 0));
    });
    clients.push(second);
    return second;
  };

  const lines = [];
  const ok = await ssh.execOverSsh(cfg, command, 5000, (line) => lines.push(line), createReconnecting);
  assert.strictEqual(ok.ok, true, ok.message);
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(clients.length, 2, "pty refusal must open a fresh SSH client");
  assert.strictEqual(clients[0].calls.length, 1);
  assert.strictEqual(clients[0].calls[0].pty, true);
  assert.strictEqual(clients[0].calls[0].cols, ssh.SSH_PTY_COLS);
  assert.strictEqual(clients[0].destroyed, true, "refused client must be torn down");
  assert.strictEqual(clients[1].calls.length, 1);
  assert.strictEqual(clients[1].calls[0].pty, false);
  assert.strictEqual(clients[1].calls[0].command, command);
  assert.ok(lines.includes(ssh.PTY_FALLBACK_LOG), `missing fallback log: ${lines.join(" | ")}`);
  assert.ok(lines.includes("UNINSTALL_OK"), `missing script output: ${lines.join(" | ")}`);
  assert.match(ok.stdout, /UNINSTALL_OK/);

  // Preference remembered: later marketplace commands skip the doomed PTY attempt.
  const skipPty = fakeConn((cmd, options, cb) => {
    assert.strictEqual(!!options.pty, false, "remembered preference must skip pty");
    cb(null, streamWith("ok\n", 0));
  });
  const skipped = await ssh.execOverSsh(cfg, "true", 5000, null, () => skipPty);
  assert.strictEqual(skipped.ok, true);
  assert.strictEqual(skipPty.calls.length, 1);
  assert.strictEqual(skipPty.calls[0].pty, false);

  ssh.resetSshPtyPreference();

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

  // Remote script failure after reconnect must surface that failure, not the PTY string.
  ssh.resetSshPtyPreference();
  const remoteClients = [];
  const createRemoteFail = () => {
    if (remoteClients.length === 0) {
      const first = fakeConn((cmd, options, cb) => {
        cb(new Error("Unable to request a pseudo-terminal"));
      });
      remoteClients.push(first);
      return first;
    }
    const second = fakeConn((cmd, options, cb) => {
      cb(null, streamWith("", 1, "ERROR: plugin path still present after uninstall\n"));
    });
    remoteClients.push(second);
    return second;
  };
  const remote = await ssh.execOverSsh(cfg, command, 5000, null, createRemoteFail);
  assert.strictEqual(remote.ok, false);
  assert.match(remote.message, /plugin path still present/);
  assert.doesNotMatch(remote.message, /pseudo-terminal/);
  assert.strictEqual(remote.exitCode, 1);
  assert.strictEqual(remoteClients.length, 2);

  console.log("marketplace pty fallback tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
