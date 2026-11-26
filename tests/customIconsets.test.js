/**
 * Admin-imported custom icon sets (#143): import validation, persistence on the
 * data volume, usericon resolution against the set, generic fallback, admin-only route.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const archiver = require("archiver");

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
    const a = archiver("zip");
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
