/**
 * Admin import / list / remove of custom ATAK iconset ZIPs for the live map.
 * Mounted at /api/settings/icon-sets behind requirePermission("page.settings").
 */
const router = require("express").Router();
const multer = require("multer");
const mapIcon = require("../services/mapIcon.service");
const customIconsets = require("../services/customIconsets.service");
const cotStream = require("../services/cotStream.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: customIconsets.LIMITS.zipBytes, files: 1 },
});

function audit(req, action, uid, summary) {
  try {
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action,
      targetType: "map_iconset",
      targetId: String(uid || ""),
      details: { summary },
    });
  } catch (_) {
    /* never block */
  }
}

async function listCustom() {
  await mapIcon.ensureIconsets();
  return mapIcon.listIconsets().filter((s) => s.custom);
}

router.get("/", async (req, res) => {
  try {
    return res.json({ ok: true, iconsets: await listCustom() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/", (req, res) => {
  upload.single("iconset")(req, res, async (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "ZIP is larger than 50 MB." : "Upload failed.";
      return res.status(400).json({ ok: false, error: message });
    }
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "No ZIP uploaded." });
      await mapIcon.ensureIconsets();
      const reservedUids = mapIcon
        .listIconsets()
        .filter((s) => !s.custom)
        .map((s) => s.uid);
      const info = await customIconsets.importZip(req.file.buffer, { reservedUids });
      await mapIcon.reloadIconsets();
      void cotStream.refreshAllMarkerIcons().catch(() => {});
      audit(req, "MAP_ICONSET_IMPORTED", info.uid, `Imported map icon set ${info.name}.`);
      return res.json({ ok: true, imported: info, iconsets: await listCustom() });
    } catch (e) {
      if (e instanceof customIconsets.IconsetImportError) {
        return res.status(400).json({ ok: false, error: e.message });
      }
      return res.status(500).json({ ok: false, error: toSafeApiError(e) });
    }
  });
});

router.delete("/:uid", async (req, res) => {
  try {
    const uid = String(req.params.uid || "");
    const isCustom = (await listCustom()).some((s) => s.uid.toLowerCase() === uid.toLowerCase());
    if (!isCustom) return res.status(404).json({ ok: false, error: "Icon set not found." });
    await customIconsets.removeSet(uid);
    await mapIcon.reloadIconsets();
    void cotStream.refreshAllMarkerIcons().catch(() => {});
    audit(req, "MAP_ICONSET_REMOVED", uid, "Removed a custom map icon set.");
    return res.json({ ok: true, iconsets: await listCustom() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
