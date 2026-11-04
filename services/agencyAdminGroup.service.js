/**
 * Create/ensure the hidden Authentik AgencyAdmin group for an agency.
 * Used by Agencies save and Agency Admin assignment paths.
 */

const directoryRepo = require("./directoryRepo.service");
const agenciesStore = require("./agencies.service");
const groupsService = require("./groups.service");
const { markHiddenAttributes } = require("./portalHidden.util");

function getAgencyAdminGroupName(agency) {
  const abbr = agenciesStore.normalizeGroupPrefix(agency?.groupPrefix);
  const countyAbbrev = String(agency?.countyAbbrev || "").trim().toUpperCase();
  if (!abbr) return null;
  if (countyAbbrev) {
    return `authentik-${countyAbbrev}-${abbr}-AgencyAdmin`;
  }
  return `authentik-${abbr}-AgencyAdmin`;
}

async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return null;
  return directoryRepo.getGroupById(name);
}

/**
 * Idempotent: creates the computed AgencyAdmin group when missing.
 * If the name already exists and is owned by this agency, returns created:false.
 */
async function ensureAgencyAdminGroupExists(agency) {
  const name = getAgencyAdminGroupName(agency);
  if (!name) throw new Error("Agency abbreviation / short name is required");

  const attributes = markHiddenAttributes({
    created_at: new Date().toISOString(),
    created_type: "Agency",
    created_type_detail: String(agency?.name || agency?.groupPrefix || "").trim() || null,
    description: `Agency admin group for ${String(agency?.name || agency?.groupPrefix || "").trim()}`,
  });

  try {
    await groupsService.createGroup(name, { attributes });
    return { created: true, name };
  } catch (err) {
    const msg = String(
      err?.response?.data?.detail || err?.response?.data || err?.message || ""
    );
    const lower = msg.toLowerCase();
    if (lower.includes("already") || lower.includes("exists") || lower.includes("unique")) {
      const existing = await getGroupByNameUnfiltered(name);
      if (existing && agenciesStore.isAgencyOwnedGroup(existing, agency)) {
        return { created: false, name };
      }
      // Exact expected admin name already present locally — treat as ensured even if
      // ownership attrs are incomplete (legacy / partial sync), so assign can proceed.
      if (existing) {
        return { created: false, name, existing: true };
      }
      throw new Error(
        `Authentik group "${name}" already exists and is not owned by this agency`
      );
    }
    throw err;
  }
}

function normalizeSuffix(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Ensure AgencyAdmin groups for the given agency suffixes (from agencies.json).
 */
async function ensureAgencyAdminGroupsForSuffixes(suffixes) {
  const agencies = agenciesStore.load() || [];
  const wanted = new Set(
    (Array.isArray(suffixes) ? suffixes : []).map(normalizeSuffix).filter(Boolean)
  );
  const results = [];
  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency?.suffix);
    if (!sfx || !wanted.has(sfx)) continue;
    results.push(await ensureAgencyAdminGroupExists(agency));
  }
  return results;
}

module.exports = {
  getAgencyAdminGroupName,
  ensureAgencyAdminGroupExists,
  ensureAgencyAdminGroupsForSuffixes,
};
