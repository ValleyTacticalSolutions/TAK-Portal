#!/usr/bin/env node
/**
 * Run unit tests; exit non-zero on first failure.
 * Files in TEST_FILES run first, in that order. Any other tests/*.test.js run after them,
 * alphabetically, so a new test can never be skipped by forgetting to list it here.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const TEST_FILES = [
  "mapIcon.test.js",
  "mapIconRender.test.js",
  "mapMeta.test.js",
  "mapBasemaps.test.js",
  "mapRender.test.js",
  "mapUidHash.test.js",
  "labelDeclutter.test.js",
  "featureBuild.test.js",
  "mapStyleGate.test.js",
  "cotStreamSlim.test.js",
  "cotStale.test.js",
  "mapPerfSoak.test.js",
  "missionGeo.test.js",
  "missionKml.test.js",
  "missionContents.test.js",
  "missionRaster.test.js",
  "dataSyncAccess.test.js",
  "dataSync.missionWrite.test.js",
  "dataSync.missionCreateGate.test.js",
  "dataPackages.uploadGroups.test.js",
  "directoryOutbox.createUser.test.js",
  "channelPatch.access.test.js",
  "channelPatch.dataSync.test.js",
  "channelPatch.engine.test.js",
  "channelPatch.persist.test.js",
  "groupRenamePropagate.test.js",
  "locatorForm.test.js",
  "locatorCot.test.js",
  "locatorAccess.test.js",
  "locatorReport.test.js",
  "geocode.test.js",
  "openaddresses.test.js",
  "preferencePackage.service.test.js",
  "enrollmentPackage.service.test.js",
  "qr.cache.test.js",
  "jimpImage.test.js",
  "takHttpSession.test.js",
  "takGroupControl.test.js",
  "takSubscriptionsCache.test.js",
  "geofence.test.js",
  "userRequestsOtherAgency.test.js",
  "requestAccessPhoneField.test.js",
  "agencyAutoApprove.test.js",
  "migrationGate.test.js",
  "stackHealthGate.test.js",
  "jsonImport.retire.test.js",
  "jsonImport.restore.test.js",
  "directorySearch.sql.test.js",
  "outbox.skipLocked.test.js",
  "cryptoSecrets.crossProcess.test.js",
  "outbox.secrets.test.js",
  "directorySync.deadLetter.test.js",
  "directorySync.inboundAbort.test.js",
  "directorySync.inboundCleanup.test.js",
  "integrations.authDefault.test.js",

  "health.migration.test.js",
  "auditLog.distinct.test.js",
  "auditLog.query.test.js",
  "mouStore.ensure.test.js",
  "directoryPkText.test.js",
  "groupsMembership.test.js",
  "groupsEditType.test.js",
  "groupTypeEdit.matrix.test.js",
  "directoryWritePath.test.js",
  "userLoginStatus.test.js",
  "mutualAid.status.test.js",
  "backup.test.js",
  "cloudtakMarketplace.test.js",
  "dockerPullRetry.test.js",
  "marketplacePtyFallback.test.js",
  "marketplaceHelper.sudoers.test.js",
  "setupDeviceAccess.test.js",
  "activeUserGate.test.js",
  "appVersion.test.js",
  "portalHidden.test.js",
  "hiddenPrefixMigration.test.js",
  "hiddenPrefixLike.test.js",
  "agencyAdminGroupEnsure.test.js",
  "agencyUsernameTokenRename.test.js",
];

const fs = require("fs");
const testsDir = path.join(__dirname, "..", "tests");

const unlisted = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.js") && !TEST_FILES.includes(f))
  .sort();

for (const file of [...TEST_FILES, ...unlisted]) {
  const testPath = path.join(testsDir, file);
  const result = spawnSync(process.execPath, [testPath], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("All tests passed.");
