/**
 * TAK Server 5.6 Marti API paths that replace SSH (issue #195):
 * cert signing (signClient/v2), API revoke, truststores from the CA chain, version gate,
 * admin check and the restart health poll.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const forge = require("node-forge");

process.env.TAK_URL = "https://tak.example.test:8443";
delete process.env.TAK_SSH_USER;
delete process.env.TAK_BYPASS_ENABLED;
delete process.env.TAK_USE_MARTI_CERT_APIS;

const marti = require("../services/takMartiCerts.service");
const takSvc = require("../services/tak.service");
const takSsh = require("../services/takSsh.service");
const { convertToPem } = require("../services/p12Pem");

/* ---------- tiny CA (root → intermediate → leaf) ---------- */

function makeKeys() {
  return forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
}
function makeCert({ subject, issuer, publicKey, signKey, serial, ca }) {
  const c = forge.pki.createCertificate();
  c.publicKey = publicKey;
  c.serialNumber = serial;
  c.validity.notBefore = new Date(Date.now() - 60000);
  c.validity.notAfter = new Date(Date.now() + 86400000);
  c.setSubject(subject);
  c.setIssuer(issuer);
  c.setExtensions(ca ? [{ name: "basicConstraints", cA: true }] : [{ name: "basicConstraints", cA: false }]);
  c.sign(signKey, forge.md.sha256.create());
  return c;
}
const rootKeys = makeKeys();
const rootSubj = [{ shortName: "CN", value: "Test Root CA" }, { shortName: "O", value: "TAK" }];
const rootCert = makeCert({ subject: rootSubj, issuer: rootSubj, publicKey: rootKeys.publicKey, signKey: rootKeys.privateKey, serial: "01", ca: true });
const intKeys = makeKeys();
const intSubj = [{ shortName: "CN", value: "Test Intermediate CA" }, { shortName: "O", value: "TAK" }];
const intCert = makeCert({ subject: intSubj, issuer: rootSubj, publicKey: intKeys.publicKey, signKey: rootKeys.privateKey, serial: "02", ca: true });
const leafKeys = makeKeys();
const leafSubj = [{ shortName: "CN", value: "tak.example.test" }];
const leafCert = makeCert({ subject: leafSubj, issuer: intSubj, publicKey: leafKeys.publicKey, signKey: intKeys.privateKey, serial: "03", ca: false });
const pemOf = (c) => forge.pki.certificateToPem(c);
const derOf = (c) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes(), "binary");

function signCsr(csrBase64, { overrideCn } = {}) {
  const csr = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(forge.util.decode64(csrBase64)));
  assert.ok(csr.verify(), "CSR must be self-signed correctly");
  const subject = csr.subject.attributes.map((a) => ({ shortName: a.shortName, value: a.value }));
  if (overrideCn) subject.find((a) => a.shortName === "CN").value = overrideCn;
  const cert = makeCert({ subject: subject.map((a) => ({ ...a })), issuer: intSubj.map((a) => ({ ...a })), publicKey: csr.publicKey, signKey: intKeys.privateKey, serial: "0a", ca: false });
  return { cert, subject };
}

function certsInP12(p12, password) {
  const p = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12.toString("binary")), false, password);
  const bags = p.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  return bags.map((b) => b.cert.subject.getField("CN").value).sort();
}

