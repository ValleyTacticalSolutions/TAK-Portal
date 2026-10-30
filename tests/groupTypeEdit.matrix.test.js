"use strict";

const assert = require("assert");
const {
  applyGroupEditAttributes,
  buildGroupNameFromParts,
  deriveGroupTypePayload,
  resolveEditPrivate,
  normalizeServerGroupType,
} = require("../services/groupTypeEdit.util");

const agencies = [
  { name: "Hamilton County Sheriff", groupPrefix: "HCSO", suffix: "hcso" },
  { name: "Butler County Sheriff", groupPrefix: "BCSO", suffix: "bcso" },
];

const TYPES = ["agency", "county", "region", "state", "generic"];

function attrsFor(uiType, detail, priv = "no") {
  const groupType = normalizeServerGroupType(uiType === "generic" ? "Global" : uiType);
  return {
    created_type: groupType,
    created_type_detail: groupType === "Global" ? "" : detail,
    private: priv,
    description: "seed",
  };
}

function editOpts(uiType, parts) {
  const { groupType, groupTypeDetail } = deriveGroupTypePayload(uiType, {
    ...parts,
    agencies,
  });
  const privateFlag = resolveEditPrivate({
    isGlobalAdmin: true,
    targetUiType: uiType,
    originalUiType: "agency",
    selectedPrivate: "no",
    currentPrivate: "yes",
  });
  const opts = {
    groupType,
    groupTypeDetail,
    description: "seed",
  };
  if (privateFlag != null) opts.private = privateFlag;
  return { opts, groupType, groupTypeDetail, name: buildGroupNameFromParts({ type: uiType, baseName: "Ops", behavior: "both", ...parts }) };
}

// --- Name builders for every UI type ---
assert.strictEqual(
  buildGroupNameFromParts({ type: "agency", baseName: "Ops", behavior: "both", prefix: "HCSO" }),
  "tak_HCSO Ops"
);
assert.strictEqual(
  buildGroupNameFromParts({ type: "agency", baseName: "Ops", behavior: "read", prefix: "HCSO" }),
  "tak_HCSO Ops_READ"
);
assert.strictEqual(
  buildGroupNameFromParts({ type: "county", baseName: "Ops", behavior: "both", county: "Hamilton" }),
  "tak_Hamilton Co Ops"
);
assert.strictEqual(
  buildGroupNameFromParts({ type: "region", baseName: "Ops", behavior: "write", region: "Southwest" }),
  "tak_Southwest Ops_WRITE"
);
assert.strictEqual(
  buildGroupNameFromParts({ type: "state", baseName: "Ops", behavior: "both", state: "oh" }),
  "tak_OH Ops"
);
assert.strictEqual(
  buildGroupNameFromParts({ type: "generic", baseName: "Ops", behavior: "both" }),
  "tak_Ops"
);

// --- derive payloads ---
assert.deepStrictEqual(
  deriveGroupTypePayload("agency", { prefix: "HCSO", agencies }),
  { groupType: "Agency", groupTypeDetail: "Hamilton County Sheriff" }
);
assert.deepStrictEqual(
  deriveGroupTypePayload("county", { county: "Hamilton" }),
  { groupType: "County", groupTypeDetail: "Hamilton" }
);
assert.deepStrictEqual(
  deriveGroupTypePayload("region", { region: "Southwest" }),
  { groupType: "Region", groupTypeDetail: "Southwest" }
);
assert.deepStrictEqual(
  deriveGroupTypePayload("state", { state: "oh" }),
  { groupType: "State", groupTypeDetail: "OH" }
);
assert.deepStrictEqual(
  deriveGroupTypePayload("generic", {}),
  { groupType: "Global", groupTypeDetail: null }
);

// --- Full conversion matrix: every from → to ---
const seeds = {
  agency: attrsFor("agency", "Hamilton County Sheriff", "yes"),
  county: attrsFor("county", "Hamilton", "no"),
  region: attrsFor("region", "Southwest", "no"),
  state: attrsFor("state", "OH", "no"),
  generic: attrsFor("generic", "", "no"),
};

