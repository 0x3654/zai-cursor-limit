// Generates icon.png: dark rounded badge, green pixel text "[:]" / "42%".
// Zero dependencies (node core zlib only) — run in a container:
//   docker run --rm -v "$PWD":/src -w /src node:22-alpine node scripts/make_icon.js
'use strict';

const zlib = require('zlib');
const fs = require('fs');

const SIZE = 128;
const BADGE = '#202124';
const TEXT = '#53C679'; // robot-text green (dark-theme palette)
const RADIUS = 26;

// 5x7 pixel glyphs (rows of '1'/'0').
const GLYPHS = {
  '[': ['01110', '10000', '10000', '10000', '10000', '10000', '01110'],
  ']': ['01110', '00001', '00001', '00001', '00001', '00001', '01110'],
  ':': ['00000', '00000', '01100', '01100', '00000', '01100', '01100'],
  '4': ['10001', '10001', '10001', '11111', '00001', '00001', '00001'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
};

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// RGBA canvas.
const px = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return;
  }
  const i = (y * SIZE + x) * 4;
  px[i] = rgb[0];
  px[i + 1] = rgb[1];
  px[i + 2] = rgb[2];
  px[i + 3] = a;
}

// Rounded-square badge.
const badge = hexRgb(BADGE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.max(RADIUS, Math.min(SIZE - 1 - RADIUS, x));
    const cy = Math.max(RADIUS, Math.min(SIZE - 1 - RADIUS, y));
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
    if (inside) {
      put(x, y, badge);
    }
  }
}

// Draws one line of 5x7 glyphs, pixel scale `s`, top-left at (left, top).
function drawLine(text, left, top, s) {
  const rgb = hexRgb(TEXT);
  for (let gi = 0; gi < text.length; gi++) {
    const g = GLYPHS[text[gi]];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] === '1') {
          for (let sy = 0; sy < s; sy++) {
            for (let sx = 0; sx < s; sx++) {
              put(left + gi * 6 * s + gx * s + sx, top + gy * s + sy, rgb);
            }
          }
        }
      }
    }
  }
}

// Two lines, glyph scale 5: "[:]" and "42%", both 17px wide → 85px.
const S = 5;
drawLine('[:]', Math.round((SIZE - 17 * S) / 2), 24, S);
drawLine('42%', Math.round((SIZE - 17 * S) / 2), 24 + 7 * S + 10, S);

// --- minimal PNG writer (RGBA, filter 0) ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('icon.png', png);
console.log(`icon.png written: ${SIZE}x${SIZE}, ${png.length} bytes`);
