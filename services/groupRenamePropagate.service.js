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
const groupRenameAlias = require("./groupRenameAlias.store");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function renameMapFingerprint(renameMap) {
  return [...renameMap.entries()]
    .map(([k, v]) => `${k}=>${v}`)
    .sort()
    .join("|");
}

function groupKeysMatch(a, b) {
  const ak = (Array.isArray(a) ? a : []).map(matchKey).filter(Boolean).sort();
  const bk = (Array.isArray(b) ? b : []).map(matchKey).filter(Boolean).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
  }
  return true;
}

async function loadMissionHydrated(listRow) {
  const name = missionNameOf(listRow);
  if (!name) return null;
  try {
    const raw = await dataSyncSvc.getMission(name);
    const full = dataSyncAccess.unwrapMission(raw);
    if (full && typeof full === "object") return full;
  } catch (err) {
    console.warn(
      `[groupRenamePropagate] Failed to load mission ${name}:`,
      err?.message || err
    );
  }
  return listRow && typeof listRow === "object" ? listRow : null;
}

async function takHasAllGroupKeys(neededKeys) {
  const needed = [...new Set((Array.isArray(neededKeys) ? neededKeys : []).filter(Boolean))];
  if (!needed.length) return true;
  try {
    const raw = await dataSyncSvc.listGroupsAll();
    const present = new Set(
      dataSyncAccess.extractTakGroupNameList(raw).map(matchKey).filter(Boolean)
    );
    return needed.every((k) => present.has(k));
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] Failed to list TAK groups:",
      err?.message || err
    );
    return false;
  }
}

/**
 * LDAP sync often lags Authentik rename. Wait briefly for new CNs to appear in TAK.
 * @returns {boolean} true when all new names are visible (or none required)
 */
async function waitForTakGroupNames(cns, opts = {}) {
  const needed = [
    ...new Set((Array.isArray(cns) ? cns : []).map(toTakCn).map(matchKey).filter(Boolean)),
  ];
  if (!needed.length) return true;
  const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 10000);
  const intervalMs = Math.max(250, Number(opts.intervalMs) || 2000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await takHasAllGroupKeys(needed)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

async function propagateToMissions(renameMap, opts = {}) {
  const result = { scanned: 0, updated: 0, errors: 0, pending: 0 };
  if (!renameMap.size) return result;
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) return result;

  // Soft wait only — Authentik is SoT; /api/groups/all can lag or omit CNs.
  // Still attempt the mission rewrite so channels do not stay stranded.
  const waitMs = opts.waitForGroupsMs != null ? Number(opts.waitForGroupsMs) : 8000;
  const newCns = [...new Set([...renameMap.values()].map(toTakCn).filter(Boolean))];
  if (waitMs > 0) {
    const groupsReady = await waitForTakGroupNames(newCns, {
      timeoutMs: waitMs,
      intervalMs: opts.intervalMs,
    });
    if (!groupsReady) {
      console.warn(
        "[groupRenamePropagate] New group CNs not yet listed by TAK; attempting mission updates anyway:",
        newCns.join(", ")
      );
    }
  }

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

    // Skip hydrate when the list already shows groups and none need renaming.
    const listed = dataSyncAccess.extractMissionGroupNames(mission);
    const listedProbe = rewriteGroupList(listed, renameMap);
    if (!listedProbe.changed && listed.length > 0) continue;

    const full = (await loadMissionHydrated(mission)) || mission;
    const current = dataSyncAccess.extractMissionGroupNames(full);
    const { next, changed } = rewriteGroupList(current, renameMap);
    if (!changed || !next.length) continue;

    try {
      await dataSyncSvc.changeMission(name, buildMissionWriteBody(full, next));
      const verified = (await loadMissionHydrated({ name })) || null;
      const after = verified
        ? dataSyncAccess.extractMissionGroupNames(verified)
        : [];
      if (!groupKeysMatch(after, next)) {
        result.errors += 1;
        result.pending += 1;
        console.warn(
          `[groupRenamePropagate] Mission ${name} group rewrite did not stick (got: ${after.join(", ") || "none"})`
        );
        continue;
      }
      result.updated += 1;
    } catch (err) {
      result.errors += 1;
      result.pending += 1;
      console.warn(
        `[groupRenamePropagate] Failed to update mission ${name}:`,
        err?.message || err
      );
    }
  }
  return result;
}

