"use strict";

const sanitizeHtml = require("sanitize-html");

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

/**
 * Decode the few entities we care about in ONE pass, so "&amp;lt;" becomes "&lt;" (not "<").
 */
function decodeBasicEntities(value) {
  return String(value == null ? "" : value).replace(
    /&(amp|lt|gt|quot|#39|#x27|nbsp);/gi,
    (_m, k) => ENTITY_MAP[String(k).toLowerCase()]
  );
}

/**
 * Remove every tag (and <script>/<style> contents) using a real HTML parser, then decode
 * the basic entities once. Returns plain text.
 */
function stripHtmlTags(html) {
  const text = sanitizeHtml(String(html == null ? "" : html), {
    allowedTags: [],
    allowedAttributes: {},
  });
  return decodeBasicEntities(text);
}

module.exports = { decodeBasicEntities, stripHtmlTags };
