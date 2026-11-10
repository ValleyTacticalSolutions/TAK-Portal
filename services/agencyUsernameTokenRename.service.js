/**
 * Orchestrates agency username token (suffix) and placement renames.
 * scope "future"  — update agency + re-key FKs; existing usernames unchanged
 * scope "existing" — also revoke TAK certs, rebuild usernames, email users
 */

const { getInt } = require("./env");
const agenciesStore = require("./agencies.service");
const templatesStore = require("./templates.service");
const userRequestsStore = require("./userRequests.store");
const accessSvc = require("./access.service");
const directoryRepo = require("./directoryRepo.service");
const authentikOutbox = require("./authentikOutbox.service");
const tak = require("./tak.service");
const usersService = require("./users.service");
const userLoginStatus = require("./userLoginStatus.service");
const db = require("./db");

function getConcurrency() {
  const defaultLimit = 5;
  const envVal = getInt("AGENCY_ACTIVE_CONCURRENCY", defaultLimit);
  return Number.isFinite(envVal) && envVal > 0 && envVal <= 25 ? envVal : defaultLimit;
}

async function runWithConcurrencyLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  let index = 0;
  const workers = [];
  const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, list.length));
  for (let i = 0; i < maxWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const current = index++;
          if (current >= list.length) break;
          await worker(list[current], current);
        }
      })()
    );
  }
  await Promise.all(workers);
}

function normalizeTokenPlacement(raw) {
  return accessSvc.normalizeUsernameTokenPlacement(raw);
}

function validateNewUsernameToken(raw) {
  return accessSvc.validateTakUsernameToken(
    String(raw || "").trim().toLowerCase(),
    "Username Agency Identifier"
  );
}

function updateTemplatesAgencySuffix(oldSuffix, newSuffix) {
  const oldSfx = String(oldSuffix || "").trim().toLowerCase();
  const newSfx = String(newSuffix || "").trim().toLowerCase();
  if (!oldSfx || !newSfx || oldSfx === newSfx) return { templatesUpdated: 0 };

  const templates = templatesStore.load();
  let templatesUpdated = 0;
  const next = templates.map((t) => {
    if (String(t.agencySuffix || "").trim().toLowerCase() !== oldSfx) return t;
    templatesUpdated += 1;
    return { ...t, agencySuffix: newSfx };
  });
  if (templatesUpdated > 0) templatesStore.save(next);
  return { templatesUpdated };
}

function updateUserRequestsAgencySuffix(oldSuffix, newSuffix) {
  const oldSfx = String(oldSuffix || "").trim().toLowerCase();
  const newSfx = String(newSuffix || "").trim().toLowerCase();
  if (!oldSfx || !newSfx || oldSfx === newSfx) return { requestsUpdated: 0 };

  const requests = userRequestsStore.load();
  let requestsUpdated = 0;
  const next = requests.map((r) => {
    if (String(r?.agencySuffix || "").trim().toLowerCase() !== oldSfx) return r;
    requestsUpdated += 1;
    return { ...r, agencySuffix: newSfx };
  });
  if (requestsUpdated > 0) userRequestsStore.save(next);
  return { requestsUpdated };
}

async function rekeyUsersAgencyAttribute(oldSuffix, newSuffix) {
  const rows = await directoryRepo.updateUsersAgencySuffixColumn(oldSuffix, newSuffix);
  for (const row of rows) {
    if (!row.authentik_pk) continue;
    await authentikOutbox.enqueue({
      kind: "patch_user",
      entityType: "user",
      entityId: row.id,
      authentikPk: row.authentik_pk,
      username: row.username,
      payload: {
        authentikPk: row.authentik_pk,
        patch: { attributes: row.attributes },
      },
    });
  }
  if (rows.length) usersService.invalidateUsersCache();
  return { matched: rows.length, updated: rows.length };
}

function resolveBadgeForUser(user, oldAgency) {
  const attrs =
    user && typeof user.attributes === "object" && user.attributes ? user.attributes : {};
  const fromAttr = String(attrs.badge_number || user?.badge_number || "").trim();
  if (fromAttr) return fromAttr;
  const username = String(user?.username || "").trim();
  if (!username) return "";
  const stripped = accessSvc.stripAgencyTokenFromUsername(
    username,
    oldAgency.suffix,
    accessSvc.getAgencyUsernameTokenPlacement(oldAgency)
  );
  const badge = String(stripped || "").trim();
  // If the agency token was not present on the username, stripping is a no-op.
  if (!badge || badge.toLowerCase() === username.toLowerCase()) return "";
  return badge;
}

