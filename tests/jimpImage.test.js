"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Jimp = require("../services/jimpCompat");
const qr = require("../services/qr.service");
const { addLogoToQrPng } = require("../services/qrLogoOverlay.service");
const mapIcon = require("../services/mapIcon.service");
const mapIconRender = require("../services/mapIconRender.service");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(buf, label) {
  assert.ok(Buffer.isBuffer(buf) && buf.length > 8, label + " should be a buffer");
  assert.ok(buf.subarray(0, 8).equals(PNG), label + " should be a PNG");
}

(async function run() {
  const services = [
    "locatorReport.service.js",
    "mapIconRender.service.js",
    "mouService.js",
    "qr.service.js",
    "qrLogoOverlay.service.js",
  ];
  for (const file of services) {
    const src = fs.readFileSync(path.join(__dirname, "..", "services", file), "utf8");
    assert.ok(src.includes('require("./jimpCompat")'), file + " should use jimpCompat");
    assert.ok(!src.includes('require("jimp")'), file + " should not call Jimp 1.x directly");
  }

  const canvas = new Jimp(20, 20, 0xffe2e8f0);
  assert.strictEqual(canvas.getWidth(), 20);
  assert.strictEqual(canvas.getHeight(), 20);
  canvas.scan(0, 0, 4, 4, function (_x, _y, idx) {
    this.bitmap.data[idx] = 1;
    this.bitmap.data[idx + 3] = 255;
  });
  const canvasPng = await canvas.getBufferAsync(Jimp.MIME_PNG);
  assertPng(canvasPng, "canvas");
  const reread = await Jimp.read(canvasPng);
  assert.strictEqual(reread.bitmap.data[0], 1, "scan writes should survive a PNG round trip");

  const jpeg = await canvas.getBufferAsync("image/jpeg");
  assert.strictEqual(jpeg[0], 0xff, "jpeg buffer should start with SOI");
  assert.strictEqual(jpeg[1], 0xd8);
  const fromJpeg = await Jimp.read(jpeg);
  assertPng(await fromJpeg.getBufferAsync(Jimp.MIME_PNG), "jpeg normalized to png");

  const content = "tak://jimp-compat-check";
  const plain = await qr.generateQrPngBuffer(content, {
    width: 256,
    margin: 1,
    logoPath: "",
  });
  const labeled = await qr.generateQrPngBuffer(content, {
    width: 256,
    margin: 1,
    logoPath: "",
    usernameLabel: "ada",
  });
  assertPng(plain, "plain qr");
  assertPng(labeled, "labeled qr");
  const plainImg = await Jimp.read(plain);
  const labeledImg = await Jimp.read(labeled);
  assert.ok(
    labeledImg.getHeight() > plainImg.getHeight(),
    "username label should extend the QR instead of being swallowed"
  );

  const logo = new Jimp(40, 40, 0xff0000ff);
  const logoPath = path.join(os.tmpdir(), "tak-portal-jimp-logo.png");
  fs.writeFileSync(logoPath, await logo.getBufferAsync(Jimp.MIME_PNG));
  try {
    const withLogo = await addLogoToQrPng(plain, logoPath, { logoRatio: 0.3 });
    assertPng(withLogo, "qr with logo");
    assert.notStrictEqual(withLogo.equals(plain), true, "logo overlay should change the PNG");
    const overlaid = await Jimp.read(withLogo);
    const cx = Math.floor(overlaid.getWidth() / 2);
    const cy = Math.floor(overlaid.getHeight() / 2);
    const idx = (overlaid.bitmap.width * cy + cx) << 2;
    const r = overlaid.bitmap.data[idx];
    const g = overlaid.bitmap.data[idx + 1];
    const b = overlaid.bitmap.data[idx + 2];
    assert.ok(r > g + 40 && r > b + 40, "center of the QR should show the red logo");
  } finally {
    fs.rmSync(logoPath, { force: true });
  }

  await mapIcon.ensureIconsets();
  const iconId = "34ae1613-9645-4222-a9d2-e5f243dea2865:Animals/ant.png";
  assert.ok(mapIcon.getIconFilePath(iconId), "white animal icon should be on disk");
  const marker = {
    uid: "jimp-tint",
    type: "a-f-G",
    origin: "feed",
    affiliation: "friend",
    iconId,
    iconSource: "usericon",
    teamColor: "#ff0000",
    color: "#ff0000",
  };
  assert.strictEqual(mapIconRender.iconSkipsRecolor(marker, iconId), false);
  const rendered = await mapIconRender.renderIconForMarker(marker);
  assertPng(rendered.buffer, "tinted map icon");
  const tinted = await Jimp.read(rendered.buffer);
  let redPixels = 0;
  tinted.scan(0, 0, tinted.getWidth(), tinted.getHeight(), function (_x, _y, idx) {
    const pr = this.bitmap.data[idx];
    const pg = this.bitmap.data[idx + 1];
    const pb = this.bitmap.data[idx + 2];
    const pa = this.bitmap.data[idx + 3];
    if (pa > 0 && pr > 200 && pg < 40 && pb < 40) redPixels += 1;
  });
  assert.ok(redPixels > 0, "white icon pixels should be tinted red");

  console.log("jimpImage.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
