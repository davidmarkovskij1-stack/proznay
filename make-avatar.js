// Генератор аватара «Прознай»: PNG 512×512, градиент + глаз.
'use strict';
const zlib = require('zlib');
const fs = require('fs');

const S = 512, SCALE = S / 76, CX = 38 * SCALE, CY = 38 * SCALE;
const RX = 20.5 * SCALE, RY_TOP = 42.5 * SCALE, RY_BOT = 33.5 * SCALE;
const PR = 7 * SCALE; // радиус зрачка
const OUT = 2.5 * SCALE; // толщина обводки

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function roundRectAlpha(x, y, r) {
  const cx = x < r ? r : x > S - r ? S - r : x;
  const cy = y < r ? r : y > S - r ? S - r : y;
  const d = Math.hypot(x - cx, y - cy);
  if (d <= r - 1) return 255;
  if (d >= r + 1) return 0;
  return Math.round(255 * (r + 1 - d) / 2);
}

const raw = Buffer.alloc(S * (1 + S * 4));
const R = S * 0.3125; // радиус скругления
for (let y = 0; y < S; y++) {
  const rowStart = y * (1 + S * 4);
  raw[rowStart] = 0; // filter none
  for (let x = 0; x < S; x++) {
    const i = rowStart + 1 + x * 4;
    const bg = roundRectAlpha(x, y, R);
    const t = (x + y) / (2 * S);
    let r = Math.round(124 + (255 - 124) * t);
    let g = Math.round(92 + (110 - 92) * t);
    let b = Math.round(255 + (199 - 255) * t);
    let a = bg;

    // глаз: расстояние до верхней и нижней дуг
    const dx = x - CX;
    if (Math.abs(dx) <= RX) {
      const sq = Math.sqrt(RX * RX - dx * dx);
      const yUp = RY_TOP - sq, yBot = RY_BOT + sq;
      if (y >= yUp && y <= yBot) {
        const dist = Math.min(y - yUp, yBot - y);
        if (Math.abs(dist - OUT / 2) <= OUT / 2 + 0.75) {
          const k = Math.max(0, Math.min(1, OUT / 2 + 0.75 - Math.abs(dist - OUT / 2)));
          r = g = b = 255; a = Math.max(a, Math.round(255 * Math.min(1, k + 0.35)));
        }
      }
      // зрачок
      const pd = Math.hypot(dx, y - CY);
      if (pd <= PR) { r = g = b = 255; a = 255; }
      else if (pd <= PR + 1) { r = g = b = 255; a = Math.max(a, Math.round(255 * (PR + 1 - pd))); }
    }

    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(__dirname + '/bot-avatar.png', png);
console.log('avatar written:', png.length, 'bytes');
