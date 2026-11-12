"use strict";

/**
 * Proof: Docker image build keeps map/prod-deps cacheable when only
 * non-map app sources change (the ~70s update bottleneck).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");

assert.match(dockerfile, /AS map-build/);
assert.match(dockerfile, /AS prod-deps/);
assert.match(dockerfile, /npm run build:map/);
assert.match(dockerfile, /npm ci --omit=dev/);

// Map inputs must be copied before build:map, and full tree only in the final stage.
const mapBuildIdx = dockerfile.indexOf("AS map-build");
const buildMapIdx = dockerfile.indexOf("npm run build:map");
const prodDepsIdx = dockerfile.indexOf("AS prod-deps");
const finalCopyIdx = dockerfile.lastIndexOf("COPY . .");
assert.ok(mapBuildIdx >= 0 && buildMapIdx > mapBuildIdx, "build:map runs in map-build stage");
assert.ok(prodDepsIdx > buildMapIdx, "prod-deps stage follows map build");
assert.ok(finalCopyIdx > prodDepsIdx, "full COPY . . is only after cached stages");

// Map stage should not COPY the whole tree (that was the old cache-buster).
const mapStage = dockerfile.slice(mapBuildIdx, prodDepsIdx);
assert.doesNotMatch(mapStage, /COPY \. \./);
assert.match(mapStage, /COPY client\/map/);
assert.match(mapStage, /generate-map-app\.mjs/);
assert.match(mapStage, /build-map\.mjs/);

assert.match(dockerignore, /^node_modules$/m);
assert.match(dockerignore, /^\.git$/m);
assert.match(dockerignore, /^tests$/m);
assert.match(dockerignore, /public\/dist/);
assert.match(dockerignore, /client\/map\/ported/);

console.log("dockerBuildCache.test.js: ok");
