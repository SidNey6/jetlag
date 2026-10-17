#!/usr/bin/env node
// Liegt jede Region vollständig in ihren Geofabrik-Auszügen? Fehlt ein Stück (Nachbarland,
// anderes Bundesland), hielte die App dort "nichts in der Nähe" für sicher und beantwortete
// Fragen wie "nächster Bahnhof" falsch. Geprüft wird ein Punktraster über den Rahmen gegen
// die Umrisse der Auszüge (Geofabrik veröffentlicht sie als .poly neben jeder Datei).
//
//   node scripts/region/coverage.mjs [region …]

import { REGIONS } from './regions.mjs';

// .poly: Name, dann Abschnitte (Ringe, "!" = Loch), je mit END abgeschlossen
export function parsePoly(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rings = [];
  let i = 1;
  while (i < lines.length && lines[i] !== 'END') {
    const hole = lines[i].startsWith('!');
    i++;
    const pts = [];
    while (lines[i] !== 'END') {
      const [lng, lat] = lines[i].split(/\s+/).map(Number);
      pts.push([lng, lat]);
      i++;
    }
    rings.push({ hole, pts });
    i++;
  }
  return rings;
}

function inRing(pts, lng, lat) {
  let inside = false;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [xa, ya] = pts[a], [xb, yb] = pts[b];
    if ((ya > lat) !== (yb > lat) && lng < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

export function inPoly(rings, lng, lat) {
  let drin = false;
  for (const r of rings) {
    if (inRing(r.pts, lng, lat)) drin = !r.hole ? true : false;
  }
  return drin;
}

// Anteil und Lage der Rasterpunkte, die kein Auszug abdeckt
export function uncovered(bounds, polys, steps = 60) {
  const fehlt = [];
  for (let r = 0; r <= steps; r++) {
    const lat = bounds.south + (r / steps) * (bounds.north - bounds.south);
    for (let c = 0; c <= steps; c++) {
      const lng = bounds.west + (c / steps) * (bounds.east - bounds.west);
      if (!polys.some((p) => inPoly(p, lng, lat))) fehlt.push([+lat.toFixed(4), +lng.toFixed(4)]);
    }
  }
  return { anteil: fehlt.length / (steps + 1) ** 2, punkte: fehlt };
}

const polyCache = new Map();
async function loadPoly(url) {
  const polyUrl = url.replace(/-latest\.osm\.pbf$/, '.poly');
  if (!polyCache.has(polyUrl)) {
    const res = await fetch(polyUrl);
    if (!res.ok) throw new Error(`${polyUrl}: HTTP ${res.status}`);
    polyCache.set(polyUrl, parsePoly(await res.text()));
  }
  return polyCache.get(polyUrl);
}

async function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REGIONS);
  let schlecht = 0;
  for (const id of ids) {
    const r = REGIONS[id];
    const polys = await Promise.all(r.sources.map(loadPoly));
    const a = uncovered(r.bounds, polys);
    const s = uncovered(r.streets, polys);
    const ok = a.anteil === 0 && s.anteil === 0;
    if (!ok) schlecht++;
    const ecken = (u) => {
      if (!u.punkte.length) return '';
      const lat = u.punkte.map((p) => p[0]), lng = u.punkte.map((p) => p[1]);
      return ` (${Math.min(...lat)}–${Math.max(...lat)} N, ${Math.min(...lng)}–${Math.max(...lng)} O)`;
    };
    console.log(`${ok ? 'ok  ' : 'LÜCKE'} ${id.padEnd(12)} Rahmen ${(a.anteil * 100).toFixed(1)} %${ecken(a)}, Straßen ${(s.anteil * 100).toFixed(1)} %${ecken(s)}`);
  }
  if (schlecht) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
