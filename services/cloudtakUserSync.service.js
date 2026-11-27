"use strict";

/**
 * Mirror TAK Portal user removal into CloudTAK (issue #132).
 *
 * - remove  -> DELETE /api/user/:u?username=:u (irreversible erase)
 * - Disabling a user in TAK Portal deliberately leaves the CloudTAK profile alone.
 *
 * Runs only when a CloudTAK API token is saved and CLOUDTAK_USER_SYNC is not
 * switched off. A missing CloudTAK profile counts as done. A CloudTAK error is
 * written to the audit log and never blocks the portal action.
 */

const settingsSvc = require("./settings.service");
const cloudtakApi = require("./cloudtakApi.service");
const auditSvc = require("./auditLog.service");

function isEnabled() {
  const s = settingsSvc.getSettings() || {};
  return cloudtakApi.isConfigured() && s.CLOUDTAK_USER_SYNC !== false && String(s.CLOUDTAK_USER_SYNC).toLowerCase() !== "false";
}

function audit(action, username, outcome, message) {
  try {
    auditSvc.logEvent({
      actor: null,
      action,
      targetType: "user",
      targetId: String(username),
      details: { summary: `CloudTAK profile ${outcome}.`, username, outcome, ...(message ? { error: message } : {}) },
    });
  } catch (_) {
    /* audit must never block */
  }
}

async function erase(username) {
  const name = String(username || "").trim();
  if (!name || !isEnabled()) return { skipped: true };
  try {
    const found = await cloudtakApi.eraseUser(name);
    audit("CLOUDTAK_USER_SYNC", name, found ? "erased" : "not found (nothing to do)");
    return { ok: true, found };
  } catch (err) {
    audit("CLOUDTAK_USER_SYNC", name, "erase failed", err && err.message);
    return { ok: false, error: err && err.message };
  }
}

module.exports = { isEnabled, erase };
