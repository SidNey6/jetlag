// Regionskarte: PMTiles-Kachel-IDs, Verzeichnisse und das Ausschneiden einer Region
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  zxyToTileId, lonToX, latToY, readDirectory, writeDirectory, writeHeader, readHeader,
  openArchive, extract, bufferSource,
} from '../scripts/region/pmtiles.mjs';

test('Kachel-IDs folgen der Hilbert-Kurve aus der Spezifikation', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.equal(zxyToTileId(1, 0, 0), 1);
  assert.equal(zxyToTileId(1, 0, 1), 2);
  assert.equal(zxyToTileId(1, 1, 1), 3);
  assert.equal(zxyToTileId(1, 1, 0), 4);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  // jede ID genau einmal
  const ids = new Set();
  for (let z = 0; z <= 4; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) ids.add(zxyToTileId(z, x, y));
  assert.equal(ids.size, 1 + 4 + 16 + 64 + 256);
  assert.equal(Math.max(...ids), ids.size - 1);
});

test('Verzeichnis: schreiben und lesen, auch mit großen Versätzen', () => {
  const entries = [
    { tileId: 0, runLength: 1, length: 10, offset: 0 },
    { tileId: 1, runLength: 1, length: 20, offset: 10 },
    { tileId: 7, runLength: 3, length: 5, offset: 10 },
    { tileId: 300000, runLength: 1, length: 70000, offset: 2 ** 33 },
  ];
  assert.deepEqual(readDirectory(writeDirectory(entries), 2), entries);
});

// Kleine Weltkarte bis Zoom 4: jede Kachel trägt ihre Koordinaten; das "Meer" (x ≥ Hälfte)
// teilt sich einen Inhalt wie in echten Archiven
function weltArchiv() {
  const tiles = [];
  for (let z = 0; z <= 4; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        const meer = z > 0 && x >= 2 ** (z - 1);
        tiles.push({ tileId: zxyToTileId(z, x, y), body: Buffer.from(meer ? 'meer' : `land ${z}/${x}/${y}`) });
      }
    }
  }
  tiles.sort((a, b) => a.tileId - b.tileId);
  const parts = [];
  const offsets = new Map();
  let pos = 0;
  const entries = tiles.map((t) => {
    const key = t.body.toString();
    if (!offsets.has(key)) { offsets.set(key, pos); parts.push(t.body); pos += t.body.length; }
    return { tileId: t.tileId, runLength: 1, length: t.body.length, offset: offsets.get(key) };
  });
  const root = writeDirectory(entries);
  const meta = gzipSync(Buffer.from(JSON.stringify({ name: 'Testwelt' })));
  const header = writeHeader({
    rootOffset: 127, rootLength: root.length, metadataOffset: 127 + root.length, metadataLength: meta.length,
    leafOffset: 127 + root.length + meta.length, leafLength: 0,
    dataOffset: 127 + root.length + meta.length, dataLength: pos,
    addressedTiles: entries.length, tileEntries: entries.length, tileContents: offsets.size,
    clustered: 1, internalCompression: 2, tileCompression: 1, tileType: 1, minZoom: 0, maxZoom: 4,
    minLon: -180, minLat: -85, maxLon: 180, maxLat: 85, centerZoom: 0, centerLon: 0, centerLat: 0,
  });
  return Buffer.concat([header, root, meta, ...parts]);
}

test('Region ausschneiden: genau die Kacheln im Rahmen, Inhalte unverändert', async () => {
  const welt = weltArchiv();
  const bounds = { south: 40, north: 60, west: -30, east: -5 };
  const res = await extract(bufferSource(welt), bounds, { maxZoom: 3 });
  const neu = await openArchive(bufferSource(res.buffer));
  const quelle = await openArchive(bufferSource(welt));
  assert.equal(neu.header.maxZoom, 3);
  assert.equal(readHeader(res.buffer).minLon, -30);
  assert.equal(neu.metadata.name, 'Jetlag Regionskarte');

  let erwartet = 0;
  for (let z = 0; z <= 4; z++) {
    const xs = [lonToX(bounds.west, z), lonToX(bounds.east, z)];
    const ys = [latToY(bounds.north, z), latToY(bounds.south, z)];
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        const id = zxyToTileId(z, x, y);
        const drin = z <= 3 && x >= xs[0] && x <= xs[1] && y >= ys[0] && y <= ys[1];
        const e = await neu.find(id);
        if (!drin) { assert.equal(e, null, `${z}/${x}/${y} gehört nicht hinein`); continue; }
        erwartet++;
        const q = await quelle.find(id);
        const a = res.buffer.subarray(neu.header.dataOffset + e.offset, neu.header.dataOffset + e.offset + e.length);
        const b = welt.subarray(quelle.header.dataOffset + q.offset, quelle.header.dataOffset + q.offset + q.length);
        assert.equal(a.toString(), b.toString());
      }
    }
  }
  assert.equal(res.tiles, erwartet);
});

test('Gleiche Inhalte liegen im Ausschnitt nur einmal', async () => {
  const welt = weltArchiv();
  // östliche Halbkugel: fast nur "Meer"
  const res = await extract(bufferSource(welt), { south: -60, north: 60, west: 10, east: 170 }, { maxZoom: 4 });
  const h = readHeader(res.buffer);
  assert.ok(h.tileContents < h.tileEntries, `${h.tileContents} Inhalte für ${h.tileEntries} Kacheln`);
});
