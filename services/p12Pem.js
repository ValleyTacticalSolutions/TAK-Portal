/**
 * Local PKCS#12 → PEM helper (replaces yanked npm package `p12-pem`).
 *
 * Same shape as p12-pem / @tak-ps/node-p12: { pemKey, pemCertificate, commonName }.
 * Uses node-forge with strict=false so legacy TAK PKCS#12 (RC2-40-CBC) still parses.
 */

const fs = require("fs");
const forge = require("node-forge");

function bufferToBinaryString(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

function convertToPem(p12input, password) {
  const p12Asn1 = forge.asn1.fromDer(
    typeof p12input === "string" ? p12input : bufferToBinaryString(p12input)
  );
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  const pemKey = getKeyFromP12(p12);
  const { pemCertificate, commonName } = getCertificateFromP12(p12);
  return { pemKey, pemCertificate, commonName };
}

function getKeyFromP12(p12) {
  const shrouded =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] || [];
  const plain =
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ||
    [];
  const bag = shrouded[0] || plain[0];
  if (!bag?.key) {
    throw new Error("Unable to get private key.");
  }
  // Match former p12-pem output: strip CRLF so callers re-normalize PEM newlines.
  return forge.pki.privateKeyToPem(bag.key).replace(/\r\n/g, "");
}

function getCertificateFromP12(p12) {
  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ||
    [];
  const certificate = certBags[0];
  if (!certificate?.cert) {
    throw new Error("Unable to get certificate.");
  }
  const pemCertificate = forge.pki
    .certificateToPem(certificate.cert)
    .replace(/\r\n/g, "");
  const commonName =
    certificate.cert.subject.attributes.find(
      (a) => a.shortName === "CN" || a.name === "commonName"
    )?.value ?? certificate.cert.subject.attributes[0]?.value;
  return { pemCertificate, commonName };
}

/**
 * @param {string} certPath path to .p12 / .pfx
 * @param {string} password PKCS#12 passphrase (may be "")
 * @returns {{ pemKey: string, pemCertificate: string, commonName: string|undefined }}
 */
function getPemFromP12(certPath, password) {
  const p12File = fs.readFileSync(certPath);
  return convertToPem(p12File, password);
}

module.exports = { getPemFromP12, convertToPem };
