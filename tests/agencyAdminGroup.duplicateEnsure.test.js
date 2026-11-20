/**
 * Proof for #141: Agency Admin / agency Save must not insert a second local
 * groups row when authentik-…-AgencyAdmin already exists.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const agencyAdminSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "agencyAdminGroup.service.js"),
  "utf8"
);
const groupsSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "groups.service.js"),
  "utf8"
);
const syncSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directorySync.service.js"),
  "utf8"
);
const repoSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "directoryRepo.service.js"),
  "utf8"
);
const abbrevSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "agencyAbbrevRename.service.js"),
  "utf8"
);
const nameRenameSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "agencyNameRename.service.js"),
  "utf8"
);

const ensureFn = agencyAdminSrc.slice(
  agencyAdminSrc.indexOf("async function ensureAgencyAdminGroupExists"),
  agencyAdminSrc.indexOf("function normalizeSuffix")
);
assert.ok(
  /getGroupByNameUnfiltered\(name\)/.test(ensureFn),
  "ensureAgencyAdminGroupExists must look up the group by name first"
);
const lookupIdx = ensureFn.indexOf("getGroupByNameUnfiltered(name)");
const createIdx = ensureFn.indexOf("groupsService.createGroup");
assert.ok(lookupIdx >= 0 && createIdx > lookupIdx, "lookup must run before createGroup");
assert.ok(
  /pending_delete/.test(ensureFn.slice(lookupIdx, createIdx)),
  "existing non-pending_delete row must short-circuit create"
);

const createFn = groupsSrc.slice(
  groupsSrc.indexOf("async function createGroup"),
  groupsSrc.indexOf("async function setUserGroups")
);
assert.ok(
  /already exists/.test(createFn),
  "createGroup must refuse when a live local row with the same name exists"
);
assert.ok(
  /getGroupById\(n\)/.test(createFn) && /pending_delete/.test(createFn),
  "createGroup must check directory before insertLocalGroup"
);

assert.match(
  syncSrc,
  /groups_authentik_pk_key|authentik_pk = \$1 AND id <> \$2/,
  "create_group worker must detect pk already owned by another local row"
);
assert.match(
  syncSrc,
  /deleteLocalGroup\(row\.entity_id\)/,
  "create_group worker must drop the orphan local row instead of retrying"
);

assert.match(
  repoSrc,
  /\(authentik_pk IS NOT NULL\) DESC/,
  "name lookup must prefer the synced row when duplicates exist"
);

assert.match(
  abbrevSrc,
  /agencyAdminGroup\.service/,
  "agency abbrev rename must use shared agencyAdminGroup.service (no create-then-catch copy)"
);
assert.doesNotMatch(
  abbrevSrc,
  /async function ensureAgencyAdminGroupExists/,
  "agency abbrev rename must not keep a local ensureAgencyAdminGroupExists copy"
);
assert.match(
  nameRenameSrc,
  /agencyAdminGroup\.service/,
  "agency name rename must use shared agencyAdminGroup.service"
);
assert.doesNotMatch(
  nameRenameSrc,
  /async function ensureAgencyAdminGroupExists/,
  "agency name rename must not keep a local ensureAgencyAdminGroupExists copy"
);

const directoryRepo = require("../services/directoryRepo.service");
const groupsService = require("../services/groups.service");
const agencyAdminGroupSvc = require("../services/agencyAdminGroup.service");
const { handleOutboxRow } = require("../services/directorySync.service");
const db = require("../services/db");
const api = require("../services/authentik");

(async () => {
  let createCalls = 0;
  const origGet = directoryRepo.getGroupById;
  const origCreate = groupsService.createGroup;

  directoryRepo.getGroupById = async (id) => ({
    name: String(id),
    pending_delete: false,
    sync_status: "ok",
    authentik_pk: "2aabd0f4-existing",
    attributes: {
      created_type: "Agency",
      created_type_detail: "Coretec",
    },
  });
  groupsService.createGroup = async () => {
    createCalls += 1;
    throw new Error("createGroup must not be called when the admin group already exists");
  };

  try {
    const result = await agencyAdminGroupSvc.ensureAgencyAdminGroupExists({
      name: "Coretec",
      groupPrefix: "coretec",
      countyAbbrev: "ALL",
    });
    assert.strictEqual(result.created, false);
    assert.strictEqual(
      result.name,
      "authentik-ALL-coretec-AgencyAdmin"
    );
    assert.strictEqual(createCalls, 0, "must not create when local row exists");
  } finally {
    directoryRepo.getGroupById = origGet;
    groupsService.createGroup = origCreate;
  }

  const deleted = [];
  const queries = [];
  const origRepoDelete = directoryRepo.deleteLocalGroup;
  const origDbQuery = db.query;
  const origApiPost = api.post;

  directoryRepo.deleteLocalGroup = async (id) => {
    deleted.push(id);
  };
  db.query = async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/SELECT authentik_pk FROM groups WHERE id/.test(sql)) {
      return { rows: [{ authentik_pk: null }] };
    }
    if (/SELECT id FROM groups[\s\S]*authentik_pk = \$1 AND id <> \$2/.test(sql)) {
      return { rows: [{ id: "owner-uuid" }] };
    }
    return { rows: [] };
  };
  api.post = async () => {
    const err = new Error("already exists");
    err.response = { status: 400, data: { detail: "group name already exists" } };
    throw err;
  };

  // findAuthentikGroupByName uses api.get — return the existing Authentik group.
  const origApiGet = api.get;
  api.get = async () => ({
    data: {
      results: [{ pk: "2aabd0f4-existing", name: "authentik-ALL-coretec-AgencyAdmin" }],
    },
  });

  try {
    await handleOutboxRow({
      kind: "create_group",
      entity_id: "orphan-uuid",
      authentik_pk: null,
      payload: {
        name: "authentik-ALL-coretec-AgencyAdmin",
        attributes: {},
      },
    });
    assert.deepStrictEqual(deleted, ["orphan-uuid"]);
    assert.ok(
      !queries.some((q) => /UPDATE groups SET authentik_pk/.test(q.sql)),
      "must not UPDATE authentik_pk onto the orphan when another row owns it"
    );
  } finally {
    directoryRepo.deleteLocalGroup = origRepoDelete;
    db.query = origDbQuery;
    api.post = origApiPost;
    api.get = origApiGet;
  }

  console.log("agencyAdminGroup.duplicateEnsure.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
