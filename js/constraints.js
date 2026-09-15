// Fragetypen. Jeder Constraint kann zweierlei:
//   allows(c, p)  – analytisch prüfen, ob ein Punkt noch in Frage kommt
//   shapes(c)     – die auszuschließende Fläche als Zeichengeometrie liefern
// Statistik und Zufallspunkte laufen über allows(), nicht über die Pixel der Maske —
// dadurch sind sie unabhängig von Zoom und Bildausschnitt.

import { distance, bearing, circle, sector, bisector, pointInPolygon, formatDistance, distanceToFeatures } from './geo.js';

export const TYPES = {
  radius:  { label: 'Radius',        icon: '◎', color: '#38bdf8' },
  thermo:  { label: 'Thermometer',   icon: '🌡', color: '#f97316' },
  compare: { label: 'Vergleich',     icon: '⇄', color: '#a78bfa' },
  area:    { label: 'Gebiet',        icon: '▱', color: '#34d399' },
  nearest: { label: 'Nächster Ort',  icon: '⌖', color: '#fbbf24' },
  sector:  { label: 'Richtung',      icon: '∡', color: '#f472b6' },
};

const BISECTOR_HALF_LENGTH = 250000; // m – deckt jeden realistischen Bildausschnitt ab
const BISECTOR_SAMPLES = 49;

export function allows(c, p) {
  switch (c.type) {
    case 'radius': {
      const inside = distance(p, c.center) <= c.radius;
      return c.inside ? inside : !inside;
    }
    case 'thermo': {
      // "wärmer" = der gesuchte Punkt liegt näher am Endpunkt der Bewegung
      const closerToEnd = distance(p, c.to) < distance(p, c.from);
      return c.warmer ? closerToEnd : !closerToEnd;
    }
    case 'compare': {
      const mine = compareDistance(c);
      const theirs = refDistance(c, p);
      return c.closer ? theirs < mine : theirs > mine;
    }
    case 'area': {
      const inside = pointInPolygon(p, c.ring);
      return c.inside ? inside : !inside;
    }
    case 'nearest': {
      const chosen = c.pois.find((x) => x.id === c.chosenId);
      if (!chosen) return true;
      const d = distance(p, chosen);
      const isNearest = c.pois.every((o) => o.id === c.chosenId || distance(p, o) >= d);
      // invert: "nein, mein nächstes X ist ein anderes" – dann fällt genau diese Zelle weg
      return c.invert ? !isNearest : isNearest;
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
export function shapes(c) {
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
      return c.pois.map((p) => ({ kind: 'dot', at: p, strong: p.id === c.chosenId, label: p.name }));
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
      const chosen = c.pois.find((x) => x.id === c.chosenId);
      const name = chosen ? chosen.name : '?';
      return c.invert
        ? `Nicht am nächsten an ${name} (von ${c.pois.length})`
        : `Am nächsten an ${name} (von ${c.pois.length})`;
    }
    case 'sector':
      return `${c.inside ? 'Richtung' : 'Nicht Richtung'} ${Math.round(c.from)}°–${Math.round(c.to)}°`;
    default:
      return c.type;
  }
}

export function allowsAll(list, p) {
  for (const c of list) if (c.active !== false && !allows(c, p)) return false;
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
export function remainingStats(area, list, samples = 6000) {
  const b = areaBounds(area);
  if (!b) return { fraction: null, inArea: 0, remaining: 0, samples: 0, precise: false };

  let total = 0, inArea = 0, remaining = 0;
  for (let round = 0; round < 3; round++) {
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
