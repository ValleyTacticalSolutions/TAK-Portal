const { getBool, getString } = require("./env");
const groupsService = require("./groups.service");
const agenciesStore = require("./agencies.service");
const directoryRepo = require("./directoryRepo.service");
const pgCache = require("./pgCache");

const LEDGER_PATH = null;
const MAX_TITLES = 3;

function ensureDirExists() {}

function emptyLedger() {
  return { county: {}, state: {}, region: {} };
}

function loadLedger() {
  const parsed = pgCache.caches.autoCreateGroups;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyLedger();
  }
  return {
    county:
      parsed.county && typeof parsed.county === "object" && !Array.isArray(parsed.county)
        ? parsed.county
        : {},
    state:
      parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
        ? parsed.state
        : {},
    region:
      parsed.region && typeof parsed.region === "object" && !Array.isArray(parsed.region)
        ? parsed.region
        : {},
  };
}

function saveLedger(ledger) {
  const next = {
    county: ledger?.county && typeof ledger.county === "object" ? ledger.county : {},
    state: ledger?.state && typeof ledger.state === "object" ? ledger.state : {},
    region: ledger?.region && typeof ledger.region === "object" ? ledger.region : {},
  };
  pgCache.replaceAutoCreateGroups(next);
  return next;
}

function normalizeTitle(raw) {
  return String(raw || "").trim();
}

function normalizeBehavior(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "read" || v === "write" || v === "both") return v;
  return "both";
}

function normalizePrivate(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return v === "yes" ? "yes" : "no";
}

function behaviorSuffix(behavior) {
  const b = normalizeBehavior(behavior);
  if (b === "read") return "_READ";
  if (b === "write") return "_WRITE";
  return "";
}

function titleWithBehavior(title, behavior) {
  const t = normalizeTitle(title);
  if (!t) return "";
  return `${t}${behaviorSuffix(behavior)}`;
}

function titleKeyPart(title) {
  return normalizeTitle(title).toLowerCase();
}

function countyKey(detail, title) {
  return `${String(detail || "").trim().toLowerCase()}|${titleKeyPart(title)}`;
}

function stateKey(detail, title) {
  return `${String(detail || "").trim().toUpperCase()}|${titleKeyPart(title)}`;
}

function regionKey(detail, title) {
  return `${String(detail || "").trim().toLowerCase()}|${titleKeyPart(title)}`;
}

/**
 * Read configured group slots (title + channel behavior [+ private for agency]).
 * Title-only dedupe matches prior behavior; empty titles are skipped.
 */
function readSlots(titlePrefix, { includePrivate = false } = {}) {
  const slots = [];
  const seen = new Set();
  const behaviorPrefix = String(titlePrefix || "").replace(/_TITLE$/, "_BEHAVIOR");
  const privatePrefix = String(titlePrefix || "").replace(/_TITLE$/, "_PRIVATE");
  for (let i = 1; i <= MAX_TITLES; i += 1) {
    const t = normalizeTitle(getString(`${titlePrefix}_${i}`, ""));
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = {
      index: i,
      title: t,
      behavior: normalizeBehavior(getString(`${behaviorPrefix}_${i}`, "both")),
    };
    if (includePrivate) {
      slot.private = normalizePrivate(getString(`${privatePrefix}_${i}`, "no"));
    }
    slots.push(slot);
  }
  return slots;
}

function getAutoCreateConfig() {
  const agencySlots = readSlots("AUTO_CREATE_AGENCY_GROUP_TITLE", {
    includePrivate: true,
  });
  const countySlots = readSlots("AUTO_CREATE_COUNTY_GROUP_TITLE");
  const regionSlots = readSlots("AUTO_CREATE_REGION_GROUP_TITLE");
  const stateSlots = readSlots("AUTO_CREATE_STATE_GROUP_TITLE");
  return {
    agencyEnabled: getBool("AUTO_CREATE_AGENCY_GROUPS_ENABLED", true),
    countyEnabled: getBool("AUTO_CREATE_COUNTY_GROUPS_ENABLED", false),
    regionEnabled: getBool("AUTO_CREATE_REGION_GROUPS_ENABLED", false),
    stateEnabled: getBool("AUTO_CREATE_STATE_GROUPS_ENABLED", false),
    agencySlots,
    countySlots,
    regionSlots,
    stateSlots,
    // Title strings kept for callers that only need the display title.
    agencyTitles: agencySlots.map((s) => s.title),
    countyTitles: countySlots.map((s) => s.title),
    regionTitles: regionSlots.map((s) => s.title),
    stateTitles: stateSlots.map((s) => s.title),
  };
}

