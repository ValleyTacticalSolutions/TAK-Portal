const router = require("express").Router();
const accessSvc = require("../services/access.service");
const agenciesStore = require("../services/agencies.service");
const mapMeta = require("../services/mapMeta.service");
const cotStream = require("../services/cotStream.service");
const store = require("../services/channelPatch.store");
const engine = require("../services/channelPatch.engine");
const auditSvc = require("../services/auditLog.service");
const channelPatchAccess = require("../services/channelPatchAccess.service");
const channelPatchDataSync = require("../services/channelPatchDataSync.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

function patchGroupsSignature(patch) {
  const mode = store.normalizeMode(patch || {});
  const parts = [mode, patch && patch.enabled !== false ? "1" : "0"];
  if (mode === "unidirectional") {
    parts.push(
      (Array.isArray(patch?.leftGroups) ? patch.leftGroups : []).join("\0"),
      (Array.isArray(patch?.rightGroups) ? patch.rightGroups : []).join("\0"),
      store.normalizeDirection(patch)
    );
  } else {
    parts.push((Array.isArray(patch?.groups) ? patch.groups : []).join("\0"));
  }
  return parts.join("|");
}

function shouldSyncDataSyncs(before, after) {
  if (!before || !after) return true;
  return patchGroupsSignature(before) !== patchGroupsSignature(after);
}

function toErrorPayload(err) {
  return toSafeApiError(err);
}

function actorLabel(authUser) {
  if (!authUser) return "";
  return (
    String(authUser.name || "").trim() ||
    String(authUser.email || "").trim() ||
    String(authUser.uid || "").trim() ||
    ""
  );
}

/**
 * Authentik is the source of truth for picker labels/scope (same as Data Sync).
 * Live-map catalog is optional and used only to enrich channel counts.
 */
async function loadScopedChannels(authUser) {
  cotStream.ensureBridgeStarted();
  let groups = [];
  try {
    const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList(), {
      scopeMemberGroups: false,
      userGroupNames: [],
    });
    groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  } catch (_) {
    groups = [];
  }
  return channelPatchAccess.buildScopedChannelPicker(authUser, groups);
}

function enrichPatch(patch) {
  const hint = engine.getRuntimeHint(patch.id);
  return {
    ...patch,
    lastForwardAt: hint?.lastForwardAt || patch.lastForwardAt || null,
    lastError:
      hint && Object.prototype.hasOwnProperty.call(hint, "lastError")
        ? hint.lastError
        : patch.lastError || null,
    bridgeConnected: cotStream.isBridgeConnected(),
  };
}

function hideOutOfScopePatch(res) {
  return res.status(404).json({ error: "Patch not found" });
}

/** Collect all channel names involved in a create/update body (bi or uni). */
function groupsFromBody(body, fallbackGroups) {
  const mode = store.normalizeMode(body || {});
  if (mode === "unidirectional") {
    const left = Array.isArray(body?.leftGroups) ? body.leftGroups : [];
    const right = Array.isArray(body?.rightGroups) ? body.rightGroups : [];
    return [...left, ...right];
  }
  if (body && Array.isArray(body.groups)) return body.groups;
  return Array.isArray(fallbackGroups) ? fallbackGroups : [];
}

