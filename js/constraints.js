// Fragetypen. Jeder Constraint kann zweierlei:
//   allows(c, p)  – analytisch prüfen, ob ein Punkt noch in Frage kommt
//   shapes(c)     – die auszuschließende Fläche als Zeichengeometrie liefern
// Statistik und Zufallspunkte laufen über allows(), nicht über die Pixel der Maske —
// dadurch sind sie unabhängig von Zoom und Bildausschnitt.

import { distance, bearing, circle, sector, bisector, pointInPolygon, formatDistance, distanceToFeatures, distanceToRing, sampleGrid } from './geo.js';

export const TYPES = {
  radius:  { label: 'Radius',        icon: '◎', color: '#38bdf8' },
  thermo:  { label: 'Thermometer',   icon: '🌡', color: '#f97316' },
  compare: { label: 'Vergleich',     icon: '⇄', color: '#a78bfa' },
  area:    { label: 'Gebiet',        icon: '▱', color: '#34d399' },
  nearest: { label: 'Nächster Ort',  icon: '⌖', color: '#fbbf24' },
  sector:  { label: 'Richtung',      icon: '∡', color: '#f472b6' },
  elevation: { label: 'Höhe',        icon: '⛰', color: '#22d3ee' },
};

// Antworten der Seite "A" – drin, wärmer, näher, ja. Die Gegenseite ist jeweils B.
export const A_ANSWERS = new Set(['inside', 'warmer', 'closer', 'yes']);

// Einheitliches Grenzfall-Modell für alle Fragetypen:
// s ist ein vorzeichenbehafteter Abstand zur Grenze in Metern (s > 0: Antwort A).
// Liegt ein Punkt innerhalb der Toleranz, gilt die Grenzfall-Regel des Regelwerks
// (tieBreak), z. B. "Radius: drin". Wer dort steht, hätte also so geantwortet –
// deshalb gehört das Toleranzband zur Seite der Grenzfall-Antwort.
function sideA(c, s, zeroIsA) {
  const tol = c.tieToleranceM || 0;
  if (c.tieBreak && Math.abs(s) <= tol) return A_ANSWERS.has(c.tieBreak);
  if (s === 0) return c.tieBreak ? A_ANSWERS.has(c.tieBreak) : zeroIsA;
  return s > 0;
}

const BISECTOR_HALF_LENGTH = 250000; // m – deckt jeden realistischen Bildausschnitt ab
const BISECTOR_SAMPLES = 49;

export function allows(c, p) {
  switch (c.type) {
    case 'radius': {
      const s = c.radius - distance(p, c.center);
      return sideA(c, s, true) === !!c.inside;
    }
    case 'thermo': {
      // "wärmer" = der gesuchte Punkt liegt näher am Endpunkt der Bewegung
      const s = distance(p, c.from) - distance(p, c.to);
      return sideA(c, s, false) === !!c.warmer;
    }
    case 'compare': {
      const s = compareDistance(c) - refDistance(c, p);
      return sideA(c, s, false) === !!c.closer;
    }
    case 'area': {
      const inside = pointInPolygon(p, c.ring);
      // Den Randabstand nur rechnen, wenn eine Toleranz ihn überhaupt braucht
      const s = c.tieBreak && c.tieToleranceM > 0
        ? (inside ? 1 : -1) * distanceToRing(p, c.ring)
        : (inside ? 1 : -1);
      return sideA(c, s, true) === !!c.inside;
    }
    case 'nearest':
      return nearestAllows(c, p);
    case 'elevation': {
      const h = sampleGrid(c.grid, p);
      if (h == null) return true; // keine Höhe bekannt: nicht ausschließen
      // "näher am Meeresspiegel" = geringerer Betrag der Höhe
      const s = Math.abs(c.myElevation) - Math.abs(h);
      return sideA(c, s, false) === !!c.closer;
    }
    case 'sector': {
      if (c.radius && distance(p, c.center) > c.radius) return !c.inside;
      const b = bearing(c.center, p);
      const span = (c.to - c.from + 360) % 360;
      const rel = (b - c.from + 360) % 360;
      const inside = span === 0 ? true : rel <= span;
      return c.inside ? inside : !inside;
    }
    default:
      return true;
  }
}

