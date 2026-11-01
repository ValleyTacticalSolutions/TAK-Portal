const assert = require("assert");
const engine = require("../services/channelPatch.engine");
const store = require("../services/channelPatch.store");

assert.strictEqual(
  engine.toMartiGroupName("tak_CPD Main"),
  "CPD Main",
  "strips Authentik tak_ prefix for Marti dest"
);
assert.strictEqual(engine.toMartiGroupName("DAVIS Main"), "DAVIS Main");

const patch = {
  id: "p1",
  groups: ["tak_CPD Main", "tak_DAVIS Main", "tak_SPD Main"],
  enabled: true,
};

assert.deepStrictEqual(
  engine.destinationsForSource(patch, "cpd main").sort(),
  ["tak_DAVIS Main", "tak_SPD Main"].sort(),
  "source fans out to every other channel"
);
assert.deepStrictEqual(
  engine.destinationsForSource(patch, "davis main").sort(),
  ["tak_CPD Main", "tak_SPD Main"].sort(),
  "mesh is bidirectional"
);
assert.deepStrictEqual(
  engine.destinationsForSource(patch, "mutual aid"),
  [],
  "unrelated channel does not match patch"
);

// Legacy hub/spokes migrate to flat groups
const migrated = store.normalizePatch({
  id: "legacy-1",
  name: "Law Family Patch",
  enabled: true,
  hubGroup: "tak_CPD Main",
  spokes: [{ group: "tak_DAVIS Main", direction: "both" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
assert.ok(migrated);
assert.deepStrictEqual(
  migrated.groups.sort(),
  ["tak_CPD Main", "tak_DAVIS Main"].sort()
);
assert.strictEqual(migrated.mode, "bidirectional", "legacy rows default to bidirectional");
assert.strictEqual(migrated.hubGroup, undefined);
assert.strictEqual(migrated.spokes, undefined);

assert.strictEqual(
  store.normalizePatch({
    id: "bad",
    groups: ["tak_Only One"],
  }),
  null,
  "requires at least two channels"
);

// Unidirectional normalize + flow
const uniLtr = store.normalizePatch({
  id: "uni-1",
  name: "Ops → Tac",
  mode: "unidirectional",
  leftGroups: ["tak_CPD Main", "tak_DAVIS Main"],
  rightGroups: ["tak_SPD Main"],
  direction: "ltr",
});
assert.ok(uniLtr);
assert.strictEqual(uniLtr.mode, "unidirectional");
assert.strictEqual(uniLtr.direction, "ltr");
assert.deepStrictEqual(uniLtr.leftGroups, ["tak_CPD Main", "tak_DAVIS Main"]);
assert.deepStrictEqual(uniLtr.rightGroups, ["tak_SPD Main"]);
assert.deepStrictEqual(
  uniLtr.groups.sort(),
  ["tak_CPD Main", "tak_DAVIS Main", "tak_SPD Main"].sort(),
  "uni groups is union of both sides"
);

assert.strictEqual(
  store.normalizePatch({
    id: "uni-overlap",
    mode: "unidirectional",
    leftGroups: ["tak_CPD Main"],
    rightGroups: ["tak_CPD Main"],
  }),
  null,
  "uni rejects overlapping sides"
);
assert.strictEqual(
  store.normalizePatch({
    id: "uni-empty",
    mode: "unidirectional",
    leftGroups: ["tak_CPD Main"],
    rightGroups: [],
  }),
  null,
  "uni requires at least one channel on each side"
);

assert.deepStrictEqual(
  engine.destinationsForSource(uniLtr, "cpd main").sort(),
  ["tak_SPD Main"],
  "uni ltr: left source fans to right dests"
);
assert.deepStrictEqual(
  engine.destinationsForSource(uniLtr, "davis main").sort(),
  ["tak_SPD Main"],
  "uni ltr: every left source fans to right"
);
assert.deepStrictEqual(
  engine.destinationsForSource(uniLtr, "spd main"),
  [],
  "uni ltr: right side does not fan back"
);

const uniRtl = store.normalizePatch({
  id: "uni-2",
  name: "Ops ← Tac",
  mode: "unidirectional",
  leftGroups: ["tak_CPD Main"],
  rightGroups: ["tak_SPD Main", "tak_DAVIS Main"],
  direction: "rtl",
});
assert.ok(uniRtl);
assert.deepStrictEqual(
  engine.destinationsForSource(uniRtl, "spd main").sort(),
  ["tak_CPD Main"],
  "uni rtl: right source fans to left dests"
);
assert.deepStrictEqual(
  engine.destinationsForSource(uniRtl, "davis main").sort(),
  ["tak_CPD Main"],
  "uni rtl: every right source fans to left"
);
assert.deepStrictEqual(
  engine.destinationsForSource(uniRtl, "cpd main"),
  [],
  "uni rtl: left side does not fan back"
);

const uniPeers = store.peerLabelsByGroupKeyFromPatches([uniLtr]);
assert.deepStrictEqual(uniPeers.get("cpd main"), ["SPD Main"]);
assert.deepStrictEqual(uniPeers.get("spd main").sort(), ["CPD Main", "DAVIS Main"].sort());

assert.strictEqual(
  engine.patchedUid("ANDROID-abc", "tak_CPD Main", "HCSO-DAVIS-3598"),
  "HCSO-DAVIS-3598.takportal.cpd-main"
);

// Patched copies must keep callsign on <contact> (ATAK shows "NO CALLSIGN" otherwise)
// while dropping endpoint so the copy is not a routable ClientEndpoint advertise.
// Team (__group), takv, usericon, and color stay — dest clients should draw the same icon.
const detailWithEndpoint = {
  contact: {
    _attributes: {
      callsign: "HCSO-DAVIS-3598",
      endpoint: "192.168.1.10:4242:tcp",
    },
  },
  takv: { _attributes: { platform: "ATAK" } },
  __group: { _attributes: { name: "Cyan", role: "Team Member" } },
  usericon: { _attributes: { iconsetpath: "COT_MAPPING_2525C/a-f/a-f-G-U-C" } },
  color: { _attributes: { argb: "-1" } },
  remarks: { _text: "keep me" },
};
assert.strictEqual(
  engine.neutralizeAsInjectedCopy(detailWithEndpoint),
  "HCSO-DAVIS-3598"
);
assert.deepStrictEqual(detailWithEndpoint.contact, {
  _attributes: { callsign: "HCSO-DAVIS-3598" },
});
assert.deepStrictEqual(detailWithEndpoint.takv, {
  _attributes: { platform: "ATAK" },
});
assert.deepStrictEqual(detailWithEndpoint.__group, {
  _attributes: { name: "Cyan", role: "Team Member" },
});
assert.deepStrictEqual(detailWithEndpoint.usericon, {
  _attributes: { iconsetpath: "COT_MAPPING_2525C/a-f/a-f-G-U-C" },
});
assert.deepStrictEqual(detailWithEndpoint.color, { _attributes: { argb: "-1" } });
assert.deepStrictEqual(detailWithEndpoint.remarks, { _text: "keep me" });

assert.strictEqual(
  engine.neutralizeAsInjectedCopy({}, "MARKER-CS"),
  "MARKER-CS",
  "falls back to marker callsign when contact is missing"
);

assert.strictEqual(store.groupMatchKey("tak_CPD Main"), "cpd main");
assert.strictEqual(store.groupDisplayLabel("tak_CPD Main"), "CPD Main");

const peerIndex = store.peerLabelsByGroupKeyFromPatches([
  {
    enabled: true,
    groups: ["tak_CPD Main", "tak_DAVIS Main", "tak_SPD Main"],
  },
  {
    enabled: false,
    groups: ["tak_CPD Main", "tak_Unused"],
  },
]);
assert.deepStrictEqual(peerIndex.get("cpd main"), ["DAVIS Main", "SPD Main"]);
assert.deepStrictEqual(peerIndex.get("davis main"), ["CPD Main", "SPD Main"]);
assert.strictEqual(peerIndex.get("unused"), undefined);

const mixedPrefix = store.peerLabelsByGroupKeyFromPatches([
  { enabled: true, groups: ["CPD Main", "tak_DAVIS Main"] },
]);
assert.deepStrictEqual(
  mixedPrefix.get("cpd main"),
  ["DAVIS Main"],
  "matches groups with or without tak_ prefix"
);

console.log("channelPatch.engine.test.js OK");
