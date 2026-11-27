"use strict";

// archiver 8 is ESM-only: the old `archiver("zip")` call throws. The wrapper must build real zips,
// and no file may require("archiver") as a function again.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createZipArchive } = require("../services/zipArchive");

function build() {
  return new Promise((resolve, reject) => {
    const a = createZipArchive({ zlib: { level: 9 } });
    const chunks = [];
    a.on("data", (c) => chunks.push(c));
    a.on("end", () => resolve(Buffer.concat(chunks)));
    a.on("error", reject);
    a.append("hello", { name: "MANIFEST/manifest.xml" });
    a.append(Buffer.from("world"), { name: "a/b.txt" });
    a.finalize();
  });
}

(async () => {
  const buf = await build();
  assert.strictEqual(buf.slice(0, 4).toString("hex"), "504b0304", "zip local header");
  assert.ok(buf.includes(Buffer.from("MANIFEST/manifest.xml")), "entry name present");
  assert.ok(buf.includes(Buffer.from("a/b.txt")), "second entry present");

  const root = path.join(__dirname, "..");
  for (const dir of ["routes", "services"]) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!String(f).endsWith(".js") || String(f) === "zipArchive.js") continue;
      const src = fs.readFileSync(path.join(root, dir, String(f)), "utf8");
      assert.ok(!/require\(["']archiver["']\)/.test(src), `${dir}/${f} must use services/zipArchive`);
    }
  }
  console.log("zipArchive tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