// "Ist dein nächstes X dasselbe wie meines?" – X als Punkte (pois) oder als Objekte
// mit Geometrie (candidates: Linien, Flächen). invert = Antwort "nein".
function nearestAllows(c, p) {
  const yes = !c.invert;

  if (c.candidates) {
    const chosen = c.candidates.find((x) => x.id === c.chosenId);
    if (!chosen) return true;
    const dChosen = distanceToFeatures(p, chosen.features);
    // Andere Kandidaten nur so genau rechnen, wie es für die Entscheidung nötig ist
    const limit = dChosen + (c.tieToleranceM || 0) + 1e-6;
    let dOther = Infinity;
    for (const cand of c.candidates) {
      if (cand.id === c.chosenId) continue;
      const d = distanceToFeatures(p, cand.features, Math.min(limit, dOther));
      if (d < dOther) dOther = d;
    }
    return sideA(c, dOther - dChosen, true) === yes;
  }

  if (!c.pois || !c.pois.length) return true;
  // Quadrierte lokale Abstände genügen fürs Argmin und sparen die Trigonometrie
  const mLat = 111319.49;
  const mLng = mLat * Math.cos(p.lat * Math.PI / 180);
  let dChosen2 = Infinity, dOther2 = Infinity;
  for (const o of c.pois) {
    const dx = (o.lng - p.lng) * mLng, dy = (o.lat - p.lat) * mLat;
    const d2 = dx * dx + dy * dy;
    if (o.id === c.chosenId) dChosen2 = d2;
    else if (d2 < dOther2) dOther2 = d2;
  }
  if (dChosen2 === Infinity) return true;
  const s = Math.sqrt(dOther2) - Math.sqrt(dChosen2);
  return sideA(c, s, true) === yes;
}

/* ---------- Raster für Fragen ohne geschlossene Form ---------- */

// Linien-Voronoi ("nächste Buslinie") und Höhenlinien haben keine einfache Kontur.
// Solche Constraints werden einmal auf ein Raster über dem Spielgebiet ausgewertet;
// das Raster wird gecacht, Schwenken und Zoomen kosten danach nichts mehr.
const rasterCache = new WeakMap();

export function needsRaster(c) {
  return c.type === 'elevation' || (c.type === 'nearest' && !!c.candidates);
}

export function rasterFor(c, bounds, cols = 100) {
  const key = `${bounds.south.toFixed(5)},${bounds.west.toFixed(5)},${bounds.north.toFixed(5)},${bounds.east.toFixed(5)},${cols}`;
  const hit = rasterCache.get(c);
  if (hit && hit.key === key) return hit.raster;

  const mid = (bounds.south + bounds.north) / 2;
  const breite = distance({ lat: mid, lng: bounds.west }, { lat: mid, lng: bounds.east });
  const hoehe = distance({ lat: bounds.south, lng: bounds.west }, { lat: bounds.north, lng: bounds.west });
  const rows = Math.max(10, Math.min(260, Math.round(cols * hoehe / Math.max(1, breite))));
  const dLat = (bounds.north - bounds.south) / rows;
  const dLng = (bounds.east - bounds.west) / cols;
  const bits = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = bounds.south + (r + 0.5) * dLat;
    for (let k = 0; k < cols; k++) {
      bits[r * cols + k] = allows(c, { lat, lng: bounds.west + (k + 0.5) * dLng }) ? 0 : 1;
    }
  }
  const raster = { ...bounds, rows, cols, bits };
  rasterCache.set(c, { key, raster });
  return raster;
}

