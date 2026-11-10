/**
 * Agency-scoped access for channel patches.
 *
 * Channel picker lists follow the same Authentik source-of-truth logic as
 * Data Sync (services/dataSyncAccess.service.js → resolveGroupsForUser).
 * Optional live-map catalog data may enrich counts only — never spelling.
 *
 * Agency admins may create/edit patches using groups in that allowlist.
 * A patch is visible only when every channel in it is in that allowlist;
 * mixed/out-of-scope patches are hidden entirely.
 */

const accessSvc = require("./access.service");
const groupsSvc = require("./groups.service");
const mapMeta = require("./mapMeta.service");
const mutualAidStore = require("./mutualAid.store");
const dataSyncAccess = require("./dataSyncAccess.service");
const { isGroupHidden } = require("./portalHidden.util");

function isAuthentikAgencyAdminGroupName(name) {
  return /-AgencyAdmin$/i.test(String(name || "").trim());
}

function isHiddenGroupName(groupOrName, { includeMutualAid = false } = {}) {
  const name =
    groupOrName && typeof groupOrName === "object"
      ? groupOrName.name
      : groupOrName;
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return true;
  const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;
  if (withoutTak.startsWith("_")) return true;
  return isGroupHidden(groupOrName, { includeMutualAid });
}

/**
 * Add MA-workflow-created channels to a picker list (global admins only).
 * Kept for callers/tests; the Channel Patch picker now merges MA via Data Sync.
 * @param {Array<{ name: string, displayName: string, baseKey: string, count?: number }>} channels
 * @param {string[]|null} [groupNames] - defaults to created groups from the MA store
 */
function mergeCreatedMutualAidPickerChannels(channels, groupNames) {
  const list = Array.isArray(channels) ? channels : [];
  const names = Array.isArray(groupNames)
    ? groupNames
    : mutualAidStore.getCreatedGroupNames();
  const seen = new Set();
  for (const c of list) {
    if (c?.baseKey) seen.add(c.baseKey);
  }
  for (const rawName of names) {
    const displayName = groupsSvc.stripTakPrefix(rawName);
    const name = groupsSvc.ensureTakPrefix(displayName || rawName);
    if (!name || isAuthentikAgencyAdminGroupName(name)) continue;
    const baseKey = mapMeta.channelBaseKey(name);
    if (!baseKey || baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY || seen.has(baseKey)) {
      continue;
    }
    seen.add(baseKey);
    list.push({
      name,
      displayName: displayName || name,
      baseKey,
      count: 0,
    });
  }
  return list;
}

function patchGroupKeys(patch) {
  const keys = new Set();
  const names = [
    ...(Array.isArray(patch?.groups) ? patch.groups : []),
    ...(Array.isArray(patch?.leftGroups) ? patch.leftGroups : []),
    ...(Array.isArray(patch?.rightGroups) ? patch.rightGroups : []),
  ];
  for (const name of names) {
    const k = mapMeta.channelBaseKey(name);
    if (k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY) keys.add(k);
  }
  return keys;
}

function toAllowSet(allowedKeys) {
  if (allowedKeys instanceof Set) return allowedKeys;
  return new Set(Array.isArray(allowedKeys) ? allowedKeys.filter(Boolean) : []);
}

function patchFullyInScope(patch, allow) {
  const keys = patchGroupKeys(patch);
  if (!keys.size) return false;
  for (const k of keys) {
    if (!allow.has(k)) return false;
  }
  return true;
}

/**
 * Global admins see every patch. Agency admins see a patch only when every
 * group in it is in their allowlist.
 */
function filterPatchesForAccess(access, patches, allowedKeys) {
  const list = Array.isArray(patches) ? patches : [];
  if (access?.isGlobalAdmin) return list;
  const allow = toAllowSet(allowedKeys);
  if (!allow.size) return [];
  return list.filter((p) => patchFullyInScope(p, allow));
}

