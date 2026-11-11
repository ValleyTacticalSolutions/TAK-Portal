/**
 * Persist historical Authentik/portal group rename aliases so Data Sync mission
 * channel labels can resolve older CNs after a rename (including when TAK still
 * holds a prior name because an earlier propagate missed).
 *
 * Map shape: { [canonicalOldKey]: "Current CN" }
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "group-rename-aliases.json");

let _cache = null;
let _auditBackfillDone = false;

function canonicalKey(name) {
  let n = String(name || "").trim().toLowerCase();
  if (n.startsWith("tak_")) n = n.slice(4);
  return n.replace(/\s+/g, " ").trim();
}

function toCn(name) {
  let n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) n = n.slice(4);
  return n.trim();
}

function load() {
  if (_cache && typeof _cache === "object") return { ..._cache };
  try {
    if (!fs.existsSync(FILE)) {
      _cache = {};
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    _cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    _cache = {};
  }
  return { ..._cache };
}

function save(map) {
  const next = map && typeof map === "object" && !Array.isArray(map) ? { ...map } : {};
  _cache = next;
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(
      "[groupRenameAlias] Failed to persist aliases:",
      err?.message || err
    );
  }
}

/** Resolve a mission/package CN through the alias table to the latest CN. */
function resolve(name) {
  const cn = toCn(name);
  const key = canonicalKey(cn);
  if (!key) return cn;
  const aliases = load();
  const mapped = aliases[key];
  if (!mapped) return cn;
  return toCn(mapped) || cn;
}

/**
 * Record old→new mappings. Re-points any prior aliases that landed on an old key.
 * @param {Map|object} renameMap canonicalKey → new CN
 */
function record(renameMap) {
  const entries =
    renameMap instanceof Map
      ? [...renameMap.entries()]
      : Object.entries(renameMap || {});
  if (!entries.length) return load();

  const aliases = load();
  const forward = new Map();
  for (const [oldRaw, newRaw] of entries) {
    const oldK = canonicalKey(oldRaw);
    const newCn = toCn(newRaw);
    const newK = canonicalKey(newCn);
    if (!oldK || !newCn || oldK === newK) continue;
    forward.set(oldK, newCn);
  }
  if (!forward.size) return aliases;

  for (const [oldK, newCn] of forward) {
    aliases[oldK] = newCn;
  }
  // Collapse chains: anything pointing at a renamed key now points at the new CN.
  for (const [k, v] of Object.entries(aliases)) {
    const vk = canonicalKey(v);
    if (forward.has(vk)) aliases[k] = forward.get(vk);
  }
  save(aliases);
  return aliases;
}

/**
 * Expand a rename map with every historical alias that should move to targetCn.
 */
function expandMap(renameMap, targetName) {
  const targetCn = toCn(targetName);
  const targetK = canonicalKey(targetCn);
  const out = new Map(renameMap instanceof Map ? renameMap : []);
  if (!targetK || !targetCn) return out;

  for (const [k, v] of out) {
    out.set(k, toCn(v) || targetCn);
  }

  const aliases = load();
  for (const [oldK, v] of Object.entries(aliases)) {
    if (!oldK || oldK === targetK) continue;
    // Alias already targets this channel, or points at something we are renaming away.
    if (canonicalKey(v) === targetK || out.has(canonicalKey(v)) || out.has(oldK)) {
      out.set(oldK, targetCn);
    }
  }
  return out;
}

/**
 * Pull UPDATE_GROUP audit rows into the alias table (once per process).
 * latest name per target_id wins; every beforeName maps to that latest CN.
 */
async function backfillFromAudit(limit = 500) {
  if (_auditBackfillDone) return load();
  _auditBackfillDone = true;
  try {
    const db = require("./db");
    if (!db.isConfigured()) return load();
    // Prefer the most recent renames, then walk oldest→newest so the final
    // name per target wins while collecting every beforeName in the chain.
    const r = await db.query(
      `SELECT target_id, details, timestamp
       FROM audit_events
       WHERE action = $1 AND target_type = $2
       ORDER BY timestamp DESC
       LIMIT $3`,
      ["UPDATE_GROUP", "group", Math.max(50, Number(limit) || 500)]
    );
    const rows = [...(r.rows || [])].reverse();
    const latestByTarget = new Map();
    const beforesByTarget = new Map();
    for (const row of rows) {
      const tid = String(row.target_id || "").trim();
      if (!tid) continue;
      const d = row.details && typeof row.details === "object" ? row.details : {};
      const before = toCn(d.beforeName);
      const next = toCn(d.name);
      if (!beforesByTarget.has(tid)) beforesByTarget.set(tid, []);
      if (before) beforesByTarget.get(tid).push(before);
      if (next) latestByTarget.set(tid, next);
    }
    const aliases = load();
    for (const [tid, latest] of latestByTarget) {
      const latestK = canonicalKey(latest);
      if (!latestK) continue;
      for (const before of beforesByTarget.get(tid) || []) {
        const oldK = canonicalKey(before);
        if (!oldK || oldK === latestK) continue;
        aliases[oldK] = latest;
      }
    }
    save(aliases);
  } catch (err) {
    console.warn(
      "[groupRenameAlias] Audit backfill failed:",
      err?.message || err
    );
  }
  return load();
}

/**
 * Historical names for one group from audit (beforeName + name), for propagate expand.
 */
async function historicalNamesForGroup(groupId) {
  const id = String(groupId || "").trim();
  const names = [];
  if (!id) return names;
  try {
    const db = require("./db");
    if (!db.isConfigured()) return names;
    const r = await db.query(
      `SELECT details FROM audit_events
       WHERE action = $1 AND target_type = $2 AND target_id = $3
       ORDER BY timestamp DESC
       LIMIT 100`,
      ["UPDATE_GROUP", "group", id]
    );
    for (const row of r.rows || []) {
      const d = row.details && typeof row.details === "object" ? row.details : {};
      if (d.beforeName) names.push(String(d.beforeName));
      if (d.name) names.push(String(d.name));
    }
  } catch (err) {
    console.warn(
      "[groupRenameAlias] Failed to load audit history:",
      err?.message || err
    );
  }
  return names;
}

function resetForTests() {
  _cache = {};
  _auditBackfillDone = false;
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch (_) {}
}

module.exports = {
  FILE,
  canonicalKey,
  toCn,
  load,
  save,
  resolve,
  record,
  expandMap,
  backfillFromAudit,
  historicalNamesForGroup,
  resetForTests,
};
