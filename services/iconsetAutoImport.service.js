/**
 * Auto-import of ATAK iconset ZIPs found in TAK Server data packages and Data Sync
 * missions (#143). Runs in the worker only while AUTO_IMPORT_ICONSETS_ENABLED is on.
 * Every file hash is tried once and remembered, so a ZIP that is not an iconset
 * (or fails validation) is not downloaded again on every pass.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const customIconsets = require("./customIconsets.service");

const STATE_FILE = ".auto-import.json";
const MAX_SEEN = 5000;

function isEnabled(settings) {
  const v = String((settings && settings.AUTO_IMPORT_ICONSETS_ENABLED) || "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(v);
}

function loadSeen(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), "utf8"));
    return Array.isArray(raw.seen) ? raw.seen.map(String) : [];
  } catch {
    return [];
  }
}

function saveSeen(root, seen) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, STATE_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify({ seen: seen.slice(-MAX_SEEN) }));
  fs.renameSync(tmp, path.join(root, STATE_FILE));
}

function looksLikeZip(name) {
  return /\.zip$/i.test(String(name || "").trim());
}

/** Candidate { hash, name } pairs from data packages and Data Sync mission contents. */
async function collectCandidates({ packages, missions }) {
  const out = new Map();
  const add = (hash, name, size) => {
    const h = String(hash || "").trim().toLowerCase();
    if (!h || out.has(h) || !looksLikeZip(name)) return;
    const n = Number(size);
    if (Number.isFinite(n) && n > customIconsets.LIMITS.zipBytes) return;
    out.set(h, { hash: h, name: String(name) });
  };

  try {
    const res = await packages.list();
    for (const p of res?.items || []) add(p.hash, p.filename, p.size);
  } catch (err) {
    console.warn("[iconset-auto-import] data packages:", err?.message || err);
  }

  try {
    const raw = await missions.list();
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    for (const m of list) {
      if (!m || !m.name) continue;
      try {
        const detail = await missions.get(m.name);
        const body = Array.isArray(detail?.data) ? detail.data[0] : detail?.data || detail;
        for (const c of body?.contents || []) {
          const d = c && c.data ? c.data : c;
          add(d?.hash || d?.Hash, d?.name || d?.filename || d?.fileName, d?.size);
        }
      } catch (err) {
        console.warn("[iconset-auto-import] mission:", err?.message || err);
      }
    }
  } catch (err) {
    console.warn("[iconset-auto-import] data syncs:", err?.message || err);
  }
  return [...out.values()];
}

/**
 * One pass. Returns { imported: [{uid,name,file}], tried }.
 * deps: packages{list,download}, missions{list,get}, reservedUids(), onImported(), root.
 */
async function runOnce(deps) {
  const root = deps.root || customIconsets.CUSTOM_ROOT;
  const seen = new Set(loadSeen(root));
  const candidates = (await collectCandidates(deps)).filter((c) => !seen.has(c.hash));
  const imported = [];
  for (const c of candidates) {
    seen.add(c.hash);
    try {
      const buf = await deps.packages.download(c.hash);
      const info = await customIconsets.importZip(buf, {
        root,
        reservedUids: await deps.reservedUids(),
      });
      imported.push({ uid: info.uid, name: info.name, file: c.name });
    } catch (err) {
      // Not an iconset, or invalid: remembered so it is not retried.
      if (!(err instanceof customIconsets.IconsetImportError)) {
        seen.delete(c.hash); // transient (download/network): try again next pass
      }
    }
  }
  saveSeen(root, [...seen]);
  if (imported.length && deps.onImported) await deps.onImported(imported);
  return { imported, tried: candidates.length };
}

let running = false;

/** Worker entry: real services, only when the setting is on and TAK is reachable. */
async function runIfEnabled() {
  const settingsSvc = require("./settings.service");
  if (!isEnabled(settingsSvc.getSettings()) || running) return null;
  running = true;
  try {
    const mapIcon = require("./mapIcon.service");
    const dataPackages = require("./dataPackages.service");
    const dataSync = require("./dataSync.service");
    return await runOnce({
      packages: {
        list: () => dataPackages.listDataPackages({}),
        download: (h) => dataPackages.downloadDataPackageBuffer(h, { maxBytes: customIconsets.LIMITS.zipBytes }),
      },
      missions: { list: () => dataSync.listMissions({}), get: (n) => dataSync.getMission(n) },
      reservedUids: async () => {
        await mapIcon.ensureIconsets();
        return mapIcon.listIconsets().filter((s) => !s.custom).map((s) => s.uid);
      },
      onImported: async (items) => {
        await mapIcon.reloadIconsets();
        for (const i of items) console.log(`[iconset-auto-import] imported ${i.name} from ${i.file}`);
      },
    });
  } finally {
    running = false;
  }
}

/** Signature of stored custom sets (names + iconset.xml mtimes). */
function customSetSignature(root = customIconsets.CUSTOM_ROOT) {
  return customIconsets
    .listDirs(root)
    .sort()
    .map((n) => {
      try {
        return n + ":" + fs.statSync(path.join(root, n, "iconset.xml")).mtimeMs;
      } catch {
        return n;
      }
    })
    .join("|");
}

/**
 * Web process: the worker imports sets on disk, so reload the icon cache when the
 * stored sets change. Returns the interval handle.
 */
function startWebWatcher({ intervalMs = 30 * 1000, root } = {}) {
  let last = customSetSignature(root);
  const t = setInterval(async () => {
    try {
      const now = customSetSignature(root);
      if (now === last) return;
      last = now;
      await require("./mapIcon.service").reloadIconsets();
      await require("./cotStream.service").refreshAllMarkerIcons();
    } catch (_) {
      /* quiet */
    }
  }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  customSetSignature,
  startWebWatcher, isEnabled, runOnce, runIfEnabled, collectCandidates, STATE_FILE };