async function propagateToPackages(renameMap) {
  const result = { scanned: 0, updated: 0, errors: 0, pending: 0 };
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
      result.pending += 1;
      console.warn(
        `[groupRenamePropagate] Failed to update package ${hash}:`,
        err?.message || err
      );
    }
  }
  return result;
}

/** Dedup in-flight deferred mission/package retries for the same rename set. */
const pendingRetryFingerprints = new Set();

let staleRepairInFlight = false;
let staleRepairCompleted = false;

/**
 * One-shot per process: backfill aliases from audit, then rewrite any missions /
 * packages / patches still holding historical CNs. Safe to call from list routes.
 */
async function maybeRepairStaleMissionGroups() {
  if (staleRepairCompleted || staleRepairInFlight) return { skipped: true };
  staleRepairInFlight = true;
  try {
    await groupRenameAlias.backfillFromAudit();
    const aliases = groupRenameAlias.load();
    const renameMap = normalizeRenameMap(aliases);
    if (!renameMap.size) {
      staleRepairCompleted = true;
      return { renameCount: 0 };
    }

    const [missions, packages, channelPatches, mutualAid] = await Promise.all([
      propagateToMissions(renameMap, { waitForGroupsMs: 0 }),
      propagateToPackages(renameMap),
      Promise.resolve(propagateToChannelPatches(renameMap)),
      propagateToMutualAid(renameMap),
    ]);

    const needsDeferred =
      Number(missions.errors) > 0 ||
      Number(missions.pending) > 0 ||
      Number(packages.errors) > 0 ||
      Number(packages.pending) > 0;
    if (needsDeferred) {
      scheduleDeferredTakPropagate(renameMap);
    } else {
      staleRepairCompleted = true;
    }

    console.warn(
      "[groupRenamePropagate] stale repair:",
      `renames=${renameMap.size}`,
      `missions updated=${missions.updated} errors=${missions.errors} pending=${missions.pending}`,
      `packages updated=${packages.updated}`,
      `patches updated=${channelPatches.updated}`,
      `mutualAid updated=${mutualAid.updated}`
    );

    return {
      renameCount: renameMap.size,
      missions,
      packages,
      channelPatches,
      mutualAid,
      deferredScheduled: needsDeferred,
    };
  } catch (err) {
    console.warn(
      "[groupRenamePropagate] stale repair failed:",
      err?.message || err
    );
    return { error: err?.message || String(err) };
  } finally {
    staleRepairInFlight = false;
  }
}

/**
 * Authentik→LDAP→TAK can take up to ~60s. Keep trying mission/package rewrites
 * in the background without blocking the Groups rename HTTP response.
 */
function scheduleDeferredTakPropagate(renameMap) {
  if (!(renameMap instanceof Map) || !renameMap.size) return;
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) return;

  const fp = renameMapFingerprint(renameMap);
  if (pendingRetryFingerprints.has(fp)) return;
  pendingRetryFingerprints.add(fp);

  const delaysMs = [8000, 20000, 45000, 90000];
  let attempt = 0;
  const mapCopy = new Map(renameMap);

  const run = async () => {
    try {
      const [missions, packages] = await Promise.all([
        propagateToMissions(mapCopy, { waitForGroupsMs: 5000 }),
        propagateToPackages(mapCopy),
      ]);
      console.warn(
        `[groupRenamePropagate] deferred attempt ${attempt + 1}/${delaysMs.length}:`,
        `missions updated=${missions.updated} errors=${missions.errors} pending=${missions.pending};`,
        `packages updated=${packages.updated} errors=${packages.errors}`
      );
      const needMore =
        (Number(missions.errors) > 0 ||
          Number(missions.pending) > 0 ||
          Number(packages.errors) > 0 ||
          Number(packages.pending) > 0) &&
        attempt < delaysMs.length - 1;
      if (needMore) {
        attempt += 1;
        setTimeout(() => {
          run().catch(() => {});
        }, delaysMs[attempt]);
        return;
      }
    } catch (err) {
      console.warn(
        "[groupRenamePropagate] deferred retry failed:",
        err?.message || err
      );
      if (attempt < delaysMs.length - 1) {
        attempt += 1;
        setTimeout(() => {
          run().catch(() => {});
        }, delaysMs[attempt]);
        return;
      }
    }
    pendingRetryFingerprints.delete(fp);
  };

  setTimeout(() => {
    run().catch(() => {});
  }, delaysMs[0]);
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
 * Expand rename map with prior CNs for this group (aliases + audit history)
 * so missions still holding an older name are rewritten to the latest CN.
 */
