/**
 * Keep Data Sync mission group lists aligned with channel patches.
 *
 * When an enabled patch links channels, any mission that already includes one
 * of those channels also receives the other patch channels. Disable/delete
 * reverses only the groups this patch added (unless another enabled patch
 * still requires them).
 */

const dataSyncSvc = require("./dataSync.service");
const dataSyncAccess = require("./dataSyncAccess.service");
const groupsSvc = require("./groups.service");
const channelPatchStore = require("./channelPatch.store");
const { isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");

function matchKey(name) {
  return channelPatchStore.groupMatchKey(name);
}

function toTakCn(name) {
  return groupsSvc.stripTakPrefix(String(name || "").trim());
}

function unwrapMissionList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function missionNameOf(mission) {
  return String(mission?.name || mission?.missionName || "").trim();
}

function uniqueCns(names) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const cn = toTakCn(raw);
    if (!cn) continue;
    const key = matchKey(cn);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cn);
  }
  return out;
}

function patchGroupKeys(patch) {
  const keys = new Set();
  for (const g of Array.isArray(patch?.groups) ? patch.groups : []) {
    const k = matchKey(g);
    if (k) keys.add(k);
  }
  return keys;
}

function patchGroupCnByKey(patch) {
  const byKey = new Map();
  for (const g of Array.isArray(patch?.groups) ? patch.groups : []) {
    const cn = toTakCn(g);
    const key = matchKey(cn);
    if (!key || !cn) continue;
    if (!byKey.has(key)) byKey.set(key, cn);
  }
  return byKey;
}

function intersects(aKeys, bKeys) {
  for (const k of aKeys) {
    if (bKeys.has(k)) return true;
  }
  return false;
}

function normalizeAppliedMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [missionName, groups] of Object.entries(raw)) {
    const name = String(missionName || "").trim();
    if (!name) continue;
    const list = uniqueCns(groups);
    if (list.length) out[name] = list;
  }
  return out;
}

function buildMissionWriteBody(mission, groups) {
  const m = mission && typeof mission === "object" ? mission : {};
  const defaultRole =
    m.defaultRole && typeof m.defaultRole === "object"
      ? m.defaultRole
      : { type: "MISSION_SUBSCRIBER", permissions: ["MISSION_WRITE", "MISSION_READ"] };
  return {
    name: missionNameOf(m),
    tool: String(m.tool || "public").trim() || "public",
    description: m.description != null ? String(m.description) : "",
    defaultRole,
    groups: uniqueCns(groups),
    keywords: Array.isArray(m.keywords) ? m.keywords : [],
    inviteOnly: m.inviteOnly === true,
  };
}

function groupsStillRequiredKeys(homeKeys, enabledPatches) {
  const required = new Set();
  for (const patch of Array.isArray(enabledPatches) ? enabledPatches : []) {
    const pKeys = patchGroupKeys(patch);
    if (!intersects(homeKeys, pKeys)) continue;
    for (const k of pKeys) required.add(k);
  }
  return required;
}

/**
 * Peer display labels for a mission from enabled patches (Groups-style).
 * @returns {string[]}
 */
function patchedWithLabelsForMission(mission, patches) {
  const names = dataSyncAccess.extractMissionGroupNames(mission);
  if (!names.length) return [];
  const asGroups = names.map((name) => ({ name }));
  const annotated = channelPatchStore.annotateGroupsWithPatchPeers(asGroups, patches);
  const byKey = new Map();
  for (const g of annotated) {
    for (const label of Array.isArray(g?.patchedWith) ? g.patchedWith : []) {
      const key = matchKey(label);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, String(label).trim());
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function annotateMissionsWithPatchPeers(missions, patches) {
  const list = Array.isArray(missions) ? missions : [];
  const patchList = Array.isArray(patches) ? patches : channelPatchStore.listEnabled();
  return list.map((m) => {
    const patchedWith = patchedWithLabelsForMission(m, patchList);
    if (!patchedWith.length) return m;
    return Object.assign({}, m, { patchedWith });
  });
}

function annotateMissionsPayloadWithPatchPeers(payload, patches) {
  const patchList = Array.isArray(patches) ? patches : channelPatchStore.listEnabled();
  if (Array.isArray(payload)) {
    return annotateMissionsWithPatchPeers(payload, patchList);
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) {
      return {
        ...payload,
        data: annotateMissionsWithPatchPeers(payload.data, patchList),
      };
    }
    if (Array.isArray(payload.missions)) {
      return {
        ...payload,
        missions: annotateMissionsWithPatchPeers(payload.missions, patchList),
      };
    }
  }
  return payload;
}

async function listAllMissionsSafe() {
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) {
    return [];
  }
  try {
    const raw = await dataSyncSvc.listMissions({});
    return unwrapMissionList(raw);
  } catch (err) {
    console.warn(
      "[channelPatchDataSync] Failed to list missions:",
      err?.message || err
    );
    return [];
  }
}

async function setMissionGroups(mission, nextGroups) {
  const name = missionNameOf(mission);
  if (!name) return;
  const body = buildMissionWriteBody(mission, nextGroups);
  if (!body.groups.length) {
    console.warn(
      "[channelPatchDataSync] Refusing to clear all groups on mission:",
      name
    );
    return;
  }
  await dataSyncSvc.changeMission(name, body);
}

/**
 * Pure helper: which CNs should be added to a mission for this patch.
 */