function assertGroupsInScope(access, groups, allowedKeys) {
  if (access?.isGlobalAdmin) return;
  const allow = toAllowSet(allowedKeys);
  const names = Array.isArray(groups) ? groups : [];
  for (const n of names) {
    const k = mapMeta.channelBaseKey(n);
    if (!k || k === mapMeta.UNASSIGNED_CHANNEL_KEY || !allow.has(k)) {
      const err = new Error(`Group not in your agency scope: ${n}`);
      err.status = 403;
      throw err;
    }
  }
}

function toPickerChannel(entry) {
  return {
    name: entry.name,
    displayName: entry.displayName || entry.name,
    baseKey: entry.baseKey,
    count: entry.count || 0,
  };
}

function catalogCountByKey(catalogGroups) {
  const catalogByKey = new Map();
  for (const g of Array.isArray(catalogGroups) ? catalogGroups : []) {
    if (!g?.baseKey || g.baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY) continue;
    catalogByKey.set(g.baseKey, g);
  }
  return catalogByKey;
}

/**
 * Build picker rows from Data Sync's Authentik-backed group list.
 * Catalog may supply live counts only.
 */
function channelsFromAuthentikNames(displayNames, catalogByKey) {
  const channels = [];
  const seen = new Set();
  for (const raw of Array.isArray(displayNames) ? displayNames : []) {
    const displayName = String(raw || "").trim();
    if (!displayName || isAuthentikAgencyAdminGroupName(displayName)) continue;
    const name = groupsSvc.ensureTakPrefix(displayName);
    const baseKey = mapMeta.channelBaseKey(name);
    if (!baseKey || baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY || seen.has(baseKey)) {
      continue;
    }
    seen.add(baseKey);
    const cat = catalogByKey.get(baseKey);
    channels.push(
      toPickerChannel({
        name,
        displayName,
        baseKey,
        count: cat?.count || 0,
      })
    );
  }
  channels.sort((a, b) =>
    String(a.displayName || "").localeCompare(String(b.displayName || ""))
  );
  return channels;
}

/**
 * Authentik groups this user may patch (same allowlist as Data Sync).
 * @returns {Array<{ name: string, displayName: string, baseKey: string }>}
 */
async function listAgencyScopedGroups(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return [];
  const scoped = await buildScopedChannelPicker(authUser, []);
  return scoped.channels.map((c) => ({
    name: c.name,
    displayName: c.displayName,
    baseKey: c.baseKey,
  }));
}

/**
 * @returns {Promise<Set<string>|null>} null = unrestricted (global admin)
 */
async function resolveAllowedChannelKeySet(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;
  const groups = await listAgencyScopedGroups(authUser);
  return new Set(groups.map((g) => g.baseKey));
}

/**
 * Channel picker + allowlist for the Channel Patch page/API.
 * Same Authentik source of truth as Data Sync group pickers.
 * Optional catalogGroups enrich live counts only (never spelling).
 */
async function buildScopedChannelPicker(authUser, catalogGroups) {
  const access = accessSvc.getAgencyAccess(authUser);
  const catalogByKey = catalogCountByKey(catalogGroups);
  const resolved = await dataSyncAccess.resolveGroupsForUser(authUser, []);
  const channels = channelsFromAuthentikNames(resolved.groups, catalogByKey);

  if (access.isGlobalAdmin) {
    return {
      access,
      channels,
      channelScope: "all",
      allowedChannelKeys: null,
    };
  }

  return {
    access,
    channels,
    channelScope: "agency",
    allowedChannelKeys: channels.map((c) => c.baseKey),
  };
}

function allowedKeySetFromPicker(scoped) {
  if (!scoped || scoped.allowedChannelKeys == null) return null;
  return new Set(
    (Array.isArray(scoped.allowedChannelKeys) ? scoped.allowedChannelKeys : []).filter(
      Boolean
    )
  );
}

module.exports = {
  patchGroupKeys,
  patchFullyInScope,
  filterPatchesForAccess,
  assertGroupsInScope,
  listAgencyScopedGroups,
  resolveAllowedChannelKeySet,
  buildScopedChannelPicker,
  allowedKeySetFromPicker,
  isHiddenGroupName,
  mergeCreatedMutualAidPickerChannels,
};