function fallbackBounds(c) {
  if (c.type === 'elevation' && c.grid) {
    return { south: c.grid.south, north: c.grid.north, west: c.grid.west, east: c.grid.east };
  }
  const p = c.myPoint;
  if (!p) return null;
  const dLat = 15000 / 111320, dLng = 15000 / (111320 * Math.cos(p.lat * Math.PI / 180));
  return { south: p.lat - dLat, north: p.lat + dLat, west: p.lng - dLng, east: p.lng + dLng };
}

// Abstand zum Bezugsobjekt: bei ausgedehnten Objekten (Autobahn, Küste, Grenze, Park)
// zählt der nächstgelegene Punkt des Objekts, nicht irgendein Mittelpunkt.
export function refDistance(c, p) {
  if (c.features && c.features.length) return distanceToFeatures(p, c.features);
  return c.ref ? distance(p, c.ref) : Infinity;
}

export function compareDistance(c) {
  if (c.myDistance != null) return c.myDistance;
  return c.myPoint ? refDistance(c, c.myPoint) : Infinity;
}

// Formen der AUSZUSCHLIESSENDEN Fläche.
//   {kind:'ring', ring, exclude:'inside'|'outside'}
//   {kind:'halfplane', line, excludeRef}  – excludeRef liegt auf der wegfallenden Seite
export function shapes(c, ctx = {}) {
  if (needsRaster(c)) {
    const b = ctx.bounds || fallbackBounds(c);
    return b ? [{ kind: 'raster', raster: rasterFor(c, b, ctx.cols || 100) }] : [];
  }
  switch (c.type) {
    case 'radius':
      return [{ kind: 'ring', ring: circle(c.center, c.radius), exclude: c.inside ? 'outside' : 'inside' }];
    case 'compare': {
      const r = compareDistance(c);
      // Um eine Linie oder Fläche herum ist die Grenze kein Kreis, sondern eine
      // Parallelkurve im Abstand r – gezeichnet als verbreiterte Geometrie.
      if (c.features && c.features.length) {
        return [{ kind: 'buffer', radiusM: r, features: c.features, exclude: c.closer ? 'outside' : 'inside' }];
      }
      return [{ kind: 'ring', ring: circle(c.ref, r), exclude: c.closer ? 'outside' : 'inside' }];
    }
    case 'thermo':
      return [{
        kind: 'halfplane',
        line: bisector(c.from, c.to, BISECTOR_HALF_LENGTH, BISECTOR_SAMPLES),
        excludeRef: c.warmer ? c.from : c.to,
      }];
    case 'area':
      return [{ kind: 'ring', ring: c.ring, exclude: c.inside ? 'outside' : 'inside' }];
    case 'nearest': {
      const chosen = c.pois.find((x) => x.id === c.chosenId);
      if (!chosen) return [];
      const parts = c.pois
        .filter((o) => o.id !== c.chosenId)
        .map((o) => ({
          line: bisector(chosen, o, BISECTOR_HALF_LENGTH, BISECTOR_SAMPLES),
          excludeRef: o,
        }));
      // Normalfall: die Umgebung jedes anderen Ortes fällt weg – eine Vereinigung.
      // Umgekehrt fällt nur die Zelle des genannten Ortes weg; das ist ein Schnitt
      // von Halbebenen und wird als "alles füllen, Gegenseiten ausstanzen" gezeichnet.
      if (!c.invert) return parts.map((p) => ({ kind: 'halfplane', ...p }));
      return parts.length ? [{ kind: 'cutout', parts }] : [];
    }
    case 'sector': {
      const r = c.radius || 200000;
      return [{ kind: 'ring', ring: sector(c.center, r, c.from, c.to), exclude: c.inside ? 'outside' : 'inside' }];
    }
    default:
      return [];
  }
}

