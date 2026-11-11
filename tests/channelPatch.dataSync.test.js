"use strict";

const assert = require("assert");
const channelPatchDataSync = require("../services/channelPatchDataSync.service");
const channelPatchStore = require("../services/channelPatch.store");

(function testPlanAdditions() {
  const patch = {
    id: "p1",
    enabled: true,
    mode: "bidirectional",
    groups: ["tak_Alpha Ops", "Beta Tac", "Gamma Main"],
  };
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops"],
    tool: "public",
    description: "",
    defaultRole: { type: "MISSION_SUBSCRIBER" },
    keywords: [],
  };
  const plan = channelPatchDataSync.planAdditionsForMission(mission, patch);
  assert.deepStrictEqual(plan.add.sort(), ["Beta Tac", "Gamma Main"]);
  assert.deepStrictEqual(plan.nextGroups.sort(), ["Alpha Ops", "Beta Tac", "Gamma Main"]);

  const already = channelPatchDataSync.planAdditionsForMission(
    { ...mission, groups: ["Alpha Ops", "Beta Tac", "Gamma Main"] },
    patch
  );
  assert.deepStrictEqual(already.add, []);
  assert.strictEqual(already.nextGroups.length, 3);

  const unrelated = channelPatchDataSync.planAdditionsForMission(
    { ...mission, groups: ["Other Channel"] },
    patch
  );
  assert.deepStrictEqual(unrelated.add, []);
})();

(function testPlanRemovalsKeepsOtherPatchPeers() {
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops", "Beta Tac", "Gamma Main"],
  };
  const otherEnabled = [
    {
      id: "p2",
      enabled: true,
      mode: "bidirectional",
      groups: ["Alpha Ops", "Gamma Main"],
    },
  ];
  const plan = channelPatchDataSync.planRemovalsForMission(
    mission,
    ["Beta Tac", "Gamma Main"],
    otherEnabled
  );
  assert.ok(plan.removed.includes("Beta Tac"));
  assert.ok(!plan.removed.includes("Gamma Main"), "still required by another patch");
  assert.deepStrictEqual(plan.nextGroups.sort(), ["Alpha Ops", "Gamma Main"]);
})();

(function testPlanRemovalsWithoutOtherPatches() {
  const mission = {
    name: "Ops Mission",
    groups: ["Alpha Ops", "Beta Tac"],
  };
  const plan = channelPatchDataSync.planRemovalsForMission(mission, ["Beta Tac"], []);
  assert.deepStrictEqual(plan.removed, ["Beta Tac"]);
  assert.deepStrictEqual(plan.nextGroups, ["Alpha Ops"]);
})();

(function testPatchedWithLabels() {
  const patches = [
    {
      id: "p1",
      enabled: true,
      mode: "bidirectional",
      groups: ["tak_Alpha Ops", "Beta Tac"],
    },
  ];
  const labels = channelPatchDataSync.patchedWithLabelsForMission(
    { groups: ["Alpha Ops"] },
    patches
  );
  assert.deepStrictEqual(labels, ["Beta Tac"]);

  const annotated = channelPatchDataSync.annotateMissionsWithPatchPeers(
    [
      { name: "Ops Mission", groups: ["Alpha Ops"] },
      { name: "Solo", groups: ["Other Channel"] },
    ],
    patches
  );
  assert.deepStrictEqual(annotated[0].patchedWith, ["Beta Tac"]);
  assert.strictEqual(annotated[1].patchedWith, undefined);
})();

(function testNormalizePersistsDataSyncApplied() {
  const patch = channelPatchStore.normalizePatch({
    id: "p-applied",
    name: "Applied",
    enabled: true,
    mode: "bidirectional",
    groups: ["Alpha Ops", "Beta Tac"],
    dataSyncApplied: {
      "Ops Mission": ["tak_Beta Tac", "Beta Tac"],
    },
  });
  assert.ok(patch);
  assert.deepStrictEqual(patch.dataSyncApplied["Ops Mission"], ["Beta Tac"]);
})();

(function testBuildMissionWriteBody() {
  const body = channelPatchDataSync.buildMissionWriteBody(
    {
      name: "Ops Mission",
      tool: "public",
      description: "desc",
      defaultRole: { type: "MISSION_OWNER" },
      keywords: ["datasync"],
      inviteOnly: false,
    },
    ["tak_Alpha Ops", "Beta Tac", "Alpha Ops"]
  );
  assert.strictEqual(body.name, "Ops Mission");
  assert.deepStrictEqual(body.groups, ["Alpha Ops", "Beta Tac"]);
  assert.strictEqual(body.defaultRole.type, "MISSION_OWNER");
  assert.deepStrictEqual(body.keywords, ["datasync"]);
})();

console.log("channelPatch.dataSync.test.js: ok");
