// Watches for the SWTOR launcher (launcher.exe) and the game itself (swtor.exe).
const { execFile } = require('child_process');

const POLL_MS = 3000;
const LAUNCHER_EXE = 'launcher.exe';
const GAME_EXE = 'swtor.exe';

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// One cheap tasklist call per poll gives every running image name.
async function runningImages() {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
  if (out === null) return null;
  const names = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// "launcher.exe" is a common name, so check the path once when one appears.
// If Windows hides the path (e.g. the launcher runs as administrator), assume it's SWTOR's.
async function isSwtorLauncher() {
  const out = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${LAUNCHER_EXE}'" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { '?' } }`,
  ]);
  const paths = (out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return paths.some((p) => p === '?' || /old republic|swtor/i.test(p));
}

/**
 * Calls back on transitions:
 *   onOpen / onClose            the SWTOR launcher started / exited
 *   onGameStart / onGameExit    swtor.exe started / exited
 */
function watchLauncher({ onOpen = () => {}, onClose = () => {}, onGameStart = () => {}, onGameExit = () => {} }) {
  let launcherOpen = false;
  let otherLauncher = false; // a non-SWTOR launcher.exe, checked once until it exits
  let gameRunning = false;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const images = await runningImages();
      if (!images) return; // tasklist failed this time; keep the previous state

      const launcherExe = images.has(LAUNCHER_EXE);
      if (launcherExe && !launcherOpen && !otherLauncher) {
        const swtor = await isSwtorLauncher();
        if (swtor === true) { launcherOpen = true; onOpen(); }
        else if (swtor === false) { otherLauncher = true; }
      } else if (!launcherExe) {
        otherLauncher = false;
        if (launcherOpen) { launcherOpen = false; onClose(); }
      }

      const game = images.has(GAME_EXE);
      if (game && !gameRunning) { gameRunning = true; onGameStart(); }
      else if (!game && gameRunning) { gameRunning = false; onGameExit(); }
    } finally {
      busy = false;
    }
  };

  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

module.exports = { watchLauncher };
