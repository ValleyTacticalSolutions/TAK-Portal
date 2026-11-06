const assert = require("assert");
const path = require("path");
const ejs = require("ejs");
const settingsSvc = require("../services/settings.service");
const { validateCreate } = require("../services/userRequests.service");

const priorPhone = settingsSvc.get("USER_PHONE_NUMBER_FIELD_ENABLED", "false");
const priorRequireAll = settingsSvc.get(
  "REQUEST_ACCESS_REQUIRE_ALL_AGENCY_DETAILS",
  "false"
);

const VIEWS = [
  "request-access.ejs",
  "pending-user-requests.ejs",
  "request-access-review.ejs",
];

function basePayload(overrides = {}) {
  return {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@example.gov",
    badgeNumber: "1234",
    radioCallsign: "T01",
    agencySuffix: "__other__",
    otherAgency: "Example Fire Department",
    otherReason: "Mutual aid support",
    groupPrefix: "",
    suffix: "",
    state: "",
    county: "",
    countyAbbrev: "",
    type: "Fire",
    ...overrides,
  };
}

function inputTag(html, name) {
  const re = new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`, "i");
  const match = html.match(re);
  return match ? match[0] : "";
}

function renderView(view, phoneEnabled) {
  const file = path.join(__dirname, "..", "views", view);
  return ejs.renderFile(
    file,
    {
      settings: {
        USER_PHONE_NUMBER_FIELD_ENABLED: phoneEnabled ? "true" : "false",
        USERNAME_PREFIX_LABEL: "Badge Number / Username",
      },
      agencies: [],
      form: { phone: "555-0100", radioCallsign: "T01" },
      error: null,
      requireAllAgencyDetails: false,
      agencyTypeOptions: [],
      regionOptions: [],
      regionCountyLocks: [],
      hcaptchaEnabled: false,
      hcaptchaSiteKey: "",
      brandLogoUrl: "",
      brandTheme: "dark",
      primaryButtonColor: "",
      siteFontFamily: "",
      portalTitle: "TAK Portal",
      isGlobalAdmin: true,
      isAgencyAdmin: false,
      allowedAgencySuffixes: [],
      passwordPolicy: null,
      reviewToken: "abc",
      APP_VERSION: "test",
    },
    { filename: file }
  );
}

(async () => {
  let failed = null;
  try {
    settingsSvc.updateSettings({
      REQUEST_ACCESS_REQUIRE_ALL_AGENCY_DETAILS: "false",
      USER_PHONE_NUMBER_FIELD_ENABLED: "true",
    });

    const kept = validateCreate(basePayload({ phone: "  555-555-0123  " }));
    assert.strictEqual(kept.phone, "555-555-0123");

    const sliced = validateCreate(basePayload({ phone: "1".repeat(50) }));
    assert.strictEqual(sliced.phone, "1".repeat(40));

    const blank = validateCreate(basePayload({ phone: "   " }));
    assert.strictEqual(blank.phone, "");

    for (const view of VIEWS) {
      const html = await renderView(view, true);
      const radio = inputTag(html, "radioCallsign");
      const phone = inputTag(html, "phone");
      assert.ok(radio, `${view} should keep radio callsign`);
      assert.ok(phone, `${view} should show an optional phone input when the setting is on`);
      assert.ok(
        html.indexOf(radio) < html.indexOf(phone),
        `${view} should place phone after radio callsign`
      );
      assert.ok(html.includes(" hasPhone"), `${view} should keep phone in the same row`);
      assert.ok(!/\srequired(\s|=|>)/i.test(phone), `${view} phone input must stay optional`);
      assert.ok(/maxlength="40"/i.test(phone), `${view} phone input should cap length at 40`);
    }

    const requestHtml = await renderView("request-access.ejs", true);
    assert.ok(
      inputTag(requestHtml, "phone").includes('value="555-0100"'),
      "request access should keep a submitted phone when the form is re-shown"
    );

    settingsSvc.updateSettings({ USER_PHONE_NUMBER_FIELD_ENABLED: "false" });
    const dropped = validateCreate(basePayload({ phone: "555-555-0123" }));
    assert.strictEqual(dropped.phone, "");

    for (const view of VIEWS) {
      const html = await renderView(view, false);
      assert.strictEqual(inputTag(html, "phone"), "", `${view} should hide phone when the setting is off`);
      assert.ok(inputTag(html, "radioCallsign"), `${view} should still show radio callsign`);
      assert.ok(!html.includes(" hasPhone"), `${view} should keep the original row width`);
    }

    console.log("requestAccessPhoneField.test.js: ok");
  } catch (err) {
    failed = err;
    console.error(err);
  } finally {
    settingsSvc.updateSettings({
      USER_PHONE_NUMBER_FIELD_ENABLED: priorPhone,
      REQUEST_ACCESS_REQUIRE_ALL_AGENCY_DETAILS: priorRequireAll,
    });
  }
  process.exit(failed ? 1 : 0);
})();
