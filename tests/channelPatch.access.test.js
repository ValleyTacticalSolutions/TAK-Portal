"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const registry = require("../services/permissions.registry");
const access = require("../services/channelPatchAccess.service");
const store = require("../services/channelPatch.store");

assert.ok(
  registry.getDefaultSetForRole("agency_admin").has("page.channel_patch"),
  "agency admins get channel patch by default"
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/channel-patch", "GET"),
  ["page.channel_patch"]
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/channel-patch", "POST"),
  ["page.channel_patch"]
);

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(
  /\/api\/channel-patch[\s\S]{0,180}requirePermission\("page\.channel_patch"\)/.test(
    serverSrc
  ),
  "channel-patch API is permission-gated, not global-admin-only"
);
assert.ok(
  /\/channel-patch", requirePermission\("page\.channel_patch"\)/.test(serverSrc),
  "channel-patch page is permission-gated, not global-admin-only"
);

const agencyAccess = { isGlobalAdmin: false, isAgencyAdmin: true };
const globalAccess = { isGlobalAdmin: true };
const allowed = new Set(["alpha ops", "alpha tac"]);

const patches = [
  { id: "1", name: "Agency only", groups: ["tak_Alpha Ops", "tak_Alpha Tac"] },
  { id: "2", name: "Mixed", groups: ["tak_Alpha Ops", "tak_Other Law"] },
  { id: "3", name: "Out of scope", groups: ["tak_Other Law", "tak_Other State"] },
  { id: "4", name: "Empty", groups: [] },
];

const visible = access.filterPatchesForAccess(agencyAccess, patches, allowed);
assert.deepStrictEqual(
  visible.map((p) => p.id),
  ["1"],
  "agency admins only see patches fully inside their allowlist"
);

const all = access.filterPatchesForAccess(globalAccess, patches, allowed);
assert.strictEqual(all.length, patches.length, "global admins see every patch");

assert.deepStrictEqual(
  access.filterPatchesForAccess(agencyAccess, patches, new Set()).map((p) => p.id),
  [],
  "empty allowlist hides every patch"
);

assert.doesNotThrow(() =>
  access.assertGroupsInScope(agencyAccess, ["tak_Alpha Ops", "Alpha Tac"], allowed)
);
assert.throws(
  () => access.assertGroupsInScope(agencyAccess, ["tak_Alpha Ops", "Other Law"], allowed),
  (err) => err && err.status === 403
);
assert.doesNotThrow(() =>
  access.assertGroupsInScope(globalAccess, ["Other Law", "Other State"], allowed)
);

const keys = access.patchGroupKeys({
  groups: ["tak_Alpha Ops_READ", "Alpha Tac"],
});
assert.ok(keys.has("alpha ops"));
assert.ok(keys.has("alpha tac"));

const uniKeys = access.patchGroupKeys({
  mode: "unidirectional",
  leftGroups: ["tak_Alpha Ops"],
  rightGroups: ["tak_Alpha Tac"],
  groups: [],
});
assert.ok(uniKeys.has("alpha ops"), "uni leftGroups count toward scope keys");
assert.ok(uniKeys.has("alpha tac"), "uni rightGroups count toward scope keys");

const picker = access.allowedKeySetFromPicker({
  allowedChannelKeys: ["alpha ops", "alpha tac"],
});
assert.ok(picker instanceof Set);
assert.ok(picker.has("alpha ops"));
assert.strictEqual(access.allowedKeySetFromPicker({ allowedChannelKeys: null }), null);

const merged = access.mergeCreatedMutualAidPickerChannels(
  [{ name: "tak_Alpha Ops", displayName: "Alpha Ops", baseKey: "alpha ops", count: 2 }],
  ["tak_MA - Shared", "MA - Shared", "tak_Alpha Ops"]
);
assert.strictEqual(
  merged.filter((c) => c.baseKey === "ma - shared").length,
  1,
  "global picker adds unique MA-created channels"
);
assert.strictEqual(merged.length, 2, "existing channels are not duplicated");
assert.strictEqual(merged.find((c) => c.baseKey === "ma - shared").displayName, "MA - Shared");
assert.strictEqual(merged.find((c) => c.baseKey === "ma - shared").name, "tak_MA - Shared");

const agencyOnly = access.mergeCreatedMutualAidPickerChannels(
  [{ name: "tak_Alpha Ops", displayName: "Alpha Ops", baseKey: "alpha ops" }],
  []
);
assert.strictEqual(agencyOnly.length, 1, "agency picker does not receive MA names");

const annotated = store.annotateGroupsWithPatchPeers(
  [{ name: "tak_Alpha Ops" }, { name: "tak_Other Law" }],
  [{ enabled: true, groups: ["tak_Alpha Ops", "tak_Alpha Tac"] }]
);
assert.deepStrictEqual(annotated[0].patchedWith, ["Alpha Tac"]);
assert.strictEqual(annotated[1].patchedWith, undefined);

(async () => {
  const dataSyncAccess = require("../services/dataSyncAccess.service");
  const originalResolve = dataSyncAccess.resolveGroupsForUser;
  dataSyncAccess.resolveGroupsForUser = async () => ({
    groups: ["Alpha Main", "Beta Ops", "Beta Ops_WRITE", "Beta Ops_READ"],
    debug: { sourceOfTruth: "authentik" },
  });
  try {
    const picker = await access.buildScopedChannelPicker(
      { isGlobalAdmin: true },
      [
        {
          baseKey: "alpha main",
          name: "tak_ALPHA Main",
          displayName: "ALPHA Main",
          count: 3,
        },
      ]
    );
    const alpha = picker.channels.find((c) => c.displayName === "Alpha Main");
    assert.ok(alpha, "Authentik channel must appear in picker");
    assert.strictEqual(alpha.displayName, "Alpha Main", "Authentik spelling must win over catalog");
    assert.strictEqual(alpha.name, "tak_Alpha Main");
    assert.strictEqual(alpha.count, 3, "catalog may still enrich live counts");
    assert.ok(
      !picker.channels.some((c) => c.displayName === "ALPHA Main"),
      "stale TAK/catalog spelling must not override Authentik"
    );

    const behaviorVariants = picker.channels.filter((c) => c.baseKey === "beta ops");
    assert.strictEqual(
      behaviorVariants.length,
      3,
      "plain / _READ / _WRITE must remain separate picker rows"
    );
    assert.ok(behaviorVariants.some((c) => c.displayName === "Beta Ops_WRITE"));
    assert.ok(behaviorVariants.some((c) => c.displayName === "Beta Ops_READ"));
    assert.ok(behaviorVariants.some((c) => c.displayName === "Beta Ops"));
    assert.strictEqual(
      picker.channels.find((c) => c.displayName === "Beta Ops_WRITE").name,
      "tak_Beta Ops_WRITE"
    );
  } finally {
    dataSyncAccess.resolveGroupsForUser = originalResolve;
  }

  console.log("channelPatch.access.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