// Dünne Hilfslinie, die zeigt, WOHER die Grenze kommt (Kreisrand, Laufweg …).
export function outline(c) {
  switch (c.type) {
    case 'radius':
      return [{ kind: 'circle', center: c.center, radius: c.radius }];
    case 'compare':
      if (c.features && c.features.length) {
        return c.features.map((f) => f.type === 'point'
          ? { kind: 'dot', at: f.points[0] }
          : { kind: 'path', points: f.points, closed: f.type === 'polygon' });
      }
      return [{ kind: 'circle', center: c.ref, radius: compareDistance(c) }, { kind: 'dot', at: c.ref }];
    case 'thermo':
      return [{ kind: 'path', points: [c.from, c.to], arrow: true }, { kind: 'dot', at: c.from }, { kind: 'dot', at: c.to }];
    case 'nearest':
      if (c.candidates) {
        return c.candidates.flatMap((cand) => cand.features.map((f) => (f.type === 'point'
          ? { kind: 'dot', at: f.points[0], strong: cand.id === c.chosenId }
          : { kind: 'path', points: f.points, closed: f.type === 'polygon', strong: cand.id === c.chosenId, faint: cand.id !== c.chosenId })));
      }
      return c.pois.map((p) => ({ kind: 'dot', at: p, strong: p.id === c.chosenId, label: p.name }));
    case 'elevation':
      return c.myPoint ? [{ kind: 'dot', at: c.myPoint, strong: true }] : [];
    case 'sector':
      return [{ kind: 'dot', at: c.center }];
    default:
      return [];
  }
}

export function describe(c, unit = 'metric') {
  const d = (m) => formatDistance(m, unit);
  switch (c.type) {
    case 'radius':
      return `${c.inside ? 'Innerhalb' : 'Außerhalb'} ${d(c.radius)} um ${c.centerName || 'Punkt'}`;
    case 'thermo':
      return `${c.warmer ? 'Wärmer' : 'Kälter'} nach ${d(distance(c.from, c.to))} Fahrt`;
    case 'compare':
      return `${c.closer ? 'Näher' : 'Weiter'} an ${c.refName || 'Ort'} als ${d(compareDistance(c))}`;
    case 'area':
      return `${c.inside ? 'In' : 'Nicht in'} ${c.name || 'Gebiet'}`;
    case 'nearest': {
      const liste = c.candidates || c.pois || [];
      const chosen = liste.find((x) => x.id === c.chosenId);
      const name = chosen ? chosen.name : '?';
      return c.invert
        ? `Nicht am nächsten an ${name} (von ${liste.length})`
        : `Am nächsten an ${name} (von ${liste.length})`;
    }
    case 'elevation':
      return `${c.closer ? 'Näher am' : 'Weiter vom'} Meeresspiegel als ${Math.round(c.myElevation)} m`;
    case 'sector':
      return `${c.inside ? 'Richtung' : 'Nicht Richtung'} ${Math.round(c.from)}°–${Math.round(c.to)}°`;
    default:
      return c.type;
  }
}

// Billige Bedingungen zuerst: eine Radiusfrage kostet ein paar Rechenschritte,
// eine Vergleichsfrage gegen eine Autobahn ein paar hundert. Wenn die billige
// den Punkt schon ausschließt, muss die teure gar nicht mehr laufen.
function isCheap(c) {
  if (c.type === 'radius' || c.type === 'thermo' || c.type === 'sector' || c.type === 'elevation') return true;
  if (c.type === 'compare') return !(c.features && c.features.length);
  return false;
}

export function allowsAll(list, p) {
  for (const c of list) {
    if (c.active !== false && isCheap(c) && !allows(c, p)) return false;
  }
  for (const c of list) {
    if (c.active !== false && !isCheap(c) && !allows(c, p)) return false;
  }
  return true;
}

/* ---------- Spielgebiet ---------- */

export function areaContains(area, p) {
  if (!area) return true;
  if (area.type === 'circle') return distance(p, area.center) <= area.radius;
  if (area.type === 'polygon') return pointInPolygon(p, area.ring);
  if (area.type === 'bbox') {
    const b = area.bounds;
    return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
  }
  return true;
}

