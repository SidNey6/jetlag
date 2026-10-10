#!/usr/bin/env node
// Kartenbild einer Region vorbauen: schneidet aus der täglich gebauten Protomaps-Weltkarte
// (Vektorkacheln aus OpenStreetMap-Daten) den Rahmen der Region heraus und legt ihn als
// data/<region>/map.pmtiles ab. Die App zeigt dann diese Karte statt Kachel für Kachel
// von tile.openstreetmap.org zu laden – und kann sie in einem Stück offline speichern.
//
//   node scripts/region/basemap.mjs bonn [--out data] [--maxzoom 14]
//
// Läuft nach build.mjs (das data/<region>/ neu anlegt) und trägt die Karte in
// data/regions.json ein. Gelesen werden nur die nötigen Bytebereiche der Weltkarte.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REGIONS } from './regions.mjs';
import { extract, httpSource } from './pmtiles.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDS = 'https://build-metadata.protomaps.dev/builds.json';
const BUILD_URL = (key) => `https://build.protomaps.com/${key}`;

export async function buildBasemap({ region, out, maxZoom = 14, source = null, buildKey = null }) {
  let key = buildKey;
  if (!source) {
    if (!key) {
      const builds = await (await fetch(BUILDS)).json();
      key = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().pop();
    }
    source = httpSource(BUILD_URL(key));
  }
  const t0 = Date.now();
  const res = await extract(source, region.bounds, {
    maxZoom,
    onProgress: (done, total) => process.stdout.write(`\r  Kacheldaten ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`),
  });
  process.stdout.write('\n');
  const dir = join(out, region.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'map.pmtiles'), res.buffer);

  const version = createHash('sha256').update(res.buffer).digest('hex').slice(0, 12);
  const listPath = join(out, 'regions.json');
  const liste = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : { regions: [] };
  const eintrag = liste.regions.find((r) => r.id === region.id);
  if (!eintrag) throw new Error(`Region ${region.id} fehlt in regions.json – erst build.mjs laufen lassen`);
  eintrag.map = {
    file: 'map.pmtiles', bytes: res.buffer.length, version, maxZoom: res.header.maxZoom,
    tiles: res.tiles, source: key ? `Protomaps ${key.replace('.pmtiles', '')}` : 'Protomaps',
  };
  writeFileSync(listPath, JSON.stringify(liste));
  console.log(`Karte ${region.name}: ${res.tiles} Kacheln, ${(res.buffer.length / 1048576).toFixed(1)} MB, `
    + `Zoom bis ${res.header.maxZoom}, ${((Date.now() - t0) / 1000).toFixed(0)} s, Version ${version}`);
  return eintrag.map;
}

async function main() {
  const a = process.argv.slice(2);
  const id = a.find((x) => !x.startsWith('--') && !/^\d+$/.test(x) && a[a.indexOf(x) - 1] !== '--out');
  const out = a.includes('--out') ? a[a.indexOf('--out') + 1] : join(ROOT, 'data');
  const maxZoom = a.includes('--maxzoom') ? parseInt(a[a.indexOf('--maxzoom') + 1], 10) : 14;
  if (!REGIONS[id]) {
    console.error(`Aufruf: basemap.mjs <${Object.keys(REGIONS).join('|')}> [--out data] [--maxzoom 14]`);
    process.exit(1);
  }
  await buildBasemap({ region: REGIONS[id], out, maxZoom });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
