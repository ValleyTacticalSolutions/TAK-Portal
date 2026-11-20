/**
 * Proof for #130: non-admin Live Map must keep markers on the user's assigned channels.
 * Fails if member keys ignore bare Authentik CNs, or if scope filtering drops matching markers.
 */
const assert = require("assert");
const Module = require("module");

// jimpCompat expects jimp 1.x; stub so mapMeta can load without image deps in this proof test.
const origRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(id) {
  if (id === "jimp") {
    return {
      Jimp: class Jimp {},
      JimpMime: { png: "image/png" },
      loadFont: async () => null,
      HorizontalAlign: {},
      VerticalAlign: {},
    };
  }
  if (id === "jimp/fonts") {
    return { SANS_64_BLACK: "stub" };
  }
  return origRequire.apply(this, arguments);
};

const mapMeta = require("../services/mapMeta.service");

function markerChannelKeys(marker) {
  const groups =
    Array.isArray(marker?.groups) && marker.groups.length
      ? marker.groups
      : [mapMeta.UNASSIGNED_GROUP];
  const keys = new Set();
  for (const g of groups) {
    const channelName = mapMeta.toChannelGroupName(g) || g;
    const key = mapMeta.channelBaseKey(channelName);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function markerVisibleInScope(marker, scopeChannelKeys) {
  if (scopeChannelKeys == null) return true;
  if (scopeChannelKeys.size === 0) return false;
  const keys = markerChannelKeys(marker);
  if (!keys.length) return false;
  return keys.some((k) => scopeChannelKeys.has(k));
}

const markers = [
  {
    uid: "eud-main",
    groups: ["tak_HCSO Main"],
  },
  {
    uid: "eud-other",
    groups: ["tak_Other Agency Ops"],
  },
  {
    uid: "feed-unassigned",
    groups: [mapMeta.UNASSIGNED_GROUP],
  },
];

// Authentik may send bare CN or tak_* — both must resolve to the same base key.
const bareKeys = mapMeta.getUserMemberChannelBaseKeys(["HCSO Main"]);
const prefixedKeys = mapMeta.getUserMemberChannelBaseKeys(["tak_HCSO Main"]);
assert.ok(bareKeys.has("hcso main"), "bare CN becomes channel base key");
assert.ok(prefixedKeys.has("hcso main"), "tak_ group becomes channel base key");
assert.deepStrictEqual(
  Array.from(bareKeys).sort(),
  Array.from(prefixedKeys).sort(),
  "bare CN and tak_ membership keys must match"
);

const scopedKeys = mapMeta.resolveAllowedChannelKeysForUser(
  { isGlobalAdmin: false, groups: ["tak_HCSO Main"] },
  ["tak_HCSO Main"],
  true
);
assert.ok(scopedKeys instanceof Set);
assert.ok(scopedKeys.has("hcso main"));
assert.strictEqual(
  mapMeta.resolveAllowedChannelKeysForUser(
    { isGlobalAdmin: true, groups: [] },
    [],
    false
  ),
  null,
  "global admin stays unscoped"
);

const visible = markers.filter((m) => markerVisibleInScope(m, scopedKeys));
assert.strictEqual(visible.length, 1, "only membership channel markers remain");
assert.strictEqual(visible[0].uid, "eud-main");
assert.ok(
  markerChannelKeys(markers[0]).includes("hcso main"),
  "scoped marker channel key matches membership key"
);

assert.strictEqual(markerVisibleInScope(markers[0], scopedKeys), true);
assert.strictEqual(markerVisibleInScope(markers[1], scopedKeys), false);
assert.strictEqual(
  markerVisibleInScope(markers[2], scopedKeys),
  false,
  "Unassigned markers are hidden under member scope"
);

// Empty membership must hide everything (not fall open).
const emptyScope = mapMeta.resolveAllowedChannelKeysForUser(
  { isGlobalAdmin: false, groups: ["some-AgencyAdmin"] },
  ["some-AgencyAdmin"],
  true
);
assert.ok(emptyScope instanceof Set);
assert.strictEqual(emptyScope.size, 0);
assert.strictEqual(
  markers.filter((m) => markerVisibleInScope(m, emptyScope)).length,
  0,
  "member with no channel groups sees no live markers"
);

// LDAP DN group names still normalize to the same base key as Authentik membership.
assert.strictEqual(
  mapMeta.channelBaseKey("cn=tak_HCSO Main,ou=groups,dc=example"),
  "hcso main"
);
assert.strictEqual(mapMeta.channelBaseKey("tak_HCSO Main"), "hcso main");

console.log("mapChannelScope.test.js: ok");