async function expandRenameMapForGroup(renameMap, opts = {}) {
  const targetName = opts.targetName != null ? opts.targetName : [...renameMap.values()][0];
  const targetCn = toTakCn(targetName);
  const targetK = matchKey(targetCn);
  let out = new Map(renameMap);
  if (!targetK) return out;

  try {
    await groupRenameAlias.backfillFromAudit();
  } catch (_) {}

  out = groupRenameAlias.expandMap(out, targetCn);

  if (opts.groupId) {
    const historical = await groupRenameAlias.historicalNamesForGroup(opts.groupId);
    for (const raw of historical) {
      const k = matchKey(raw);
      if (!k || k === targetK) continue;
      out.set(k, targetCn);
    }
  }

  // Ensure every value is the latest CN (collapse multi-hop maps).
  for (const [k, v] of out) {
    out.set(k, targetCn || toTakCn(v));
  }
  out.delete(targetK);
  return out;
}

/**
 * Propagate one or many group renames into TAK missions/packages, patches, and Mutual Aid.
 * @param {Map|object|string} renameMapOrOldName
 * @param {string} [newName] when first arg is a single old name
 * @param {{ groupId?: string, targetName?: string }} [opts]
 */
async function propagateGroupRename(renameMapOrOldName, newName, opts = {}) {
  // Allow propagateGroupRename(map, { groupId, targetName })
  if (
    newName &&
    typeof newName === "object" &&
    !Array.isArray(newName) &&
    !(newName instanceof Map)
  ) {
    opts = newName;
    newName = undefined;
  }

  let renameMap = normalizeRenameMap(renameMapOrOldName, newName);
  const targetName =
    opts.targetName != null
      ? opts.targetName
      : newName != null
        ? newName
        : [...renameMap.values()][0];

  if (opts.groupId || opts.targetName) {
    renameMap = await expandRenameMapForGroup(renameMap, {
      groupId: opts.groupId,
      targetName,
    });
  }

  // Persist aliases even when TAK is down so the Data Sync UI can resolve labels.
  if (renameMap.size) {
    groupRenameAlias.record(renameMap);
  }

  const empty = {
    renameCount: renameMap.size,
    missions: { scanned: 0, updated: 0, errors: 0, pending: 0 },
    packages: { scanned: 0, updated: 0, errors: 0, pending: 0 },
    channelPatches: { scanned: 0, updated: 0, errors: 0 },
    mutualAid: { scanned: 0, updated: 0, userAttrsUpdated: 0, errors: 0 },
    deferredScheduled: false,
  };
  if (!renameMap.size) return empty;

  const [missions, packages, channelPatches, mutualAid] = await Promise.all([
    propagateToMissions(renameMap),
    propagateToPackages(renameMap),
    Promise.resolve(propagateToChannelPatches(renameMap)),
    propagateToMutualAid(renameMap),
  ]);

  const needsDeferred =
    Number(missions.errors) > 0 ||
    Number(missions.pending) > 0 ||
    Number(packages.errors) > 0 ||
    Number(packages.pending) > 0;
  if (needsDeferred) {
    scheduleDeferredTakPropagate(renameMap);
  }

  console.warn(
    "[groupRenamePropagate] sync pass:",
    `renames=${renameMap.size}`,
    `missions updated=${missions.updated} errors=${missions.errors} pending=${missions.pending}`,
    `packages updated=${packages.updated} errors=${packages.errors}`,
    needsDeferred ? "(deferred retries scheduled)" : ""
  );

  return {
    renameCount: renameMap.size,
    missions,
    packages,
    channelPatches,
    mutualAid,
    deferredScheduled: needsDeferred,
  };
}

module.exports = {
  matchKey,
  toTakCn,
  normalizeRenameMap,
  rewriteGroupList,
  formatMutualAidGroupName,
  groupKeysMatch,
  waitForTakGroupNames,
  expandRenameMapForGroup,
  propagateToMissions,
  propagateToPackages,
  propagateToChannelPatches,
  propagateToMutualAid,
  propagateGroupRename,
  scheduleDeferredTakPropagate,
  maybeRepairStaleMissionGroups,
};
