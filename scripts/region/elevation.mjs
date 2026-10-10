#!/usr/bin/env node
// Geländehöhen einer Region vorbauen: ein Höhenraster (~100 m Maschenweite) für den ganzen
// Rahmen, gelesen aus den freien "Terrain Tiles" auf AWS (Terrarium-PNG, Mapzen; in Europa
// u. a. aus SRTM und EU-DEM). Damit braucht "näher am Meeresspiegel?" in der Region weder
// den gedrosselten Online-Höhendienst noch Wartezeit.
//
//   node scripts/region/elevation.mjs bonn [--out data]
//
// Läuft nach build.mjs und trägt die Datei als "elevation" in data/regions.json ein.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { REGIONS } from './regions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const ZOOM = 12;          // ~24 m je Pixel bei 50° N – deutlich feiner als das Raster
const STEP_M = 100;       // Maschenweite des Rasters

/* ---------- PNG lesen (8 Bit, RGB oder RGBA, ohne Interlacing) ---------- */

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Kein PNG');
  let p = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`PNG-Format nicht unterstützt (Tiefe ${depth}, Farbe ${color}, Interlace ${interlace})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

// Terrarium: Höhe = R·256 + G + B/256 − 32768
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/* ---------- Raster ---------- */

const worldX = (lng, z) => ((lng + 180) / 360) * 2 ** z * 256;
const worldY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256;
};

export function gridShape(bounds, stepM = STEP_M) {
  const mid = ((bounds.south + bounds.north) / 2) * Math.PI / 180;
  return {
    rows: Math.ceil(((bounds.north - bounds.south) * 111320) / stepM) + 1,
    cols: Math.ceil(((bounds.east - bounds.west) * 111320 * Math.cos(mid)) / stepM) + 1,
  };
}

// getTile(x, y) → Promise<{width, height, channels, data}>; bilinear zwischen Pixelmitten
export async function buildGrid(bounds, getTile, { zoom = ZOOM, stepM = STEP_M } = {}) {
  const { rows, cols } = gridShape(bounds, stepM);
  const x0 = Math.floor(worldX(bounds.west, zoom) / 256) , x1 = Math.floor(worldX(bounds.east, zoom) / 256);
  const y0 = Math.floor(worldY(bounds.north, zoom) / 256), y1 = Math.floor(worldY(bounds.south, zoom) / 256);
  const tiles = new Map();
  const jobs = [];
  for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = y0 - 1; y <= y1 + 1; y++) jobs.push([x, y]);
  // Randkacheln (±1) nur für die Interpolation am Rahmen; acht Abrufe gleichzeitig
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < jobs.length) {
      const [x, y] = jobs[i++];
      tiles.set(`${x}/${y}`, await getTile(x, y));
    }
  }));
  const pixel = (px, py) => {
    const t = tiles.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
    const lx = ((px % 256) + 256) % 256, ly = ((py % 256) + 256) % 256;
    const o = (ly * t.width + lx) * t.channels;
    return terrariumHeight(t.data[o], t.data[o + 1], t.data[o + 2]);
  };
  const values = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = bounds.south + (r / (rows - 1)) * (bounds.north - bounds.south);
    const fy = worldY(lat, zoom) - 0.5;
    const py = Math.floor(fy), ty = fy - py;
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + (c / (cols - 1)) * (bounds.east - bounds.west);
      const fx = worldX(lng, zoom) - 0.5;
      const px = Math.floor(fx), tx = fx - px;
      const h = (pixel(px, py) * (1 - tx) + pixel(px + 1, py) * tx) * (1 - ty)
        + (pixel(px, py + 1) * (1 - tx) + pixel(px + 1, py + 1) * tx) * ty;
      values[r * cols + c] = Math.round(h * 10);   // Dezimeter
    }
  }
  return { ...bounds, rows, cols, scale: 0.1, v: values };
}

async function fetchTile(z, x, y) {
  for (let versuch = 0; versuch < 4; versuch++) {
    try {
      const res = await fetch(TILE_URL(z, x, y), { headers: { 'User-Agent': 'jetlag-toolkit-region-build' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decodePng(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      if (versuch === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (versuch + 1)));
    }
  }
  return null;
}

export async function buildElevation({ region, out, getTile = (x, y) => fetchTile(ZOOM, x, y) }) {
  const t0 = Date.now();
  const grid = await buildGrid(region.bounds, getTile);
  const json = JSON.stringify({ ...grid, source: 'AWS Terrain Tiles (Mapzen; u. a. SRTM, EU-DEM)' });
  writeFileSync(join(out, region.id, 'elevation.json'), json);
  const listPath = join(out, 'regions.json');
  if (!existsSync(listPath)) throw new Error('regions.json fehlt – erst build.mjs laufen lassen');
  const liste = JSON.parse(readFileSync(listPath, 'utf8'));
  const eintrag = liste.regions.find((r) => r.id === region.id);
  if (!eintrag) throw new Error(`Region ${region.id} fehlt in regions.json`);
  eintrag.files.elevation = Buffer.byteLength(json);
  if (Array.isArray(eintrag.empty)) eintrag.empty = eintrag.empty.filter((p) => p !== 'elevation');
  writeFileSync(listPath, JSON.stringify(liste));
  const min = grid.v.reduce((m, x) => Math.min(m, x), Infinity) / 10;
  const max = grid.v.reduce((m, x) => Math.max(m, x), -Infinity) / 10;
  console.log(`Höhen ${region.name}: ${grid.cols}×${grid.rows} Punkte, ${min.toFixed(0)}–${max.toFixed(0)} m, `
    + `${(Buffer.byteLength(json) / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return grid;
}

async function main() {
  const a = process.argv.slice(2);
  const id = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--out');
  const out = a.includes('--out') ? a[a.indexOf('--out') + 1] : join(ROOT, 'data');
  if (!REGIONS[id]) {
    console.error(`Aufruf: elevation.mjs <${Object.keys(REGIONS).join('|')}> [--out data]`);
    process.exit(1);
  }
  await buildElevation({ region: REGIONS[id], out });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
