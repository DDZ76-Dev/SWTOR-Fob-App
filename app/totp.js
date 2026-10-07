// RFC 6238 TOTP using WebCrypto. Shared by the renderer and the Electron main process.
const TOTP = (() => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

  // SWTOR keys use the standard authenticator parameters.
  const SWTOR = Object.freeze({ digits: 6, period: 30, algorithm: 'SHA1' });

  function normalizeSecret(input) {
    return String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  }

  function base32Decode(input) {
    const clean = normalizeSecret(input);
    if (!clean) throw new Error('Setup key is empty');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
      const idx = ALPHABET.indexOf(ch);
      if (idx === -1) throw new Error(`Invalid character "${ch}" in setup key`);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    if (out.length < 10) throw new Error('Setup key is too short');
    return new Uint8Array(out);
  }

  // Accepts an otpauth://totp/... URI (from the SWTOR QR code) or a bare Base32 setup key.
  function parseKey(input) {
    const text = String(input || '').trim();
    if (/^otpauth-migration:/i.test(text)) {
      throw new Error('That is a Google Authenticator transfer code, not a SWTOR setup QR');
    }
    if (!/^otpauth:/i.test(text)) {
      const secret = normalizeSecret(text);
      base32Decode(secret);
      return { secret, ...SWTOR, label: '', issuer: '' };
    }

    let url;
    try { url = new URL(text); } catch { throw new Error('QR code is not a valid authenticator link'); }
    if (url.host.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) keys are supported');

    const p = url.searchParams;
    const secret = normalizeSecret(p.get('secret') || '');
    base32Decode(secret);

    const algorithm = (p.get('algorithm') || SWTOR.algorithm).toUpperCase();
    if (!HASHES[algorithm]) throw new Error(`Unsupported algorithm ${algorithm}`);
    const digits = parseInt(p.get('digits') || SWTOR.digits, 10);
    const period = parseInt(p.get('period') || SWTOR.period, 10);
    if (![6, 7, 8].includes(digits)) throw new Error(`Unsupported digit count ${digits}`);
    if (!(period >= 10 && period <= 120)) throw new Error(`Unsupported period ${period}`);

    const rawLabel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const [labelIssuer, account] = rawLabel.includes(':') ? rawLabel.split(/:(.*)/s) : ['', rawLabel];
    return {
      secret, digits, period, algorithm,
      label: (account || '').trim(),
      issuer: (p.get('issuer') || labelIssuer || '').trim(),
    };
  }

  async function generate(secret, { digits = 6, period = 30, algorithm = 'SHA1', time = Date.now() } = {}) {
    const keyBytes = base32Decode(secret);
    const counter = Math.floor(time / 1000 / period);
    const msg = new ArrayBuffer(8);
    const view = new DataView(msg);
    view.setUint32(0, Math.floor(counter / 2 ** 32));
    view.setUint32(4, counter >>> 0);

    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: HASHES[algorithm] }, false, ['sign']);
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 10 ** digits).padStart(digits, '0');
  }

  return { SWTOR, parseKey, generate, base32Decode };
})();

if (typeof module !== 'undefined') module.exports = TOTP;
