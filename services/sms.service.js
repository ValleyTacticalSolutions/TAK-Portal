/**
 * SMS via Twilio or Brevo (settings: SMS_PROVIDER).
 */
const axios = require("axios");
const { guardedAxios } = require("./outboundUrl");
const settingsSvc = require("./settings.service");

function isSmsConfigured() {
  const cfg = settingsSvc.getSettings() || {};
  const p = String(cfg.SMS_PROVIDER || "disabled").trim().toLowerCase();
  if (p === "twilio") {
    const sid = String(cfg.SMS_TWILIO_ACCOUNT_SID || "").trim();
    const token = String(cfg.SMS_TWILIO_AUTH_TOKEN || "").trim();
    const from = String(cfg.SMS_TWILIO_FROM || "").trim();
    return !!(sid && token && from);
  }
  if (p === "brevo") {
    const key = String(cfg.SMS_BREVO_API_KEY || "").trim();
    const sender = String(cfg.SMS_BREVO_SENDER || "").trim();
    return !!(key && sender);
  }
  return false;
}

/** Comma/semicolon-separated phone strings → E.164-like list or { error }. */
function parsePhoneList(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "Enter at least one phone number." };
  const parts = s
    .split(/[;,]/g)
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!parts.length) return { error: "Enter at least one phone number." };
  const seen = new Set();
  const phones = [];
  for (const p of parts) {
    const digits = p.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      return { error: `Invalid phone number: ${p}` };
    }
    let e164;
    if (digits.length === 10) {
      e164 = "+1" + digits;
    } else if (digits.length === 11 && digits[0] === "1") {
      e164 = "+" + digits;
    } else {
      e164 = "+" + digits;
    }
    if (seen.has(e164)) continue;
    seen.add(e164);
    phones.push(e164);
  }
  if (!phones.length) return { error: "Enter at least one phone number." };
  return { phones };
}

async function sendTwilio(cfg, toE164, bodyText) {
  const sid = String(cfg.SMS_TWILIO_ACCOUNT_SID || "").trim();
  const token = String(cfg.SMS_TWILIO_AUTH_TOKEN || "").trim();
  const from = String(cfg.SMS_TWILIO_FROM || "").trim();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams();
  params.set("To", toE164);
  params.set("From", from);
  params.set("Body", bodyText);
  const res = await guardedAxios(axios).post(url, params.toString(), {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 45000,
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, data: res.data };
  }
  const errBody =
    typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data || "");
  return { ok: false, error: errBody || `HTTP ${res.status}` };
}

async function sendBrevo(cfg, toE164, bodyText) {
  const key = String(cfg.SMS_BREVO_API_KEY || "").trim();
  const sender = String(cfg.SMS_BREVO_SENDER || "").trim().slice(0, 11);
  const res = await guardedAxios(axios).post(
    "https://api.brevo.com/v3/transactionalSMS/sms",
    {
      sender,
      recipient: toE164,
      content: bodyText,
      type: "transactional",
    },
    {
      headers: {
        "api-key": key,
        "Content-Type": "application/json",
      },
      timeout: 45000,
      validateStatus: () => true,
    }
  );
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, data: res.data };
  }
  const errBody =
    typeof res.data === "object" ? JSON.stringify(res.data) : String(res.data || "");
  return { ok: false, error: errBody || `HTTP ${res.status}` };
}

/**
 * @param {Record<string, string>} cfg - settings subset or full settings
 * @param {string} toE164
 * @param {string} bodyText
 */
async function sendSmsUsingConfig(cfg, toE164, bodyText) {
  const p = String(cfg.SMS_PROVIDER || "disabled").trim().toLowerCase();
  if (p === "disabled") {
    return { ok: false, error: "SMS is disabled in settings." };
  }
  if (p === "twilio") {
    return sendTwilio(cfg, toE164, bodyText);
  }
  if (p === "brevo") {
    return sendBrevo(cfg, toE164, bodyText);
  }
  return { ok: false, error: "Unknown SMS provider." };
}

async function sendSmsFromSettings(toE164, bodyText) {
  const cfg = settingsSvc.getSettings() || {};
  return sendSmsUsingConfig(cfg, toE164, bodyText);
}

/** Used by POST /settings/test-sms to merge form body with disk settings. */
function collectBodySettings(rawBody) {
  const bodySettings = {};
  if (rawBody.settings && typeof rawBody.settings === "object") {
    Object.keys(rawBody.settings).forEach((key) => {
      bodySettings[key] = rawBody.settings[key];
    });
  }
  Object.keys(rawBody).forEach((key) => {
    const match = key.match(/^settings\[(.+)\]$/);
    if (match) {
      bodySettings[match[1]] = rawBody[key];
    }
  });
  return bodySettings;
}

module.exports = {
  isSmsConfigured,
  parsePhoneList,
  sendSmsUsingConfig,
  sendSmsFromSettings,
  collectBodySettings,
};
