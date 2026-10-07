const { app, BrowserWindow, ipcMain, safeStorage, clipboard, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const TOTP = require('./app/totp.js');
const { measureOffset } = require('./time-sync.js');
const { watchLauncher } = require('./launcher-watch.js');

// Source photo is 1945x808. The window adds transparent margin around it for the drop shadow
// (keep in sync with the body padding in app/style.css).
const FOB_WIDTH = 700;
const PAD = { x: 32, top: 22, bottom: 58 };
const WIDTH = FOB_WIDTH + PAD.x * 2;
const HEIGHT = Math.round(FOB_WIDTH * 808 / 1945) + PAD.top + PAD.bottom;

const ICON = path.join(__dirname, 'assets', 'icon.ico');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
const IS_TEST = process.env.SWTOR_KEY_TEST === '1';
const STARTED_IN_BACKGROUND = process.argv.includes('--background');

// Same data folder for the dev build and the installed .exe (which would otherwise use the product name).
if (!IS_TEST) app.setPath('userData', path.join(app.getPath('appData'), 'swtor-security-key'));

const keyFile = () => path.join(app.getPath('userData'), 'security-key.json');
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');

// ---------- Key storage ----------
// The key lives only in the main process. The window can ask for the current code
// and public details, but it never receives the secret and cannot edit the key:
// once attached, the only allowed change is removing it.
function loadKey() {
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
    const secret = raw.encrypted
      ? safeStorage.decryptString(Buffer.from(raw.secret, 'base64'))
      : raw.secret;
    return { ...raw, secret };
  } catch {
    return null;
  }
}

function publicStatus(key) {
  if (!key) return { attached: false };
  const { digits, period, algorithm, label, issuer, attachedAt } = key;
  return { attached: true, digits, period, algorithm, label, issuer, attachedAt };
}

function attachKey(input) {
  if (loadKey()) throw new Error('A security key is already attached. Remove it first.');
  const parsed = TOTP.parseKey(input);
  const encrypted = safeStorage.isEncryptionAvailable();
  const record = {
    ...parsed,
    secret: encrypted ? safeStorage.encryptString(parsed.secret).toString('base64') : parsed.secret,
    encrypted,
    attachedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify(record));
  return publicStatus(loadKey());
}

// ---------- Time sync ----------
// Codes are generated from network time (PC clock + measured offset), so a drifting
// Windows clock can't produce rejected codes.
const clock = { offset: 0, source: null, syncedAt: null, error: null };
let syncing = null;
const now = () => Date.now() + clock.offset;

function syncTime({ maxAgeMs = 60_000 } = {}) {
  if (clock.syncedAt && Date.now() - clock.syncedAt < maxAgeMs) return Promise.resolve(clock);
  if (!syncing) {
    syncing = measureOffset()
      .then(({ offset, source }) => Object.assign(clock, { offset: Math.round(offset), source, syncedAt: Date.now(), error: null }))
      .catch((err) => Object.assign(clock, { error: err.message }))
      .finally(() => { syncing = null; });
  }
  return syncing.then(() => clock);
}

async function currentCode() {
  const key = loadKey();
  if (!key) return null;
  const time = now();
  return { code: await TOTP.generate(key.secret, { ...key, time }), period: key.period, time };
}

// ---------- Preferences ----------
function loadPrefs() {
  try { return { openWithLauncher: true, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { return { openWithLauncher: true }; }
}
function savePrefs(prefs) {
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify(prefs));
}

// Start hidden in the tray at Windows sign-in so the launcher can be detected.
// The value name must match installer/installer.nsh, which removes it on uninstall.
const LOGIN_ITEM_NAME = 'SWTOR Security Key';
function applyLoginItem(enabled) {
  if (IS_TEST) return;
  // The portable .exe unpacks to a temp folder; PORTABLE_EXECUTABLE_FILE is the real file.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? ['--background'] : [path.resolve(__dirname), '--background'];
  app.setLoginItemSettings({ openAtLogin: enabled, path: exe, args, name: LOGIN_ITEM_NAME });
}

// ---------- Window, tray and launcher ----------
let win = null;
let tray = null;
let quitting = false;
let shownForLauncher = false;
let prefs = { openWithLauncher: true };

// Restores the last position only if most of the window would still be on a connected screen.
function savedPosition() {
  const pos = prefs.position;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return {};
  const area = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: WIDTH, height: HEIGHT }).workArea;
  const visibleW = Math.min(pos.x + WIDTH, area.x + area.width) - Math.max(pos.x, area.x);
  const visibleH = Math.min(pos.y + HEIGHT, area.y + area.height) - Math.max(pos.y, area.y);
  return visibleW > WIDTH / 2 && visibleH > HEIGHT / 2 ? { x: pos.x, y: pos.y } : {};
}

