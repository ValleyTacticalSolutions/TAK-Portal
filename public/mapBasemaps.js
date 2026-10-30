/**
 * Shared MapLibre basemap definitions for /map and dashboard mini map.
 */
(function () {
  "use strict";

  const MAP_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
  const DEFAULT_BASEMAP_ID = "dark-matter";
  // TAK marker labels use Open Sans Semibold. CARTO's versioned fonts CDN
  // (tiles.basemaps.cartocdn.com/v/.../fonts) serves Montserrat / Open Sans
  // Regular+Bold for basemap text but 404s Semibold — rewrite those fetches
  // to MapLibre demotiles so labels render without breaking CARTO place names.
  const SEMIBOLD_FONTSTACK = "Open Sans Semibold";
  const SEMIBOLD_GLYPH_RE = /\/fonts\/Open(?:%20| )Sans(?:%20| )Semibold\/([^/?#]+\.pbf)/i;

  function rewriteMissingCartoSemiboldGlyphs(url, resourceType) {
    if (resourceType !== "Glyphs") return undefined;
    const raw = String(url || "");
    if (!raw || raw.indexOf("demotiles.maplibre.org/font/") !== -1) return undefined;
    const match = raw.match(SEMIBOLD_GLYPH_RE);
    if (!match) return undefined;
    return {
      url:
        "https://demotiles.maplibre.org/font/" +
        SEMIBOLD_FONTSTACK +
        "/" +
        match[1],
    };
  }

  function withMapGlyphs(style) {
    if (typeof style === "string") return style;
    return { ...style, glyphs: MAP_GLYPHS };
  }

  function rasterBasemapStyle(label, tileUrl, attribution, maxzoom) {
    return withMapGlyphs({
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: [
            tileUrl
              .replace(/\{\$x\}/g, "{x}")
              .replace(/\{\$y\}/g, "{y}")
              .replace(/\{\$z\}/g, "{z}"),
          ],
          tileSize: 256,
          attribution,
          maxzoom: maxzoom || 18,
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    });
  }

  const BASEMAPS = {
    "dark-matter": {
      label: "CARTO Dark Matter",
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    },
    positron: {
      label: "CARTO Positron",
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    },
    voyager: {
      label: "CARTO Voyager",
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    },
    satellite: {
      label: "Esri Satellite",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [
              "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            attribution: "Esri, Maxar, Earthstar Geographics",
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    topo: {
      label: "OpenTopoMap Topographic",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution:
              '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>, OSM',
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    "google-maps": {
      label: "Google Maps",
      style: rasterBasemapStyle(
        "Google Maps",
        "https://mts1.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}&s=Gal&apistyle=s.t:2|s.e:l|p.v:off",
        "Google",
        18
      ),
    },
    "google-satellite": {
      label: "Google Satellite",
      style: rasterBasemapStyle(
        "Google Satellite",
        "https://mt1.google.com/vt/lyrs=s&hl=en&x={x}&y={y}&z={z}",
        "Google",
        22
      ),
    },
    "google-hybrid": {
      label: "Google Hybrid",
      style: rasterBasemapStyle(
        "Google Hybrid",
        "https://mt1.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
        "Google",
        22
      ),
    },
    "google-terrain": {
      label: "Google Terrain",
      style: rasterBasemapStyle(
        "Google Terrain",
        "https://mts1.google.com/vt/lyrs=p&hl=en&x={x}&y={y}&z={z}",
        "Google",
        18
      ),
    },
    "google-traffic": {
      label: "Google Traffic",
      style: rasterBasemapStyle(
        "Google Traffic",
        "https://mt0.google.com/vt/lyrs=m,parking,traffic&hl=en&x={x}&y={y}&z={z}&apistyle=s.t:2|s.e:l|p.v:off",
        "Google",
        18
      ),
    },
  };

  function normalizeBasemapId(id) {
    let saved = String(id || "").trim() || DEFAULT_BASEMAP_ID;
    if (saved === "dark" || saved === "light") {
      saved = saved === "light" ? "voyager" : DEFAULT_BASEMAP_ID;
    } else if (/-nolabels$/.test(saved)) {
      saved = saved.replace(/-nolabels$/, "");
    }
    if (!BASEMAPS[saved]) saved = DEFAULT_BASEMAP_ID;
    return saved;
  }

  function getBasemapEntry(id) {
    const key = normalizeBasemapId(id);
    return BASEMAPS[key] || BASEMAPS[DEFAULT_BASEMAP_ID];
  }

  function getBasemapStyle(id) {
    return getBasemapEntry(id).style;
  }

  window.TAK_MAP_BASEMAPS = {
    MAP_GLYPHS,
    DEFAULT_BASEMAP_ID,
    BASEMAPS,
    withMapGlyphs,
    rewriteMissingCartoSemiboldGlyphs,
    rasterBasemapStyle,
    normalizeBasemapId,
    getBasemapEntry,
    getBasemapStyle,
  };
})();
