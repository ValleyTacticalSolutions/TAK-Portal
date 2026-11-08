/**
 * Channel patch engine — CoT rebroadcast across selected channels.
 *
 * Bidirectional: full mesh (both ways). Unidirectional: sources → destinations only
 * (left/right lists + ltr|rtl arrow resolved by channelPatch.store.resolveFlowEnds).
 *
 * Patched CoT is written on the portal's webadmin TLS stream. Reusing the EUD's
 * UID would make TAK Server treat webadmin as a second instance of that client
 * (same callsign, admin's full group list). A distinct UID per destination did
 * the same thing to ATAK: contacts are keyed by UID, so one person in several
 * patched channels showed up once per channel.
 *
 * Each source UID therefore gets one stable clone (…callsign.takportal.<srcUid>),
 * and that single event lists every destination group. TAK group membership
 * decides who receives it. Someone already in a destination channel updates the
 * same clone instead of growing another contact.
 *
 * The copy keeps type, team (__group), usericon, color, and <contact callsign>.
 * Endpoint / flow-tags / detail uid are stripped so it is not a live ClientEndpoint.
 * Our own echoes on the map stream are ignored.
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const groupsSvc = require("./groups.service");
const store = require("./channelPatch.store");

const PATCH_TAG = "__takportal_patch";
const BRIDGE_TAG = "__takportal_bridge";
const RUNTIME_FLUSH_MS = 5000;
const MAX_DESTS_PER_EVENT = 32;

let started = false;
let unsubscribe = null;
/** @type {Promise<typeof import("@tak-ps/node-cot")>|null} */
let nodeCotPromise = null;

/** In-memory runtime hints keyed by patch id (flushed periodically). */
const runtimeByPatch = new Map();
let runtimeFlushTimer = null;

