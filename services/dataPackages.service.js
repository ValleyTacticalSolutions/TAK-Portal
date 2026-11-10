/**
 * Data package service for TAK/OpenTAK.
 * Lists packages via Marti `/Marti/api/files/metadata` (Data Packages + archived Data Sync).
 */
const crypto = require("crypto");
const util = require("util");
const {
  buildTakAxios,
  getTakBaseUrl,
  isTakConfigured,
  ensureTakCaAvailable,
} = require("./tak.service");
const { getBool } = require("./env");
const packageKind = require("./packageKind.service");

function isDebugEnabled() {
  return getBool("TAK_DEBUG", false);
}

function dbg(...args) {
  if (!isDebugEnabled()) return;
  console.log("[data-packages]", ...args);
}

function dbgVerbose(label, value) {
  if (!isDebugEnabled()) return;
  try {
    const json = JSON.stringify(value, null, 2);
    if (json && json.length <= 40000) {
      console.log(`[data-packages][verbose] ${label}\n${json}`);
      return;
    }
  } catch (_) {
    // Fall through to util.inspect
  }
  console.log(
    `[data-packages][verbose] ${label}\n${util.inspect(value, {
      depth: 8,
      maxArrayLength: 200,
      maxStringLength: 12000,
      breakLength: 140,
      compact: false,
    })}`
  );
}

function listKeysDeep(obj, prefix = "", out = new Set(), depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < 25; i++) {
      const v = obj[i];
      const path = `${prefix}[${i}]`;
      out.add(path);
      if (v && typeof v === "object") listKeysDeep(v, path, out, depth + 1);
    }
    return out;
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      listKeysDeep(v, path, out, depth + 1);
    }
  }
  return out;
}

async function assertTakAvailable() {
  if (getBool("TAK_BYPASS_ENABLED", false)) {
    const e = new Error("TAK operations are disabled (TAK_BYPASS_ENABLED=true).");
    e.code = "TAK_BYPASS";
    throw e;
  }
  if (!isTakConfigured()) {
    const e = new Error("TAK_URL is not configured in Server Settings.");
    e.code = "TAK_NOT_CONFIGURED";
    throw e;
  }
  // Installer/settings often point at ./certs/tak-ca.pem which is outside the
  // persisted data volume. Fetch via privileged SSH when the file is missing.
  await ensureTakCaAvailable();
}

function getTakOriginBaseUrl() {
  const u = new URL(getTakBaseUrl());
  return `${u.protocol}//${u.host}`;
}

function buildTakOriginAxios(options = {}) {
  return buildTakAxios({
    ...options,
    baseURL: getTakOriginBaseUrl(),
  });
}

function normalizeDataPackageList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (payload && payload.data && Array.isArray(payload.data.results)) return payload.data.results;
  if (payload && payload.results && Array.isArray(payload.results.items)) return payload.results.items;
  return [];
}

function parseKeywords(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function scalar(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  return "";
}

function pickScalar(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const out = scalar(obj[keys[i]]);
    if (out) return out;
  }
  return "";
}

