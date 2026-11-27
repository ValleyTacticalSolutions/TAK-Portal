/**
 * Admin-imported ATAK-style iconset ZIPs for the live map.
 * Stored under data/custom-iconsets/<uid>/ (the data volume), so they survive
 * container restarts and updates. Bundled sets in assets/map-icons are never touched.
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const unzipper = require("unzipper");
const { resolveInside } = require("./safePath");
const { isIconsetUidToken } = require("./mapIcon.resolve");

const CUSTOM_ROOT =
  process.env.TAK_CUSTOM_ICONSETS_DIR ||
  path.join(__dirname, "..", "data", "custom-iconsets");

const LIMITS = {
  zipBytes: 50 * 1024 * 1024,
  entries: 5000,
  fileBytes: 2 * 1024 * 1024,
  xmlBytes: 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class IconsetImportError extends Error {}

function fail(msg) {
  throw new IconsetImportError(msg);
}

function xmlAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

/** Normalize a ZIP entry path; returns null for entries to skip, throws on unsafe paths. */
function cleanEntryPath(raw) {
  const p = String(raw || "").replace(/\\/g, "/");
  if (p.includes("\0")) fail("Unsafe path in ZIP.");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) fail("Unsafe path in ZIP.");
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "..")) fail("Unsafe path in ZIP.");
  if (!parts.length) return null;
  if (parts[0] === "__MACOSX") return null;
  if (parts[parts.length - 1].startsWith(".")) return null;
  return parts.join("/");
}

function uidDir(uid) {
  if (!isIconsetUidToken(uid)) fail("Iconset uid is missing or invalid.");
  return String(uid).toLowerCase();
}

/**
 * Validate and store an ATAK iconset ZIP. Returns { uid, name, iconCount }.
 * Replaces an earlier import with the same uid. `reservedUids` are bundled sets.
 */
async function importZip(buffer, { root = CUSTOM_ROOT, reservedUids = [] } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) fail("Upload a ZIP file.");
  if (buffer.length > LIMITS.zipBytes) fail("ZIP is larger than 50 MB.");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) fail("File is not a ZIP.");

  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    fail("File is not a valid ZIP.");
  }

  const files = directory.files.filter((f) => f.type !== "Directory");
  if (files.length > LIMITS.entries) fail("ZIP has too many files.");

  const entries = [];
  for (const f of files) {
    const rel = cleanEntryPath(f.path);
    if (!rel) continue;
    entries.push({ rel, file: f });
  }

  const xmlEntries = entries.filter((e) => /(^|\/)iconset\.xml$/i.test(e.rel));
  if (xmlEntries.length !== 1) fail("ZIP must contain exactly one iconset.xml.");
  const xmlEntry = xmlEntries[0];
  const prefix = xmlEntry.rel.slice(0, xmlEntry.rel.length - "iconset.xml".length);
  if (prefix.split("/").filter(Boolean).length > 1) fail("iconset.xml must be at the top of the ZIP.");

  let total = 0;
  const pngs = [];
  for (const e of entries) {
    if (e === xmlEntry) continue;
    if (prefix && !e.rel.startsWith(prefix)) fail("ZIP has files outside the iconset folder.");
    const rel = e.rel.slice(prefix.length);
    if (!/\.png$/i.test(rel)) fail(`File type not allowed: ${rel}`);
    const size = Number(e.file.uncompressedSize || 0);
    if (size > LIMITS.fileBytes) fail(`Icon is larger than 2 MB: ${rel}`);
    total += size;
    if (total > LIMITS.totalBytes) fail("ZIP is too large when unpacked.");
    pngs.push({ rel, file: e.file });
  }
  if (!pngs.length) fail("ZIP has no PNG icons.");

  if (Number(xmlEntry.file.uncompressedSize || 0) > LIMITS.xmlBytes) fail("iconset.xml is too large.");
  const xml = (await xmlEntry.file.buffer()).toString("utf8");
  const header = xml.match(/<iconset[^>]*>/i);
  if (!header) fail("iconset.xml has no <iconset> element.");
  const uid = xmlAttr(header[0], "uid");
  const dir = uidDir(uid);
  if (reservedUids.some((r) => String(r).toLowerCase() === dir)) {
    fail("That iconset uid is already used by a bundled icon set.");
  }
  const name = xmlAttr(header[0], "name") || dir;
  const iconCount = [...xml.matchAll(/<icon\s/gi)].length;

  await fsp.mkdir(root, { recursive: true });
  const stage = await fsp.mkdtemp(path.join(root, ".import-"));
  try {
    await fsp.writeFile(path.join(stage, "iconset.xml"), xml);
    let written = 0;
    for (const p of pngs) {
      const buf = await p.file.buffer();
      if (buf.length > LIMITS.fileBytes) fail(`Icon is larger than 2 MB: ${p.rel}`);
      written += buf.length;
      if (written > LIMITS.totalBytes) fail("ZIP is too large when unpacked.");
      if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
        fail(`Not a real PNG: ${p.rel}`);
      }
      const dest = resolveInside(stage, p.rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    }
    const finalDir = resolveInside(root, dir);
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(stage, finalDir);
  } catch (err) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { uid, name, iconCount, pngCount: pngs.length };
}

/** Directory names of stored custom sets. */
function listDirs(root = CUSTOM_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(root, n, "iconset.xml")));
}

async function removeSet(uid, { root = CUSTOM_ROOT } = {}) {
  const dir = uidDir(uid);
  const target = resolveInside(root, dir);
  if (!fs.existsSync(target)) return false;
  await fsp.rm(target, { recursive: true, force: true });
  return true;
}

module.exports = {
  CUSTOM_ROOT,
  LIMITS,
  IconsetImportError,
  importZip,
  listDirs,
  removeSet,
  cleanEntryPath,
};
