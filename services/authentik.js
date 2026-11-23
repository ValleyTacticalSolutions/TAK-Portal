const axios = require("axios");
const http = require("http");
const https = require("https");
const { getString } = require("./env");
const { guardAxios } = require("./outboundUrl");

const agentOptions = {
  keepAlive: true,
  maxSockets: 20,
};

const client = axios.create({
  // baseURL and headers will be set per-request
  timeout: 30000,
  httpAgent: new http.Agent(agentOptions),
  httpsAgent: new https.Agent(agentOptions),
});
// Registered before the baseURL interceptor below: axios runs request interceptors last-added-first,
// so the guard sees the final URL.
guardAxios(client, { builtin: false });

client.interceptors.request.use((config) => {
  const AUTHENTIK_URL = getString("AUTHENTIK_URL", "");
  const AUTHENTIK_TOKEN = getString("AUTHENTIK_TOKEN", "");

  if (!AUTHENTIK_URL) {
    throw new Error("Missing AUTHENTIK_URL in settings.json");
  }
  if (!AUTHENTIK_TOKEN) {
    throw new Error("Missing AUTHENTIK_TOKEN in settings.json");
  }

  const baseUrl = AUTHENTIK_URL.replace(/\/+$|\s+$/g, "");

  // Ensure baseURL and headers are always up to date
  config.baseURL = `${baseUrl}/api/v3`;
  config.headers = {
    ...(config.headers || {}),
    Authorization: `Bearer ${AUTHENTIK_TOKEN}`,
    "Content-Type": "application/json",
  };

  return config;
});

module.exports = client;
