// Watches for the SWTOR launcher (launcher.exe) and reports when it opens and closes.
const { execFile } = require('child_process');

const POLL_MS = 3000;
const EXE = 'launcher.exe';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// tasklist is cheap enough to poll; it only tells us that *some* launcher.exe exists.
async function launcherExeRunning() {
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH']);
  return out.toLowerCase().includes(`"${EXE}"`);
}

// "launcher.exe" is a common name, so check the path once when one appears.
// If Windows hides the path (e.g. the launcher runs as administrator), assume it's SWTOR's.
async function isSwtorLauncher() {
  const out = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { '?' } }`,
  ]);
  const paths = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return paths.some((p) => p === '?' || /old republic|swtor/i.test(p));
}

function watchLauncher({ onOpen, onClose }) {
  let running = false;
  let otherLauncher = false; // a non-SWTOR launcher.exe, checked once until it exits
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const exeRunning = await launcherExeRunning();
      if (exeRunning && !running && !otherLauncher) {
        if (await isSwtorLauncher()) { running = true; onOpen(); } else { otherLauncher = true; }
      } else if (!exeRunning) {
        otherLauncher = false;
        if (running) { running = false; onClose(); }
      }
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

module.exports = { watchLauncher };
