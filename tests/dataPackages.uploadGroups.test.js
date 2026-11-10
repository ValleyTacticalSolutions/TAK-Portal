/**
 * Proof: data package upload must pass Marti `Groups` query params so TAK does
 * not assign every group from the uploading certificate.
 */
const assert = require("assert");
const dataPackagesSvc = require("../services/dataPackages.service");

const {
  buildMissionUploadParams,
  normalizeGroupsList,
  groupsMetadataValue,
  metadataStringPutConfig,
} = dataPackagesSvc;

assert.deepStrictEqual(normalizeGroupsList([" FL Interop ", "", "DAVIS Main"]), [
  "FL Interop",
  "DAVIS Main",
]);
assert.deepStrictEqual(normalizeGroupsList('["FL Interop","DAVIS Main"]'), [
  "FL Interop",
  "DAVIS Main",
]);
assert.strictEqual(groupsMetadataValue(["FL Interop", "DAVIS Main"]), "FL Interop,DAVIS Main");

const params = buildMissionUploadParams({
  hash: "abc123",
  filename: "TDOT Cameras - Chattanooga",
  creatorUid: "admin",
  groups: ["FL Interop", "DAVIS Main"],
  keywords: ["missionpackage", "alpha"],
  mimetype: "application/zip",
});

assert.ok(params instanceof URLSearchParams, "missionupload params should be URLSearchParams");
assert.strictEqual(params.get("hash"), "abc123");
assert.strictEqual(params.get("filename"), "TDOT Cameras - Chattanooga");
assert.strictEqual(params.get("creatorUid"), "admin");
assert.strictEqual(params.get("mimetype"), "application/zip");

const keywords = params.getAll("keyword");
assert.deepStrictEqual(keywords, ["missionpackage", "alpha"]);

const groups = params.getAll("Groups");
assert.deepStrictEqual(
  groups,
  ["FL Interop", "DAVIS Main"],
  "Groups must be repeated query params (capital G)"
);
assert.strictEqual(params.getAll("groups").length, 0, "must not use lowercase groups");

const qs = params.toString();
assert.ok(
  qs.includes("Groups=FL+Interop") || qs.includes("Groups=FL%20Interop"),
  "query string must include Groups=FL Interop"
);
assert.ok(qs.includes("Groups=DAVIS+Main") || qs.includes("Groups=DAVIS%20Main"));

// Without selected groups, still add missionpackage keyword and omit Groups.
const bare = buildMissionUploadParams({
  hash: "deadbeef",
  filename: "pack.zip",
  creatorUid: "",
});
assert.strictEqual(bare.get("creatorUid"), "tak-portal");
assert.deepStrictEqual(bare.getAll("keyword"), ["missionpackage"]);
assert.strictEqual(bare.getAll("Groups").length, 0);

const putCfg = metadataStringPutConfig();
assert.strictEqual(putCfg.headers["Content-Type"], "application/json");
assert.strictEqual(
  putCfg.transformRequest[0]("FL Interop"),
  '"FL Interop"',
  "string metadata body must be JSON-encoded"
);

const uploadSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../services/dataPackages.service.js"),
  "utf8"
);
assert.ok(
  uploadSrc.includes("buildMissionUploadParams"),
  "uploadDataPackage must build missionupload params via helper"
);
assert.ok(
  uploadSrc.includes('params.append("Groups", group)'),
  "upload must append case-sensitive Groups params"
);

const routeSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../routes/dataPackages.routes.js"),
  "utf8"
);
assert.ok(
  /uploadDataPackage\([\s\S]*groups/.test(routeSrc),
  "upload route must pass selected groups into uploadDataPackage"
);
assert.ok(
  !/metaPatch\.groups\s*=/.test(routeSrc),
  "upload route must not rely on post-upload groups metadata PATCH"
);

console.log("dataPackages.uploadGroups.test.js: ok");
