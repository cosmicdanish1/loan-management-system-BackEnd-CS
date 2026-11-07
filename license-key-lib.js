/**
 * Signing side of the license keys (format 2, see src/modules/license/license-crypto.ts).
 * Used by generate-license.js. Needs the PRIVATE key, which must never be on a customer machine.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Where the private key lives: LICENSE_PRIVATE_KEY_FILE, else ~/.pwt-license/license-private.pem (outside the project). */
function privateKeyPath() {
  return process.env.LICENSE_PRIVATE_KEY_FILE || path.join(os.homedir(), '.pwt-license', 'license-private.pem');
}

function isEncryptedPem(pem) {
  return /BEGIN ENCRYPTED PRIVATE KEY/.test(pem);
}

function loadPrivateKey(passphrase) {
  const file = privateKeyPath();
  if (!fs.existsSync(file)) throw new Error(`Private key not found: ${file}`);
  const pem = fs.readFileSync(file, 'utf8');
  return crypto.createPrivateKey(isEncryptedPem(pem) ? { key: pem, passphrase } : pem);
}

function expiryEncoded(expiryDate) {
  return Math.floor(expiryDate.getTime() / 86400000).toString(36).toUpperCase().padStart(4, '0');
}

function signKeyV2(privateKey, customerCode, expiryDate) {
  const enc = expiryEncoded(expiryDate);
  const sig = crypto.sign(null, Buffer.from(`PWT1|${customerCode}|${enc}`, 'utf8'), privateKey);
  const groups = b32encode(sig).match(/.{1,8}/g).join('-');
  return `PWT1-${customerCode}-${enc}-${groups}`;
}

module.exports = { b32encode, privateKeyPath, isEncryptedPem, loadPrivateKey, signKeyV2, expiryEncoded };
