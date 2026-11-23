/**
 * Proof (CodeQL wave 10): plain-text error responses use fixed messages, and the map video
 * player takes its URL from the marker record and only accepts http(s).
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Normalize CRLF so the "\n}\n" function matchers work on Windows checkouts (core.autocrlf=true).
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");

const mou = read("routes/mou.routes.js");
const fn = mou.match(/function sendPlainError[\s\S]*?\n}\n/)[0];
assert.ok(!/send\(String\(message/.test(fn), "sendPlainError must not send the caller's message");
const sent = [];
const res = {
  setHeader() {},
  type() {},
  status() { return this; },
  send(t) { sent.push(t); return this; },
};
new Function("res", "status", "message", fn + "; return sendPlainError(res, status, message);")(res, 404, "<img src=x onerror=alert(1)>");
assert.strictEqual(sent[0], "Not found.");

const ma = read("routes/mutualAid.routes.js");
assert.ok(!/\.send\(String\(toErrorPayload/.test(ma) && /\.send\(fixedErrorText/.test(ma), "mutual aid QR download sends error text");

const map = read("client/map/legacy/map.js");
assert.ok(!/getAttribute\("data-video-url"\)/.test(map), "video URL must not be read back from the DOM");
assert.ok(/safeHttpVideoUrl\(markerVideoUrl\(getMarkerRecord\(uid\)\)\)/.test(map));
const helper = map.match(/function safeHttpVideoUrl[\s\S]*?\n  }\n/)[0];
const safe = new Function(helper + "; return safeHttpVideoUrl;")();
assert.strictEqual(safe("javascript:alert(1)"), "");
assert.strictEqual(safe("data:text/html,x"), "");
assert.strictEqual(safe("https://cam.example/live.m3u8"), "https://cam.example/live.m3u8");
console.log("codeqlWave10 ok");
