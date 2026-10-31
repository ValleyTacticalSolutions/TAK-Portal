const assert = require("assert");
const fs = require("fs");
const path = require("path");

const directoryRepo = require("../services/directoryRepo.service");
const portalHidden = require("../services/portalHidden.util");
const migration = require("../services/hiddenPrefixMigration.service");

// SQL must use starts_with so "_" in prefixes (e.g. adm_) is literal, not LIKE (#83)
{
  const params = [];
  const sql = directoryRepo.hiddenUserClause(params, false);
  assert.ok(params.length === 1 && Array.isArray(params[0]));
  assert.ok(params[0].includes("ak-outpost"));
  assert.ok(/starts_with\s*\(\s*lower\(username\)\s*,\s*p\s*\)/i.test(sql), sql);
  assert.ok(!/LIKE\s+p\s*\|\|/i.test(sql), "hiddenUserClause must not use LIKE p || '%'");
}

const repoSrc = fs.readFileSync(
  path.join(__dirname, "../services/directoryRepo.service.js"),
  "utf8"
);
assert.ok(
  /starts_with\s*\(\s*lower\(\$\{nameCol\}\)\s*,\s*p\s*\)/.test(repoSrc) ||
    /starts_with\(lower\(\$\{nameCol\}\), p\)/.test(repoSrc),
  "hiddenGroupClause must use starts_with"
);
assert.ok(
  !/LIKE\s+\$\{nameCol\}/.test(repoSrc) && !/LIKE p \|\| '%'/.test(repoSrc),
  "directoryRepo must not use LIKE p || '%' for hidden prefixes"
);

assert.ok(
  migration.LEGACY_USER_HIDDEN_PREFIXES.includes("adm_"),
  "legacy list still includes adm_ (literal underscore)"
);

const migrationSrc = fs.readFileSync(
  path.join(__dirname, "../services/hiddenPrefixMigration.service.js"),
  "utf8"
);
assert.ok(
  /starts_with\s*\(\s*lower\(username\)\s*,\s*p\s*\)/.test(migrationSrc),
  "migration user queries must use starts_with"
);
assert.ok(
  !/LIKE\s+p\s*\|\|\s*'%'/.test(migrationSrc),
  "migration must not use LIKE p || '%'"
);

assert.strictEqual(portalHidden.usernameMatchesHiddenPrefix("adm1axyz", ["adm_"]), false);
assert.strictEqual(portalHidden.usernameMatchesHiddenPrefix("adm_ldapservice", ["adm_"]), true);

console.log("hiddenPrefixLike.test.js: ok");
