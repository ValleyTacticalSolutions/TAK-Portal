const assert = require("assert");
const http = require("http");
const express = require("express");
const { createApiRateLimiter, clientKey, isTrustedProxy } = require("../services/rateLimit");

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: "/x", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

(async () => {
  assert.strictEqual(isTrustedProxy("127.0.0.1"), true);
  assert.strictEqual(isTrustedProxy("10.0.0.5"), true);
  assert.strictEqual(isTrustedProxy("8.8.8.8"), false);

  // Trusted peer (Caddy): use last X-Forwarded-For hop.
  assert.strictEqual(
    clientKey({
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    "5.6.7.8"
  );
  // Untrusted peer: ignore spoofed X-Forwarded-For.
  assert.strictEqual(
    clientKey({
      headers: { "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "203.0.113.9" },
      ip: "203.0.113.9",
    }),
    "203.0.113.9"
  );
  assert.strictEqual(clientKey({ headers: {}, ip: "9.9.9.9", socket: { remoteAddress: "9.9.9.9" } }), "9.9.9.9");

  const app = express();
  app.use(createApiRateLimiter({ limit: 3, windowMs: 60000 }));
  app.get("/x", (req, res) => res.send("ok"));
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // Localhost peer is trusted, so XFF keys clients.
    const a = [];
    for (let i = 0; i < 5; i++) a.push(await get(port, { "x-forwarded-for": "10.0.0.1" }));
    assert.deepStrictEqual(a, [200, 200, 200, 429, 429]);
    // A different client is not affected.
    assert.strictEqual(await get(port, { "x-forwarded-for": "10.0.0.2" }), 200);

    // Spoofed rotating XFF from the same trusted peer still keys by last hop;
    // prove rotating first-hop spoof cannot open a new bucket when last hop is fixed.
    const b = [];
    for (let i = 0; i < 5; i++) {
      b.push(await get(port, { "x-forwarded-for": `${i}.0.0.1, 10.0.0.3` }));
    }
    assert.deepStrictEqual(b, [200, 200, 200, 429, 429]);
  } finally {
    server.close();
  }
  console.log("rateLimit.test.js passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
