"use strict";

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value) {
  return String(value == null ? "" : value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove all leading and/or trailing copies of one character, in linear time. */
function trimChar(value, ch, { start = true, end = true } = {}) {
  const s = String(value == null ? "" : value);
  let a = 0;
  let b = s.length;
  if (start) while (a < b && s[a] === ch) a++;
  if (end) while (b > a && s[b - 1] === ch) b--;
  return s.slice(a, b);
}

/**
 * Simple, linear-time email shape check: one "@", no whitespace, a dot in the domain,
 * and a final label of 2+ letters. Max length 254 (RFC 5321).
 */
function isValidEmail(value) {
  const s = String(value == null ? "" : value);
  if (!s || s.length > 254 || /\s/.test(s)) return false;
  const at = s.indexOf("@");
  if (at < 1) return false;
  const domain = s.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  if (lastDot < 1) return false;
  const tld = domain.slice(lastDot + 1);
  return tld.length >= 2 && /^[A-Za-z]+$/.test(tld);
}

module.exports = { escapeRegExp, trimChar, isValidEmail };