function buildAgencyGroupName(groupPrefix, title, behavior) {
  const prefix = agenciesStore.normalizeGroupPrefix(groupPrefix);
  const t = titleWithBehavior(title, behavior);
  if (!prefix || !t) return null;
  return groupsService.ensureTakPrefix(`${prefix} ${t}`);
}

function buildCountyGroupName(county, title, behavior) {
  const c = String(county || "").trim();
  const t = titleWithBehavior(title, behavior);
  if (!c || !t) return null;
  return groupsService.ensureTakPrefix(`${c} Co ${t}`);
}

function buildRegionGroupName(regionName, title, behavior) {
  const r = String(regionName || "").trim().replace(/\s+/g, " ");
  const t = titleWithBehavior(title, behavior);
  if (!r || !t) return null;
  return groupsService.ensureTakPrefix(`${r} ${t}`);
}

function buildStateGroupName(state, title, behavior) {
  const s = String(state || "").trim().toUpperCase();
  const t = titleWithBehavior(title, behavior);
  if (!s || !t) return null;
  return groupsService.ensureTakPrefix(`${s} ${t}`);
}

async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return null;
  return directoryRepo.getGroupById(name);
}

function isDuplicateNameError(err) {
  const msg = String(
    err?.response?.data?.detail || err?.response?.data || err?.message || ""
  ).toLowerCase();
  return (
    msg.includes("already") || msg.includes("exists") || msg.includes("unique")
  );
}

function actorAttributes(actor) {
  if (!actor) return {};
  return {
    created_by_username: String(actor.username || "").trim() || null,
    created_by_display_name:
      String(actor.displayName || actor.username || "").trim() || null,
  };
}

function markLedger(ledger, scope, key, entry) {
  const bucket =
    scope === "state" ? "state" : scope === "region" ? "region" : "county";
  if (!ledger[bucket] || typeof ledger[bucket] !== "object") {
    ledger[bucket] = {};
  }
  if (ledger[bucket][key]) return false;
  ledger[bucket][key] = {
    detail: entry.detail,
    title: entry.title,
    groupName: entry.groupName,
    provisionedAt: entry.provisionedAt || new Date().toISOString(),
  };
  return true;
}

async function ensureAgencyTitleGroup(agency, slot, actor) {
  const title = normalizeTitle(slot?.title);
  const behavior = normalizeBehavior(slot?.behavior);
  const isPrivate = normalizePrivate(slot?.private);
  const name = buildAgencyGroupName(agency?.groupPrefix, title, behavior);
  if (!name) throw new Error("Agency abbreviation / short name is required");

  const attributes = {
    created_at: new Date().toISOString(),
    private: isPrivate,
    created_type: "Agency",
    created_type_detail:
      String(agency?.name || agency?.groupPrefix || "").trim() || null,
    ...actorAttributes(actor),
  };

  try {
    const group = await groupsService.createGroup(name, { attributes });
    return {
      created: true,
      skipped: false,
      name,
      group,
      created_type: "Agency",
      created_type_detail: attributes.created_type_detail,
      title,
      behavior,
      private: isPrivate,
    };
  } catch (err) {
    if (!isDuplicateNameError(err)) throw err;
    const existing = await getGroupByNameUnfiltered(name);
    if (existing && agenciesStore.isAgencyOwnedGroup(existing, agency)) {
      return {
        created: false,
        skipped: true,
        name,
        group: existing,
        created_type: "Agency",
        created_type_detail: attributes.created_type_detail,
        title,
        behavior,
        private: isPrivate,
      };
    }
    throw new Error(
      `Authentik group "${name}" already exists and is not owned by this agency`
    );
  }
}

