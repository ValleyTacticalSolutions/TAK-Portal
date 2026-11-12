// GHSA-mrhx-c7xc-m3w5: zod <4.6.6 can exhaust memory. jimp's @jimp/* plugins pin zod ^3,
// so package.json overrides zod. Fails if the override is dropped or zod resolves to a vulnerable version.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
const parse = (v) => v.split("-")[0].split(".").map(Number);
const FIXED = [4, 6, 6];

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.ok(pkg.overrides && pkg.overrides.zod, "package.json must override zod");

function zodCopies(dir, out) {
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) return out;
  for (const name of fs.readdirSync(nm)) {
    const p = path.join(nm, name);
    if (name === "zod") {
      const f = path.join(p, "package.json");
      if (fs.existsSync(f)) out.push([p, JSON.parse(fs.readFileSync(f, "utf8")).version]);
    }
    if (name.startsWith("@")) { for (const s of fs.readdirSync(p)) zodCopies(path.join(p, s), out); }
    else if (fs.existsSync(path.join(p, "node_modules"))) zodCopies(p, out);
  }
  return out;
}
const copies = zodCopies(root, []);
assert.ok(copies.length > 0, "zod should be installed");
for (const [p, v] of copies) {
  assert.ok(cmp(parse(v), FIXED) >= 0, `${p} is zod ${v}; need >= 4.6.6`);
}
console.log("zodOverride.test.js: ok");