// GET /api/channel-patch/meta
router.get("/meta", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const agencies = accessSvc.filterAgenciesForUser(
      authUser,
      agenciesStore.load()
    );
    const scoped = await loadScopedChannels(authUser);
    res.json({
      isGlobalAdmin: access.isGlobalAdmin,
      isAgencyAdmin: access.isAgencyAdmin,
      agencies,
      channels: scoped.channels,
      channelScope: scoped.channelScope,
      allowedChannelKeys: scoped.allowedChannelKeys,
      bridgeConnected: cotStream.isBridgeConnected(),
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// GET /api/channel-patch
router.get("/", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);
    const patches = channelPatchAccess
      .filterPatchesForAccess(access, store.list(), allowed)
      .map(enrichPatch);
    res.json({ patches, bridgeConnected: cotStream.isBridgeConnected() });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// POST /api/channel-patch
router.post("/", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const body = req.body || {};
    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    const mode = store.normalizeMode(body);
    const groups = groupsFromBody(body);
    channelPatchAccess.assertGroupsInScope(access, groups, allowed);

    const createInput = {
      name: body.name,
      enabled: body.enabled !== false,
      mode,
      agencyScope: access.isGlobalAdmin
        ? body.agencyScope || []
        : access.allowedAgencySuffixes || [],
    };
    if (mode === "unidirectional") {
      createInput.leftGroups = Array.isArray(body.leftGroups)
        ? body.leftGroups
        : [];
      createInput.rightGroups = Array.isArray(body.rightGroups)
        ? body.rightGroups
        : [];
      createInput.direction = body.direction;
    } else {
      createInput.groups = Array.isArray(body.groups) ? body.groups : [];
    }

    const patch = store.create(createInput, actorLabel(authUser));
    await channelPatchDataSync.syncDataSyncsForPatchChange({
      before: null,
      after: patch,
    });
    const synced = store.getById(patch.id) || patch;

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_CREATED",
      targetType: "channel_patch",
      targetId: synced.id,
      details: {
        name: synced.name,
        mode: synced.mode,
        direction: synced.direction || null,
        groups: synced.groups,
        leftGroups: synced.leftGroups || null,
        rightGroups: synced.rightGroups || null,
        summary: `Created channel patch ${synced.name}.`,
      },
    });

    res.status(201).json(enrichPatch(synced));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

// PATCH /api/channel-patch/:id
router.patch("/:id", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const existing = store.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Patch not found" });
    }

    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    if (
      !channelPatchAccess.filterPatchesForAccess(access, [existing], allowed)
        .length
    ) {
      return hideOutOfScopePatch(res);
    }

    const body = req.body || {};
    const nextMode =
      body.mode != null ? store.normalizeMode(body) : store.normalizeMode(existing);
    const scopeGroups =
      body.mode != null ||
      body.groups != null ||
      body.leftGroups != null ||
      body.rightGroups != null
        ? groupsFromBody(
            {
              mode: nextMode,
              groups: body.groups != null ? body.groups : existing.groups,
              leftGroups:
                body.leftGroups != null ? body.leftGroups : existing.leftGroups,
              rightGroups:
                body.rightGroups != null
                  ? body.rightGroups
                  : existing.rightGroups,
            },
            existing.groups
          )
        : existing.groups;
    channelPatchAccess.assertGroupsInScope(access, scopeGroups, allowed);

    const fields = {};
    if (body.name != null) fields.name = body.name;
    if (body.enabled != null) fields.enabled = body.enabled;
    if (body.mode != null) fields.mode = nextMode;
    if (body.agencyScope != null && access.isGlobalAdmin) {
      fields.agencyScope = body.agencyScope;
    }

    if (nextMode === "unidirectional") {
      if (body.leftGroups != null) fields.leftGroups = body.leftGroups;
      else if (body.mode != null && existing.leftGroups)
        fields.leftGroups = existing.leftGroups;
      if (body.rightGroups != null) fields.rightGroups = body.rightGroups;
      else if (body.mode != null && existing.rightGroups)
        fields.rightGroups = existing.rightGroups;
      if (body.direction != null) fields.direction = body.direction;
      else if (body.mode != null) fields.direction = existing.direction || "ltr";
    } else {
      if (body.groups != null) fields.groups = body.groups;
      else if (body.mode != null) fields.groups = existing.groups;
    }

    const patch = store.update(req.params.id, fields);
    if (shouldSyncDataSyncs(existing, patch)) {
      await channelPatchDataSync.syncDataSyncsForPatchChange({
        before: existing,
        after: patch,
      });
    }
    const synced = store.getById(patch.id) || patch;

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_UPDATED",
      targetType: "channel_patch",
      targetId: synced.id,
      details: {
        name: synced.name,
        enabled: synced.enabled,
        mode: synced.mode,
        direction: synced.direction || null,
        groups: synced.groups,
        leftGroups: synced.leftGroups || null,
        rightGroups: synced.rightGroups || null,
        summary: `Updated channel patch ${synced.name}.`,
      },
    });

    res.json(enrichPatch(synced));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

// DELETE /api/channel-patch/:id
router.delete("/:id", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const existing = store.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Patch not found" });
    }

    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    if (
      !channelPatchAccess.filterPatchesForAccess(access, [existing], allowed)
        .length
    ) {
      return hideOutOfScopePatch(res);
    }

    await channelPatchDataSync.syncDataSyncsForPatchChange({
      before: existing,
      after: null,
    });
    store.remove(req.params.id);

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_DELETED",
      targetType: "channel_patch",
      targetId: existing.id,
      details: {
        name: existing.name,
        groups: existing.groups,
        summary: `Deleted channel patch ${existing.name}.`,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
