/**
 * Marker layers can be added once the style document exists.
 * map.isStyleLoaded() stays false until every tile and sprite finishes.
 * A desktop viewport requests many more tiles than a phone, so waiting on
 * that flag left layers unbuilt past the 3s restore fallback. The fallback
 * then rebuilt marker layers and the map flashed.
 */
export type StyleGateMap = {
  isStyleLoaded?: () => boolean;
  getStyle?: () => { layers?: unknown } | null | undefined;
};

export type IconAttempt = {
  state: "pending" | "installed" | "failed";
  at: number;
};

/**
 * True once the style document is parsed.
 * map.isStyleLoaded() is false whenever any tile is in flight, including the
 * live marker source, which updates several times a second. addImage only
 * needs a parsed style, so that flag must not gate icon installs.
 */
export function styleReadyForMarkerLayers(
  map: StyleGateMap | null | undefined,
  styleParsed?: boolean
): boolean {
  if (styleParsed === true) return true;
  if (!map) return false;
  try {
    if (typeof map.getStyle === "function") {
      const style = map.getStyle();
      if (style && Array.isArray(style.layers)) return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

/** Skip a fetch when the icon is already in the style, in flight, or cooling down. */
export function iconFetchAllowed(
  row: IconAttempt | null | undefined,
  now: number,
  backoffMs: number,
  hasImage: boolean
): boolean {
  if (hasImage) return false;
  if (!row) return true;
  if (row.state === "installed" || row.state === "pending") return false;
  if (row.state === "failed" && now - row.at < backoffMs) return false;
  return true;
}
