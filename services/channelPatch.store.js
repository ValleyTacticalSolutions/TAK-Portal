/**
 * Persist channel patches in Postgres.
 *
 * Modes:
 *  - bidirectional: named set of channels patched together (full mesh, both ways)
 *  - unidirectional: left/right channel lists with ltr|rtl flow
 * Legacy hub/spokes rows are migrated on read to bidirectional mesh.
 */
const crypto = require("crypto");
const pgCache = require("./pgCache");

const FILE = null;

let _cache = null;

function ensureDirExists() {}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function groupDedupeKey(name) {
  return safeStr(name).trim().toLowerCase();
}

/** Match Authentik `tak_` names to catalog / patch group names. */
function groupMatchKey(name) {
  let n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) n = n.slice(4);
  return n.toLowerCase().replace(/\s+/g, " ").trim();
}

function groupDisplayLabel(name) {
  let n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) n = n.slice(4);
  return n;
}

/**
 * Deduped list of group name strings from an array of strings/objects.
 * @returns {string[]}
 */
function extractNamesFromList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    let name = "";
    if (typeof item === "string" || typeof item === "number") {
      name = safeStr(item).trim();
    } else if (item && typeof item === "object") {
      name = safeStr(item.group || item.name || item.groupName).trim();
    }
    if (!name) continue;
    const key = groupDedupeKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Accept modern `groups: string[]` or legacy hub + spokes.
 * @returns {string[]}
 */
function extractGroupNames(raw) {
  const out = extractNamesFromList(raw?.groups);

  // Legacy hub / spokes → flat mesh
  if (!out.length) {
    const legacy = [];
    const hub = safeStr(raw?.hubGroup || raw?.hub).trim();
    if (hub) legacy.push(hub);
    const spokes = Array.isArray(raw?.spokes) ? raw.spokes : [];
    for (const row of spokes) {
      if (typeof row === "string" || typeof row === "number") {
        legacy.push(safeStr(row).trim());
      } else if (row && typeof row === "object") {
        legacy.push(safeStr(row.group || row.name || row.groupName).trim());
      }
    }
    return extractNamesFromList(legacy);
  }

  return out;
}

function normalizeMode(raw) {
  const m = safeStr(raw?.mode || raw?.type).trim().toLowerCase();
  if (
    m === "unidirectional" ||
    m === "uni" ||
    m === "uni-directional" ||
    m === "one-way" ||
    m === "oneway"
  ) {
    return "unidirectional";
  }
  return "bidirectional";
}

function normalizeDirection(raw) {
  const d = safeStr(raw?.direction).trim().toLowerCase();
  if (d === "rtl" || d === "right-to-left" || d === "left" || d === "←") {
    return "rtl";
  }
  return "ltr";
}

function normalizeAppliedGroupList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const label = groupDisplayLabel(
      typeof item === "string" || typeof item === "number"
        ? item
        : item && typeof item === "object"
          ? item.group || item.name || item.groupName
          : ""
    );
    if (!label) continue;
    const key = groupMatchKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Mission name → { original, added } channel CNs for Data Sync patch sync.
 * Legacy shape (string[]) is treated as added-only.
 */
function normalizeDataSyncApplied(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [missionName, entryRaw] of Object.entries(raw)) {
    const name = safeStr(missionName).trim();
    if (!name) continue;
    let original = [];
    let added = [];
    if (Array.isArray(entryRaw)) {
      added = normalizeAppliedGroupList(entryRaw);
    } else if (entryRaw && typeof entryRaw === "object") {
      original = normalizeAppliedGroupList(entryRaw.original);
      added = normalizeAppliedGroupList(
        Array.isArray(entryRaw.added) ? entryRaw.added : entryRaw.groups
      );
    }
    if (!original.length && !added.length) continue;
    out[name] = { original, added };
  }
  return out;
}

/**
 * Resolved traffic ends for a patch.
 * @returns {{ sources: string[], destinations: string[] }}
 */
function resolveFlowEnds(patch) {
  if (!patch || normalizeMode(patch) !== "unidirectional") {
    const groups = Array.isArray(patch?.groups) ? patch.groups : [];
    return { sources: groups.slice(), destinations: groups.slice() };
  }
  const left = Array.isArray(patch.leftGroups) ? patch.leftGroups : [];
  const right = Array.isArray(patch.rightGroups) ? patch.rightGroups : [];
  const direction = normalizeDirection(patch);
  if (direction === "rtl") {
    return { sources: right.slice(), destinations: left.slice() };
  }
  return { sources: left.slice(), destinations: right.slice() };
}

