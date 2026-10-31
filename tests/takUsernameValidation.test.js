const assert = require("assert");
const accessSvc = require("../services/access.service");

const {
  validateTakUsername,
  validateTakUsernameToken,
  isValidTakUsernameCharset,
  buildUsernameWithAgencyToken,
  TAK_USERNAME_INVALID_MSG,
} = accessSvc;

assert.strictEqual(validateTakUsername("abcd"), null);
assert.strictEqual(validateTakUsername("ab.cd"), null);
assert.strictEqual(validateTakUsername("ab_cd"), null);
assert.strictEqual(validateTakUsername("ab-cd"), null);
assert.strictEqual(validateTakUsername("ABC123"), null);

assert.strictEqual(validateTakUsername("abc"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername(""), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab/cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab\\cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab,cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab+cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername('ab"cd'), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab<cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab>cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab;cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab cd"), TAK_USERNAME_INVALID_MSG);
assert.strictEqual(validateTakUsername("ab@cd"), TAK_USERNAME_INVALID_MSG);

assert.strictEqual(isValidTakUsernameCharset("ok.name_1-2"), true);
assert.strictEqual(isValidTakUsernameCharset("bad/name"), false);

assert.strictEqual(validateTakUsernameToken("abcd", "Badge"), null);
assert.match(
  validateTakUsernameToken("ab/cd", "Badge"),
  /letters, numbers, dots, underscores and hyphens/i
);
assert.match(validateTakUsernameToken("", "Badge"), /required/i);

const agency = { suffix: "abcd", usernameTokenPlacement: "suffix" };
assert.strictEqual(
  buildUsernameWithAgencyToken("12", agency),
  "12abcd"
);
assert.strictEqual(
  validateTakUsername(buildUsernameWithAgencyToken("12", agency)),
  null
);
assert.strictEqual(
  validateTakUsername(buildUsernameWithAgencyToken("1", { suffix: "ab" })),
  TAK_USERNAME_INVALID_MSG
);
assert.strictEqual(
  validateTakUsername(
    buildUsernameWithAgencyToken("name/other", { suffix: "xx" })
  ),
  TAK_USERNAME_INVALID_MSG
);

console.log("takUsernameValidation.test.js: ok");
