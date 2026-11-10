/**
 * Jimp 0.22 call shape on top of Jimp 1.6.
 *
 * `require("jimp")` is a named-export namespace in 1.x (`Jimp.read` is not a
 * function). Constructors, buffers, contain, and print also changed shape.
 * Call sites in this app stay on the 0.22 surface so QR labels, logo badges,
 * map-icon tint, locator maps, and MOU image normalize keep working.
 */
const {
  Jimp: JimpClass,
  JimpMime,
  loadFont,
  HorizontalAlign,
  VerticalAlign,
} = require("jimp");
const { SANS_64_BLACK } = require("jimp/fonts");

const MIME_PNG = JimpMime.png;

function adapt(image) {
  if (!image || image.__takJimp) return image;

  const rawGetBuffer = image.getBuffer;
  const rawContain = image.contain;
  const rawPrint = image.print;
  const rawClone = image.clone;

  image.getWidth = function getWidth() {
    return this.width;
  };
  image.getHeight = function getHeight() {
    return this.height;
  };
  image.getBufferAsync = async function getBufferAsync(mime) {
    const out = await rawGetBuffer.call(this, mime || MIME_PNG);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  };
  image.contain = function contain(w, h, align, mode) {
    if (w && typeof w === "object") return rawContain.call(this, w);
    const options = { w, h };
    if (align != null) options.align = align;
    if (mode != null) options.mode = mode;
    return rawContain.call(this, options);
  };
  image.print = function print(font, x, y, text, maxWidth, maxHeight) {
    if (font && typeof font === "object" && Object.prototype.hasOwnProperty.call(font, "font")) {
      return rawPrint.call(this, font);
    }
    const options = { font, x, y, text };
    if (maxWidth != null) options.maxWidth = maxWidth;
    if (maxHeight != null) options.maxHeight = maxHeight;
    return rawPrint.call(this, options);
  };
  image.clone = function clone() {
    return adapt(rawClone.call(this));
  };

  Object.defineProperty(image, "__takJimp", { value: true });
  return image;
}

function Jimp(width, height, color) {
  return adapt(new JimpClass({ width, height, color }));
}

Jimp.read = async function read(input, options) {
  return adapt(await JimpClass.read(input, options));
};

Jimp.loadFont = function loadJimpFont(font) {
  return loadFont(font);
};

Jimp.MIME_PNG = MIME_PNG;
Jimp.FONT_SANS_64_BLACK = SANS_64_BLACK;
Jimp.HORIZONTAL_ALIGN_CENTER = HorizontalAlign.CENTER;
Jimp.VERTICAL_ALIGN_TOP = VerticalAlign.TOP;

module.exports = Jimp;