function isActionLockedUsername(username) {
  // Mirror users.service isUserActionLocked without exporting it.
  const { getString } = require("./env");
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;
  const prefixes = String(getString("USERS_ACTIONS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
  if (!prefixes.length) return false;
  return prefixes.some((p) => u.startsWith(p));
}

/**
 * Build rename plan for existing users. Throws on validation/collision failures.
 */
async function buildExistingRenamePlan(users, oldAgency, newAgency) {
  const plans = [];
  const newNamesLower = new Set();
  const affectedIds = new Set();

  for (const user of users) {
    if (usersService.isIntegrationUser(user)) continue;

    const userId = String(user.uuid || user.id || user.pk || "");
    const oldUsername = String(user.username || "").trim();
    if (!userId || !oldUsername) {
      throw new Error(`User is missing id/username and cannot be renamed`);
    }
    if (isActionLockedUsername(oldUsername)) {
      throw new Error(`Actions are locked for user ${oldUsername}`);
    }

    const badge = resolveBadgeForUser(user, oldAgency);
    if (!badge) {
      throw new Error(
        `User "${oldUsername}" has no badge number; cannot rebuild username`
      );
    }

    const newUsername = accessSvc.buildUsernameWithAgencyToken(badge, newAgency);
    const usernameErr = accessSvc.validateTakUsername(newUsername);
    if (usernameErr) {
      throw new Error(`User "${oldUsername}": ${usernameErr}`);
    }

    const lower = newUsername.toLowerCase();
    if (newNamesLower.has(lower)) {
      throw new Error(`Duplicate rebuilt username "${newUsername}" within this agency`);
    }
    newNamesLower.add(lower);
    affectedIds.add(userId);

    plans.push({
      user,
      userId,
      oldUsername,
      newUsername,
      badge,
      usernameChanged: oldUsername.toLowerCase() !== lower,
    });
  }

  // Collision check against users outside the rename set.
  for (const plan of plans) {
    if (!plan.usernameChanged) continue;
    const existing = await directoryRepo.getUserByUsername(plan.newUsername);
    if (!existing) continue;
    const existingId = String(existing.uuid || existing.id || "");
    if (affectedIds.has(existingId)) continue;
    throw new Error(
      `New username "${plan.newUsername}" already exists (conflicts with an existing user)`
    );
  }

  return plans;
}

async function applyExistingUserRenames(plans, newAgency) {
  const newSfx = String(newAgency.suffix || "").trim().toLowerCase();
  const toRevoke = plans.filter((p) => p.usernameChanged).map((p) => p.oldUsername);
  if (toRevoke.length) {
    await tak.revokeCertsForUsersBulk(toRevoke, { requireVerified: true });
  }

  const failures = [];
  const emailFailures = [];
  let usersUpdated = 0;
  let emailsSent = 0;
  const concurrency = getConcurrency();

  await runWithConcurrencyLimit(plans, concurrency, async (plan) => {
    try {
      const attrs =
        plan.user.attributes && typeof plan.user.attributes === "object"
          ? { ...plan.user.attributes }
          : {};
      attrs.agency = newSfx;
      attrs.badge_number = plan.badge;

      const patch = {
        username: plan.newUsername,
        attributes: attrs,
      };

      const outboxId = await db.withTransaction(async (c) => {
        await directoryRepo.updateLocalUser(plan.user.uuid || plan.user.id, patch, c);
        return authentikOutbox.enqueue(
          {
            kind: "patch_user",
            entityType: "user",
            entityId: plan.user.uuid || plan.user.id,
            authentikPk: plan.user.authentik_pk,
            username: plan.newUsername,
            payload: {
              authentikPk: plan.user.authentik_pk,
              patch: {
                username: plan.newUsername,
                attributes: attrs,
              },
            },
          },
          c
        );
      });
      void outboxId;
      usersUpdated += 1;

      if (plan.usernameChanged) {
        try {
          const updatedUser = {
            ...plan.user,
            username: plan.newUsername,
            attributes: attrs,
          };
          const sent = await usersService.emailAgencyUsernameChanged({
            user: updatedUser,
            oldUsername: plan.oldUsername,
            newUsername: plan.newUsername,
          });
          if (sent) emailsSent += 1;
        } catch (mailErr) {
          emailFailures.push({
            userId: plan.userId,
            username: plan.newUsername,
            error: mailErr?.message || String(mailErr),
          });
        }
      }
    } catch (err) {
      failures.push({
        userId: plan.userId,
        username: plan.oldUsername,
        error: err?.message || String(err),
      });
    }
  });

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.username || f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to update ${failures.length} user(s) after certificate revoke. ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  // Revoked users must show "{role} - No Logins" (not Web Only), so clear
  // cert + last_login flags and refresh stored status labels.
  const revokedIds = plans
    .filter((p) => p.usernameChanged)
    .map((p) => String(p.user.uuid || p.user.id || "").trim())
    .filter(Boolean);
  if (revokedIds.length) {
    try {
      await userLoginStatus.forceNoLoginsStatusForUserIds(revokedIds);
    } catch (statusErr) {
      console.warn(
        "[agency-username-token] failed to force No Logins status:",
        statusErr?.message || statusErr
      );
    }
  }

  usersService.invalidateUsersCache();
  return { usersUpdated, emailsSent, emailFailures };
}

/**
 * @param {number} agencyIndex
 * @param {{ suffix?: string, usernameTokenPlacement?: string, scope: "future"|"existing" }} opts
 */
async function renameAgencyUsernameToken(agencyIndex, opts = {}) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const scope = String(opts.scope || "").trim().toLowerCase();
  if (scope !== "future" && scope !== "existing") {
    throw new Error('scope must be "future" or "existing"');
  }

  const agency = agencies[idx];
  const oldSuffix = String(agency.suffix || "").trim().toLowerCase();
  const oldPlacement = normalizeTokenPlacement(
    agency.usernameTokenPlacement ?? agency.usernameSuffixPlacement
  );

  const newSuffixRaw =
    opts.suffix != null ? String(opts.suffix).trim().toLowerCase() : oldSuffix;
  const tokenErr = validateNewUsernameToken(newSuffixRaw);
  if (tokenErr) throw new Error(tokenErr);

  const newPlacement =
    opts.usernameTokenPlacement != null
      ? normalizeTokenPlacement(opts.usernameTokenPlacement)
      : oldPlacement;

  if (newSuffixRaw !== oldSuffix) {
    if (
      agencies.some(
        (x, i) =>
          i !== idx && String(x.suffix || "").toLowerCase() === newSuffixRaw
      )
    ) {
      throw new Error("Suffix already exists");
    }
  }

  if (newSuffixRaw === oldSuffix && newPlacement === oldPlacement) {
    return {
      success: true,
      skipped: true,
      scope,
      oldSuffix,
      newSuffix: newSuffixRaw,
      oldPlacement,
      newPlacement,
      usersMatched: 0,
      usersUpdated: 0,
      usersRenamed: 0,
      templatesUpdated: 0,
      requestsUpdated: 0,
      emailsSent: 0,
    };
  }

  const oldAgency = {
    ...agency,
    suffix: oldSuffix,
    usernameTokenPlacement: oldPlacement,
  };
  const newAgency = {
    ...agency,
    suffix: newSuffixRaw,
    usernameTokenPlacement: newPlacement,
  };

  const users = await directoryRepo.listUsersByAgencySuffix(oldSuffix);
  const nonIntegration = users.filter((u) => !usersService.isIntegrationUser(u));

  let usersRenamed = 0;
  let usersUpdated = 0;
  let emailsSent = 0;
  let emailFailures = [];

  if (scope === "existing") {
    const plans = await buildExistingRenamePlan(users, oldAgency, newAgency);
    const out = await applyExistingUserRenames(plans, newAgency);
    usersRenamed = plans.filter((p) => p.usernameChanged).length;
    usersUpdated = out.usersUpdated;
    emailsSent = out.emailsSent;
    emailFailures = out.emailFailures;
    // Integration (and any skipped) users still on the old suffix need agency re-key only.
    if (newSuffixRaw !== oldSuffix) {
      const rekey = await rekeyUsersAgencyAttribute(oldSuffix, newSuffixRaw);
      usersUpdated += rekey.updated;
    }
  } else if (newSuffixRaw !== oldSuffix) {
    // Future-only: re-key agency attribute so users stay linked; keep usernames.
    const rekey = await rekeyUsersAgencyAttribute(oldSuffix, newSuffixRaw);
    usersUpdated = rekey.updated;
  }

  const templateStats = updateTemplatesAgencySuffix(oldSuffix, newSuffixRaw);
  const requestStats = updateUserRequestsAgencySuffix(oldSuffix, newSuffixRaw);

  agencies[idx] = {
    ...agency,
    suffix: newSuffixRaw,
    usernameTokenPlacement: newPlacement,
  };
  agenciesStore.save(agencies);

  usersService.invalidateUsersCache();

  return {
    success: true,
    skipped: false,
    scope,
    agencyName: String(agency.name || "").trim(),
    oldSuffix,
    newSuffix: newSuffixRaw,
    oldPlacement,
    newPlacement,
    usersMatched: nonIntegration.length,
    usersUpdated,
    usersRenamed,
    templatesUpdated: templateStats.templatesUpdated,
    requestsUpdated: requestStats.requestsUpdated,
    emailsSent,
    emailFailures,
  };
}

module.exports = {
  validateNewUsernameToken,
  renameAgencyUsernameToken,
  buildExistingRenamePlan,
  updateTemplatesAgencySuffix,
  updateUserRequestsAgencySuffix,
};
