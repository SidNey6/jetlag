// Abdeckungsprüfung der Regionen gegen Geofabrik-Umrisse (.poly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePoly, inPoly, uncovered } from '../scripts/region/coverage.mjs';
import { REGIONS } from '../scripts/region/regions.mjs';

// Quadrat 6–8 °O, 50–52 °N mit einem Loch bei 7 °O / 51 °N
const POLY = `testland
1
   6.0 50.0
   8.0 50.0
   8.0 52.0
   6.0 52.0
   6.0 50.0
END
!2
   6.9 50.9
   7.1 50.9
   7.1 51.1
   6.9 51.1
   6.9 50.9
END
END
`;

test('Umriss lesen: Ringe und Löcher', () => {
  const rings = parsePoly(POLY);
  assert.equal(rings.length, 2);
  assert.equal(rings[1].hole, true);
  assert.equal(inPoly(rings, 6.5, 50.5), true);
  assert.equal(inPoly(rings, 7.0, 51.0), false);   // im Loch
  assert.equal(inPoly(rings, 8.5, 51.0), false);   // draußen
});

test('Lücken im Rahmen werden gefunden', () => {
  const rings = parsePoly(POLY);
  assert.equal(uncovered({ south: 50.1, west: 6.1, north: 50.8, east: 6.8 }, [rings]).anteil, 0);
  const rand = uncovered({ south: 50.5, west: 7.5, north: 51.5, east: 8.5 }, [rings], 20);
  assert.ok(rand.anteil > 0.4 && rand.anteil < 0.6, `Anteil ${rand.anteil}`);
  assert.ok(rand.punkte.every(([, lng]) => lng >= 8));   // auf der Linie zählt als außen
});

test('Regionen: Straßenrahmen liegt im Datenrahmen, Quellen sind Geofabrik-Auszüge', () => {
  for (const r of Object.values(REGIONS)) {
    const b = r.bounds, s = r.streets;
    assert.ok(s.south >= b.south && s.north <= b.north && s.west >= b.west && s.east <= b.east, r.id);
    assert.ok(r.sources.length && r.sources.every((u) => /^https:\/\/download\.geofabrik\.de\/.+-latest\.osm\.pbf$/.test(u)), r.id);
  }
});
