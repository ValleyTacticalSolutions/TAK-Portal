/**
 * When Authentik/portal group names change, rewrite matching references on:
 * - Data Sync missions (Marti mission groups)
 * - Data Packages / file-sync metadata groups
 * - Channel patch stored channel names + Data Sync apply ledger
 * - Mutual Aid deployments linked to (or created as) that channel
 *
 * Best-effort: rename callers should not fail if TAK is down.
 */

const groupsSvc = require("./groups.service");
const dataSyncSvc = require("./dataSync.service");
const dataSyncAccess = require("./dataSyncAccess.service");
const dataPackagesSvc = require("./dataPackages.service");
const channelPatchStore = require("./channelPatch.store");
const mutualAidStore = require("./mutualAid.store");
const { isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");

function matchKey(name) {
  return dataSyncAccess.canonicalGroupKey(name);
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

function packageHash(record) {
  return String(
    record?.hash || record?.Hash || record?.sha256 || record?.uid || record?.id || ""
  ).trim();
}

/**
 * Build oldKey → new CN map from a Map, object, or single pair.
 * Keys are canonical (strip tak_, lowercased). Values are TAK CNs (no tak_).
 */
function normalizeRenameMap(input, maybeNewName) {
  const out = new Map();
  const add = (oldRaw, newRaw) => {
    const oldCn = toTakCn(oldRaw);
    const newCn = toTakCn(newRaw);
    const oldK = matchKey(oldCn);
    const newK = matchKey(newCn);
    if (!oldK || !newCn || oldK === newK) return;
    out.set(oldK, newCn);
  };

  if (input instanceof Map) {
    for (const [o, n] of input) add(o, n);
    return out;
  }
  if (input && typeof input === "object" && maybeNewName == null && !Array.isArray(input)) {
    for (const [o, n] of Object.entries(input)) add(o, n);
    return out;
  }
  if (maybeNewName != null) {
    add(input, maybeNewName);
    return out;
  }
  return out;
}

/**
 * Replace matching names in a list. Preserves relative order; drops dupes by key.
 * @returns {{ next: string[], changed: boolean }}
 */
function rewriteGroupList(names, renameMap) {
  const map = renameMap instanceof Map ? renameMap : normalizeRenameMap(renameMap);
  const next = [];
  const seen = new Set();
  let changed = false;
  for (const raw of Array.isArray(names) ? names : []) {
    const cn = toTakCn(raw);
    if (!cn) continue;
    const key = matchKey(cn);
    if (!key) continue;
    const mapped = map.has(key) ? map.get(key) : cn;
    if (mapped !== cn) changed = true;
    const outKey = matchKey(mapped);
    if (!outKey || seen.has(outKey)) continue;
    seen.add(outKey);
    next.push(mapped);
  }
  return { next, changed };
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
    groups,
    keywords: Array.isArray(m.keywords) ? m.keywords : [],
    inviteOnly: m.inviteOnly === true,
  };
}

async function propagateToMissions(renameMap) {
  const result = { scanned: 0, updated: 0, errors: 0 };
  if (!renameMap.size) return result;
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) return result;

  let missions = [];
  try {
    const raw = await dataSyncSvc.listMissions({});
    missions = unwrapMissionList(raw);
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] Failed to list missions:",
      err?.message || err
    );
    return result;
  }

  for (const mission of missions) {
    result.scanned += 1;
    const name = missionNameOf(mission);
    if (!name) continue;
    const current = dataSyncAccess.extractMissionGroupNames(mission);
    const { next, changed } = rewriteGroupList(current, renameMap);
    if (!changed || !next.length) continue;
    try {
      await dataSyncSvc.changeMission(name, buildMissionWriteBody(mission, next));
      result.updated += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[groupRenamePropagate] Failed to update mission ${name}:`,
        err?.message || err
      );
    }
  }
  return result;
}

async function propagateToPackages(renameMap) {
  const result = { scanned: 0, updated: 0, errors: 0 };
  if (!renameMap.size) return result;
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) return result;

  let items = [];
  try {
    const data = await dataPackagesSvc.listDataPackages({});
    items = Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] Failed to list data packages:",
      err?.message || err
    );
    return result;
  }

  for (const pkg of items) {
    result.scanned += 1;
    const hash = packageHash(pkg);
    if (!hash) continue;
    const current = dataSyncAccess.extractPackageGroupNames(pkg);
    const { next, changed } = rewriteGroupList(current, renameMap);
    if (!changed || !next.length) continue;
    try {
      await dataPackagesSvc.updateDataPackageMetadata(hash, { groups: next });
      result.updated += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[groupRenamePropagate] Failed to update package ${hash}:`,
        err?.message || err
      );
    }
  }
  return result;
}

function rewritePatchNameList(list, renameMap) {
  const { next, changed } = rewriteGroupList(list, renameMap);
  return { next, changed };
}

function rewriteDataSyncApplied(applied, renameMap) {
  const src = applied && typeof applied === "object" ? applied : {};
  const out = {};
  let changed = false;
  for (const [missionName, entryRaw] of Object.entries(src)) {
    let original = [];
    let added = [];
    if (Array.isArray(entryRaw)) {
      added = entryRaw;
    } else if (entryRaw && typeof entryRaw === "object") {
      original = Array.isArray(entryRaw.original) ? entryRaw.original : [];
      added = Array.isArray(entryRaw.added)
        ? entryRaw.added
        : Array.isArray(entryRaw.groups)
          ? entryRaw.groups
          : [];
    }
    const o = rewriteGroupList(original, renameMap);
    const a = rewriteGroupList(added, renameMap);
    if (o.changed || a.changed) changed = true;
    if (!o.next.length && !a.next.length) continue;
    out[missionName] = { original: o.next, added: a.next };
  }
  return { next: out, changed };
}

