"use strict";

const assert = require("assert");
const mouStore = require("../services/mouStore");
const {
  hasAcceptedAgreementForSession,
  hasPersistedAgreementAcceptance,
  recordAgreementAcceptance,
} = require("../services/userAgreementSession.service");

const user = { username: "bridge.user", uid: "u-bridge-1" };
const agreement = { version: 7, title: "Test", bodyHtml: "<p>hi</p>" };

const prev = mouStore.loadUserAgreement();
try {
  mouStore.saveUserAgreement({
    schemaVersion: 1,
    enabled: true,
    currentVersion: 7,
    versions: [agreement],
    acceptances: {},
  });

  assert.strictEqual(hasPersistedAgreementAcceptance(user, agreement), false);
  assert.strictEqual(
    hasAcceptedAgreementForSession({ headers: {} }, user, agreement),
    false,
    "no cookie and no persistence => not accepted"
  );

  const saved = recordAgreementAcceptance(user, agreement, { source: "locate-bridge" });
  assert.strictEqual(saved.version, 7);
  assert.strictEqual(saved.source, "locate-bridge");
  assert.strictEqual(hasPersistedAgreementAcceptance(user, agreement), true);
  assert.strictEqual(
    hasAcceptedAgreementForSession({ headers: {} }, user, agreement),
    true,
    "persisted acceptance clears the gate without a browser cookie"
  );
  assert.strictEqual(
    hasAcceptedAgreementForSession({ headers: {} }, user, { version: 8 }),
    false,
    "new agreement version requires accept again"
  );

  console.log("userAgreementBridge tests passed");
} finally {
  mouStore.saveUserAgreement(prev || { schemaVersion: 1, enabled: false, currentVersion: 0, versions: [] });
}