function planAdditionsForMission(mission, patch) {
  const current = dataSyncAccess.extractMissionGroupNames(mission);
  const currentKeys = new Set(current.map(matchKey).filter(Boolean));
  const patchKeys = patchGroupKeys(patch);
  if (!intersects(currentKeys, patchKeys)) {
    return { add: [], nextGroups: uniqueCns(current) };
  }
  const byKey = patchGroupCnByKey(patch);
  const add = [];
  for (const [key, cn] of byKey) {
    if (!currentKeys.has(key)) add.push(cn);
  }
  return { add, nextGroups: uniqueCns([...current, ...add]) };
}

/**
 * Pure helper: remove this patch's prior additions unless still required.
 */
function planRemovalsForMission(mission, addedCns, otherEnabledPatches) {
  const current = dataSyncAccess.extractMissionGroupNames(mission);
  const addedKeys = new Set(uniqueCns(addedCns).map(matchKey).filter(Boolean));
  if (!addedKeys.size) {
    return { nextGroups: uniqueCns(current), removed: [] };
  }
  const home = [];
  for (const n of current) {
    const k = matchKey(n);
    if (!k || addedKeys.has(k)) continue;
    home.push(n);
  }
  const homeKeys = new Set(home.map(matchKey).filter(Boolean));
  const stillRequired = groupsStillRequiredKeys(homeKeys, otherEnabledPatches);
  const removed = [];
  const keep = [];
  for (const n of current) {
    const k = matchKey(n);
    if (addedKeys.has(k) && !stillRequired.has(k)) {
      removed.push(toTakCn(n));
      continue;
    }
    keep.push(n);
  }
  const nextGroups = uniqueCns(keep.length ? keep : home);
  return { nextGroups, removed };
}

async function applyPatchToDataSyncs(patch) {
  if (!patch || patch.enabled === false) {
    return { applied: {}, changed: [] };
  }
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) {
    return { applied: normalizeAppliedMap(patch.dataSyncApplied), changed: [] };
  }

  const missions = await listAllMissionsSafe();
  const applied = {};
  const changed = [];

  for (const mission of missions) {
    const name = missionNameOf(mission);
    if (!name) continue;
    const plan = planAdditionsForMission(mission, patch);
    if (!plan.add.length) continue;
    try {
      await setMissionGroups(mission, plan.nextGroups);
      applied[name] = plan.add.slice();
      changed.push(name);
    } catch (err) {
      console.warn(
        `[channelPatchDataSync] Failed to add patch channels to mission ${name}:`,
        err?.message || err
      );
    }
  }

  return { applied, changed };
}

async function unapplyPatchFromDataSyncs(patch) {
  const prior = normalizeAppliedMap(patch?.dataSyncApplied);
  if (!Object.keys(prior).length) {
    return { applied: {}, changed: [] };
  }
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) {
    return { applied: {}, changed: [] };
  }

  const otherEnabled = channelPatchStore
    .listEnabled()
    .filter((p) => p && p.id && patch && p.id !== patch.id);

  const changed = [];
  for (const [name, added] of Object.entries(prior)) {
    let mission = null;
    try {
      const raw = await dataSyncSvc.getMission(name);
      mission = dataSyncAccess.unwrapMission(raw);
    } catch (err) {
      console.warn(
        `[channelPatchDataSync] Mission ${name} missing during unapply:`,
        err?.message || err
      );
      continue;
    }
    if (!mission) continue;
    const plan = planRemovalsForMission(mission, added, otherEnabled);
    if (!plan.removed.length) continue;
    try {
      await setMissionGroups(mission, plan.nextGroups);
      changed.push(name);
    } catch (err) {
      console.warn(
        `[channelPatchDataSync] Failed to remove patch channels from mission ${name}:`,
        err?.message || err
      );
    }
  }

  return { applied: {}, changed };
}

/**
 * Sync Data Sync missions after a patch create/update/delete.
 * Best-effort: patch persistence already succeeded; TAK errors are logged.
 *
 * @param {{ before?: object|null, after?: object|null }} change
 *   before = prior row (null on create); after = new row (null on delete)
 */
async function syncDataSyncsForPatchChange({ before = null, after = null } = {}) {
  const result = {
    unapplied: [],
    applied: [],
    dataSyncApplied: {},
  };

  try {
    if (before && before.enabled !== false) {
      const out = await unapplyPatchFromDataSyncs(before);
      result.unapplied = out.changed;
    }

    if (after && after.enabled !== false) {
      const out = await applyPatchToDataSyncs(after);
      result.applied = out.changed;
      result.dataSyncApplied = out.applied;
      if (after.id) {
        try {
          channelPatchStore.update(after.id, {
            dataSyncApplied: out.applied,
          });
        } catch (err) {
          console.warn(
            "[channelPatchDataSync] Failed to persist dataSyncApplied:",
            err?.message || err
          );
        }
      }
    } else if (before && before.id && after && after.enabled === false) {
      try {
        channelPatchStore.update(after.id, { dataSyncApplied: {} });
      } catch (_) {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn(
      "[channelPatchDataSync] syncDataSyncsForPatchChange failed:",
      err?.message || err
    );
  }

  return result;
}

module.exports = {
  matchKey,
  toTakCn,
  normalizeAppliedMap,
  planAdditionsForMission,
  planRemovalsForMission,
  patchedWithLabelsForMission,
  annotateMissionsWithPatchPeers,
  annotateMissionsPayloadWithPatchPeers,
  applyPatchToDataSyncs,
  unapplyPatchFromDataSyncs,
  syncDataSyncsForPatchChange,
  buildMissionWriteBody,
  groupsStillRequiredKeys,
};