function propagateToChannelPatches(renameMap) {
  const result = { scanned: 0, updated: 0, errors: 0 };
  if (!renameMap.size) return result;

  let patches = [];
  try {
    patches = channelPatchStore.list();
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] Failed to list channel patches:",
      err?.message || err
    );
    return result;
  }

  for (const patch of patches) {
    result.scanned += 1;
    if (!patch?.id) continue;
    const fields = {};
    let changed = false;

    if (Array.isArray(patch.groups)) {
      const r = rewritePatchNameList(patch.groups, renameMap);
      if (r.changed) {
        fields.groups = r.next;
        changed = true;
      }
    }
    if (Array.isArray(patch.leftGroups)) {
      const r = rewritePatchNameList(patch.leftGroups, renameMap);
      if (r.changed) {
        fields.leftGroups = r.next;
        changed = true;
      }
    }
    if (Array.isArray(patch.rightGroups)) {
      const r = rewritePatchNameList(patch.rightGroups, renameMap);
      if (r.changed) {
        fields.rightGroups = r.next;
        changed = true;
      }
    }
    if (patch.dataSyncApplied) {
      const r = rewriteDataSyncApplied(patch.dataSyncApplied, renameMap);
      if (r.changed) {
        fields.dataSyncApplied = r.next;
        changed = true;
      }
    }

    if (!changed) continue;
    try {
      channelPatchStore.update(patch.id, fields);
      result.updated += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[groupRenamePropagate] Failed to update channel patch ${patch.id}:`,
        err?.message || err
      );
    }
  }
  return result;
}

/** Keep Authentik-shaped names when the MA row already used tak_. */
function formatMutualAidGroupName(previousName, newCn) {
  const prev = String(previousName || "").trim();
  const cn = toTakCn(newCn);
  if (!cn) return prev;
  if (prev.toLowerCase().startsWith("tak_")) return groupsSvc.ensureTakPrefix(cn);
  return cn;
}

async function patchMutualAidUserGroupAttr(userId, groupName) {
  const id = String(userId || "").trim();
  const name = String(groupName || "").trim();
  if (!id || !name) return;
  try {
    const usersSvc = require("./users.service");
    const user = await usersSvc.getUserById(id);
    if (!user) return;
    await usersSvc.enqueueLocalUserAttributePatch(user, {
      ...(user.attributes || {}),
      mutual_aid: true,
      mutual_aid_group: name,
    });
  } catch (err) {
    console.warn(
      `[groupRenamePropagate] Failed to update mutual_aid_group for user ${id}:`,
      err?.message || err
    );
  }
}

/**
 * Rewrite Mutual Aid deployments that reference renamed channels
 * (existing linked groups and MA-created groups alike).
 */
async function propagateToMutualAid(renameMap) {
  const result = { scanned: 0, updated: 0, userAttrsUpdated: 0, errors: 0 };
  if (!renameMap.size) return result;

  let items = [];
  try {
    items = mutualAidStore.load().map((x) => (x && typeof x === "object" ? { ...x } : x));
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] Failed to list mutual aid items:",
      err?.message || err
    );
    return result;
  }

  let dirty = false;
  const userPatches = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    result.scanned += 1;
    const prevName = String(item.groupName || "").trim();
    if (!prevName) continue;
    const key = matchKey(prevName);
    if (!key || !renameMap.has(key)) continue;
    const nextName = formatMutualAidGroupName(prevName, renameMap.get(key));
    if (!nextName || matchKey(nextName) === key) continue;

    items[i] = {
      ...item,
      groupName: nextName,
      updatedAt: new Date().toISOString(),
    };
    dirty = true;
    result.updated += 1;
    if (item.userId) {
      userPatches.push({ userId: item.userId, groupName: nextName });
    }
  }

  if (dirty) {
    try {
      mutualAidStore.save(items);
    } catch (err) {
      result.errors += 1;
      console.warn(
        "[groupRenamePropagate] Failed to save mutual aid store:",
        err?.message || err
      );
      return result;
    }
  }

  for (const patch of userPatches) {
    try {
      await patchMutualAidUserGroupAttr(patch.userId, patch.groupName);
      result.userAttrsUpdated += 1;
    } catch (_) {
      result.errors += 1;
    }
  }

  return result;
}

/**
 * Propagate one or many group renames into TAK missions/packages, patches, and Mutual Aid.
 * @param {Map|object|string} renameMapOrOldName
 * @param {string} [newName] when first arg is a single old name
 */
async function propagateGroupRename(renameMapOrOldName, newName) {
  const renameMap = normalizeRenameMap(renameMapOrOldName, newName);
  const empty = {
    renameCount: renameMap.size,
    missions: { scanned: 0, updated: 0, errors: 0 },
    packages: { scanned: 0, updated: 0, errors: 0 },
    channelPatches: { scanned: 0, updated: 0, errors: 0 },
    mutualAid: { scanned: 0, updated: 0, userAttrsUpdated: 0, errors: 0 },
  };
  if (!renameMap.size) return empty;

  const [missions, packages, channelPatches, mutualAid] = await Promise.all([
    propagateToMissions(renameMap),
    propagateToPackages(renameMap),
    Promise.resolve(propagateToChannelPatches(renameMap)),
    propagateToMutualAid(renameMap),
  ]);

  return {
    renameCount: renameMap.size,
    missions,
    packages,
    channelPatches,
    mutualAid,
  };
}

module.exports = {
  matchKey,
  toTakCn,
  normalizeRenameMap,
  rewriteGroupList,
  formatMutualAidGroupName,
  propagateToMissions,
  propagateToPackages,
  propagateToChannelPatches,
  propagateToMutualAid,
  propagateGroupRename,
};
