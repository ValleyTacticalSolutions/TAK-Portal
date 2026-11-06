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
  engine.patchedUid("ANDROID-abc", "HCSO-DAVIS-3598"),
  "HCSO-DAVIS-3598.takportal.ANDROID-abc"
);
assert.notStrictEqual(
  engine.patchedUid("ANDROID-abc", "HCSO-DAVIS-3598"),
  engine.patchedUid("ANDROID-def", "HCSO-DAVIS-3598"),
  "same callsign on two devices stays two contacts"
);
assert.strictEqual(
  engine.patchedUid("ANDROID-3a1bc5b11e5c213e", "TN_HalavaA.a9+.a"),
  "TN_HalavaA.a9-.a.takportal.ANDROID-3a1bc5b11e5c213e"
);
assert.ok(
  engine.patchedUid("ANDROID-abc", "HCSO-DAVIS-3598").includes(".takportal."),
  "clone UID stays excluded from connected-user metrics"
);

// One source event fans out to many channels as a single clone.
const fanoutDetail = {
  contact: {
    _attributes: {
      callsign: "TN_HalavaA.a9+.a",
      endpoint: "192.168.1.10:4242:tcp",
    },
  },
  __group: { _attributes: { name: "Cyan", role: "Team Member" } },
  usericon: { _attributes: { iconsetpath: "COT_MAPPING_2525C/a-f/a-f-G-U-C" } },
};
const fanout = engine.applyPatchIdentity(fanoutDetail, {
  srcUid: "ANDROID-3a1bc5b11e5c213e",
  destGroups: [
    "tak_TBI Alpha",
    "tak_Aircraft Known",
    "tak_CBCOEMHS PSMA 1",
    "tak_TBI Alpha",
  ],
  patchId: "56c6be39-aaaa|other-patch",
  fromGroup: "tn mutual aid",
});
assert.strictEqual(
  fanout.uid,
  "TN_HalavaA.a9-.a.takportal.ANDROID-3a1bc5b11e5c213e"
);
assert.deepStrictEqual(fanout.martiGroups, [
  "TBI Alpha",
  "Aircraft Known",
  "CBCOEMHS PSMA 1",
]);
assert.strictEqual(fanoutDetail.contact._attributes.endpoint, undefined);
assert.strictEqual(fanoutDetail.contact._attributes.callsign, "TN_HalavaA.a9+.a");
assert.deepStrictEqual(fanoutDetail.__group, {
  _attributes: { name: "Cyan", role: "Team Member" },
});
assert.deepStrictEqual(
  fanoutDetail.marti.dest.map((d) => d._attributes.group),
  fanout.martiGroups
);
assert.deepStrictEqual(
  fanoutDetail.filtergroup.map((g) => g._attributes.group),
  fanout.martiGroups
);
assert.strictEqual(
  fanoutDetail.__takportal_patch._attributes.srcUid,
  "ANDROID-3a1bc5b11e5c213e"
);
assert.ok(
  fanoutDetail.__takportal_patch._attributes.to.includes("tak_TBI Alpha")
);
assert.ok(
  fanoutDetail.__takportal_patch._attributes.to.includes("tak_Aircraft Known")
);
assert.ok(
  !fanout.uid.includes("tbi-alpha"),
  "destination channel is not part of the clone UID"
);

const otherChannel = {
  contact: { _attributes: { callsign: "TN_HalavaA.a9+.a" } },
};
const sameDevice = engine.applyPatchIdentity(otherChannel, {
  srcUid: "ANDROID-3a1bc5b11e5c213e",
  destGroups: ["tak_TN Mutual Aid"],
  patchId: "p2",
  fromGroup: "source",
});
assert.strictEqual(
  sameDevice.uid,
  fanout.uid,
  "another patched channel reuses the same clone UID"
);
assert.deepStrictEqual(otherChannel.filtergroup, {
  _attributes: { group: "TN Mutual Aid" },
});

const longUid = `ANDROID-${"a".repeat(80)}`;
const longClone = engine.patchedUid(longUid, "CALLSIGN");
assert.ok(longClone.length <= 128, "clone UID stays inside the CoT uid limit");
assert.notStrictEqual(
  longClone,
  engine.patchedUid(`${longUid}-other`, "CALLSIGN"),
  "long source UIDs do not collapse onto one clone"
);
assert.ok(longClone.includes(".takportal."));

assert.throws(
  () =>
    engine.applyPatchIdentity(
      { contact: { _attributes: { callsign: "X" } } },
      { srcUid: "ANDROID-abc", destGroups: [] }
    ),
  /Empty Marti dest group/,
  "a copy with no dest must not be written on the webadmin stream"
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
