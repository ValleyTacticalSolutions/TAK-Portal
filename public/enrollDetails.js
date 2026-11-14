/**
 * Parse a TAK enrollment URL (tak://com.atakmap.app/enroll?host=...&username=...&token=...)
 * into the plain fields the QR code carries, for the "Show Details" view.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.EnrollDetails = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseEnrollUrl(url) {
    const s = String(url || "").trim();
    const q = s.indexOf("?");
    if (q < 0) return null;
    const out = { host: "", username: "", password: "" };
    for (const part of s.slice(q + 1).split("&")) {
      const eq = part.indexOf("=");
      const key = eq < 0 ? part : part.slice(0, eq);
      const raw = eq < 0 ? "" : part.slice(eq + 1);
      let val = raw;
      try {
        val = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch {
        /* keep raw value */
      }
      if (key === "host") out.host = val;
      else if (key === "username") out.username = val;
      else if (key === "token") out.password = val;
    }
    return out.host || out.username || out.password ? out : null;
  }

  return { parseEnrollUrl };
});