const targets = {
  agency: { prefix: "BCSO" },
  county: { county: "Butler" },
  region: { region: "Northeast" },
  state: { state: "IN" },
  generic: {},
};

for (const from of TYPES) {
  for (const to of TYPES) {
    const before = seeds[from];
    const { opts, groupType, groupTypeDetail, name } = editOpts(to, targets[to]);
    assert.ok(name.startsWith("tak_"), `${from}→${to} name ${name}`);

    const after = applyGroupEditAttributes(before, {
      ...opts,
      // Always pass detail (null/empty) like the PATCH route does when type is set
      groupTypeDetail: groupType === "Global" ? null : groupTypeDetail,
      private:
        groupType === "Agency"
          ? resolveEditPrivate({
              isGlobalAdmin: true,
              targetUiType: to,
              originalUiType: from,
              selectedPrivate: to === "agency" ? "yes" : "no",
              currentPrivate: before.private,
            })
          : "no",
    });

    assert.strictEqual(
      after.created_type,
      groupType,
      `${from}→${to}: created_type`
    );

    if (groupType === "Global") {
      assert.strictEqual(after.created_type_detail, "", `${from}→${to}: detail cleared`);
      assert.strictEqual(after.private, "no", `${from}→${to}: private cleared for Global`);
    } else {
      assert.strictEqual(
        after.created_type_detail,
        groupTypeDetail,
        `${from}→${to}: detail`
      );
      // Previous scoped detail must not linger when switching scoped types
      if (from !== to && before.created_type_detail && before.created_type_detail !== groupTypeDetail) {
        assert.notStrictEqual(
          after.created_type_detail,
          before.created_type_detail,
          `${from}→${to}: old detail replaced`
        );
      }
    }

    if (groupType !== "Agency") {
      assert.strictEqual(after.private, "no", `${from}→${to}: non-agency private=no`);
    }
  }
}

// Agency→Agency (detail change) keeps ability to set private=yes
{
  const after = applyGroupEditAttributes(seeds.agency, {
    groupType: "Agency",
    groupTypeDetail: "Butler County Sheriff",
    private: "yes",
  });
  assert.strictEqual(after.created_type, "Agency");
  assert.strictEqual(after.created_type_detail, "Butler County Sheriff");
  assert.strictEqual(after.private, "yes");
}

// Agency (private=yes) → County clears private and swaps detail
{
  const after = applyGroupEditAttributes(seeds.agency, {
    groupType: "County",
    groupTypeDetail: "Butler",
    private: "no",
  });
  assert.strictEqual(after.created_type, "County");
  assert.strictEqual(after.created_type_detail, "Butler");
  assert.strictEqual(after.private, "no");
}

// Global → Agency can set private
{
  const after = applyGroupEditAttributes(seeds.generic, {
    groupType: "Agency",
    groupTypeDetail: "Hamilton County Sheriff",
    private: "yes",
  });
  assert.strictEqual(after.created_type, "Agency");
  assert.strictEqual(after.created_type_detail, "Hamilton County Sheriff");
  assert.strictEqual(after.private, "yes");
}

// Type update without explicit private still clears private for non-agency
{
  const after = applyGroupEditAttributes(seeds.agency, {
    groupType: "Region",
    groupTypeDetail: "Southwest",
  });
  assert.strictEqual(after.private, "no");
  assert.strictEqual(after.created_type_detail, "Southwest");
}

// resolveEditPrivate matrix
assert.strictEqual(
  resolveEditPrivate({
    isGlobalAdmin: true,
    targetUiType: "agency",
    originalUiType: "generic",
    selectedPrivate: "yes",
    currentPrivate: "no",
  }),
  "yes"
);
assert.strictEqual(
  resolveEditPrivate({
    isGlobalAdmin: true,
    targetUiType: "county",
    originalUiType: "agency",
    selectedPrivate: "yes",
    currentPrivate: "yes",
  }),
  "no"
);
assert.strictEqual(
  resolveEditPrivate({
    isGlobalAdmin: false,
    targetUiType: "agency",
    originalUiType: "agency",
    selectedPrivate: "yes",
    currentPrivate: "no",
  }),
  null
);

console.log("groupTypeEdit.matrix.test.js: ok");
