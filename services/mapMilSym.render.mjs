/**
 * ESM helper: CoT → 2525D SIDC → milsymbol PNG (used from mapMilSym.service.js).
 */
import ms from "milsymbol";
import Type2525 from "@tak-ps/node-cot/2525";
import sharp from "sharp";

const DEFAULT_SIZE = 48;

/** CloudTAK milicon / numeric 2525D SIDC (20 digits), optional 2525D: prefix. */
export function parseDirect2525DSidc(raw) {
  const s = String(raw || "").trim();
  const m = /^(?:2525D:)?(1[0-9]\d{18})$/i.exec(s);
  return m ? m[1] : null;
}

export function isCotTypeConvertable(cotType) {
  const t = String(cotType || "").trim();
  if (parseDirect2525DSidc(t)) return true;
  try {
    return Type2525.is2525BConvertable(t);
  } catch {
    return false;
  }
}

export function cotTypeTo2525DIconId(cotType) {
  const t = String(cotType || "").trim();
  const direct = parseDirect2525DSidc(t);
  if (direct) return `2525D:${direct}`;
  if (!isCotTypeConvertable(t)) return null;
  try {
    const sidc = Type2525.to2525D(t);
    return sidc ? `2525D:${sidc}` : null;
  } catch {
    return null;
  }
}

export function cotTypeTo2525B(cotType) {
  const t = String(cotType || "").trim();
  if (!isCotTypeConvertable(t)) return null;
  try {
    return Type2525.to2525B(t);
  } catch {
    return null;
  }
}

export async function renderMilSymPng(cotType, size = DEFAULT_SIZE) {
  const t = String(cotType || "").trim();
  const direct = parseDirect2525DSidc(t);
  let sidc = direct;
  if (!sidc) {
    if (!Type2525.is2525BConvertable(t)) {
      throw new Error("CoT type is not 2525B-convertable");
    }
    sidc = Type2525.to2525D(t);
  }
  if (!sidc) {
    throw new Error("CoT type is not 2525B-convertable");
  }
  const symbol = new ms.Symbol(sidc, milSymOptions(size));
  const svg = symbol.asSVG();
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

function milSymOptions(size) {
  return {
    size: Number(size) || DEFAULT_SIZE,
    fill: true,
    fillOpacity: 1,
    frame: true,
    strokeWidth: 4,
  };
}

export async function renderMilSymPngByIconId(apiIconId, size = DEFAULT_SIZE) {
  const raw = String(apiIconId || "").trim();
  if (!raw.startsWith("2525D:")) {
    throw new Error("Expected 2525D: icon id");
  }
  const sidc = raw.slice("2525D:".length);
  const symbol = new ms.Symbol(sidc, milSymOptions(size));
  const svg = symbol.asSVG();
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}
