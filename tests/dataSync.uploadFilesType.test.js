// CodeQL js/type-confusion-through-parameter-tampering: /sync/upload must treat
// anything other than an array in req.files as "no files" instead of indexing into it.
const assert = require("assert");
const http = require("http");
const express = require("express");
const dataSyncSvc = require("../services/dataSync.service");

dataSyncSvc.assertTakAvailable = () => {};
const router = require("../routes/dataSync.routes");

function post(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: "POST", path: "/sync/upload", headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const app = express();
  // Simulate a tampered/odd req.files value (a string has a length and indexable chars).
  app.use((req, _res, next) => {
    req.files = "abc";
    next();
  });
  app.use(router);
  const server = app.listen(0);
  try {
    const r = await post(server.address().port, {});
    assert.strictEqual(r.status, 400);
    assert.ok(/No file uploaded/.test(r.body.error), `unexpected error: ${r.body.error}`);
    console.log("dataSync.uploadFilesType.test.js passed");
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
