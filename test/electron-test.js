// End-to-end check of the real desktop app: attach, lock, code, storage, remove.
// Uses a throwaway profile folder, so your real key is never touched.
// Run: npx electron test/electron-test.js
const { app, BrowserWindow, clipboard } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swtor-key-test-'));
app.setPath('userData', tmp);
process.env.SWTOR_KEY_TEST = '1'; // no tray, launcher watcher or Windows sign-in entry
require('../main.js');

const SECRET = 'JBSWY3DPEHPK3PXP';
const QR = `otpauth://totp/SWTOR:test-account?secret=${SECRET}&issuer=SWTOR`;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

function reference(timeMs) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]); // JBSWY3DPEHPK3PXP
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const originalClipboard = clipboard.readText();
  const run = (js) => win.webContents.executeJavaScript(`(async () => { ${js} })()`);

  try {
    const exposed = await run(`return Object.keys(window.keyHost).sort()`);
    check('window only gets status/attach/remove/code (no secret access)',
      JSON.stringify(exposed) === JSON.stringify(['attach', 'clearCopy', 'close', 'code', 'copy', 'minimize', 'refreshCopy', 'remove', 'status', 'syncTime', 'timeStatus']), exposed.join(','));
    check('window has no Node.js access', await run(`return typeof require === 'undefined' && typeof process === 'undefined'`));

    check('starts with no key', (await run(`return keyHost.status()`)).attached === false);
    check('no code without a key', (await run(`return keyHost.code()`)) === null);

    const status = await run(`return keyHost.attach(${JSON.stringify(QR)})`);
    check('attaches from SWTOR QR text', status.attached && status.digits === 6 && status.period === 30);
    check('status never contains the secret', !JSON.stringify(status).includes(SECRET));

    const second = await run(`try { await keyHost.attach('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'); return 'overwrote'; } catch (e) { return e.message; }`);
    check('locked: a second key cannot overwrite the first', /already attached/.test(second));

    const file = fs.readFileSync(path.join(tmp, 'security-key.json'), 'utf8');
    check('key file is encrypted (secret not readable on disk)', !file.includes(SECRET) && JSON.parse(file).encrypted === true);

    const { code, time } = await run(`return keyHost.code()`);
    check('code matches independent calculation', code === reference(time), `${code} vs ${reference(time)}`);

    const badRemoveAttach = await run(`try { await keyHost.attach('not a key'); return 'accepted'; } catch (e) { return e.message; }`);
    check('rejects junk input while locked', badRemoveAttach !== 'accepted');

    clipboard.writeText('something the user copied');
    const copied = await run(`return keyHost.copy()`);
    check('button copy puts the current code on the clipboard', clipboard.readText() === copied && /^\d{6}$/.test(copied));
    await run(`return keyHost.clearCopy()`);
    check('clipboard is cleared when the display turns off', clipboard.readText() === '');
    await run(`return keyHost.copy()`);
    clipboard.writeText('user copied something else');
    await run(`return keyHost.clearCopy()`);
    check('never clears something else the user copied', clipboard.readText() === 'user copied something else');

    // Time sync against internet time servers.
    const clock = await run(`return keyHost.syncTime(true)`);
    check('time sync reaches a time server', !!clock.syncedAt && !clock.error, clock.error || `via ${clock.source}, PC clock off by ${clock.offset} ms`);
    const netNow = () => Date.now() + (clock.offset || 0);
    const synced = await run(`return keyHost.code()`);
    check('codes use the synced time', synced.code === reference(synced.time) && Math.abs(synced.time - netNow()) < 1000);

    // Use the real on-screen controls, the way a user would.
    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 300));
    const toastNow = () => run(`return document.getElementById('toast').classList.contains('show') && document.querySelector('#toast .toast-text').textContent`);

    clipboard.writeText('before press');
    await run(`document.getElementById('keyButton').click()`);
    let buttonToast = false;
    for (let i = 0; i < 40 && !/^Time/.test(buttonToast); i++) {
      await new Promise((r) => setTimeout(r, 100));
      buttonToast = await toastNow();
    }
    check('button refreshes and syncs time (does not copy)', clipboard.readText() === 'before press' && /^Time synced/.test(buttonToast), String(buttonToast));

    // Stay clear of a 30 s boundary so the code can't change mid-check.
    while ((netNow() % 30000) > 26000 || (netNow() % 30000) < 1000) await new Promise((r) => setTimeout(r, 200));
    await run(`document.getElementById('lcd').click()`);
    await new Promise((r) => setTimeout(r, 600));
    const pasted = clipboard.readText();
    const copyToast = await toastNow();
    check('clicking the digits copies the current code', /^\d{6}$/.test(pasted) && pasted === reference(netNow()), pasted);
    check('copy notification appears with the same code', copyToast === `Code ${pasted.slice(0, 3)} ${pasted.slice(3)} copied`, String(copyToast));
    clipboard.writeText('again');
    await run(`document.getElementById('lcd').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('clicking the digits again copies again', clipboard.readText() === reference(netNow()));

    win.setPosition(137, 151);
    await new Promise((r) => setTimeout(r, 900));
    const savedPrefs = JSON.parse(fs.readFileSync(path.join(tmp, 'prefs.json'), 'utf8'));
    check('remembers the window position', savedPrefs.position && Math.abs(savedPrefs.position.x - 137) <= 3 && Math.abs(savedPrefs.position.y - 151) <= 3, JSON.stringify(savedPrefs.position));

    await run(`return keyHost.remove()`);
    check('remove deletes the key', !fs.existsSync(path.join(tmp, 'security-key.json')) && (await run(`return keyHost.status()`)).attached === false);
  } catch (err) {
    failures++;
    console.log('FAIL  test crashed', err);
  }

  clipboard.writeText(originalClipboard);
  console.log(failures ? `\n${failures} FAILED` : '\nAll desktop app checks passed');
  // Windows keeps the profile folder locked while Electron runs, so cleanup is best-effort.
  BrowserWindow.getAllWindows().forEach((w) => w.destroy());
  try { fs.rmSync(path.join(tmp, 'security-key.json'), { force: true }); } catch { /* already removed */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in %TEMP% */ }
  app.exit(failures ? 1 : 0);
});
