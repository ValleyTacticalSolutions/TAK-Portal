/**
 * Upload a client file (APK, IPA, ...) for a custom TAK client (Settings > Supported TAK Clients).
 * Mounted under /api/settings/custom-clients with page.settings permission.
 */
const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const svc = require("../services/customTakClients.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "..", "data", "uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const base = (file.originalname || "client").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `customclient_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!svc.ALLOWED_FILE_EXT.test(String(file.originalname || ""))) {
      return cb(new Error("Unsupported file type. Use .apk, .aab, .ipa, .zip, .exe, .msi, .dmg, .pkg or .deb."));
    }
    return cb(null, true);
  },
});

router.post("/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "File exceeds the 500 MB upload limit." : err.message || "Upload failed.";
      return res.status(400).json({ ok: false, error: message });
    }
    if (!req.file || !req.file.path) {
      return res.status(400).json({ ok: false, error: "No file uploaded." });
    }
    try {
      const info = svc.saveUploadedFile(req.file.path, req.file.originalname);
      try {
        auditSvc.logEvent({
          actor: req.authentikUser || null,
          request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
          action: "CUSTOM_CLIENT_FILE_UPLOADED",
          targetType: "custom_client_file",
          targetId: info.downloadUrl,
          details: { fileName: info.fileName, summary: `Uploaded custom client file ${info.fileName}.` },
        });
      } catch (_) {
        /* never block */
      }
      return res.json({ ok: true, ...info });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
      return res.status(400).json({ ok: false, error: toSafeApiError(e) });
    }
  });
});

module.exports = router;