function asNumOrRaw(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function normalizePackageRecord(item) {
  const o = item && typeof item === "object" ? item : {};
  const candidates = [
    o,
    o.file,
    o.File,
    o.metadata,
    o.Metadata,
    o.content,
    o.Content,
    o.resource,
    o.Resource,
    o.value,
    o.Value,
  ].filter((x) => x && typeof x === "object");

  let hash = "";
  let filename = "";
  let mimeType = "";
  let size = "";
  let creator = "";
  let created = "";
  let tool = "";
  let keywords = [];
  let groups = "";
  let expiration = "";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!hash) {
      hash = pickScalar(c, [
        "hash",
        "Hash",
        "sha256",
        "SHA256",
        "sha",
        "SHA",
        "checksum",
        "Checksum",
        "contentHash",
        "ContentHash",
        "content_hash",
        "fileHash",
        "FileHash",
        "file_hash",
        "uid",
        "UID",
        "id",
        "ID",
        "key",
        "Key",
        "primaryKey",
        "PrimaryKey",
      ]);
    }
    if (!filename) {
      filename = pickScalar(c, [
        "filename",
        "Filename",
        "fileName",
        "FileName",
        "name",
        "Name",
        "label",
        "Label",
        "title",
        "Title",
        "original_filename",
        "OriginalFilename",
        "downloadName",
        "DownloadName",
        "resource",
        "Resource",
      ]);
    }
    if (!mimeType) {
      mimeType = pickScalar(c, [
        "mime_type",
        "mimeType",
        "MimeType",
        "MIMEType",
        "mimetype",
        "contentType",
        "ContentType",
        "type",
        "Type",
      ]);
    }
    if (!size) {
      size = pickScalar(c, [
        "size",
        "Size",
        "content_length",
        "ContentLength",
        "contentLength",
        "length",
        "Length",
      ]);
    }
    if (!creator) {
      creator = pickScalar(c, [
        "creator_uid",
        "creatorUid",
        "CreatorUID",
        "user",
        "User",
        "creator",
        "Creator",
        "owner",
        "Owner",
        "author",
        "Author",
      ]);
    }
    if (!created) {
      created = pickScalar(c, [
        "created_at",
        "CreatedAt",
        "createTime",
        "CreateTime",
        "created",
        "Created",
        "time",
        "Time",
        "timestamp",
        "Timestamp",
        "submissionDateTime",
        "SubmissionDateTime",
        "updated_at",
      ]);
    }
    if (!tool) tool = pickScalar(c, ["tool", "Tool"]);
    if (!keywords.length) {
      keywords = parseKeywords(
        c.keywords || c.keyword || c.tags || c.Keywords || c.Keyword || c.Tags
      );
    }
    if (!groups) {
      groups = pickScalar(c, [
        "groups",
        "Groups",
        "group",
        "Group",
      ]);
    }
    if (!expiration) {
      expiration = pickScalar(c, [
        "expiration",
        "Expiration",
        "expires",
        "Expires",
        "expiresAt",
        "ExpiresAt",
      ]);
    }
  }

  return {
    ...o,
    hash,
    filename,
    mime_type: mimeType,
    size: asNumOrRaw(size),
    creator_uid: creator,
    created_at: created,
    tool,
    keywords,
    groups,
    expiration,
  };
}

async function listDataPackages(query = {}) {
  await assertTakAvailable();
  const client = buildTakOriginAxios({ timeout: 60000 });
  dbg("list start", { query });
  const res = await client.get("/Marti/api/files/metadata", { params: query || {} });
  dbg("endpoint /Marti/api/files/metadata", {
    status: res.status,
    topKeys: res.data && typeof res.data === "object" ? Object.keys(res.data).slice(0, 20) : [],
  });
  const rawList = normalizeDataPackageList(res.data);
  dbg("raw sample /Marti/api/files/metadata", rawList.slice(0, 2));
  dbgVerbose("raw payload /Marti/api/files/metadata", res.data);
  dbg("deep keys /Marti/api/files/metadata", Array.from(listKeysDeep(res.data)).slice(0, 250));
  const list = normalizeDataPackageList(res.data)
    .map(normalizePackageRecord)
    .filter((x) => x.hash || x.filename)
    .map(packageKind.annotatePackageRecord);
  dbgVerbose("normalized records /Marti/api/files/metadata", list);
  dbg("normalized /Marti/api/files/metadata", {
    rawCount: rawList.length,
    normalizedCount: list.length,
    sample: list.slice(0, 3).map((x) => ({ hash: x.hash, filename: x.filename })),
  });
  return {
    items: list,
    raw: res.data,
    source: "marti_files_metadata",
  };
}

async function deleteDataPackage(hash) {
  await assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 60000 });
  const res = await client.delete(`/Marti/api/files/${encodeURIComponent(h)}`, {
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });
  if (res.status === 404) return { ok: true, alreadyGone: true };
  return res.data || { ok: true };
}

async function downloadDataPackageStream(hash) {
  await assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 180000 });
  const reqOpts = {
    params: { hash: h },
    responseType: "stream",
    validateStatus: () => true,
  };
  const res = await client.get("/Marti/sync/content", reqOpts);
  dbg("download /Marti/sync/content", { hash: h, status: res.status });
  return res;
}

