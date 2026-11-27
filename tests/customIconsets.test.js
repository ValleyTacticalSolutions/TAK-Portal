/**
 * Admin-imported custom icon sets (#143): import validation, persistence on the
 * data volume, usericon resolution against the set, generic fallback, admin-only route.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createZipArchive } = require("../services/zipArchive");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "custom-iconsets-"));
process.env.TAK_CUSTOM_ICONSETS_DIR = tmpRoot;

const customIconsets = require("../services/customIconsets.service");
const mapIcon = require("../services/mapIcon.service");

const UID = "3f9d1c2e-1111-4222-8333-444455556666";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-body"),
]);
const XML = `<iconset name="TNTAK Traffic" uid="${UID}" defaultGroup="Traffic"><icon name="crash.png" group="Traffic"/></iconset>`;

function zip(files) {
  return new Promise((resolve, reject) => {
    const a = createZipArchive();
    const chunks = [];
    a.on("data", (c) => chunks.push(c));
    a.on("end", () => resolve(Buffer.concat(chunks)));
    a.on("error", reject);
    for (const [name, data] of Object.entries(files)) a.append(data, { name });
    a.finalize();
  });
}

async function rejects(files, re) {
  await assert.rejects(
    customIconsets.importZip(await zip(files), { root: tmpRoot }),
    (e) => e instanceof customIconsets.IconsetImportError && re.test(e.message)
  );
}

async function main() {
  // Validation
  // (archiver rewrites ".." itself, so check the path guard directly)
  for (const bad of ["../evil.png", "a/../../evil.png", "/etc/x.png", "C:/x.png", "a\\..\\..\\x.png"]) {
    assert.throws(() => customIconsets.cleanEntryPath(bad), /Unsafe path/, bad);
  }
  await rejects({ "iconset.xml": XML, "Traffic/run.sh": "x" }, /File type not allowed/);
  await rejects({ "iconset.xml": XML, "Traffic/crash.png": "not a png" }, /Not a real PNG/);
  await rejects({ "Traffic/crash.png": PNG }, /exactly one iconset\.xml/);
  await rejects({ "iconset.xml": XML.replace(UID, "bad uid"), "a.png": PNG }, /uid/);
  await assert.rejects(
    customIconsets.importZip(await zip({ "iconset.xml": XML, "a.png": PNG }), {
      root: tmpRoot,
      reservedUids: [UID.toUpperCase()],
    }),
    /bundled/
  );
  await assert.rejects(customIconsets.importZip(Buffer.from("hello world"), { root: tmpRoot }), /not a ZIP/);
  assert.deepStrictEqual(customIconsets.listDirs(tmpRoot), [], "failed imports leave nothing behind");
  assert.deepStrictEqual(fs.readdirSync(tmpRoot), [], "no staging folders left");

  // Import (set nested in a top folder is accepted)
  const info = await customIconsets.importZip(
    await zip({ "TNTAK/iconset.xml": XML, "TNTAK/Traffic/crash.png": PNG }),
    { root: tmpRoot }
  );
  assert.strictEqual(info.uid, UID);
  assert.ok(fs.existsSync(path.join(tmpRoot, UID, "Traffic", "crash.png")));

  // Live map resolves usericon paths against the imported set, bundled sets stay
  await mapIcon.ensureIconsets();
  const sets = mapIcon.listIconsets();
  assert.ok(sets.find((s) => s.uid === UID && s.custom), "custom set is loaded");
  assert.strictEqual(sets.filter((s) => !s.custom).length, mapIcon.REQUIRED_ICONSET_DIRS.length);
  const hit = mapIcon.resolveIcon({
    type: "b-m-p-s-m",
    usericon: { iconsetpath: `${UID}/Traffic/crash.png` },
  });
  assert.ok(hit && hit.iconId === `${UID}:Traffic/crash.png`, "usericon resolves to the custom icon");
  assert.ok(mapIcon.getIconFilePath(hit.iconId), "icon file is served");

  // Persists across a restart: fresh load reads it back from the volume
  await mapIcon.reloadIconsets();
  assert.ok(mapIcon.listIconsets().some((s) => s.uid === UID && s.custom));

  // Missing icon falls back (no custom hit)
  const miss = mapIcon.resolveIcon({
    type: "b-m-p-s-m",
    usericon: { iconsetpath: `${UID}/Traffic/missing.png` },
  });
  assert.ok(!miss || miss.iconsetUid !== UID, "missing custom icon falls back");

  // Remove
  assert.strictEqual(await customIconsets.removeSet(UID, { root: tmpRoot }), true);
  await mapIcon.reloadIconsets();
  assert.ok(!mapIcon.listIconsets().some((s) => s.uid === UID));

  // Route is admin-only (settings permission) and wired
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(
    /\/api\/settings\/icon-sets[\s\S]{0,180}requirePermission\("page\.settings"\)[\s\S]{0,80}customIconsets\.routes/.test(
      serverSrc
    ),
    "icon-sets API requires page.settings"
  );
  const view = fs.readFileSync(path.join(__dirname, "..", "views", "settings.ejs"), "utf8");
  assert.match(view, /data-icon-sets-section/);
  assert.match(view, /<h3>Custom Icon Sets<\/h3>/);
  assert.match(view, /Import ZIP/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("customIconsets tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// --- auto-import from data packages / data syncs (#143) ---
(async () => {
  const autoImport = require("../services/iconsetAutoImport.service");
  assert.strictEqual(autoImport.isEnabled({}), false);
  assert.strictEqual(autoImport.isEnabled({ AUTO_IMPORT_ICONSETS_ENABLED: "true" }), true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "custom-iconsets-auto-"));
  const UID2 = "aaaaaaaa-1111-4222-8333-444455556666";
  const good = await zip({
    "iconset.xml": `<iconset name="Auto" uid="${UID2}"><icon name="a.png"/></iconset>`,
    "a.png": PNG,
  });
  const notIconset = await zip({ "readme.txt": Buffer.from("hi") });
  const files = { h1: good, h2: notIconset, h3: good };
  const downloads = [];
  let imported = 0;
  const deps = {
    root,
    packages: {
      list: async () => ({
        items: [
          { hash: "H1", filename: "traffic.zip", size: 10 },
          { hash: "h2", filename: "other.zip" },
          { hash: "h4", filename: "photo.jpg" },
        ],
      }),
      download: async (h) => {
        downloads.push(h);
        return files[h];
      },
    },
    missions: {
      list: async () => ({ data: [{ name: "m1" }] }),
      get: async () => ({ data: { contents: [{ data: { hash: "h3", name: "set.zip" } }] } }),
    },
    reservedUids: async () => [],
    onImported: async () => {
      imported++;
    },
  };
  const first = await autoImport.runOnce(deps);
  assert.strictEqual(first.imported.length, 2, "package and mission zips import");
  assert.deepStrictEqual(downloads.sort(), ["h1", "h2", "h3"], "non-zip files are never downloaded");
  assert(customIconsets.listDirs(root).includes(UID2));
  assert.strictEqual(imported, 1);

  downloads.length = 0;
  const second = await autoImport.runOnce(deps);
  assert.strictEqual(second.tried, 0, "each hash is tried once");
  assert.deepStrictEqual(downloads, []);
  console.log("auto-import ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

const settingsView = fs.readFileSync(path.join(__dirname, "..", "views", "settings.ejs"), "utf8").replace(/\r\n/g, "\n");
assert(/renderField\("AUTO_IMPORT_ICONSETS_ENABLED"/.test(settingsView), "settings has auto-import toggle");
assert(/"AUTO_IMPORT_ICONSETS_ENABLED",\n\s+"MOU_ENABLED"/.test(settingsView), "toggle is a boolean key");
