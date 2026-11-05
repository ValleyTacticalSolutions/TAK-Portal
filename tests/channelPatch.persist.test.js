"use strict";

const assert = require("assert");
const db = require("../services/db");
const pgCache = require("../services/pgCache");
const store = require("../services/channelPatch.store");

const origConfigured = db.isConfigured;
const origTx = db.withTransaction;

function keyConflict() {
  const err = new Error(
    'duplicate key value violates unique constraint "channel_patches_pkey"'
  );
  err.code = "23505";
  return err;
}

function patch(id, name, groups) {
  return {
    id,
    name,
    enabled: true,
    groups,
    createdAt: "2026-11-05T18:00:00.000Z",
    updatedAt: "2026-11-05T18:00:00.000Z",
  };
}

async function main() {
  let unhandled = null;
  process.on("unhandledRejection", (err) => {
    unhandled = err;
  });

  let inTx = 0;
  let maxInTx = 0;
  let conflictsLeft = 1;
  let lockQueries = 0;
  const completed = [];
  const completedNames = [];

  db.isConfigured = () => true;
  db.withTransaction = async (fn) => {
    inTx += 1;
    maxInTx = Math.max(maxInTx, inTx);
    const batch = [];
    const names = [];
    const seen = new Set();
    const client = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("pg_advisory_xact_lock")) {
          lockQueries += 1;
          return { rows: [] };
        }
        if (text.includes("INSERT INTO channel_patches")) {
          const id = params[0];
          if (seen.has(id)) throw keyConflict();
          if (conflictsLeft > 0) {
            conflictsLeft -= 1;
            throw keyConflict();
          }
          seen.add(id);
          batch.push(id);
          const payload = JSON.parse(params[1]);
          names.push(payload.name);
        }
        return { rows: [] };
      },
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await fn(client);
      completed.push(batch);
      completedNames.push(names);
      return result;
    } finally {
      inTx -= 1;
    }
  };

  store.invalidateCache();
  pgCache.caches.channelPatches = [
    patch("flood", "Flooding 11-5-26", ["tak_Mutual Aid", "tak_Polk Main"]),
    patch("flood", "Flooding 11-5-26 copy", ["tak_Mutual Aid", "tak_Polk Main"]),
    patch("polk", "Polk County Flood", ["tak_Polk Flood", "tak_Mutual Aid"]),
  ];
  const loaded = store.list();
  assert.strictEqual(loaded.length, 2, "load collapses duplicate patch ids");
  assert.strictEqual(loaded[0].id, "flood");
  assert.strictEqual(loaded.find((p) => p.id === "flood").name, "Flooding 11-5-26 copy", "later duplicate wins");
  assert.strictEqual(loaded.find((p) => p.id === "polk").name, "Polk County Flood");

  const first = pgCache.replaceChannelPatches([
    patch("flood", "Flooding 11-5-26", ["tak_Mutual Aid", "tak_Polk Main"]),
    patch("flood", "Flooding 11-5-26 duplicate", ["tak_Mutual Aid", "tak_Polk Main"]),
    patch("polk", "Polk County Flood", ["tak_Polk Flood", "tak_Mutual Aid"]),
  ]);
  assert.strictEqual(pgCache.caches.channelPatches.length, 2, "a save drops a repeated patch id");
  assert.strictEqual(pgCache.caches.channelPatches[0].name, "Flooding 11-5-26 duplicate");
  const second = pgCache.replaceChannelPatches([
    patch("flood", "Flooding 11-5-26", ["tak_Mutual Aid", "tak_Polk Main"]),
    patch("polk", "Polk County Flood", ["tak_Polk Flood", "tak_Mutual Aid"]),
  ]);

  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(unhandled, null, "duplicate key must not reject as unhandled");
  assert.strictEqual(maxInTx, 1, "overlapping channel patch saves must not run together");
  assert.ok(lockQueries >= 2, "each replace takes the channel patch advisory lock");
  assert.ok(completed.length >= 2, "unique violation is retried and the save finishes");
  for (const batch of completed) {
    assert.deepStrictEqual(batch, ["flood", "polk"], "each save inserts an id once");
  }
  assert.ok(
    completedNames.some((names) => names[0] === "Flooding 11-5-26 duplicate"),
    "duplicate id in one save keeps the later patch"
  );

  console.log("channelPatch.persist.test.js OK");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.isConfigured = origConfigured;
    db.withTransaction = origTx;
  });