(async function run() {
  /* ---------- version parsing / gate ---------- */
  assert.deepStrictEqual(marti.parseTakVersion("5.6-RELEASE-12"), { major: 5, minor: 6, patch: 12 });
  assert.deepStrictEqual(marti.parseTakVersion("TAK Server 5.4-RELEASE-30-HEAD"), { major: 5, minor: 4, patch: 30 });
  assert.deepStrictEqual(marti.parseTakVersion({ major: 5, minor: 6, patch: 1, branch: "RELEASE" }), { major: 5, minor: 6, patch: 1 });
  assert.strictEqual(marti.parseTakVersion(""), null);
  assert.strictEqual(marti.versionAtLeast({ major: 5, minor: 6 }, 5, 6), true);
  assert.strictEqual(marti.versionAtLeast({ major: 6, minor: 0 }, 5, 6), true);
  assert.strictEqual(marti.versionAtLeast({ major: 5, minor: 5 }, 5, 6), false);

  let version = { major: 5, minor: 6, patch: 0 };
  let securityConfig = { data: { enableEnrollment: true } };
  let isAdminBody = true;
  const martiCalls = [];
  const fakeMarti = () => ({
    get: async (url) => {
      martiCalls.push(url);
      if (url === "/api/version/info") return { data: version };
      if (url === "/api/version") return { data: "5.6-RELEASE-0" };
      if (url === "/api/security/config") return { data: securityConfig };
      if (url === "/api/util/isAdmin") return { data: isAdminBody };
      throw new Error("unexpected " + url);
    },
  });

  marti.__setTestHooks({ martiClient: fakeMarti, sleep: async () => {} });
  assert.strictEqual(await marti.canUseMartiCertApis(), true, "5.6 server uses the APIs");
  version = { major: 5, minor: 5, patch: 9 };
  marti.clearVersionCache();
  assert.strictEqual(await marti.canUseMartiCertApis(), false, "5.5 server stays on SSH");
  process.env.TAK_USE_MARTI_CERT_APIS = "false";
  version = { major: 5, minor: 6, patch: 0 };
  marti.clearVersionCache();
  assert.strictEqual(await marti.canUseMartiCertApis(), false, "switch off forces SSH");
  delete process.env.TAK_USE_MARTI_CERT_APIS;
  assert.strictEqual(await marti.canUseMartiCertApis(), true);

  assert.strictEqual(await marti.isServerSigningEnabled(), true);
  securityConfig = { data: { enableEnrollment: false } };
  assert.strictEqual(await marti.isServerSigningEnabled(), false);
  securityConfig = { data: { enableEnrollment: true } };

  /* ---------- admin check ---------- */
  assert.strictEqual(marti.parseIsAdminResponse(true), true);
  assert.strictEqual(marti.parseIsAdminResponse("true"), true);
  assert.strictEqual(marti.parseIsAdminResponse({ data: true }), true);
  assert.strictEqual(marti.parseIsAdminResponse(false), false);
  assert.strictEqual((await marti.checkMartiAdminAccess()).ok, true);
  isAdminBody = false;
  assert.strictEqual((await marti.checkMartiAdminAccess()).ok, false);

  /* ---------- /api/tls/config name entries ---------- */
  const cfgXml =
    '<?xml version="1.0"?><certificateConfig xmlns="com.bbn.marti.config"><nameEntries>' +
    '<nameEntry name="O" value="TAK &amp; Co"/><nameEntry name="OU" value="TAK"/></nameEntries></certificateConfig>';
  assert.deepStrictEqual(marti.parseCertificateConfigNameEntries(cfgXml), [
    { name: "O", value: "TAK & Co" },
    { name: "OU", value: "TAK" },
  ]);
  assert.deepStrictEqual(
    marti.parseCertificateConfigNameEntries("<ns2:nameEntry><name>C</name><value>US</value></ns2:nameEntry>"),
    [{ name: "C", value: "US" }]
  );

  /* ---------- signClient/v2 response parsing ---------- */
  const bare = pemOf(intCert).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const parsed = marti.parseSignClientV2Response(JSON.stringify({ signedCert: bare, ca0: pemOf(intCert), ca1: bare }));
  assert.ok(parsed.certPem.startsWith("-----BEGIN CERTIFICATE-----\n"));
  assert.strictEqual(parsed.caPems.length, 2);
  const parsedXml = marti.parseSignClientV2Response(`<enrollment><signedCert>${bare}</signedCert><ca>${bare}</ca></enrollment>`);
  assert.strictEqual(parsedXml.caPems.length, 1);
  assert.throws(() => marti.parseSignClientV2Response("{}"), /no signed certificate/);

  /* ---------- signing as the integration user (401 while LDAP catches up, then OK) ---------- */
  let signAttempts = 0;
  let lastSubject = null;
  let lastAuth = null;
  let cnOverride = null;
  const fakeEnroll = ({ username, password }) => ({
    get: async (url) => {
      assert.strictEqual(url, "/api/tls/config");
      return { data: cfgXml };
    },
    post: async (url, body, opts) => {
      assert.strictEqual(url, "/api/tls/signClient/v2");
      lastAuth = { username, password };
      signAttempts += 1;
      if (signAttempts === 1) {
        const e = new Error("Unauthorized");
        e.response = { status: 401 };
        throw e;
      }
      assert.strictEqual(opts.params.clientUid, `tak-portal-${username}`);
      const { cert, subject } = signCsr(body, { overrideCn: cnOverride });
      lastSubject = subject;
      return {
        data: JSON.stringify({ signedCert: pemOf(cert), ca0: pemOf(intCert), ca1: pemOf(rootCert) }),
      };
    },
  });
  marti.__setTestHooks({ martiClient: fakeMarti, enrollClient: fakeEnroll, sleep: async () => {} });

  const signed = await marti.signIntegrationCertViaApi("global-test-feed", "Secret!1", { waitMs: 60000, retryEveryMs: 1 });
  assert.strictEqual(signAttempts, 2, "401 is retried");
  assert.deepStrictEqual(lastAuth, { username: "global-test-feed", password: "Secret!1" });
  assert.deepStrictEqual(lastSubject, [
    { shortName: "O", value: "TAK & Co" },
    { shortName: "OU", value: "TAK" },
    { shortName: "CN", value: "global-test-feed" },
  ], "CSR subject = TAK name entries + CN");
  assert.strictEqual(signed.issuedVia, "marti-api");
  assert.ok(new crypto.X509Certificate(signed.pem).checkPrivateKey(crypto.createPrivateKey(signed.key)));
  const fromP12 = convertToPem(signed.p12, marti.INTEGRATION_P12_PASSWORD);
  assert.strictEqual(fromP12.commonName, "global-test-feed", "local p12 opens with atakatak");
  assert.deepStrictEqual(certsInP12(signed.p12, "atakatak"), ["Test Intermediate CA", "Test Root CA", "global-test-feed"]);

  // Auth failures stop once the wait window is used up.
  signAttempts = 0;
  await assert.rejects(
    marti.signIntegrationCertViaApi("global-test-feed", "x", { waitMs: 0, retryEveryMs: 1 }),
    /HTTP 401/
  );

  // A cert for a different CN is refused.
  signAttempts = 1;
  cnOverride = "someone-else";
  await assert.rejects(marti.signIntegrationCertViaApi("global-test-feed", "x"), /different name/);
  cnOverride = null;

  /* ---------- truststores from the verified TLS chain ---------- */
  const classified = marti.classifyCaChain([pemOf(leafCert), pemOf(intCert), pemOf(rootCert)]);
  assert.strictEqual(classified.roots.length, 1);
  assert.strictEqual(classified.intermediates.length, 1);

  marti.__setTestHooks({
    martiClient: fakeMarti,
    enrollClient: fakeEnroll,
    peerChain: async () => [derOf(leafCert), derOf(intCert), derOf(rootCert)],
    sleep: async () => {},
  });
  const rootTrust = await marti.buildTakRootTruststoreViaApi();
  assert.strictEqual(rootTrust.password, "atakatak");
  assert.deepStrictEqual(certsInP12(rootTrust.p12, "atakatak"), ["Test Root CA"]);
  const intTrust = await marti.buildTakIntermediateTruststoreViaApi();
  assert.deepStrictEqual(certsInP12(intTrust.p12, "atakatak"), ["Test Intermediate CA"]);
  assert.strictEqual(intTrust.fileName, "truststore-intermediate.p12");

  // takSsh wrappers use the API with no SSH configured.
  const viaWrapper = await takSsh.fetchTakTruststoreP12();
  assert.deepStrictEqual(certsInP12(viaWrapper.p12, "atakatak"), ["Test Root CA"]);
  const intViaWrapper = await takSsh.fetchTakIntermediateTruststoreP12();
  assert.deepStrictEqual(certsInP12(intViaWrapper.p12, "atakatak"), ["Test Intermediate CA"]);

  // API failure with no SSH reports the API error.
  marti.__setTestHooks({ peerChain: async () => { throw new Error("handshake refused"); } });
  await assert.rejects(takSsh.fetchTakTruststoreP12(), /handshake refused/);
  marti.__setTestHooks({ peerChain: async () => [derOf(leafCert), derOf(intCert), derOf(rootCert)] });

  /* ---------- integration create + revoke with no SSH ---------- */
  const un = `global-marti-test-${process.pid}`;
  takSsh.deleteStoredIntegrationCertFiles(un);
  signAttempts = 1; // skip the simulated 401
  try {
    const prov = await takSsh.provisionIntegrationCertFiles(un, { password: "Pw!123456" });
    assert.strictEqual(prov.issuedVia, "marti-api");
    assert.ok(fs.existsSync(prov.pemPath) && fs.existsSync(prov.keyPath) && fs.existsSync(prov.p12Path));
    assert.strictEqual(takSsh.readIntegrationCertSource(un), "marti-api");
    assert.strictEqual(lastAuth.username, un);

    const cached = await takSsh.getOrProvisionIntegrationCertFiles(un);
    assert.strictEqual(cached.fromCache, true);

    const revokeCalls = [];
    const origRevoke = takSvc.revokeCertsForUser;
    takSvc.revokeCertsForUser = async (u, opts) => {
      revokeCalls.push({ u, opts });
      return { revoked: 1, verified: true };
    };
    try {
      const rv = await takSsh.revokeIntegrationCertViaSshScript(un);
      assert.strictEqual(rv.via, "marti-api");
      assert.deepStrictEqual(revokeCalls, [{ u: un, opts: { requireVerified: true } }]);
      assert.ok(!takSsh.hasStoredIntegrationCertFiles(un), "local cache removed after revoke");
    } finally {
      takSvc.revokeCertsForUser = origRevoke;
    }

    // Without a password (or on a pre-5.6 server) and no SSH, the old SSH error still shows.
    await assert.rejects(takSsh.provisionIntegrationCertFiles(un), /SSH (is )?not configured/);
    version = { major: 5, minor: 5, patch: 0 };
    marti.clearVersionCache();
    await assert.rejects(takSsh.provisionIntegrationCertFiles(un, { password: "x" }), /SSH (is )?not configured/);
    version = { major: 5, minor: 6, patch: 0 };
    marti.clearVersionCache();

    // Signing turned off on the server → API path skipped.
    securityConfig = { data: { enableEnrollment: false } };
    await assert.rejects(takSsh.provisionIntegrationCertFiles(un, { password: "x" }), /SSH (is )?not configured/);
    securityConfig = { data: { enableEnrollment: true } };
  } finally {
    takSsh.deleteStoredIntegrationCertFiles(un);
  }

  /* ---------- real verified TLS handshake returns the CA chain ---------- */
  {
    const tlsMod = require("tls");
    let restore = () => {};
    const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);
    const server = tlsMod.createServer({ key: leafKeyPem, cert: pemOf(leafCert) + pemOf(intCert) }, (s) => s.end());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      let caPem = pemOf(rootCert);
      const origAuth = takSvc.getTakTlsAuth;
      const origBase = takSvc.getTakBaseUrl;
      const port = server.address().port;
      takSvc.getTakTlsAuth = () => ({ ca: Buffer.from(caPem), cert: pemOf(leafCert), key: leafKeyPem, rejectUnauthorized: true });
      takSvc.getTakBaseUrl = () => "https://127.0.0.1:" + port + "/Marti";
      restore = () => { takSvc.getTakTlsAuth = origAuth; takSvc.getTakBaseUrl = origBase; };
      marti.__setTestHooks({ peerChain: null });
      const chain = await marti.getTakCaChainViaApi();
      assert.strictEqual(chain.roots.length, 1, "root comes from TAK_CA_PATH / verified chain");
      assert.strictEqual(chain.intermediates.length, 1, "intermediate comes from the handshake");
      assert.ok(new crypto.X509Certificate(chain.intermediates[0]).subject.includes("Test Intermediate CA"));

      // A server the configured CA does not trust is refused (no trust-on-first-use).
      const otherKeys = makeKeys();
      const otherSubj = [{ shortName: "CN", value: "Other Root" }];
      const otherRoot = makeCert({ subject: otherSubj, issuer: otherSubj, publicKey: otherKeys.publicKey, signKey: otherKeys.privateKey, serial: "09", ca: true });
      caPem = pemOf(otherRoot);
      await assert.rejects(marti.fetchVerifiedPeerChain());
    } finally {
      server.close();
      restore();
    }
  }

  /* ---------- independent parser: OpenSSL must read what forge wrote ---------- */
  {
    const { spawnSync } = require("child_process");
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marti-ossl-"));
    try {
      const have = spawnSync("openssl", ["version"]).status === 0;
      // No friendlyName must not crash forge (it checks `'friendlyName' in options`).
      const { keyPem } = marti.buildIntegrationCsr("svc-ossl", []);
      const k = forge.pki.privateKeyFromPem(keyPem);
      const pub = forge.pki.setRsaPublicKey(k.n, k.e);
      const leaf = makeCert({ subject: [{ shortName: "CN", value: "svc-ossl" }], issuer: intSubj.map((a) => ({ ...a })), publicKey: pub, signKey: intKeys.privateKey, serial: "0b", ca: false });
      const clientP12 = marti.buildClientP12({ keyPem, certPem: pemOf(leaf), caPems: [pemOf(intCert), pemOf(rootCert)] });
      const trustP12 = marti.buildTruststoreP12([pemOf(rootCert)]);
      if (have) {
        const ossl = (file, buf, extra) => {
          const f = path.join(dir, file);
          fs.writeFileSync(f, buf);
          const r = spawnSync("openssl", ["pkcs12", "-in", f, "-passin", "pass:atakatak", ...extra], { encoding: "utf8" });
          assert.strictEqual(r.status, 0, `openssl rejected ${file}: ${r.stderr}`);
          return r.stdout + r.stderr;
        };
        const c = ossl("client.p12", clientP12, ["-nodes"]);
        assert.ok(c.includes("PRIVATE KEY") && /CN\s*=\s*svc-ossl/.test(c) && /Test Root CA/.test(c), "client p12: key, cert and chain");
        const t = ossl("trust.p12", trustP12, ["-nokeys"]);
        assert.ok(t.includes("Test Root CA") && !t.includes("PRIVATE KEY"), "truststore p12 is cert-only");
        const bad = spawnSync("openssl", ["pkcs12", "-in", path.join(dir, "trust.p12"), "-passin", "pass:wrong", "-nokeys"], { encoding: "utf8" });
        assert.notStrictEqual(bad.status, 0, "wrong password is rejected");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ---------- wiring ---------- */
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const maint = read("services/takMaintenance.service.js");
  const healthFn = maint.slice(maint.indexOf("async function checkTakApiHealthyOnce"), maint.indexOf("function sleep"));
  assert.ok(healthFn.includes('"/api/version"'), "restart health poll uses GET /api/version");
  assert.ok(!healthFn.includes("/api/certadmin/cert"), "restart health poll no longer pulls the cert list");

  const routes = read("routes/integrations.routes.js");
  assert.ok(/provisionIntegrationCertFiles\(createdUsername,\s*\{\s*password:\s*result\?\.initialPassword/.test(routes),
    "integration create passes the new user's password for API signing");
  assert.ok(routes.includes("fetchTakIntermediateTruststoreP12()"), "cert zip uses the API-first truststore");
  assert.ok(read("services/enrollmentPackage.service.js").includes("fetchTakTruststoreP12()"),
    "enrollment package uses the API-first truststore");

  const usersSrc = read("services/users.service.js");
  assert.ok(/defineProperty\(result,\s*"initialPassword",\s*\{\s*value:\s*randomPassword,\s*enumerable:\s*false/.test(usersSrc),
    "integration password is non-enumerable so it never reaches the JSON response");

  const sshRoutes = read("routes/ssh.routes.js");
  assert.strictEqual((sshRoutes.match(/takAdmin: await takAdminCheck\(\)/g) || []).length, 2);
  assert.ok(read("views/settings.ejs").includes('"  • TAK Admin API: "'), "SSH test shows the TAK admin check");

  console.log("takMartiCerts.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