/** Download package bytes for map overlay parsing (bounded). */
async function downloadDataPackageBuffer(hash, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 64 * 1024 * 1024;
  const res = await downloadDataPackageStream(hash);
  if (res.status >= 400) {
    const err = new Error(`Data package download failed (${res.status})`);
    err.status = res.status;
    err.code = "PACKAGE_DOWNLOAD_FAILED";
    throw err;
  }
  const stream = res.data;
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        stream.destroy();
        const err = new Error(`Data package exceeds map overlay size limit (${maxBytes} bytes).`);
        err.code = "PACKAGE_TOO_LARGE";
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

function safeFilename(name, fallback) {
  const cleaned = String(name || "")
    .replace(/[^\w.\- ()\[\]]+/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Force a browser-friendly ZIP download name (TAK often omits .zip). */
function zipDownloadFilename(name, hash) {
  const fallback = `data-package-${String(hash || "file").slice(0, 16)}.zip`;
  let base = safeFilename(name, fallback);
  if (!/\.zip$/i.test(base)) base = `${base}.zip`;
  return base;
}

function normalizeGroupsList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((g) => String(g || "").trim()).filter(Boolean);
  }
  if (raw == null || raw === "") return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return normalizeGroupsList(parsed);
    } catch (_) {
      /* fall through */
    }
  }
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function groupsMetadataValue(groups) {
  return normalizeGroupsList(groups).join(",");
}

function normalizeKeywordList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Build Marti missionupload query params.
 * Groups MUST be set here — without `Groups`, TAK assigns every group on the
 * uploading certificate. Param name is intentionally case-sensitive (`Groups`).
 */
function buildMissionUploadParams({
  hash,
  filename,
  creatorUid,
  groups,
  keywords,
  mimetype,
} = {}) {
  const params = new URLSearchParams();
  const h = String(hash || "").trim();
  const name = String(filename || "").trim();
  const uid = String(creatorUid || "").trim() || "tak-portal";
  if (h) params.append("hash", h);
  if (name) params.append("filename", name);
  params.append("creatorUid", uid);
  if (mimetype) params.append("mimetype", String(mimetype));

  const kw = normalizeKeywordList(keywords);
  if (!kw.some((k) => k.toLowerCase() === "missionpackage")) {
    params.append("keyword", "missionpackage");
  }
  for (const keyword of kw) {
    if (!keyword) continue;
    params.append("keyword", keyword);
  }

  for (const group of normalizeGroupsList(groups)) {
    // Intentionally "Groups" (capital G) — TAK Server is case-sensitive here.
    params.append("Groups", group);
  }
  return params;
}

/** PUT string metadata fields as JSON strings (Marti MetadataApi). */
function metadataStringPutConfig() {
  return {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    transformRequest: [(data) => (typeof data === "string" ? JSON.stringify(data) : data)],
  };
}

/**
 * Parse UI / API expiration into Marti epoch millis.
 * Accepts datetime-local (`YYYY-MM-DDTHH:mm`), ISO strings, or numeric millis/seconds.
 * Returns null when empty / "none".
 */
function parseExpirationMillis(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Heuristic: values below year ~2001 in ms are likely seconds.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const s = String(raw).trim();
  if (!s || /^none$/i.test(s)) return null;
  if (/^\d+$/.test(s)) return parseExpirationMillis(Number(s));
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || ms <= 0) {
    const e = new Error("Expiration date/time is invalid.");
    e.code = "INVALID_EXPIRATION";
    throw e;
  }
  return ms;
}