function loadNodeCot() {
  if (!nodeCotPromise) nodeCotPromise = import("@tak-ps/node-cot");
  return nodeCotPromise;
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function groupKey(name) {
  return mapMeta.channelBaseKey(name);
}

/**
 * Portal catalog uses Authentik names (tak_…). Marti dest / filtergroup use the CN.
 */
function toMartiGroupName(catalogOrAny) {
  return groupsSvc.stripTakPrefix(safeStr(catalogOrAny).trim());
}

function isPortalPatchedCot(cot) {
  const detail = cot?.raw?.event?.detail || cot?.detail?.() || {};
  if (detail && detail[PATCH_TAG]) return true;
  if (detail && detail[PATCH_TAG]?._attributes) return true;
  return false;
}

function isPortalBridgeCot(cot) {
  const detail = cot?.raw?.event?.detail || cot?.detail?.() || {};
  return !!(detail && detail[BRIDGE_TAG]);
}

/**
 * Destinations for a source channel within one patch.
 * Bi: full mesh (both ways). Uni: only if source is on the sending side.
 * @returns {string[]} destination group names (catalog names)
 */
function destinationsForSource(patch, sourceKey) {
  if (!sourceKey) return [];

  const mode = store.normalizeMode(patch);
  if (mode === "unidirectional") {
    const { sources, destinations } = store.resolveFlowEnds(patch);
    if (!sources.length || !destinations.length) return [];

    const sourceKeys = new Set(sources.map((g) => groupKey(g)).filter(Boolean));
    if (!sourceKeys.has(sourceKey)) return [];

    const dests = [];
    const seen = new Set();
    for (const groupName of destinations) {
      const g = safeStr(groupName).trim();
      if (!g) continue;
      const k = groupKey(g);
      if (!k || k === sourceKey) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      dests.push(g);
    }
    return dests;
  }

  const groups = Array.isArray(patch?.groups) ? patch.groups : [];
  if (groups.length < 2) return [];

  const memberKeys = new Set(groups.map((g) => groupKey(g)).filter(Boolean));
  if (!memberKeys.has(sourceKey)) return [];

  const dests = [];
  const seen = new Set();
  for (const groupName of groups) {
    const g = safeStr(groupName).trim();
    if (!g) continue;
    const k = groupKey(g);
    if (!k || k === sourceKey) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    dests.push(g);
  }
  return dests;
}

function queueRuntime(patchId, fields) {
  const id = safeStr(patchId).trim();
  if (!id) return;
  const prev = runtimeByPatch.get(id) || {};
  runtimeByPatch.set(id, { ...prev, ...fields, dirty: true });
  if (!runtimeFlushTimer) {
    runtimeFlushTimer = setTimeout(flushRuntime, RUNTIME_FLUSH_MS);
    if (typeof runtimeFlushTimer.unref === "function") runtimeFlushTimer.unref();
  }
}

function flushRuntime() {
  runtimeFlushTimer = null;
  // One replace for the whole flush. A save per dirty patch overlaps itself:
  // each replace deletes every row and inserts them again, and the second
  // insert hits channel_patches_pkey.
  let changed = false;
  for (const [id, row] of runtimeByPatch) {
    if (!row?.dirty) continue;
    try {
      const updated = store.touchRuntime(
        id,
        {
          lastForwardAt: row.lastForwardAt ?? undefined,
          lastError: row.lastError ?? undefined,
        },
        { persist: false }
      );
      if (updated) changed = true;
      runtimeByPatch.set(id, { ...row, dirty: false });
    } catch (_) {}
  }
  if (!changed) return;
  try {
    store.persistCached();
  } catch (_) {}
}

function clearExistingDests(detail) {
  if (!detail.marti) detail.marti = {};
  detail.marti.dest = [];
}

function stampPatchTag(detail, meta) {
  detail[PATCH_TAG] = {
    _attributes: {
      patchId: safeStr(meta.patchId),
      from: safeStr(meta.fromGroup),
      to: safeStr(meta.toGroup),
      srcUid: safeStr(meta.srcUid),
    },
  };
}

function setFilterGroups(detail, groupNames) {
  const groups = [];
  const seen = new Set();
  for (const name of groupNames || []) {
    const g = safeStr(name).trim();
    if (!g) continue;
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(g);
  }
  if (!groups.length) return;
  if (groups.length === 1) {
    detail.filtergroup = { _attributes: { group: groups[0] } };
    return;
  }
  detail.filtergroup = groups.map((group) => ({ _attributes: { group } }));
}

const PATCH_UID_MAX = 128;

function slugToken(value) {
  return safeStr(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function fnv1a32(text) {
  let h = 0x811c9dc5;
  const s = safeStr(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * One clone UID per source EUD, shared by every destination channel.
 * Not the real UID: this write is on the webadmin stream.
 * Callsign prefix keeps UIDs readable in logs / filters (see takMetrics .takportal. exclude).
 */
function patchedUid(srcUid, callsign) {
  const rawUid = safeStr(srcUid).trim();
  const uidSlug = slugToken(rawUid);
  let uidToken = uidSlug;
  if (!uidToken || uidToken.length > 64) {
    const base = (uidToken || "src").slice(0, 48);
    uidToken = `${base}-${fnv1a32(rawUid || "src")}`;
  }
  const suffix = `.takportal.${uidToken}`;
  const room = Math.max(4, PATCH_UID_MAX - suffix.length);
  const label = slugToken(callsign).slice(0, room) || uidSlug.slice(0, room) || "unit";
  return `${label}${suffix}`.slice(0, PATCH_UID_MAX);
}

function stripContactEndpoint(contact) {
  if (!contact || typeof contact !== "object") return contact;
  if (contact._attributes && typeof contact._attributes === "object") {
    const attrs = { ...contact._attributes };
    delete attrs.endpoint;
    delete attrs.Endpoint;
    return { ...contact, _attributes: attrs };
  }
  const next = { ...contact };
  delete next.endpoint;
  delete next.Endpoint;
  return next;
}

/**
 * Strip only routing/identity that would bind this copy to the webadmin socket.
 * Keep type, team (__group), usericon, color, takv, status, and other marker
 * payload so dest clients draw the same icon as the source.
 * Returns the callsign used on the copy.
 */
function neutralizeAsInjectedCopy(detail, fallbackCallsign) {
  if (!detail || typeof detail !== "object") {
    return safeStr(fallbackCallsign).trim();
  }

  const callsign = safeStr(
    detail.contact?._attributes?.callsign ||
      detail.contact?.callsign ||
      fallbackCallsign ||
      ""
  ).trim();

  // Detail <uid> is a device identity handle — do not advertise it on webadmin.
  delete detail.uid;
  delete detail._uid_;
  // Do not carry original flow tags onto the webadmin write
  delete detail["_flow-tags_"];
  delete detail["flow-tags"];
  delete detail._flowTags;
  delete detail.flowTags;

  // ATAK shows "NO CALLSIGN" when <contact callsign> is missing. Keep the
  // rest of <contact>, but strip endpoint so this is not a routable
  // ClientEndpoint advertise on the webadmin socket.
  if (detail.contact) {
    detail.contact = stripContactEndpoint(detail.contact);
    const attrs =
      detail.contact._attributes && typeof detail.contact._attributes === "object"
        ? detail.contact._attributes
        : detail.contact;
    if (callsign && !safeStr(attrs.callsign).trim()) attrs.callsign = callsign;
  } else if (callsign) {
    detail.contact = { _attributes: { callsign } };
  }

  return callsign;
}

/**
 * Point one injected copy at every destination group and give it the stable clone UID.
 * Mutates detail. Does not write.
 * @param {object} detail CoT detail tree
 * @param {{ srcUid?: string, destGroups?: string[], callsign?: string, patchId?: string, fromGroup?: string }} meta
 * @returns {{ uid: string, callsign: string, martiGroups: string[], catalogDests: string[] }}
 */
function applyPatchIdentity(detail, meta) {
  if (!detail || typeof detail !== "object") {
    throw new Error("Invalid CoT detail");
  }
  clearExistingDests(detail);
  const callsign = neutralizeAsInjectedCopy(detail, meta?.callsign);
  const srcUid = safeStr(meta?.srcUid).trim();
  const uid = patchedUid(srcUid, callsign);

  const martiGroups = [];
  const catalogDests = [];
  const seen = new Set();
  for (const destGroup of meta?.destGroups || []) {
    const catalog = safeStr(destGroup).trim();
    const martiGroup = toMartiGroupName(catalog);
    if (!martiGroup) continue;
    const key = martiGroup.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    martiGroups.push(martiGroup);
    catalogDests.push(catalog);
  }
  // No dest would fall through to webadmin's full group list.
  if (!martiGroups.length) throw new Error("Empty Marti dest group");

  detail.marti.dest = martiGroups.map((group) => ({ _attributes: { group } }));
  setFilterGroups(detail, martiGroups);
  stampPatchTag(detail, {
    patchId: meta?.patchId,
    fromGroup: meta?.fromGroup,
    toGroup: catalogDests.join("|"),
    srcUid,
    callsign,
  });

  return { uid, callsign, martiGroups, catalogDests };
}

/**
 * Build one CoT clone for every destination of this source event.
 * @param {string[]} destGroups catalog / Authentik names (may include tak_)
 */
async function buildPatchedCot(sourceCot, destGroups, meta) {
  const mod = await loadNodeCot();
  const CoT = mod.default || mod.CoT;
  if (!CoT) throw new Error("node-cot CoT constructor unavailable");

  const raw = JSON.parse(JSON.stringify(sourceCot.raw));
  if (!raw?.event) throw new Error("Invalid CoT raw");

  const srcUid = safeStr(raw.event?._attributes?.uid).trim();
  const clone = new CoT(raw);
  const shaped = applyPatchIdentity(clone.detail(), {
    srcUid,
    destGroups,
    callsign: meta?.callsign,
    patchId: meta?.patchId,
    fromGroup: meta?.fromGroup,
  });
  // CoT type is left unchanged so dest clients keep the source icon.
  clone.uid(shaped.uid);
  return clone;
}

async function forwardCot({ marker, cot }) {
  if (!cot || isPortalPatchedCot(cot) || isPortalBridgeCot(cot)) return;
  if (!cotStream.isBridgeConnected()) return;

  const patches = store.listEnabled();
  if (!patches.length) return;

  // Use the EUD's real publish subscription only — NOT marker.groups.
  // marker.groups may include channel-patch map attribution (dest channels),
  // which would fan traffic back onto the source channel as a ghost pin.
  const publishGroups = mapMeta.resolveGroupsFromSubscription(marker);
  const sourceKeys = (Array.isArray(publishGroups) ? publishGroups : [])
    .map((g) => groupKey(mapMeta.toChannelGroupName(g) || g))
    .filter((k) => k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY);
  if (!sourceKeys.length) return;

  /** @type {Map<string, { dest: string, patchId: string, fromGroup: string }>} */
  const destJobs = new Map();

  for (const patch of patches) {
    for (const sourceKey of sourceKeys) {
      const dests = destinationsForSource(patch, sourceKey);
      for (const dest of dests) {
        const destKey = groupKey(dest);
        if (!destKey || destJobs.has(destKey)) continue;
        destJobs.set(destKey, {
          dest,
          patchId: patch.id,
          fromGroup: sourceKey,
        });
      }
    }
  }

  if (!destJobs.size) return;

  const jobs = Array.from(destJobs.values()).slice(0, MAX_DESTS_PER_EVENT);
  const patchIdsTouched = new Set(jobs.map((job) => job.patchId));
  try {
    // One event, every dest group. A CoT per channel minted a new ATAK contact
    // for the same callsign each time.
    const targeted = await buildPatchedCot(
      cot,
      jobs.map((job) => job.dest),
      {
        patchId: [...patchIdsTouched].join("|"),
        fromGroup: [...new Set(jobs.map((job) => job.fromGroup))].join("|"),
        callsign: marker?.callsign,
      }
    );

    const ok = await cotStream.writeCot(targeted, { stripFlow: true });
    const now = new Date().toISOString();
    for (const id of patchIdsTouched) {
      if (ok) {
        queueRuntime(id, { lastForwardAt: now, lastError: null });
      } else {
        queueRuntime(id, {
          lastError: "TAK stream not connected; write skipped",
        });
      }
    }
  } catch (err) {
    const message = err?.message || String(err);
    for (const id of patchIdsTouched) {
      queueRuntime(id, { lastError: message });
    }
    console.error("[channel-patch] forward failed:", message);
  }
}

function onCot({ marker, cot }) {
  void forwardCot({ marker, cot });
}

/**
 * For map attribution: given a marker's current channel groups, return catalog
 * destinations that enabled patches would fan out to.
 */
function augmentDestGroupsForSourceGroups(sourceGroups) {
  const patches = store.listEnabled();
  if (!patches.length) return [];
  const sourceKeys = (Array.isArray(sourceGroups) ? sourceGroups : [])
    .map((g) => groupKey(g))
    .filter((k) => k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY);
  if (!sourceKeys.length) return [];

  const dests = [];
  const seen = new Set();
  for (const patch of patches) {
    for (const sourceKey of sourceKeys) {
      for (const dest of destinationsForSource(patch, sourceKey)) {
        const channel = mapMeta.toChannelGroupName(dest) || safeStr(dest).trim();
        const k = groupKey(channel);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        dests.push(channel);
      }
    }
  }
  return dests;
}

function start() {
  if (started) return;
  started = true;
  cotStream.ensureBridgeStarted();
  if (typeof mapMeta.setPatchDestAugmenter === "function") {
    mapMeta.setPatchDestAugmenter(augmentDestGroupsForSourceGroups);
  }
  unsubscribe = cotStream.onCotProcessed(onCot);
  console.log("[channel-patch] engine started");
}

function stop() {
  if (typeof mapMeta.setPatchDestAugmenter === "function") {
    mapMeta.setPatchDestAugmenter(null);
  }
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch (_) {}
    unsubscribe = null;
  }
  if (runtimeFlushTimer) {
    clearTimeout(runtimeFlushTimer);
    runtimeFlushTimer = null;
  }
  flushRuntime();
  started = false;
}

function getRuntimeHint(patchId) {
  return runtimeByPatch.get(safeStr(patchId).trim()) || null;
}

module.exports = {
  start,
  stop,
  destinationsForSource,
  isPortalPatchedCot,
  isPortalBridgeCot,
  toMartiGroupName,
  patchedUid,
  applyPatchIdentity,
  neutralizeAsInjectedCopy,
  getRuntimeHint,
  PATCH_TAG,
  BRIDGE_TAG,
};
