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

export function styleReadyForMarkerLayers(
  map: StyleGateMap | null | undefined
): boolean {
  if (!map) return false;
  try {
    if (typeof map.getStyle === "function") {
      const style = map.getStyle();
      if (style && Array.isArray(style.layers)) return true;
    }
  } catch (_) {
    /* Style is mid-swap; fall through to the stricter check. */
  }
  return typeof map.isStyleLoaded === "function" && map.isStyleLoaded();
}
