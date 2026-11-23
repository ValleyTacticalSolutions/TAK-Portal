"use strict";

const path = require("path");

/**
 * Resolve `target` (absolute, or relative to `base`) and refuse anything that lands outside `base`.
 * Returns the absolute path. Throws "Illegal path" otherwise (also for NUL bytes).
 */
function resolveInside(base, target) {
  const baseAbs = path.resolve(String(base));
  const t = String(target == null ? "" : target);
  if (t.includes("\0")) throw new Error("Illegal path");
  const resolved = path.resolve(baseAbs, t);
  const prefix = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (resolved !== baseAbs && !resolved.startsWith(prefix)) {
    throw new Error("Illegal path");
  }
  return resolved;
}

module.exports = { resolveInside };
