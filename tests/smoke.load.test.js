"use strict";

/**
 * Smoke test: catches syntax errors, missing modules and broken templates anywhere in the app,
 * not just in files another test happens to touch.
 * - every routes/*.js and services/*.js loads (require)
 * - server.js and worker.js parse
 * - every views/**\/*.ejs compiles
 * - every browser script in public/*.js and client/map/legacy/*.js parses
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const root = path.join(__dirname, "..");
const failures = [];

function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, "/");
}

function firstLine(err) {
  return String((err && err.message) || err).split("\n")[0];
}

// Server modules load.
for (const dir of ["routes", "services"]) {
  for (const file of listFiles(path.join(root, dir), ".js")) {
    try {
      require(file);
    } catch (err) {
      failures.push(`${rel(file)}: ${firstLine(err)}`);
    }
  }
}

// Entry points parse (not executed: they start servers).
for (const name of ["server.js", "worker.js"]) {
  const file = path.join(root, name);
  try {
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, "utf8")}\n})`, {
      filename: file,
    });
  } catch (err) {
    failures.push(`${name}: ${firstLine(err)}`);
  }
}

// Templates compile.
const views = listFiles(path.join(root, "views"), ".ejs");
assert.ok(views.length > 10, "expected to find the views");
for (const file of views) {
  try {
    ejs.compile(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (err) {
    failures.push(`${rel(file)}: ${firstLine(err)}`);
  }
}

// Browser scripts parse.
const browserScripts = [
  ...fs
    .readdirSync(path.join(root, "public"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(root, "public", f)),
  ...listFiles(path.join(root, "client", "map", "legacy"), ".js"),
];
for (const file of browserScripts) {
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (err) {
    failures.push(`${rel(file)}: ${firstLine(err)}`);
  }
}

assert.deepStrictEqual(failures, [], `smoke load failures:\n${failures.join("\n")}`);
console.log(`smoke.load.test.js: ok (${views.length} views, ${browserScripts.length} browser scripts)`);
process.exit(0); // some services start timers on load
