// Checks launcher detection with stand-in processes (a copy of ping.exe renamed launcher.exe).
// Run: node test/launcher-watch-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchLauncher } = require('../launcher-watch.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fob-watch-test-'));
const ping = path.join(process.env.SystemRoot, 'System32', 'PING.EXE');

function fakeLauncher(folder, seconds) {
  const dir = path.join(tmp, folder);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'launcher.exe');
  fs.copyFileSync(ping, exe);
  return spawn(exe, ['-n', String(seconds), '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
}

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

(async () => {
  const events = [];
  const stop = watchLauncher({ onOpen: () => events.push('open'), onClose: () => events.push('close') });

  await sleep(4000);
  check('nothing happens with no launcher running', events.length === 0);

  const other = fakeLauncher('Some Other Game', 9);
  await sleep(7000);
  check('ignores a launcher.exe from another program', events.length === 0);
  other.kill();
  await sleep(4000);

  const swtor = fakeLauncher('Star Wars - The Old Republic', 60);
  await sleep(7000);
  check('detects the SWTOR launcher opening', events.join() === 'open');
  swtor.kill();
  await sleep(7000);
  check('detects the SWTOR launcher closing', events.join() === 'open,close');

  stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still locked, left in %TEMP% */ }
  console.log(failures ? `\n${failures} FAILED` : '\nAll launcher checks passed');
  process.exit(failures ? 1 : 0);
})();
