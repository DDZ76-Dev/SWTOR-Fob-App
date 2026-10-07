// Measures how far the PC clock is from real time, so codes stay valid even if Windows time drifts.
// Tries SNTP (UDP 123) first, then falls back to the Date header of an HTTPS response.
const dgram = require('dgram');
const https = require('https');

const NTP_SERVERS = ['time.windows.com', 'time.google.com', 'pool.ntp.org'];
const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900 and 1970

function readNtpTime(buf, offset) {
  const seconds = buf.readUInt32BE(offset) - NTP_EPOCH_OFFSET;
  const fraction = buf.readUInt32BE(offset + 4) / 2 ** 32;
  return (seconds + fraction) * 1000;
}

function sntp(host, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI 0, version 3, client mode
    let t1;
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${host} timed out`)); }, timeoutMs);
    socket.once('error', (err) => { clearTimeout(timer); socket.close(); reject(err); });
    socket.once('message', (msg) => {
      const t4 = Date.now();
      clearTimeout(timer);
      socket.close();
      if (msg.length < 48 || (msg[1] === 0)) return reject(new Error(`${host} sent an invalid reply`));
      const t2 = readNtpTime(msg, 32); // server receive
      const t3 = readNtpTime(msg, 40); // server transmit
      // Standard NTP offset: average of the two one-way differences.
      resolve({ offset: ((t2 - t1) + (t3 - t4)) / 2, source: host });
    });
    t1 = Date.now();
    socket.send(packet, 123, host);
  });
}

function httpDate(url = 'https://www.cloudflare.com/', timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const t1 = Date.now();
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const t4 = Date.now();
      res.resume();
      const date = Date.parse(res.headers.date);
      if (Number.isNaN(date)) return reject(new Error('No Date header'));
      // The header has 1 s resolution; assume the middle of that second.
      resolve({ offset: date + 500 - (t1 + t4) / 2, source: new URL(url).host });
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS time check timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function measureOffset() {
  for (const host of NTP_SERVERS) {
    try { return await sntp(host); } catch { /* try the next one */ }
  }
  return httpDate();
}

module.exports = { measureOffset };
