(() => {
  const DISPLAY_SECONDS = 60;
  const STORAGE_KEY = 'swtor-security-key';

  // The Electron main process holds the key (see main.js). In a plain browser preview,
  // this stand-in keeps it in localStorage with the same rules: attach once, read-only, remove.
  const browserStore = {
    read() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
    },
    async status() {
      const k = this.read();
      if (!k) return { attached: false };
      const { secret, ...rest } = k;
      return { attached: true, ...rest };
    },
    async attach(input) {
      if (this.read()) throw new Error('A security key is already attached. Remove it first.');
      const key = { ...TOTP.parseKey(input), attachedAt: new Date().toISOString() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(key));
      return this.status();
    },
    async remove() {
      localStorage.removeItem(STORAGE_KEY);
      return { attached: false };
    },
    async code() {
      const k = this.read();
      if (!k) return null;
      const now = Date.now();
      return { code: await TOTP.generate(k.secret, { ...k, time: now }), period: k.period, time: now };
    },
    copied: false,
    async copy() {
      const r = await this.code();
      if (!r) return null;
      await navigator.clipboard.writeText(r.code);
      this.copied = true;
      return r.code;
    },
    async refreshCopy() { return this.copied ? this.copy() : null; },
    async clearCopy() { this.copied = false; },
    async syncTime() { return { offset: 0, source: 'PC clock', syncedAt: Date.now(), error: null }; },
    async timeStatus() { return this.syncTime(); },
    async swtorState() { return { launcherOpen: false, gameRunning: false }; },
    onSwtorState() {},
    onVisibility() {},
  };

  const host = window.keyHost || null;
  const store = host || browserStore;
  if (!host) document.body.classList.add('in-browser');

  const $ = (id) => document.getElementById(id);
  const svg = $('lcdSvg');
  const lcd = $('lcd');
  const button = $('keyButton');
  const attachPanel = $('attachPanel');
  const infoPanel = $('infoPanel');

  let status = { attached: false };
  let digitEls = [];
  let barEls = [];
  let currentCode = '';
  let offTimer = null;
  let tickTimer = null;
  let lastCounter = null;

  // ---------- Seven-segment LCD ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DW = 56, DH = 100, GAP = 15, T = 12.5, CUT = 2.2;
  const BAR_Y = 113, BAR_H = 7;
  const SKEW = -6;

  const GLYPHS = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
    '-': 'g', 'E': 'adefg', 'r': 'eg', ' ': '',
  };

  function hSeg(x1, x2, y) {
    const h = T / 2;
    return [[x1, y], [x1 + h, y - h], [x2 - h, y - h], [x2, y], [x2 - h, y + h], [x1 + h, y + h]];
  }
  function vSeg(x, y1, y2) {
    const h = T / 2;
    return [[x, y1], [x + h, y1 + h], [x + h, y2 - h], [x, y2], [x - h, y2 - h], [x - h, y1 + h]];
  }
  function segmentShapes() {
    const L = T / 2, R = DW - T / 2, TOP = T / 2, MID = DH / 2, BOT = DH - T / 2;
    return {
      a: hSeg(L + CUT, R - CUT, TOP),
      b: vSeg(R, TOP + CUT, MID - CUT),
      c: vSeg(R, MID + CUT, BOT - CUT),
      d: hSeg(L + CUT, R - CUT, BOT),
      e: vSeg(L, MID + CUT, BOT - CUT),
      f: vSeg(L, TOP + CUT, MID - CUT),
      g: hSeg(L + CUT, R - CUT, MID),
    };
  }

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function buildLcd(count) {
    svg.innerHTML = '';
    digitEls = [];
    barEls = [];

    const totalW = count * DW + (count - 1) * GAP;
    const slant = Math.tan((-SKEW * Math.PI) / 180) * (BAR_Y + BAR_H);
    svg.setAttribute('viewBox', `${-slant - 4} -6 ${totalW + slant + 12} ${BAR_Y + BAR_H + 10}`);

    const defs = el('defs', {}, svg);
    const filter = el('filter', { id: 'segBlur', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    el('feGaussianBlur', { stdDeviation: '1.6' }, filter);

    const root = el('g', { transform: `skewX(${SKEW})` }, svg);
    // Layers: ghost (unlit segments visible through the polarizer), shadow cast on the reflector, lit segments.
    const ghostLayer = el('g', {}, root);
    const shadowLayer = el('g', { transform: 'translate(2.6 3.4)' }, root);
    const litLayer = el('g', {}, root);

    const shapes = segmentShapes();
    for (let i = 0; i < count; i++) {
      const ox = i * (DW + GAP);
      const segs = {};
      for (const [name, pts] of Object.entries(shapes)) {
        const points = pts.map(([x, y]) => `${(x + ox).toFixed(2)},${y.toFixed(2)}`).join(' ');
        el('polygon', { points, class: 'seg seg-ghost' }, ghostLayer);
        segs[name] = [
          el('polygon', { points, class: 'seg seg-shadow' }, shadowLayer),
          el('polygon', { points, class: 'seg seg-on' }, litLayer),
        ];
      }
      digitEls.push(segs);
    }

    // Time-remaining bar row under the digits.
    const bars = 12, barGap = 6;
    const barW = (totalW - (bars - 1) * barGap) / bars;
    for (let i = 0; i < bars; i++) {
      const x = i * (barW + barGap);
      const attrs = { x, y: BAR_Y, width: barW, height: BAR_H, rx: 1 };
      el('rect', { ...attrs, class: 'seg seg-ghost' }, ghostLayer);
      barEls.push([
        el('rect', { ...attrs, class: 'seg seg-shadow' }, shadowLayer),
        el('rect', { ...attrs, class: 'seg seg-on' }, litLayer),
      ]);
    }
  }

  function showText(text) {
    const chars = text.padStart(digitEls.length, ' ').slice(-digitEls.length);
    digitEls.forEach((segs, i) => {
      const on = GLYPHS[chars[i]] ?? '';
      for (const [name, nodes] of Object.entries(segs)) {
        nodes.forEach((n) => n.classList.toggle('lit', on.includes(name)));
      }
    });
  }

  function showBars(fraction) {
    const lit = Math.ceil(fraction * barEls.length);
    barEls.forEach((nodes, i) => nodes.forEach((n) => n.classList.toggle('lit', i < lit)));
  }

  function blank() {
    showText('');
    showBars(0);
    currentCode = '';
  }



  // ---------- Code generation ----------
  const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // Network-time offset from the main process, so the countdown matches the code it generates.
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  async function refresh() {
    const t = now();
    const periodMs = (status.period || TOTP.SWTOR.period) * 1000;
    const counter = Math.floor(t / periodMs);
    showBars(1 - (t % periodMs) / periodMs);
    if (counter === lastCounter) return;
    const rolledOver = lastCounter !== null;
    lastCounter = counter;
    try {
      const result = await store.code();
      if (!tickTimer) return; // display was turned off while the code was being fetched
      if (!result) throw new Error('No key');
      currentCode = result.code;
      showText(currentCode);
      // Keep the clipboard current so a paste never uses an expired code.
      if (rolledOver) {
        store.refreshCopy()
          .then((code) => { if (code) toast(`New code ${code.slice(0, 3)} ${code.slice(3)} copied`); })
          .catch(() => {});
      }
    } catch {
      currentCode = '';
      showText('Err');
    }
  }

  // keepClipboard: the window was hidden, so a just-copied code may still be on its way into
  // the launcher. Leave it for DISPLAY_SECONDS, then clear it (only if it's still our code).
  let clipboardTimer = null;
  function powerOff({ keepClipboard = false } = {}) {
    clearInterval(tickTimer);
    clearTimeout(offTimer);
    tickTimer = offTimer = null;
    lastCounter = null;
    blank();
    clearTimeout(clipboardTimer);
    const clear = () => store.clearCopy().catch(() => {});
    if (keepClipboard) clipboardTimer = setTimeout(clear, DISPLAY_SECONDS * 1000);
    else clear();
  }

  // A quick off/on flicker of the segments confirms the code was copied.
  function blink() {
    svg.classList.add('blink');
    setTimeout(() => svg.classList.remove('blink'), 140);
  }

  function panelsOpen() {
    return !attachPanel.hidden || !infoPanel.hidden;
  }

  // While the SWTOR launcher is open the display stays on; otherwise it turns off
  // DISPLAY_SECONDS after the last press, like the real fob saving its battery.
  let launcherOpen = false;
  function scheduleOff() {
    clearTimeout(offTimer);
    offTimer = launcherOpen ? null : setTimeout(powerOff, DISPLAY_SECONDS * 1000);
  }

  // Turns the display on (or keeps it on) and redraws the code.
  function powerOn() {
    if (!tickTimer) tickTimer = setInterval(refresh, 250);
    lastCounter = null;
    refresh();
    scheduleOff();
  }

  function applySwtorState(state) {
    const wasOpen = launcherOpen;
    launcherOpen = state.launcherOpen && !state.gameRunning;
    if (state.gameRunning) {
      powerOff();
    } else if (launcherOpen && !wasOpen) {
      if (status.attached) powerOn();
    } else if (!launcherOpen && wasOpen && tickTimer) {
      scheduleOff();
    }
  }

  function describeOffset(ms) {
    const s = Math.abs(ms / 1000);
    if (s < 1) return 'PC clock is accurate';
    return `PC clock was ${s.toFixed(1)} s ${ms > 0 ? 'slow' : 'fast'} – corrected`;
  }

  // Button: refresh the display and re-sync with internet time.
  async function pressButton() {
    if (panelsOpen()) return;
    if (!status.attached) {
      showText('-'.repeat(digitEls.length));
      setTimeout(() => { blank(); openPanel(); }, 900);
      return;
    }
    powerOn();
    try {
      const clock = await store.syncTime(true);
      if (clock.error || !clock.syncedAt) {
        toast('Time sync failed – using PC clock', true);
        return;
      }
      clockOffset = clock.offset;
      if (tickTimer) { lastCounter = null; refresh(); }
      toast(`Time synced · ${describeOffset(clock.offset)}`);
    } catch {
      toast('Time sync failed – using PC clock', true);
    }
  }

  // Digits: copy the code (turning the display on first if needed).
  async function copyCode() {
    if (panelsOpen()) return;
    if (!status.attached) { openPanel(); return; }
    const wasOn = !!tickTimer;
    powerOn();
    try {
      const code = await store.copy();
      if (!code) throw new Error('No code to copy');
      if (wasOn) blink();
      toast(`Code ${code.slice(0, 3)} ${code.slice(3)} copied`);
    } catch (err) {
      console.warn('Copy failed:', cleanError(err));
      toast('Copy failed – click again', true);
    }
  }

  // Small notification under the LCD.
  let toastTimer = null;
  function toast(message, isError = false) {
    const t = $('toast');
    t.querySelector('.toast-text').textContent = message;
    t.classList.toggle('error', isError);
    t.classList.remove('show');
    void t.offsetWidth; // restart the animation on repeated presses
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  // ---------- Button feel ----------
  const press = () => button.classList.add('pressed');
  const release = () => button.classList.remove('pressed');
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointerleave', release);
  button.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') press(); });
  button.addEventListener('keyup', release);
  button.addEventListener('click', pressButton);
  lcd.addEventListener('click', copyCode);
  lcd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyCode(); }
  });

  document.addEventListener('keydown', (e) => {
    if (panelsOpen() || e.target === button || e.target === lcd) return;
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      press();
      setTimeout(release, 120);
      pressButton();
    }
  });

  // ---------- Panels ----------
  function closePanels() {
    attachPanel.hidden = true;
    infoPanel.hidden = true;
    $('inSecret').value = '';
  }

  // Panels sit on top of the fob; the display keeps running underneath.
  function openPanel() {
    closePanels();
    if (status.attached) {
      const account = [status.issuer, status.label].filter(Boolean).join(' · ');
      $('infoAccount').textContent = account || 'SWTOR';
      $('infoFormat').textContent = `${status.digits} digits · every ${status.period} s · ${status.algorithm}`;
      $('infoAttached').textContent = status.attachedAt ? new Date(status.attachedAt).toLocaleString() : '';
      $('infoClock').textContent = 'Checking…';
      store.timeStatus().then((c) => {
        $('infoClock').textContent = c.syncedAt
          ? `Synced via ${c.source} at ${new Date(c.syncedAt).toLocaleTimeString()} · ${describeOffset(c.offset).replace(' – corrected', '')}`
          : `Not synced${c.error ? ' (' + c.error + ')' : ''} – using PC clock`;
      }).catch(() => { $('infoClock').textContent = 'Unknown'; });
      $('removeWarning').hidden = true;
      $('btnRemove').classList.remove('confirm');
      $('btnRemove').textContent = 'Remove key';
      infoPanel.hidden = false;
    } else {
      $('attachError').textContent = '';
      attachPanel.hidden = false;
    }
  }

  // The key changed (attached, removed or loaded at startup): start from a blank display.
  async function applyStatus(next) {
    powerOff();
    status = next;
    buildLcd(status.attached ? status.digits : TOTP.SWTOR.digits);
    blank();
  }

  async function attach(input) {
    try {
      await applyStatus(await store.attach(input));
      closePanels();
      pressButton();
    } catch (err) {
      $('attachError').textContent = cleanError(err);
    }
  }

  // Reads a QR code from an image (a screenshot of the swtor.com setup page).
  async function attachFromImage(blob) {
    $('attachError').textContent = 'Reading QR code…';
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (!qr) throw new Error('No QR code found in that image');
      await attach(qr.data);
    } catch (err) {
      $('attachError').textContent = cleanError(err);
    }
  }

  attachPanel.addEventListener('submit', (e) => {
    e.preventDefault();
    attach($('inSecret').value);
  });
  $('qrFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) attachFromImage(file);
  });
  document.addEventListener('paste', (e) => {
    if (attachPanel.hidden) return;
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      attachFromImage(item.getAsFile());
    }
  });
  attachPanel.addEventListener('dragover', (e) => { e.preventDefault(); attachPanel.classList.add('dragover'); });
  attachPanel.addEventListener('dragleave', () => attachPanel.classList.remove('dragover'));
  attachPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    attachPanel.classList.remove('dragover');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) attachFromImage(file);
  });

  // Removal needs a second click to confirm.
  $('btnRemove').addEventListener('click', async () => {
    const btn = $('btnRemove');
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.textContent = 'Confirm remove';
      $('removeWarning').hidden = false;
      return;
    }
    await applyStatus(await store.remove());
    openPanel();
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
  $('btnInfo').addEventListener('click', openPanel);
  $('btnMin').addEventListener('click', () => host?.minimize());
  $('btnClose').addEventListener('click', () => host?.close());

  // ---------- Boot ----------
  store.status()
    .catch(() => ({ attached: false }))
    .then(applyStatus)
    .then(() => store.swtorState())
    .then(applySwtorState)
    .catch(() => {});
  // Pick up the network-time offset once the startup sync finishes.
  const pollClock = (tries) => store.timeStatus().then((c) => {
    if (c.syncedAt) clockOffset = c.offset;
    else if (tries > 0) setTimeout(() => pollClock(tries - 1), 1000);
  }).catch(() => {});
  pollClock(10);

  store.onSwtorState(applySwtorState);
  // Hidden to the tray or minimized: back to the off state, like putting the fob away.
  // Shown again while the launcher is open: switch back on.
  store.onVisibility((visible) => {
    if (!visible) powerOff({ keepClipboard: true });
    else if (launcherOpen && status.attached) powerOn();
  });
})();