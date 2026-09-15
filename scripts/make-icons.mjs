// Erzeugt die App-Icons als PNG – ohne Bildbibliothek, damit das Repo
// ohne Installationsschritt baubar bleibt. Aufruf: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');

/* ---------- PNG ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // Filter "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Motiv ---------- */
// Radarringe mit hellem Mittelpunkt und einer Trennlinie – genau das, was die App tut.
const BG = [15, 23, 48];
const ACCENT = [56, 189, 248];
const HOT = [249, 115, 22];
const DOT = [232, 240, 254];

function scene(u, v, scale) {
  // u,v in [0,1]; scale schrumpft den Inhalt für maskierbare Icons
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;
  const r = Math.hypot(x, y);

  for (const ring of [0.17, 0.28, 0.39]) {
    if (Math.abs(r - ring) < 0.021) return ACCENT;
  }
  if (r < 0.075) return DOT;

  const a = (-28 * Math.PI) / 180;
  const d = Math.abs(x * Math.sin(a) + y * Math.cos(a));
  if (d < 0.021 && r < 0.46) return HOT;

  return null;
}

function render(size, { contentScale = 1 } = {}) {
  const ss = 3; // 3x3-Supersampling gegen Treppenkanten
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          const c = scene(u, v, contentScale) || BG;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  // maskierbar: Inhalt bleibt im sicheren Kreis, den Android-Launcher ausschneiden
  ['icon-maskable-512.png', render(512, { contentScale: 0.68 })],
  ['apple-touch-icon.png', render(180)],
  ['favicon.png', render(64)],
];
for (const [name, data] of files) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name}  ${(data.length / 1024).toFixed(1)} kB`);
}
