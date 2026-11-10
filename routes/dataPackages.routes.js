const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { isTakConfigured } = require("../services/tak.service");
const { getBool, getString } = require("../services/env");
const dataPackagesSvc = require("../services/dataPackages.service");
const dataSyncAccess = require("../services/dataSyncAccess.service");
const auditSvc = require("../services/auditLog.service");
const packageKind = require("../services/packageKind.service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

function takErrMessage(err) {
  const d = err?.response?.data;
  if (d == null) return err?.message || "TAK request failed";
  if (typeof d === "string") return d.slice(0, 2000);
  if (typeof d === "object") {
    return d.error || d.message || d.detail || JSON.stringify(d).slice(0, 1500);
  }
  return String(d);
}

function sendTakError(res, err, fallbackStatus) {
  const code = err?.code;
  if (
    code === "TAK_NOT_CONFIGURED" ||
    code === "TAK_BYPASS" ||
    code === "TAK_CA_MISSING" ||
    code === "INVALID_HASH" ||
    code === "INVALID_UPLOAD" ||
    code === "INVALID_EXPIRATION"
  ) {
    return res.status(400).json({ error: err.message, code });
  }
  if (code === "NOT_FOUND") {
    return res.status(404).json({ error: err.message, code });
  }
  const status = err?.response?.status;
  const outStatus =
    typeof status === "number" && status >= 400 && status < 600 ? status : fallbackStatus || 502;
  return res.status(outStatus).json({
    error: takErrMessage(err),
    code: err?.code,
    takStatus: status,
  });
}

function sendAccessError(res, err) {
  const code = err?.code;
  if (code === "FORBIDDEN" || code === "MISSION_ACCESS_DENIED") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return null;
}

function handleRouteError(res, err) {
  const handled = sendAccessError(res, err);
  if (handled) return handled;
  return sendTakError(res, err);
}

async function assertWriteGroups(req, groups) {
  const authUser = req.authentikUser || null;
  const allowedKeySet = await dataSyncAccess.getAllowedCanonicalKeySet(authUser);
  dataSyncAccess.assertGroupAllowed({ groups }, allowedKeySet);
}

function firstVal(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (obj[k] != null && obj[k] !== "") return String(obj[k]);
  }
  return "";
}