export function areaRing(area) {
  if (!area) return null;
  if (area.type === 'circle') return circle(area.center, area.radius);
  if (area.type === 'polygon') return area.ring;
  if (area.type === 'bbox') {
    const b = area.bounds;
    return [
      { lat: b.south, lng: b.west }, { lat: b.north, lng: b.west },
      { lat: b.north, lng: b.east }, { lat: b.south, lng: b.east },
    ];
  }
  return null;
}

export function areaBounds(area) {
  const ring = areaRing(area);
  if (!ring) return null;
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of ring) {
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    w = Math.min(w, p.lng); e = Math.max(e, p.lng);
  }
  return { south: s, north: n, west: w, east: e };
}

// Flächentreues Ziehen eines Punktes aus der Bounding-Box (lat über asin-Verteilung,
// sonst wären Punkte nahe den Polen überrepräsentiert).
function randomInBounds(b, rnd = Math.random) {
  const D2R = Math.PI / 180;
  const s = Math.sin(b.south * D2R), n = Math.sin(b.north * D2R);
  return {
    lat: Math.asin(s + rnd() * (n - s)) / D2R,
    lng: b.west + rnd() * (b.east - b.west),
  };
}

// Monte-Carlo: Anteil des Spielgebiets, der nach allen aktiven Fragen übrig bleibt.
// Bei kleinen Restgebieten treffen zu wenige Stichproben, um eine stabile Zahl zu geben –
// dann wird nachgezogen, statt eine zappelnde Prozentangabe anzuzeigen.
export function remainingStats(area, list, samples = 6000, maxRounds = 3) {
  const b = areaBounds(area);
  if (!b) return { fraction: null, inArea: 0, remaining: 0, samples: 0, precise: false };

  let total = 0, inArea = 0, remaining = 0;
  for (let round = 0; round < maxRounds; round++) {
    const n = samples * 4 ** round - total;
    for (let i = 0; i < n; i++) {
      const p = randomInBounds(b);
      if (!areaContains(area, p)) continue;
      inArea++;
      if (allowsAll(list, p)) remaining++;
    }
    total = samples * 4 ** round;
    if (remaining >= 40 || inArea === 0) break;
  }
  return {
    fraction: inArea ? remaining / inArea : null,
    inArea, remaining, samples: total,
    precise: remaining >= 40,
  };
}

export function formatFraction(st) {
  if (!st || st.fraction == null) return null;
  if (st.remaining === 0) return 'leer';
  const pct = st.fraction * 100;
  if (!st.precise) return pct < 0.1 ? '< 0,1 %' : `~${pct.toFixed(1).replace('.', ',')} %`;
  return `${pct.toFixed(1).replace('.', ',')} %`;
}

export function randomAllowedPoint(area, list, tries = 20000) {
  const b = areaBounds(area);
  if (!b) return null;
  for (let i = 0; i < tries; i++) {
    const p = randomInBounds(b);
    if (areaContains(area, p) && allowsAll(list, p)) return p;
  }
  return null;
}

// Wie gut teilt eine hypothetische Radiusfrage das Restgebiet?
// 50/50 ist die informativste Frage – danach wird sortiert.
export function analyzeRadius(area, list, center, radii, samples = 4000) {
  const b = areaBounds(area);
  if (!b) return [];
  const pts = [];
  for (let i = 0; i < samples && pts.length < samples; i++) {
    const p = randomInBounds(b);
    if (areaContains(area, p) && allowsAll(list, p)) pts.push(p);
  }
  if (!pts.length) return [];
  return radii.map((r) => {
    let inside = 0;
    for (const p of pts) if (distance(p, center) <= r) inside++;
    const f = inside / pts.length;
    return { radius: r, insideFraction: f, balance: 1 - Math.abs(0.5 - f) * 2 };
  });
}

export function nearestOf(pois, p) {
  let best = null, bd = Infinity;
  for (const o of pois) {
    const d = distance(p, o);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? { poi: best, distance: bd } : null;
}
