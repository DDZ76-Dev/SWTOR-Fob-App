// Checks launcher detection with stand-in processes (a copy of ping.exe renamed launcher.exe).
// Run: node test/launcher-watch-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchLauncher } = require('../launcher-watch.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls instead of fixed waits: PowerShell can take many seconds to start on a busy machine.
async function waitFor(cond, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(250); }
  return cond();
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fob-watch-test-'));
const ping = path.join(process.env.SystemRoot, 'System32', 'PING.EXE');

function fakeLauncher(folder, seconds, name = 'launcher.exe') {
  const dir = path.join(tmp, folder);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, name);
  fs.copyFileSync(ping, exe);
  return spawn(exe, ['-n', String(seconds), '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
}

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
};

(async () => {
  // The watcher sees every process, so a real SWTOR launcher or game would interfere.
  const { execFileSync } = require('child_process');
  const running = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).toLowerCase();
  if (running.includes('"launcher.exe"') || running.includes('"swtor.exe"')) {
    console.log('SKIP  launcher detection tests: close SWTOR (launcher.exe / swtor.exe) and run again');
    process.exit(0);
  }

  const events = [];
  const stop = watchLauncher({
    onOpen: () => events.push('open'),
    onClose: () => events.push('close'),
    onGameStart: () => events.push('game'),
    onGameExit: () => events.push('game-exit'),
  });

  await sleep(4000);
  check('nothing happens with no launcher running', events.length === 0);

  const other = fakeLauncher('Some Other Game', 30);
  await sleep(15000); // long enough for even a slow path check to finish
  check('ignores a launcher.exe from another program', events.length === 0);
  other.kill();
  await sleep(4000);

  const swtor = fakeLauncher('Star Wars - The Old Republic', 120);
  check('detects the SWTOR launcher opening', await waitFor(() => events.join() === 'open'));
  swtor.kill();
  check('detects the SWTOR launcher closing', await waitFor(() => events.join() === 'open,close'));

  const game = fakeLauncher('Star Wars - The Old Republic/swtor/retailclient', 120, 'swtor.exe');
  check('detects the game starting', await waitFor(() => events.join() === 'open,close,game'));
  game.kill();
  check('detects the game exiting', await waitFor(() => events.join() === 'open,close,game,game-exit'));

  stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still locked, left in %TEMP% */ }
  console.log(failures ? `\n${failures} FAILED` : '\nAll launcher checks passed');
  process.exit(failures ? 1 : 0);
})();
