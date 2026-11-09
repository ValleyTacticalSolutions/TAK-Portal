const assert = require("assert");
const path = require("path");

// Fresh module graph so prior directorySync mocks cannot leak in.
function loadFresh() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes(`${path.sep}services${path.sep}directorySync.service`) ||
      key.includes(`${path.sep}services${path.sep}db`) ||
      key.includes(`${path.sep}services${path.sep}authentik`) ||
      key.includes(`${path.sep}services${path.sep}authentikOutbox.service`) ||
      key.includes(`${path.sep}services${path.sep}directoryRepo.service`) ||
      key.includes(`${path.sep}services${path.sep}userLoginStatus.service`) ||
      key.includes(`${path.sep}services${path.sep}agencies.service`) ||
      key.includes(`${path.sep}services${path.sep}access.service`)
    ) {
      delete require.cache[key];
    }
  }
}

(async () => {
  loadFresh();
  const sqlCalls = [];
  const db = require("../services/db");
  db.query = async (sql, params) => {
    sqlCalls.push({ sql: String(sql), params });
    if (/FROM groups WHERE pending_delete = false/.test(sql) && /SELECT id, authentik_pk/.test(sql)) {
      return {
        rows: [
          { id: "11111111-1111-1111-1111-111111111111", authentik_pk: "g-live" },
          { id: "22222222-2222-2222-2222-222222222222", authentik_pk: "g-orphan" },
        ],
      };
    }
    if (/directory_sync/.test(sql)) return { rows: [{ last_error: null, completed: false }] };
    if (/SELECT id, groups_hash FROM users/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };

  const api = require("../services/authentik");
  api.get = async (url) => {
    if (String(url).includes("/core/groups/")) {
      return {
        data: {
          results: [{ pk: "g-live", name: "tak_live", attributes: {} }],
          pagination: {},
        },
      };
    }
    if (String(url).includes("/core/users/")) {
      return {
        data: {
          results: [
            {
              pk: "u-live",
              username: "live.user",
              is_active: true,
              attributes: {},
              groups: ["g-live"],
            },
          ],
          pagination: {},
        },
      };
    }
    throw new Error(`unexpected authentik get ${url}`);
  };

  const outbox = require("../services/authentikOutbox.service");
  outbox.pendingEntityKeys = async () => ({
    byUserId: new Set(),
    byUsername: new Set(),
    byPk: new Set(),
    rows: [],
  });

  const agencies = require("../services/agencies.service");
  agencies.load = () => [];

  const access = require("../services/access.service");
  access.listTypes = () => [];

  const loginStatus = require("../services/userLoginStatus.service");
  loginStatus.refreshStoredUserStatus = async () => {};
  loginStatus.parseAuthentikLastLogin = () => null;

  const { inboundSnapshot } = require("../services/directorySync.service");
  await inboundSnapshot();

  const groupDelete = sqlCalls.find(
    (c) => /^DELETE FROM groups/i.test(c.sql.trim()) || /\nDELETE FROM groups/i.test(c.sql)
  );
  assert.ok(groupDelete, "inbound snapshot must DELETE groups missing from Authentik");
  assert.deepStrictEqual(groupDelete.params[0], ["g-live"]);
  assert.ok(
    /authentik_pk IS NOT NULL/.test(groupDelete.sql),
    "group cleanup must only target rows linked to Authentik"
  );

  const userDelete = sqlCalls.find((c) => /DELETE FROM users/i.test(c.sql));
  assert.ok(userDelete, "inbound snapshot must DELETE users missing from Authentik");
  assert.deepStrictEqual(userDelete.params[0], ["u-live"]);
  assert.ok(
    !sqlCalls.some((c) => /is_active = false/.test(c.sql) && /authentik_pk IS NOT NULL/.test(c.sql)),
    "missing Authentik users must be deleted, not only deactivated"
  );

  console.log("directorySync.inboundCleanup.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