/**
 * For each channel in enabled patches, the other channels it is patched with.
 * Bi: full mesh peers. Uni: sources ↔ destinations (labels both ways; traffic is one-way).
 * @returns {Map<string, string[]>} matchKey -> sorted peer display labels
 */
function peerLabelsByGroupKeyFromPatches(patches) {
  const byKey = new Map();

  function addPeer(srcKey, dstKey, dstLabel) {
    if (!srcKey || !dstKey || srcKey === dstKey) return;
    if (!byKey.has(srcKey)) byKey.set(srcKey, new Map());
    const peers = byKey.get(srcKey);
    if (!peers.has(dstKey)) peers.set(dstKey, dstLabel);
  }

  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || p.enabled === false) continue;

    if (normalizeMode(p) === "unidirectional") {
      const { sources, destinations } = resolveFlowEnds(p);
      const srcItems = sources
        .map((g) => ({ key: groupMatchKey(g), label: groupDisplayLabel(g) }))
        .filter((x) => x.key);
      const dstItems = destinations
        .map((g) => ({ key: groupMatchKey(g), label: groupDisplayLabel(g) }))
        .filter((x) => x.key);
      for (const src of srcItems) {
        for (const dst of dstItems) {
          addPeer(src.key, dst.key, dst.label);
          addPeer(dst.key, src.key, src.label);
        }
      }
      continue;
    }

    const items = (Array.isArray(p.groups) ? p.groups : [])
      .map((g) => ({ key: groupMatchKey(g), label: groupDisplayLabel(g) }))
      .filter((x) => x.key);
    for (const src of items) {
      for (const dst of items) {
        addPeer(src.key, dst.key, dst.label);
      }
    }
  }

  const out = new Map();
  for (const [k, peers] of byKey) {
    out.set(
      k,
      Array.from(peers.values()).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      )
    );
  }
  return out;
}

function enabledPeerLabelsByGroupKey() {
  return peerLabelsByGroupKeyFromPatches(listEnabled());
}

function annotateGroupsWithPatchPeers(groups, patches) {
  const index = Array.isArray(patches)
    ? peerLabelsByGroupKeyFromPatches(patches)
    : enabledPeerLabelsByGroupKey();
  if (!index.size) return Array.isArray(groups) ? groups : [];
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const peers = index.get(groupMatchKey(g && g.name));
    if (!peers || !peers.length) return g;
    return Object.assign({}, g, { patchedWith: peers });
  });
}

function normalizePatch(raw, { assignId = false } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const mode = normalizeMode(raw);
  let id = safeStr(raw.id).trim();
  if (!id && assignId) id = crypto.randomUUID();
  if (!id) return null;

  const now = new Date().toISOString();
  const dataSyncApplied = normalizeDataSyncApplied(raw.dataSyncApplied);
  const base = {
    id,
    name: safeStr(raw.name).trim() || "Untitled Patch",
    enabled: raw.enabled !== false && raw.enabled !== "false" && raw.enabled !== 0,
    mode,
    createdBy: safeStr(raw.createdBy).trim() || "",
    createdAt: safeStr(raw.createdAt).trim() || now,
    updatedAt: safeStr(raw.updatedAt).trim() || now,
    agencyScope: Array.isArray(raw.agencyScope)
      ? raw.agencyScope.map((s) => safeStr(s).trim()).filter(Boolean)
      : [],
    lastForwardAt: safeStr(raw.lastForwardAt).trim() || null,
    lastError: safeStr(raw.lastError).trim() || null,
    dataSyncApplied,
  };

  if (mode === "unidirectional") {
    const leftGroups = extractNamesFromList(
      raw.leftGroups != null ? raw.leftGroups : raw.sources
    );
    const rightGroups = extractNamesFromList(
      raw.rightGroups != null ? raw.rightGroups : raw.destinations
    );
    if (!leftGroups.length || !rightGroups.length) return null;

    const leftKeys = new Set(leftGroups.map(groupDedupeKey));
    for (const g of rightGroups) {
      if (leftKeys.has(groupDedupeKey(g))) return null;
    }

    const groups = extractNamesFromList([...leftGroups, ...rightGroups]);
    if (groups.length < 2) return null;

    return {
      ...base,
      groups,
      leftGroups,
      rightGroups,
      direction: normalizeDirection(raw),
    };
  }

  const groups = extractGroupNames(raw);
  if (groups.length < 2) return null;

  return {
    ...base,
    groups,
  };
}

function readFile() {
  try {
    const parsed = pgCache.caches.channelPatches;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[channelPatch.store] Failed to read:", err.message || err);
    return [];
  }
}

