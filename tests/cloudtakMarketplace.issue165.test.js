"use strict";

// #165: a failed host scan must still stamp lastScanAt so workerBackground waits
// SCAN_INTERVAL_MS instead of re-running the SSH scan every 15-30 seconds.
const assert = require("assert");
const ssh = require("../services/cloudtakMarketplace.ssh");
const store = require("../services/cloudtakMarketplace.store");
const marketplace = require("../services/cloudtakMarketplace.service");

(async () => {
  const origs = {
    resolved: ssh.resolvedCheckoutPath,
    detect: ssh.detectCheckout,
    read: store.readNotifyState,
    write: store.writeNotifyState,
    readScan: store.readScanCache,
    writeScan: store.writeScanCache,
  };
  let state = { lastScanAt: 0 };
  try {
    ssh.resolvedCheckoutPath = () => "";
    ssh.detectCheckout = async () => ({ ok: false, message: "ssh down" });
    store.readNotifyState = () => ({ ...state });
    store.writeNotifyState = (d) => {
      state = { ...d };
    };
    store.readScanCache = () => null;
    store.writeScanCache = () => {};
    const before = Date.now();
    const result = await marketplace.scanHost();
    assert.strictEqual(result.ok, false);
    assert.ok(state.lastScanAt >= before, "failed scan must stamp lastScanAt");
  } finally {
    ssh.resolvedCheckoutPath = origs.resolved;
    ssh.detectCheckout = origs.detect;
    store.readNotifyState = origs.read;
    store.writeNotifyState = origs.write;
    store.readScanCache = origs.readScan;
    store.writeScanCache = origs.writeScan;
  }
  console.log("cloudtakMarketplace.issue165 ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
