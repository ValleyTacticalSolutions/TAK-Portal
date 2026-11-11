/**
 * Keep Data Sync mission group lists aligned with channel patches.
 *
 * When an enabled patch links channels, any mission that already includes one
 * of those channels also receives the other patch channels. The ledger stores
 * each mission's pre-patch channels plus what this patch added, so disable /
 * delete can restore the originals (then re-apply any remaining patches).
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

/**
 * @returns {{ original: string[], added: string[] }|null}
 */
function normalizeAppliedEntry(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const added = uniqueCns(raw);
    if (!added.length) return null;
    return { original: [], added };
  }
  if (typeof raw !== "object") return null;
  const added = uniqueCns(
    Array.isArray(raw.added) ? raw.added : Array.isArray(raw.groups) ? raw.groups : []
  );
  const original = uniqueCns(Array.isArray(raw.original) ? raw.original : []);
  if (!added.length && !original.length) return null;
  return { original, added };
}

function normalizeAppliedMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [missionName, entryRaw] of Object.entries(raw)) {
    const name = String(missionName || "").trim();
    if (!name) continue;
    const entry = normalizeAppliedEntry(entryRaw);
    if (!entry) continue;
    out[name] = entry;
  }
  return out;
}

function affectedDataSyncNames(patch) {
  return Object.keys(normalizeAppliedMap(patch?.dataSyncApplied)).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
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

/** Channels this patch added onto the mission (orange "patched with" list). */
function addedGroupsForMission(missionName, patches) {
  const name = String(missionName || "").trim();
  if (!name) return [];
  const byKey = new Map();
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || p.enabled === false) continue;
    const entry = normalizeAppliedMap(p.dataSyncApplied)[name];
    if (!entry) continue;
    for (const g of entry.added) {
      const key = matchKey(g);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, g);
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

/**
 * Every channel in an enabled patch that affects this mission is locked in the
 * edit UI — including original mission channels that are part of the patch.
 */
function lockedGroupsForMission(missionName, patches) {
  const name = String(missionName || "").trim();
  if (!name) return [];
  const byKey = new Map();
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || p.enabled === false) continue;
    const entry = normalizeAppliedMap(p.dataSyncApplied)[name];
    if (!entry) continue;
    for (const [key, cn] of patchGroupCnByKey(p)) {
      if (!byKey.has(key)) byKey.set(key, cn);
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
    const name = missionNameOf(m);
    const patchLockedGroups = lockedGroupsForMission(name, patchList);
    const added = addedGroupsForMission(name, patchList);
    // Orange label lists additional patched-on channels; fall back to peer labels.
    const patchedWith = added.length
      ? added.slice()
      : patchedWithLabelsForMission(m, patchList);
    if (!patchedWith.length && !patchLockedGroups.length) return m;
    const next = Object.assign({}, m);
    if (patchedWith.length) next.patchedWith = patchedWith;
    if (patchLockedGroups.length) next.patchLockedGroups = patchLockedGroups;
    return next;
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

function annotateMissionDetailWithPatchPeers(mission, patches) {
  if (!mission || typeof mission !== "object") return mission;
  const patchList = Array.isArray(patches) ? patches : channelPatchStore.listEnabled();
  const [annotated] = annotateMissionsWithPatchPeers([mission], patchList);
  return annotated || mission;
}

/** Force patch-added channels to remain on mission writes while patches are active. */
function ensureLockedGroupsInMissionBody(missionName, body) {
  const locked = lockedGroupsForMission(missionName, channelPatchStore.listEnabled());
  if (!locked.length) return body;
  const o = body && typeof body === "object" ? { ...body } : {};
  o.groups = uniqueCns([...(Array.isArray(o.groups) ? o.groups : []), ...locked]);
  return o;
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
  const original = uniqueCns(current);
  const currentKeys = new Set(original.map(matchKey).filter(Boolean));
  const patchKeys = patchGroupKeys(patch);
  if (!intersects(currentKeys, patchKeys)) {
    return { original, add: [], nextGroups: original.slice() };
  }
  const byKey = patchGroupCnByKey(patch);
  const add = [];
  for (const [key, cn] of byKey) {
    if (!currentKeys.has(key)) add.push(cn);
  }
  return { original, add, nextGroups: uniqueCns([...original, ...add]) };
}

/**
 * Restore toward remembered originals, then keep peers still required by others.
 * Legacy entries without original fall back to (current − added).
 */
function planRestoreForMission(mission, entry, otherEnabledPatches) {
  const current = dataSyncAccess.extractMissionGroupNames(mission);
  const normalized = normalizeAppliedEntry(entry) || { original: [], added: [] };
  const addedKeys = new Set(normalized.added.map(matchKey).filter(Boolean));
  let original = uniqueCns(normalized.original);
  if (!original.length) {
    original = uniqueCns(
      current.filter((n) => {
        const k = matchKey(n);
        return k && !addedKeys.has(k);
      })
    );
  }
  let next = original.slice();
  let nextKeys = new Set(next.map(matchKey).filter(Boolean));
  for (const other of Array.isArray(otherEnabledPatches) ? otherEnabledPatches : []) {
    const pKeys = patchGroupKeys(other);
    if (!intersects(nextKeys, pKeys)) continue;
    const byKey = patchGroupCnByKey(other);
    for (const [key, cn] of byKey) {
      if (nextKeys.has(key)) continue;
      next.push(cn);
      nextKeys.add(key);
    }
  }
  next = uniqueCns(next);
  const removed = uniqueCns(current).filter((n) => {
    const k = matchKey(n);
    return k && !nextKeys.has(k);
  });
  return { nextGroups: next, original, removed };
}

/** @deprecated use planRestoreForMission — kept for older tests/callers */
function planRemovalsForMission(mission, addedCns, otherEnabledPatches) {
  return planRestoreForMission(
    mission,
    { original: [], added: addedCns },
    otherEnabledPatches
  );
}

function persistPatchApplied(patchId, appliedMap) {
  if (!patchId) return;
  try {
    channelPatchStore.update(patchId, {
      dataSyncApplied: normalizeAppliedMap(appliedMap),
    });
  } catch (err) {
    console.warn(
      "[channelPatchDataSync] Failed to persist dataSyncApplied:",
      err?.message || err
    );
  }
}

function patchChannelCns(patch) {
  return Array.from(patchGroupCnByKey(patch).values());
}

function desiredGroupsFromOriginal(originalGroups, patch) {
  return uniqueCns([...(Array.isArray(originalGroups) ? originalGroups : []), ...patchChannelCns(patch)]);
}

function groupsEqual(a, b) {
  const ak = uniqueCns(a).map(matchKey).filter(Boolean).sort();
  const bk = uniqueCns(b).map(matchKey).filter(Boolean).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
  }
  return true;
}

async function loadMissionByName(name) {
  try {
    const raw = await dataSyncSvc.getMission(name);
    return dataSyncAccess.unwrapMission(raw);
  } catch (err) {
    console.warn(
      `[channelPatchDataSync] Mission ${name} missing:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Apply patch channels onto Data Syncs.
 * Re-applies missions remembered in the ledger first (disable → re-enable),
 * then scans for any newly intersecting missions.
 */
async function applyPatchToDataSyncs(patch) {
  if (!patch || patch.enabled === false) {
    return { applied: {}, changed: [] };
  }
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) {
    return { applied: normalizeAppliedMap(patch.dataSyncApplied), changed: [] };
  }

  const prior = normalizeAppliedMap(patch.dataSyncApplied);
  const applied = {};
  const changed = [];
  const handled = new Set();

  for (const [name, entry] of Object.entries(prior)) {
    handled.add(name.toLowerCase());
    let mission = await loadMissionByName(name);
    if (!mission) continue;
    const current = dataSyncAccess.extractMissionGroupNames(mission);
    const addedKeys = new Set(entry.added.map(matchKey).filter(Boolean));
    const original = uniqueCns(
      entry.original.length
        ? entry.original
        : current.filter((n) => {
            const k = matchKey(n);
            return k && !addedKeys.has(k);
          })
    );
    if (!original.length && !current.length) continue;
    const base = original.length ? original : uniqueCns(current);
    const baseKeys = new Set(base.map(matchKey).filter(Boolean));
    const desired = desiredGroupsFromOriginal(base, patch);
    const added = desired.filter((g) => {
      const k = matchKey(g);
      return k && !baseKeys.has(k);
    });
    try {
      if (!groupsEqual(current, desired)) {
        await setMissionGroups(mission, desired);
        changed.push(name);
      }
      applied[name] = { original: base.slice(), added: uniqueCns(added) };
    } catch (err) {
      console.warn(
        `[channelPatchDataSync] Failed to re-apply patch channels on mission ${name}:`,
        err?.message || err
      );
    }
  }

  const missions = await listAllMissionsSafe();
  for (const mission of missions) {
    const name = missionNameOf(mission);
    if (!name || handled.has(name.toLowerCase())) continue;
    const plan = planAdditionsForMission(mission, patch);
    if (!plan.add.length) continue;
    try {
      await setMissionGroups(mission, plan.nextGroups);
      applied[name] = {
        original: plan.original.slice(),
        added: plan.add.slice(),
      };
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

async function refreshOtherPatchLedger(otherPatch, missionName, beforeGroups, added) {
  if (!otherPatch?.id || !missionName || !added.length) return;
  const prior = normalizeAppliedMap(otherPatch.dataSyncApplied);
  const existing = prior[missionName] || { original: [], added: [] };
  const original =
    existing.original.length > 0 ? existing.original : uniqueCns(beforeGroups);
  const mergedAdded = uniqueCns([...existing.added, ...added]);
  prior[missionName] = { original, added: mergedAdded };
  persistPatchApplied(otherPatch.id, prior);
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
  for (const [name, entry] of Object.entries(prior)) {
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

    const addedKeys = new Set(entry.added.map(matchKey).filter(Boolean));
    const restored = uniqueCns(
      entry.original.length
        ? entry.original
        : dataSyncAccess.extractMissionGroupNames(mission).filter((n) => {
            const k = matchKey(n);
            return k && !addedKeys.has(k);
          })
    );
    if (!restored.length) {
      console.warn(
        `[channelPatchDataSync] No original channels to restore for mission ${name}`
      );
      continue;
    }

    try {
      await setMissionGroups(mission, restored);
      changed.push(name);
    } catch (err) {
      console.warn(
        `[channelPatchDataSync] Failed to restore mission ${name}:`,
        err?.message || err
      );
      continue;
    }

    let currentGroups = restored.slice();
    for (const other of otherEnabled) {
      const plan = planAdditionsForMission(
        { ...mission, groups: currentGroups },
        other
      );
      if (!plan.add.length) continue;
      try {
        await setMissionGroups({ ...mission, groups: currentGroups }, plan.nextGroups);
        await refreshOtherPatchLedger(other, name, currentGroups, plan.add);
        currentGroups = plan.nextGroups;
      } catch (err) {
        console.warn(
          `[channelPatchDataSync] Failed to re-apply patch ${other.id} on ${name}:`,
          err?.message || err
        );
      }
    }
  }

  return { applied: {}, changed };
}

/**
 * Sync Data Sync missions after a patch create/update/delete/enable/disable.
 * Best-effort: patch persistence already succeeded; TAK errors are logged.
 *
 * Disable → restore remembered originals (ledger kept for re-enable).
 * Re-enable → re-apply from that ledger, then scan for new intersections.
 * Delete → restore originals (caller removes the patch afterward).
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
    const beforeOn = !!(before && before.enabled !== false);
    const afterOn = !!(after && after.enabled !== false);

    // Enabled → disabled, or enabled → deleted/changed: strip this patch's channels.
    if (beforeOn) {
      const out = await unapplyPatchFromDataSyncs(before);
      result.unapplied = out.changed;
    }

    if (afterOn) {
      // Carry ledger forward on re-enable so the same missions are restored.
      const seed =
        !beforeOn && before && before.id && after && after.id === before.id
          ? { ...after, dataSyncApplied: before.dataSyncApplied || after.dataSyncApplied }
          : after;
      const out = await applyPatchToDataSyncs(seed);
      result.applied = out.changed;
      result.dataSyncApplied = out.applied;
      persistPatchApplied(after.id, out.applied);
    }
    // Keep ledger while disabled so re-enable can target the same Data Syncs.
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
  normalizeAppliedEntry,
  normalizeAppliedMap,
  affectedDataSyncNames,
  planAdditionsForMission,
  planRestoreForMission,
  planRemovalsForMission,
  patchedWithLabelsForMission,
  addedGroupsForMission,
  lockedGroupsForMission,
  annotateMissionsWithPatchPeers,
  annotateMissionsPayloadWithPatchPeers,
  annotateMissionDetailWithPatchPeers,
  ensureLockedGroupsInMissionBody,
  applyPatchToDataSyncs,
  unapplyPatchFromDataSyncs,
  syncDataSyncsForPatchChange,
  buildMissionWriteBody,
  groupsStillRequiredKeys,
};