let savePositionTimer = null;
function rememberPosition() {
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const [x, y] = win.getPosition();
    prefs.position = { x, y };
    savePrefs(prefs);
  }, 400);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...savedPosition(),
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'SWTOR Security Key',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => { if (!STARTED_IN_BACKGROUND || IS_TEST) win.show(); });
  win.on('move', rememberPosition); // debounced; fires for drags and programmatic moves
  // Tell the window when it goes to the tray/taskbar or comes back, so the display can switch off/on.
  const sendVisibility = (visible) => { if (!win.isDestroyed()) win.webContents.send('window:visibility', visible); };
  win.on('hide', () => sendVisibility(false));
  win.on('minimize', () => sendVisibility(false));
  win.on('show', () => sendVisibility(true));
  win.on('restore', () => sendVisibility(true));
  // Closing hides to the tray so the launcher watcher keeps running.
  win.on('close', (e) => {
    if (!quitting && tray) { e.preventDefault(); win.hide(); }
  });
}

function showWindow({ focus = true } = {}) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (focus) { win.show(); win.focus(); } else { win.showInactive(); }
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show security key', click: () => showWindow() },
    {
      label: 'Open with SWTOR launcher',
      type: 'checkbox',
      checked: prefs.openWithLauncher,
      click: (item) => {
        prefs.openWithLauncher = item.checked;
        savePrefs(prefs);
        applyLoginItem(item.checked);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('SWTOR Security Key');
  tray.on('click', () => showWindow());
  buildTrayMenu();
}

// The window keeps its display on while the launcher is open (see app.js).
const swtor = { launcherOpen: false, gameRunning: false };
function sendSwtorState() {
  if (win && !win.isDestroyed()) win.webContents.send('swtor:state', { ...swtor });
}

// Launcher opens: float the key beside it with the display on, without stealing focus
//   from the launcher's login box.
// Game starts: hide to the tray (still reachable from the tray icon).
// Launcher closes without the game: hide again, unless the user opened the key themselves.
function startLauncherWatch() {
  watchLauncher({
    onOpen: () => {
      swtor.launcherOpen = true;
      if (!prefs.openWithLauncher || !win) return;
      syncTime().catch(() => {});
      if (!win.isVisible()) shownForLauncher = true;
      win.setAlwaysOnTop(true, 'floating');
      showWindow({ focus: false });
      sendSwtorState();
    },
    onClose: () => {
      swtor.launcherOpen = false;
      sendSwtorState();
      if (!win) return;
      win.setAlwaysOnTop(false);
      if (shownForLauncher) win.hide();
      shownForLauncher = false;
    },
    onGameStart: () => {
      swtor.gameRunning = true;
      sendSwtorState();
      if (!prefs.openWithLauncher || !win) return;
      win.setAlwaysOnTop(false);
      win.hide();
      shownForLauncher = false;
    },
    onGameExit: () => {
      swtor.gameRunning = false;
      sendSwtorState();
    },
  });
}

// ---------- IPC ----------
ipcMain.handle('key:status', () => publicStatus(loadKey()));
ipcMain.handle('key:attach', (_e, input) => attachKey(input));
ipcMain.handle('key:remove', () => {
  fs.rmSync(keyFile(), { force: true });
  return publicStatus(null);
});
ipcMain.handle('key:code', () => currentCode());
ipcMain.handle('time:sync', (_e, force) => syncTime({ maxAgeMs: force ? 5_000 : 60_000 }).then((c) => ({ ...c })));
ipcMain.handle('time:status', () => ({ ...clock }));
ipcMain.handle('swtor:state', () => ({ ...swtor }));

// Copies the current code. Only replaces/clears the clipboard while it still holds a code we put there.
let lastCopied = null;
ipcMain.handle('key:copy', async () => {
  const result = await currentCode();
  if (!result) return null;
  clipboard.writeText(result.code);
  // Read it back so the window only reports success when the code is really on the clipboard.
  if (clipboard.readText() !== result.code) throw new Error('Clipboard is busy, press again');
  lastCopied = result.code;
  return result.code;
});
ipcMain.handle('key:refreshCopy', async () => {
  if (!lastCopied || clipboard.readText() !== lastCopied) return null;
  const result = await currentCode();
  if (!result) return null;
  lastCopied = result.code;
  clipboard.writeText(lastCopied);
  return lastCopied;
});
ipcMain.handle('key:clearCopy', () => {
  if (lastCopied && clipboard.readText() === lastCopied) clipboard.clear();
  lastCopied = null;
});
ipcMain.on('window:close', () => win?.close());
ipcMain.on('window:minimize', () => win?.minimize());

// ---------- Startup ----------
if (!IS_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('io.github.ddz76dev.swtorfob');

  app.whenReady().then(() => {
    // Editable settings file from the first version; keys must now be attached from a SWTOR QR code.
    fs.rmSync(path.join(app.getPath('userData'), 'key-config.json'), { force: true });
    prefs = loadPrefs();
    applyLoginItem(prefs.openWithLauncher);
    // Started at sign-in but the user turned that off (an install/upgrade re-adds the entry):
    // the line above removed it again, so just exit.
    if (STARTED_IN_BACKGROUND && !prefs.openWithLauncher && !IS_TEST) {
      app.quit();
      return;
    }
    createWindow();
    syncTime().catch(() => {});
    setInterval(() => syncTime({ maxAgeMs: 0 }).catch(() => {}), 30 * 60_000);
    if (!IS_TEST) {
      createTray();
      startLauncherWatch();
    }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