async function uploadDataPackage(buffer, originalName, metadata = {}) {
  await assertTakAvailable();
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    const e = new Error("File content is required.");
    e.code = "INVALID_UPLOAD";
    throw e;
  }
  const filename = safeFilename(originalName || "data-package.zip", "data-package.zip");
  const mimeType = String(metadata.mimeType || "application/zip");
  const groups = normalizeGroupsList(metadata.groups);
  const keywords = normalizeKeywordList(metadata.keywords);
  const client = buildTakOriginAxios({ timeout: 180000 });
  const BlobCtor = global.Blob || require("node:buffer").Blob;

  // When groups are selected, skip OpenTAK and use Marti missionupload so we
  // can pass the case-sensitive `Groups` query params TAK expects.
  if (!groups.length) {
    try {
      const form = new FormData();
      const blob = new BlobCtor([buffer], { type: mimeType });
      form.append("file", blob, filename);

      Object.keys(metadata || {}).forEach((k) => {
        const v = metadata[k];
        if (v == null || v === "" || k === "mimeType" || k === "groups") return;
        if (Array.isArray(v)) form.append(k, v.join(","));
        else form.append(k, String(v));
      });

      const res = await client.post("/api/data_packages", form, {
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      if (status && status !== 404 && status !== 405) throw err;
    }
  }

  // Marti endpoint for package/file upload (supports Groups query params).
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const creatorUid = String(metadata.creator_uid || metadata.creatorUid || "tak-portal").trim();
  const params = buildMissionUploadParams({
    hash,
    filename,
    creatorUid,
    groups,
    keywords,
    mimetype: mimeType,
  });

  const fallbackForm = new FormData();
  const fallbackBlob = new BlobCtor([buffer], { type: mimeType });
  fallbackForm.append("assetfile", fallbackBlob, filename);
  fallbackForm.append("filename", filename);

  const fallbackRes = await client.post("/Marti/sync/missionupload", fallbackForm, {
    params,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return fallbackRes.data;
}

function extractUploadHash(out, fallbackHash) {
  if (out && typeof out === "object") {
    const h = String(out.hash || out.Hash || out.uid || out.id || "").trim();
    if (h) return h;
  }
  if (typeof out === "string") {
    const m = out.match(/[a-fA-F0-9]{64}/);
    if (m) return m[0];
  }
  return String(fallbackHash || "").trim();
}

/** Exact title/name match (case-insensitive, optional .zip). */
function packageNamesEqual(a, b) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .replace(/\.zip$/i, "")
      .toLowerCase();
  const left = norm(a);
  const right = norm(b);
  return !!left && !!right && left === right;
}

function packageRecordTitle(record) {
  if (!record || typeof record !== "object") return "";
  return String(
    record.filename || record.name || record.title || record.Name || record.original_filename || ""
  ).trim();
}

/**
 * Marti can return multiple file-manager rows that share one content hash.
 * Prefer an exact name match when provided so edit/load picks the clicked row.
 */
function pickPackageRecord(list, { hash, name } = {}) {
  const items = Array.isArray(list) ? list : [];
  const h = String(hash || "")
    .trim()
    .toLowerCase();
  const wantName = String(name || "").trim();
  const byHash = h
    ? items.filter(
        (item) =>
          String(item?.hash || item?.Hash || "")
            .trim()
            .toLowerCase() === h
      )
    : items.slice();
  if (wantName) {
    const exact = (byHash.length ? byHash : items).find((item) =>
      packageNamesEqual(packageRecordTitle(item), wantName)
    );
    if (exact) return exact;
    // Name was provided but no row matched — do not fall back to another hash twin.
    if (byHash.length || items.length) return null;
  }
  return byHash[0] || items[0] || null;
}

async function getDataPackageMetadata(hash, options = {}) {
  await assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const nameHint = String(
    options.name || options.filename || options.fileName || options.title || ""
  ).trim();
  const client = buildTakOriginAxios({ timeout: 60000 });
  const out = {
    hash: h,
    tool: "",
    keywords: [],
    groups: [],
  };
  dbg("metadata start", { hash: h, name: nameHint || undefined });

  try {
    const toolRes = await client.get(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/tool`);
    const d = toolRes.data;
    if (typeof d === "string") out.tool = d.trim();
    else if (d && typeof d === "object") out.tool = String(d.tool || d.value || "").trim();
  } catch (_) {
    // optional endpoint by TAK build
  }

  try {
    const params = { hash: h };
    if (nameHint) params.name = nameHint;
    const listRes = await client.get("/Marti/api/files/metadata", { params });
    const list = normalizeDataPackageList(listRes.data).map(normalizePackageRecord);
    const item = pickPackageRecord(list, { hash: h, name: nameHint });
    if (item) {
      if (!out.tool) out.tool = String(item.tool || "").trim();
      if (!out.keywords || !out.keywords.length) out.keywords = parseKeywords(item.keywords);
      const title = packageRecordTitle(item);
      if (title) {
        out.filename = title;
        out.name = title;
        out.title = title;
      }
      out.groups = normalizeGroupsList(item.groups);
      if (item.expiration != null && item.expiration !== "") out.expiration = item.expiration;
    } else if (nameHint) {
      const e = new Error("Data package not found for that hash and name.");
      e.code = "NOT_FOUND";
      throw e;
    }
  } catch (err) {
    if (err?.code === "NOT_FOUND") throw err;
    // optional metadata source
  }
  dbgVerbose(`metadata resolved payload for ${h}`, out);

  dbg("metadata resolved", {
    hash: h,
    name: out.name || out.filename || "",
    tool: out.tool,
    keywordsCount: Array.isArray(out.keywords) ? out.keywords.length : 0,
    groupsCount: Array.isArray(out.groups) ? out.groups.length : 0,
    installOnEnrollment: out.installOnEnrollment,
    installOnConnection: out.installOnConnection,
  });
  return out;
}

async function updateDataPackageMetadata(hash, patch = {}) {
  await assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 60000 });
  const out = { ok: true };
  dbg("metadata update start", { hash: h, patchKeys: Object.keys(patch || {}) });

  if (patch.tool != null) {
    const tool = String(patch.tool || "").trim();
    await client.put(
      `/Marti/api/sync/metadata/${encodeURIComponent(h)}/tool`,
      tool,
      metadataStringPutConfig()
    );
    out.tool = tool;
  }

  if (patch.keywords != null) {
    const keywords = normalizeKeywordList(patch.keywords);
    await client.put(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/keywords`, keywords, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
    out.keywords = keywords;
  }

  if (patch.groups != null) {
    const groups = normalizeGroupsList(patch.groups);
    // MetadataApi expects a JSON string body (same as name/tool). Groups are
    // preferably set at upload via missionupload `Groups` query params; this
    // path is for edit/retry.
    await client.put(
      `/Marti/api/sync/metadata/${encodeURIComponent(h)}/groups`,
      groupsMetadataValue(groups),
      metadataStringPutConfig()
    );
    out.groups = groups;
  }

  const title = String(patch.title || patch.name || patch.filename || "").trim();
  if (title) {
    // Resource exposes both name and filename; set both for TAK UI consistency.
    await client.put(
      `/Marti/api/sync/metadata/${encodeURIComponent(h)}/name`,
      title,
      metadataStringPutConfig()
    );
    try {
      await client.put(
        `/Marti/api/sync/metadata/${encodeURIComponent(h)}/filename`,
        title,
        metadataStringPutConfig()
      );
    } catch (_) {
      /* some TAK builds only accept name */
    }
    out.title = title;
    out.name = title;
    out.filename = title;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "expiration")) {
    const expirationMs = parseExpirationMillis(patch.expiration);
    if (expirationMs != null) {
      await client.put(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/expiration`, null, {
        params: { expiration: expirationMs },
        headers: { Accept: "application/json" },
      });
      out.expiration = expirationMs;
    }
  }

  // OTS-specific flags; if endpoint/build does not support it we continue.
  if (
    patch.installOnEnrollment != null ||
    patch.installOnConnection != null
  ) {
    try {
      const body = {
        install_on_enrollment: patch.installOnEnrollment === true,
        install_on_connection: patch.installOnConnection === true,
      };
      await client.put("/api/data_packages", body, {
        params: { hash: h },
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
      out.installOnEnrollment = body.install_on_enrollment;
      out.installOnConnection = body.install_on_connection;
    } catch (_) {
      out.flagsUnsupported = true;
    }
  }

  dbgVerbose(`metadata update result for ${h}`, out);
  dbg("metadata update done", { hash: h, out });
  return out;
}

module.exports = {
  assertTakAvailable,
  listDataPackages,
  deleteDataPackage,
  downloadDataPackageStream,
  downloadDataPackageBuffer,
  uploadDataPackage,
  getDataPackageMetadata,
  updateDataPackageMetadata,
  normalizeGroupsList,
  normalizeKeywordList,
  groupsMetadataValue,
  buildMissionUploadParams,
  metadataStringPutConfig,
  parseExpirationMillis,
  extractUploadHash,
  packageNamesEqual,
  packageRecordTitle,
  pickPackageRecord,
  zipDownloadFilename,
  safeFilename,
};
