// Checks app/totp.js against the RFC 6238 vectors and an independent Node crypto implementation.
// Run: node test/totp-test.js
const crypto = require('crypto');
const TOTP = require('../app/totp.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function reference(keyBuf, timeMs, { digits = 6, period = 30, algorithm = 'sha1' } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / period)));
  const h = crypto.createHmac(algorithm, keyBuf).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

(async () => {
  // RFC 6238 Appendix B test vectors (8 digits).
  const rfcKeys = {
    SHA1: Buffer.from('12345678901234567890'),
    SHA256: Buffer.from('12345678901234567890123456789012'),
    SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, ...expected] of vectors) {
    for (const [i, alg] of ['SHA1', 'SHA256', 'SHA512'].entries()) {
      const got = await TOTP.generate(base32Encode(rfcKeys[alg]), { digits: 8, algorithm: alg, time: t * 1000 });
      check(`RFC vector ${alg} t=${t}`, got === expected[i], `${got} vs ${expected[i]}`);
    }
  }

  // 2,000 random keys and times against Node's own HMAC.
  let mismatches = 0;
  for (let i = 0; i < 2000; i++) {
    const key = crypto.randomBytes(10 + (i % 23));
    const t = Math.floor(Math.random() * 4e12);
    if (await TOTP.generate(base32Encode(key), { time: t }) !== reference(key, t)) mismatches++;
  }
  check('2000 random keys match independent implementation', mismatches === 0, `${mismatches} mismatches`);

  // Code boundaries: same code within a 30 s window, new code right after it.
  const k = 'JBSWY3DPEHPK3PXP';
  const a = await TOTP.generate(k, { time: 1_700_000_010_000 });
  const b = await TOTP.generate(k, { time: 1_700_000_039_999 });
  const c = await TOTP.generate(k, { time: 1_700_000_040_000 });
  check('stable inside a 30 s window', a === b);
  check('changes at the window boundary', b !== c);

  // QR / setup-key parsing.
  const parsed = TOTP.parseKey('otpauth://totp/SWTOR:me%40mail.com?secret=jbsw y3dp-ehpk3pxp&issuer=SWTOR');
  check('parses SWTOR otpauth QR', parsed.secret === k && parsed.label === 'me@mail.com' && parsed.issuer === 'SWTOR' && parsed.digits === 6 && parsed.period === 30);
  check('plain setup key defaults to SWTOR format', JSON.stringify(TOTP.parseKey(k)) === JSON.stringify({ secret: k, digits: 6, period: 30, algorithm: 'SHA1', label: '', issuer: '' }));
  for (const [name, bad] of [
    ['rejects empty input', ''],
    ['rejects short key', 'ABCDEFG'],
    ['rejects invalid characters', 'JBSWY3DPEHPK3PX1'],
    ['rejects HOTP (counter) QR', 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'],
    ['rejects Google transfer QR', 'otpauth-migration://offline?data=abc'],
    ['rejects unknown algorithm', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5'],
    ['rejects odd digit count', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4'],
    ['rejects non-URL junk', 'https://example.com/?secret=JBSWY3DPEHPK3PXP'],
  ]) {
    let threw = false;
    try { TOTP.parseKey(bad); } catch { threw = true; }
    check(name, threw);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll TOTP checks passed');
  process.exit(failures ? 1 : 0);
})();
