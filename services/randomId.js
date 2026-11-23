const crypto = require("crypto");

/** Unpredictable id suffix (hex) from crypto, never Math.random. */
function randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** `<time base36>-<8 hex>` id used for jobs/audit rows/templates. */
function timeId() {
  return `${Date.now().toString(36)}-${randomHex(4)}`;
}

module.exports = { randomHex, timeId };