function normalizeKeywordList(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (keywords == null || keywords === "") return [];
  return String(keywords)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function groupsFromRequest(body) {
  if (!body || typeof body !== "object") return [];
  if (body.groups != null) return dataPackagesSvc.normalizeGroupsList(body.groups);
  if (body.group != null) return dataPackagesSvc.normalizeGroupsList(body.group);
  return [];
}

function resolveDataPackageMetadataAction(keywords) {
  const lower = normalizeKeywordList(keywords).map((k) => k.toLowerCase());
  if (lower.includes(String(packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION").toLowerCase())) {
    return "DATA_PACKAGE_ARCHIVED";
  }
  if (lower.includes(String(packageKind.PACKAGE_ACTIVE_KEYWORD || "missionpackage").toLowerCase())) {
    return "DATA_PACKAGE_RESTORED";
  }
  return "DATA_PACKAGE_METADATA_UPDATED";
}

const DATA_PACKAGE_SUMMARIES = {
  DATA_PACKAGE_UPLOADED: (label) => `Uploaded data package "${label}".`,
  DATA_PACKAGE_DOWNLOADED: (label) => `Downloaded data package "${label}".`,
  DATA_PACKAGE_DELETED: (label) => `Permanently deleted data package "${label}".`,
  DATA_PACKAGE_ARCHIVED: (label) => `Archived data package "${label}".`,
  DATA_PACKAGE_RESTORED: (label) => `Restored data package "${label}" to active.`,
  DATA_PACKAGE_METADATA_UPDATED: (label) => `Updated metadata for data package "${label}".`,
};

function auditDataPackage(req, action, hash, details = {}) {
  const h = String(hash || "").trim();
  const fileName = String(details.fileName || details.filename || "").trim();
  const label = fileName || h || "data package";
  const summaryFn = DATA_PACKAGE_SUMMARIES[action];
  auditSvc.auditFromRequest(req, {
    action,
    targetType: "data_package",
    targetId: h || fileName,
    details: {
      hash: h || undefined,
      fileName: fileName || undefined,
      summary:
        details.summary || (summaryFn ? summaryFn(label) : `Data package ${action} on "${label}".`),
      ...details,
    },
  });
}

function fileNameFromRequest(req, body) {
  const q = req && req.query ? req.query : {};
  const b = body && typeof body === "object" ? body : {};
  return String(
    q.fileName ||
      q.filename ||
      q.name ||
      q.title ||
      b.fileName ||
      b.filename ||
      b.name ||
      b.title ||
      ""
  ).trim();
}

async function resolveDataPackageLabel(hash, hint) {
  const fromHint = String(hint || "").trim();
  if (fromHint) return fromHint;
  const h = String(hash || "").trim();
  if (!h) return "";
  try {
    const meta = await dataPackagesSvc.getDataPackageMetadata(h);
    return firstVal(meta, ["filename", "name", "original_filename"]) || h;
  } catch (_) {
    return h;
  }
}

router.get("/status", (req, res) => {
  const bypass = getBool("TAK_BYPASS_ENABLED", false);
  let takHost = "";
  try {
    const u = new URL(String(getString("TAK_URL", "") || "").trim());
    takHost = u.host || "";
  } catch (_) {
    takHost = "";
  }
  res.json({
    configured: !!(isTakConfigured() && !bypass),
    bypassed: bypass,
    takHost,
  });
});

/** Authentik-backed group list (same source of truth / agency scope as Data Sync). */
router.get("/groups", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const resolved = await dataSyncAccess.resolveGroupsForUser(authUser, []);
    if (String(req.query.debug || "") === "1") {
      return res.json({ data: resolved.groups, _debug: resolved.debug });
    }
    return res.json(resolved.groups);
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.get("/packages", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const data = await dataSyncAccess.listDataPackagesForUser(authUser);
    return res.json(data);
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.get("/packages/:hash/metadata", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const fileNameHint = fileNameFromRequest(req);
    await dataSyncAccess.assertDataPackageAllowed(authUser, req.params.hash, {
      fileName: fileNameHint,
    });
    const out = await dataPackagesSvc.getDataPackageMetadata(req.params.hash, {
      fileName: fileNameHint,
    });
    return res.json(out);
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.post("/packages/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.size) {
      return res.status(400).json({ error: "Select a file to upload." });
    }

    const groups = groupsFromRequest(req.body || {});
    if (!groups.length) {
      return res.status(400).json({ error: "Select at least one assigned group / channel." });
    }
    await assertWriteGroups(req, groups);

    const title = String(
      (req.body && (req.body.title || req.body.name || req.body.filename)) ||
        file.originalname ||
        ""
    ).trim();
    const uploadName = title || String(file.originalname || "data-package.zip");
    const expirationRaw =
      req.body && (req.body.expiration != null || req.body.Expiration != null)
        ? req.body.expiration != null
          ? req.body.expiration
          : req.body.Expiration
        : "";
    const expirationMs = dataPackagesSvc.parseExpirationMillis(expirationRaw);
    if (expirationMs != null && expirationMs <= Date.now()) {
      return res.status(400).json({
        error: "Expiration date/time must be in the future.",
        code: "INVALID_EXPIRATION",
      });
    }
    // Groups must be applied on Marti missionupload (`Groups` query params).
    // Post-upload metadata PUT cannot reliably replace the cert's full group vector.
    const out = await dataPackagesSvc.uploadDataPackage(file.buffer, uploadName, {
      mimeType: file.mimetype || "application/octet-stream",
      keywords: "missionpackage",
      tool: "public",
      groups,
      creator_uid: req.body && req.body.creator_uid ? String(req.body.creator_uid) : "",
    });

    const computedHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const hash = dataPackagesSvc.extractUploadHash(out, computedHash);
    // Filename/Groups are applied on missionupload. Name/expiration metadata is best-effort.
    const metaPatch = {};
    if (title) metaPatch.title = title;
    if (expirationMs != null) metaPatch.expiration = expirationMs;
    let metadataApplied = false;
    let metadataApplyError;
    if (hash && Object.keys(metaPatch).length) {
      try {
        await dataPackagesSvc.updateDataPackageMetadata(hash, metaPatch);
        metadataApplied = true;
      } catch (metaErr) {
        metadataApplyError = metaErr?.message || String(metaErr);
      }
    }

    auditDataPackage(req, "DATA_PACKAGE_UPLOADED", hash, {
      fileName: uploadName,
      sizeBytes: file.size,
      hash,
      title: title || undefined,
      groups: groups.length ? groups : undefined,
      expiration: expirationMs || undefined,
      metadataApplied: Object.keys(metaPatch).length ? metadataApplied : undefined,
      metadataApplyError,
    });
    return res.json({
      ...(out && typeof out === "object" ? out : { raw: out }),
      hash,
      title: title || uploadName,
      groups,
      expiration: expirationMs || undefined,
      metadataApplied: Object.keys(metaPatch).length ? metadataApplied : undefined,
      metadataApplyError,
    });
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.get("/packages/download", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const hash = req.query && req.query.hash ? String(req.query.hash) : "";
    const fileNameHint = fileNameFromRequest(req);
    await dataSyncAccess.assertDataPackageAllowed(authUser, hash, { fileName: fileNameHint });
    const r = await dataPackagesSvc.downloadDataPackageStream(hash);

    if (r.status >= 400) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        r.data.on("data", (c) => chunks.push(c));
        r.data.on("end", resolve);
        r.data.on("error", reject);
      });
      const msg = Buffer.concat(chunks).toString("utf8").slice(0, 2000) || "Download failed";
      return res.status(r.status).json({ error: msg });
    }

    res.status(r.status);
    const zipName = dataPackagesSvc.zipDownloadFilename(fileNameHint, hash);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    const cl = r.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);

    const label = await resolveDataPackageLabel(hash, fileNameHint);
    auditDataPackage(req, "DATA_PACKAGE_DOWNLOADED", hash, { fileName: label });
    r.data.pipe(res);
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.delete("/packages/:hash", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const hash = req.params.hash;
    const fileNameHint = fileNameFromRequest(req, req.body);
    await dataSyncAccess.assertDataPackageAllowed(authUser, hash, { fileName: fileNameHint });
    const label = await resolveDataPackageLabel(hash, fileNameHint);
    const out = await dataPackagesSvc.deleteDataPackage(hash);
    auditDataPackage(req, "DATA_PACKAGE_DELETED", hash, { fileName: label });
    return res.json(out || { ok: true });
  } catch (err) {
    return handleRouteError(res, err);
  }
});

router.put("/packages/:hash/metadata", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hash = req.params.hash;
    // Prefer the pre-edit name so hash twins resolve to the clicked row.
    const priorName = String(
      body.priorFileName || body.priorFilename || body.originalFileName || body.originalFilename || ""
    ).trim();
    const fileNameHint = priorName || fileNameFromRequest(req, body);
    await dataSyncAccess.assertDataPackageAllowed(authUser, hash, { fileName: fileNameHint });
    const label = await resolveDataPackageLabel(hash, fileNameHint);
    const keywords = body.keywords;
    const groups = Object.prototype.hasOwnProperty.call(body, "groups")
      ? groupsFromRequest(body)
      : undefined;
    if (groups) {
      if (!groups.length) {
        return res.status(400).json({ error: "Select at least one assigned group / channel." });
      }
      await assertWriteGroups(req, groups);
    }
    const title = String(body.title || body.name || body.filename || "").trim();
    const action = resolveDataPackageMetadataAction(keywords);
    const out = await dataPackagesSvc.updateDataPackageMetadata(hash, {
      tool: body.tool,
      keywords: body.keywords,
      groups,
      title: title || undefined,
      installOnEnrollment: body.installOnEnrollment,
      installOnConnection: body.installOnConnection,
    });
    auditDataPackage(req, action, hash, {
      fileName: title || label,
      tool: body.tool,
      keywords: normalizeKeywordList(keywords),
      groups,
      title: title || undefined,
      installOnEnrollment: body.installOnEnrollment,
      installOnConnection: body.installOnConnection,
    });
    return res.json(out);
  } catch (err) {
    return handleRouteError(res, err);
  }
});

module.exports = router;
