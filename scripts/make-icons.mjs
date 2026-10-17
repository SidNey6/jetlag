// Erzeugt die App-Icons als PNG – ohne Bildbibliothek, damit das Repo
// ohne Installationsschritt baubar bleibt. Aufruf: node scripts/make-icons.mjs
// Mit --android legt es zusätzlich die Symbole der Android-App an (native/android).
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
const BG = [18, 19, 22];
const ACCENT = [77, 141, 245];
const HOT = [252, 90, 28];
const DOT = [237, 237, 239];

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

// transparent: nur das Motiv (Vordergrund adaptiver Android-Symbole); round: runde Maske
function render(size, { contentScale = 1, transparent = false, round = false } = {}) {
  const ss = 3; // 3x3-Supersampling gegen Treppenkanten
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          if (round && Math.hypot(u - 0.5, v - 0.5) > 0.5) continue;
          const c = scene(u, v, contentScale) || (transparent ? null : BG);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      // Farbe über die gedeckten Teilpunkte mitteln, Deckkraft über alle
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
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

// Android: klassische und runde Symbole je Dichte, dazu der Vordergrund adaptiver Symbole
// (108 dp, sichtbar sind nur die inneren 66 dp – daher das kleinere Motiv)
if (process.argv.includes('--android')) {
  const RES = join(OUT, '..', '..', 'native', 'android', 'app', 'src', 'main', 'res');
  const DICHTEN = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, f] of Object.entries(DICHTEN)) {
    const dir = join(RES, `mipmap-${d}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ic_launcher.png'), render(Math.round(48 * f), { contentScale: 0.86 }));
    writeFileSync(join(dir, 'ic_launcher_round.png'), render(Math.round(48 * f), { contentScale: 0.8, round: true }));
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), render(Math.round(108 * f), { contentScale: 0.6, transparent: true }));
  }
  const hex = '#' + BG.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  writeFileSync(join(RES, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex}</color>\n</resources>\n`);
  console.log('Android-Symbole geschrieben');
}
