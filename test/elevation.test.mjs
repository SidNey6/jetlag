// Vorgebaute Geländehöhen: PNG lesen, Terrarium-Kodierung, Raster bauen und zuschneiden
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, terrariumHeight, buildGrid, gridShape } from '../scripts/region/elevation.mjs';
import { cropGrid, sampleGrid } from '../js/geo.js';

// Kleiner PNG-Schreiber mit wählbarem Filter je Zeile – der Leser muss alle fünf können
function encodePng(width, height, channels, data, filters) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = data[y * stride + i];
      const a = i >= channels ? data[y * stride + i - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);   // CRC prüft der Leser nicht
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG: alle Zeilenfilter, RGB und RGBA', () => {
  for (const channels of [3, 4]) {
    const w = 7, h = 10;
    const data = new Uint8Array(w * h * channels).map((_, i) => (i * 37 + (i >> 3) * 11) & 255);
    const png = decodePng(encodePng(w, h, channels, data, [0, 1, 2, 3, 4]));
    assert.equal(png.width, w);
    assert.equal(png.channels, channels);
    assert.deepEqual([...png.data], [...data]);
  }
});

test('Terrarium-Kodierung', () => {
  assert.equal(terrariumHeight(128, 0, 0), 0);
  assert.equal(terrariumHeight(128, 60, 128), 60.5);
  assert.equal(terrariumHeight(127, 255, 0), -1);
});

// Gelände als Ebene über den Weltpixeln: bilinear muss sie exakt treffen
test('Raster aus Kacheln: Werte stimmen zwischen Pixelmitten und über Kachelgrenzen', async () => {
  const z = 12;
  const hoehe = (px, py) => 50 + (px % 1000) * 0.02 + (py % 1000) * 0.01;
  const getTile = async (tx, ty) => {
    const data = new Uint8Array(256 * 256 * 3);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const v = hoehe(tx * 256 + x, ty * 256 + y) + 32768;
        const o = (y * 256 + x) * 3;
        data[o] = Math.floor(v / 256); data[o + 1] = Math.floor(v) % 256; data[o + 2] = Math.round((v % 1) * 256);
      }
    }
    return { width: 256, height: 256, channels: 3, data };
  };
  const bounds = { south: 50.70, north: 50.72, west: 7.08, east: 7.11 };
  const grid = await buildGrid(bounds, getTile, { zoom: z, stepM: 200 });
  assert.deepEqual({ rows: grid.rows, cols: grid.cols }, gridShape(bounds, 200));
  const wx = (lng) => ((lng + 180) / 360) * 2 ** z * 256;
  const wy = (lat) => { const r = lat * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256; };
  for (const [r, c] of [[0, 0], [3, 5], [grid.rows - 1, grid.cols - 1]]) {
    const lat = bounds.south + (r / (grid.rows - 1)) * (bounds.north - bounds.south);
    const lng = bounds.west + (c / (grid.cols - 1)) * (bounds.east - bounds.west);
    const soll = 50 + ((wx(lng) - 0.5) % 1000) * 0.02 + ((wy(lat) - 0.5) % 1000) * 0.01;
    assert.ok(Math.abs(grid.v[r * grid.cols + c] * grid.scale - soll) < 0.15, `${r}/${c}: ${grid.v[r * grid.cols + c] / 10} statt ${soll}`);
  }
});

test('Ausschnitt: gedeckelt, Werte wie im großen Raster', () => {
  const gross = { south: 50, north: 51, west: 7, east: 8, rows: 301, cols: 301, values: [] };
  for (let r = 0; r < 301; r++) for (let c = 0; c < 301; c++) gross.values.push(r * 2 + c);
  const b = { south: 50.2, north: 50.6, west: 7.1, east: 7.3 };
  const klein = cropGrid(gross, b, 40);
  assert.equal(klein.rows, 40);
  assert.equal(klein.cols, 40);
  for (const p of [{ lat: 50.25, lng: 7.15 }, { lat: 50.6, lng: 7.3 }, { lat: 50.41, lng: 7.22 }]) {
    assert.ok(Math.abs(sampleGrid(klein, p) - sampleGrid(gross, p)) < 0.2);
  }
  // kleiner Ausschnitt behält die Maschenweite des großen Rasters
  const fein = cropGrid(gross, { south: 50.2, north: 50.22, west: 7.1, east: 7.11 }, 40);
  assert.deepEqual([fein.rows, fein.cols], [7, 4]);
  assert.equal(cropGrid(gross, { south: 52, north: 53, west: 7, east: 8 }), null);
});