function writeFile(items) {
  pgCache.replaceChannelPatches(items);
}

function load() {
  if (_cache) return _cache.slice();
  const items = pgCache.dedupeChannelPatches(
    readFile()
      .map((row) => normalizePatch(row))
      .filter(Boolean)
  );
  _cache = items;
  return items.slice();
}

function save(items) {
  const arr = pgCache.dedupeChannelPatches(
    (Array.isArray(items) ? items : [])
      .map((row) => normalizePatch(row))
      .filter(Boolean)
  );
  _cache = arr;
  writeFile(arr);
  return arr.slice();
}

function persistCached() {
  writeFile(_cache || []);
}

function list() {
  return load();
}

function listEnabled() {
  return load().filter((p) => p.enabled);
}

function getById(id) {
  const key = safeStr(id).trim();
  if (!key) return null;
  return load().find((p) => p.id === key) || null;
}

function invalidPatchError() {
  const err = new Error(
    "Invalid patch: select at least two distinct channels (uni: one+ on each side, no overlap)."
  );
  err.status = 400;
  return err;
}

function create(input, actorName) {
  const patch = normalizePatch(
    {
      ...input,
      id: crypto.randomUUID(),
      createdBy: safeStr(actorName).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastForwardAt: null,
      lastError: null,
    },
    { assignId: true }
  );
  if (!patch) throw invalidPatchError();
  const items = load();
  items.push(patch);
  save(items);
  return patch;
}

function update(id, patchFields) {
  const key = safeStr(id).trim();
  const items = load();
  const idx = items.findIndex((p) => p.id === key);
  if (idx < 0) {
    const err = new Error("Patch not found");
    err.status = 404;
    throw err;
  }

  const prev = items[idx];
  const merged = {
    ...prev,
    ...patchFields,
    id: prev.id,
    createdBy: prev.createdBy,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  };

  // When switching to bidirectional, drop uni-only fields so normalize does not
  // accidentally keep stale left/right as the source of truth.
  const nextMode = normalizeMode(merged);
  if (nextMode === "bidirectional") {
    delete merged.leftGroups;
    delete merged.rightGroups;
    delete merged.direction;
  }

  if (patchFields && Object.prototype.hasOwnProperty.call(patchFields, "enabled")) {
    merged.enabled =
      patchFields.enabled !== false &&
      patchFields.enabled !== "false" &&
      patchFields.enabled !== 0;
  }

  const next = normalizePatch(merged);
  if (!next) throw invalidPatchError();

  if (
    patchFields &&
    !Object.prototype.hasOwnProperty.call(patchFields, "lastForwardAt")
  ) {
    next.lastForwardAt = prev.lastForwardAt || null;
  }
  if (
    patchFields &&
    !Object.prototype.hasOwnProperty.call(patchFields, "lastError")
  ) {
    next.lastError = prev.lastError || null;
  }
  if (
    patchFields &&
    !Object.prototype.hasOwnProperty.call(patchFields, "dataSyncApplied")
  ) {
    next.dataSyncApplied = normalizeDataSyncApplied(prev.dataSyncApplied);
  }

  items[idx] = next;
  save(items);
  return next;
}

function remove(id) {
  const key = safeStr(id).trim();
  const items = load();
  const next = items.filter((p) => p.id !== key);
  if (next.length === items.length) {
    const err = new Error("Patch not found");
    err.status = 404;
    throw err;
  }
  save(next);
  return true;
}

function touchRuntime(id, { lastForwardAt, lastError } = {}, options = {}) {
  const key = safeStr(id).trim();
  const items = load();
  const idx = items.findIndex((p) => p.id === key);
  if (idx < 0) return null;
  const row = { ...items[idx] };
  if (lastForwardAt !== undefined) row.lastForwardAt = lastForwardAt;
  if (lastError !== undefined) row.lastError = lastError;
  row.updatedAt = items[idx].updatedAt;
  items[idx] = row;
  _cache = items;
  if (!options || options.persist !== false) writeFile(items);
  return row;
}

function invalidateCache() {
  _cache = null;
}

module.exports = {
  list,
  listEnabled,
  getById,
  create,
  update,
  remove,
  touchRuntime,
  persistCached,
  invalidateCache,
  normalizePatch,
  extractGroupNames,
  groupMatchKey,
  groupDisplayLabel,
  peerLabelsByGroupKeyFromPatches,
  enabledPeerLabelsByGroupKey,
  annotateGroupsWithPatchPeers,
  resolveFlowEnds,
  normalizeMode,
  normalizeDirection,
};
