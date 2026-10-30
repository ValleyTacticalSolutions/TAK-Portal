"use strict";

/**
 * Pure helpers for Groups page edit type conversions
 * (Agency / County / Region / State / Global) and related attributes.
 */

const SCOPED_TYPES = new Set(["Agency", "County", "Region", "State"]);
const UI_TO_SERVER = {
  agency: "Agency",
  county: "County",
  region: "Region",
  state: "State",
  generic: "Global",
  global: "Global",
};

function normalizeServerGroupType(raw) {
  const s = String(raw || "").trim();
  if (s === "Agency" || s === "County" || s === "Region" || s === "State" || s === "Global") {
    return s;
  }
  const mapped = UI_TO_SERVER[s.toLowerCase()];
  return mapped || null;
}

function isScopedGroupType(groupType) {
  return SCOPED_TYPES.has(String(groupType || "").trim());
}

/**
 * Apply edit fields onto a copy of existing Authentik/local group attributes.
 * Used by renameGroup so type conversions stay consistent across all combinations.
 *
 * @param {object} existingAttrs
 * @param {object} opts
 * @param {string} [opts.description]
 * @param {string} [opts.private] "yes"|"no"
 * @param {string} [opts.groupType] Agency|County|Region|State|Global
 * @param {string|null} [opts.groupTypeDetail]
 */
function applyGroupEditAttributes(existingAttrs, opts = {}) {
  const nextAttrs = {
    ...(existingAttrs && typeof existingAttrs === "object" ? existingAttrs : {}),
  };

  const wantsDescription = Object.prototype.hasOwnProperty.call(opts, "description");
  const wantsPrivate = Object.prototype.hasOwnProperty.call(opts, "private");
  const wantsGroupType = Object.prototype.hasOwnProperty.call(opts, "groupType");
  const wantsGroupTypeDetail = Object.prototype.hasOwnProperty.call(opts, "groupTypeDetail");

  if (wantsDescription) {
    nextAttrs.description = String(opts.description || "").trim();
  }

  if (wantsGroupType) {
    nextAttrs.created_type = normalizeServerGroupType(opts.groupType) || "Global";
  }

  if (wantsGroupTypeDetail) {
    const detail = String(opts.groupTypeDetail || "").trim();
    // Empty string clears leftover scoped ownership (required for → Global and
    // when switching Agency↔County↔Region↔State so the previous detail does not linger).
    nextAttrs.created_type_detail = detail || "";
  } else if (wantsGroupType) {
    const gt = normalizeServerGroupType(opts.groupType) || "Global";
    if (gt === "Global") {
      nextAttrs.created_type_detail = "";
    }
  }

  // Private is agency-only. Non-agency types always normalize to "no" when type is updated.
  if (wantsGroupType) {
    const gt = normalizeServerGroupType(opts.groupType) || "Global";
    if (gt !== "Agency") {
      nextAttrs.private = "no";
    } else if (wantsPrivate) {
      const priv = String(opts.private || "").trim().toLowerCase();
      nextAttrs.private = priv === "yes" ? "yes" : "no";
    }
  } else if (wantsPrivate) {
    const priv = String(opts.private || "").trim().toLowerCase();
    nextAttrs.private = priv === "yes" ? "yes" : "no";
  }

  return nextAttrs;
}

/**
 * Build the expected portal name (with tak_) for a structured edit.
 * Mirrors views/groups.ejs buildGroupNameFromParts.
 */
function buildGroupNameFromParts({ type, baseName, behavior, prefix, county, region, state }) {
  let name = String(baseName || "").trim();
  if (!name) return "";

  const b = String(behavior || "both").toLowerCase();
  if (b === "read") name += "_READ";
  else if (b === "write") name += "_WRITE";

  const uiType = String(type || "generic").toLowerCase();
  if (uiType === "agency") {
    const p = String(prefix || "").trim();
    if (!p) return "";
    name = `${p} ${name}`;
  } else if (uiType === "county") {
    const c = String(county || "").trim();
    if (!c) return "";
    name = `${c} Co ${name}`;
  } else if (uiType === "region") {
    const r = String(region || "").trim();
    if (!r) return "";
    name = `${r} ${name}`;
  } else if (uiType === "state") {
    const s = String(state || "").trim().toUpperCase();
    if (!s) return "";
    name = `${s} ${name}`;
  }

  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function deriveGroupTypePayload(type, { prefix, county, region, state, agencies } = {}) {
  const uiType = String(type || "generic").toLowerCase();
  let groupType = "Global";
  let groupTypeDetail = null;
  const list = Array.isArray(agencies) ? agencies : [];

  if (uiType === "agency") {
    groupType = "Agency";
    const agencyObj = list.find((a) => {
      const p = String(a.groupPrefix || "").trim();
      return p.toLowerCase() === String(prefix || "").trim().toLowerCase();
    });
    if (agencyObj && agencyObj.name) groupTypeDetail = String(agencyObj.name);
    else if (prefix) groupTypeDetail = String(prefix);
  } else if (uiType === "county") {
    groupType = "County";
    if (county) groupTypeDetail = String(county);
  } else if (uiType === "region") {
    groupType = "Region";
    if (region) groupTypeDetail = String(region);
  } else if (uiType === "state") {
    groupType = "State";
    if (state) groupTypeDetail = String(state).toUpperCase();
  }

  return { groupType, groupTypeDetail };
}

/**
 * Private flag for a save: agency types may set yes/no; leaving agency clears to no.
 */
function resolveEditPrivate({
  isGlobalAdmin,
  targetUiType,
  originalUiType,
  selectedPrivate,
  currentPrivate,
}) {
  if (!isGlobalAdmin) return null;
  const target = String(targetUiType || "").toLowerCase();
  const original = String(originalUiType || "").toLowerCase();
  if (target === "agency") {
    return String(selectedPrivate || "no").trim().toLowerCase() === "yes" ? "yes" : "no";
  }
  if (
    String(currentPrivate || "").toLowerCase() === "yes" ||
    original === "agency"
  ) {
    return "no";
  }
  return null;
}

module.exports = {
  SCOPED_TYPES,
  UI_TO_SERVER,
  normalizeServerGroupType,
  isScopedGroupType,
  applyGroupEditAttributes,
  buildGroupNameFromParts,
  deriveGroupTypePayload,
  resolveEditPrivate,
};