async function ensureGeoTitleGroup({
  scope,
  detail,
  title,
  behavior,
  name,
  actor,
  ledger,
}) {
  const key =
    scope === "state"
      ? stateKey(detail, title)
      : scope === "region"
        ? regionKey(detail, title)
        : countyKey(detail, title);
  const bucket =
    scope === "state" ? "state" : scope === "region" ? "region" : "county";
  const createdType =
    scope === "state" ? "State" : scope === "region" ? "Region" : "County";
  const normalizedBehavior = normalizeBehavior(behavior);

  if (ledger[bucket] && ledger[bucket][key]) {
    return {
      created: false,
      skipped: true,
      reason: "ledger",
      name,
      group: null,
      created_type: createdType,
      created_type_detail: detail,
      title,
      behavior: normalizedBehavior,
      ledgerKey: key,
    };
  }

  const existing = await getGroupByNameUnfiltered(name);
  if (existing) {
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: existing.name || name,
    });
    return {
      created: false,
      skipped: true,
      reason: "exists",
      name: existing.name || name,
      group: existing,
      created_type: createdType,
      created_type_detail: detail,
      title,
      behavior: normalizedBehavior,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  }
  const attributes = {
    created_at: new Date().toISOString(),
    private: "no",
    created_type: createdType,
    created_type_detail: detail,
    ...actorAttributes(actor),
  };

  try {
    const group = await groupsService.createGroup(name, { attributes });
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: group?.name || name,
    });
    return {
      created: true,
      skipped: false,
      name: group?.name || name,
      group,
      created_type: createdType,
      created_type_detail: detail,
      title,
      behavior: normalizedBehavior,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  } catch (err) {
    if (!isDuplicateNameError(err)) throw err;
    // Race / concurrent create: treat as exists and ledger it.
    const raced = await getGroupByNameUnfiltered(name);
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: raced?.name || name,
    });
    return {
      created: false,
      skipped: true,
      reason: "exists",
      name: raced?.name || name,
      group: raced,
      created_type: createdType,
      created_type_detail: detail,
      title,
      behavior: normalizedBehavior,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  }
}

/**
 * Ensure configured auto-create groups for a newly created agency.
 * Agency titles use ownership checks. County/State use the provisioned ledger.
 */
async function ensureAutoCreateGroupsForAgency(agency, actor) {
  const config = getAutoCreateConfig();
  const results = [];
  const createdGroups = [];
  let mainGroup = null;
  let ledger = loadLedger();
  let ledgerDirty = false;

  if (config.agencyEnabled) {
    const slots = config.agencySlots.length
      ? config.agencySlots
      : [{ title: "Main", behavior: "both", private: "no" }];
    for (const slot of slots) {
      const result = await ensureAgencyTitleGroup(agency, slot, actor);
      results.push(result);
      if (!mainGroup) mainGroup = result;
      if (result.created) createdGroups.push(result);
    }
  }

  const county = String(agency?.county || "").trim();
  const stateFederal = !!agency?.stateFederalAgency;
  if (config.countyEnabled && county && !stateFederal) {
    const slots = config.countySlots.length
      ? config.countySlots
      : [{ title: "Interop", behavior: "both" }];
    for (const slot of slots) {
      const name = buildCountyGroupName(county, slot.title, slot.behavior);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "county",
        detail: county,
        title: slot.title,
        behavior: slot.behavior,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  const regionsSvc = require("./regions.service");
  const regionName = regionsSvc.getRegionName(agency?.regionId);
  if (config.regionEnabled && regionName) {
    const slots = config.regionSlots.length
      ? config.regionSlots
      : [{ title: "Interop", behavior: "both" }];
    for (const slot of slots) {
      const name = buildRegionGroupName(regionName, slot.title, slot.behavior);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "region",
        detail: regionName,
        title: slot.title,
        behavior: slot.behavior,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  const state = String(agency?.state || "").trim().toUpperCase();
  if (config.stateEnabled && state) {
    const slots = config.stateSlots.length
      ? config.stateSlots
      : [{ title: "Interop", behavior: "both" }];
    for (const slot of slots) {
      const name = buildStateGroupName(state, slot.title, slot.behavior);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "state",
        detail: state,
        title: slot.title,
        behavior: slot.behavior,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  if (ledgerDirty) {
    saveLedger(ledger);
  }

  return {
    mainGroup,
    createdGroups,
    results,
    config,
  };
}

module.exports = {
  MAX_TITLES,
  LEDGER_PATH,
  getAutoCreateConfig,
  ensureAutoCreateGroupsForAgency,
  buildAgencyGroupName,
  buildCountyGroupName,
  buildRegionGroupName,
  buildStateGroupName,
  normalizeBehavior,
  normalizePrivate,
  getGroupByNameUnfiltered,
  loadLedger,
  saveLedger,
};
