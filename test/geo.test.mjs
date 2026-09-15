// Prüft die Rechenkerne: Geodäsie, Fragetypen, Restflächen-Schätzung, Kachelmathematik.
// Aufruf: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

const geo = await import('../js/geo.js');
const C = await import('../js/constraints.js');
const TM = await import('../js/tilemath.js');

const BERLIN = { lat: 52.5200, lng: 13.4050 };
const MUENCHEN = { lat: 48.1351, lng: 11.5820 };
const HAMBURG = { lat: 53.5511, lng: 9.9937 };

test('Distanz stimmt mit bekannten Strecken überein', () => {
  assert.ok(Math.abs(geo.distance(BERLIN, MUENCHEN) - 504000) < 2000);
  assert.ok(Math.abs(geo.distance(BERLIN, HAMBURG) - 255000) < 2000);
  assert.equal(geo.distance(BERLIN, BERLIN), 0);
});

test('Peilung zeigt in die erwartete Himmelsrichtung', () => {
  // Hamburg liegt ~228 km westlich und ~114 km nördlich von Berlin: atan2 ergibt knapp 298°
  assert.ok(Math.abs(geo.bearing(BERLIN, HAMBURG) - 298) < 1.5);
  assert.equal(geo.formatBearing(geo.bearing(BERLIN, HAMBURG)).endsWith('WNW'), true);
  const north = geo.destination(BERLIN, 0, 1000);
  assert.ok(north.lat > BERLIN.lat);
  assert.ok(Math.abs(north.lng - BERLIN.lng) < 1e-9);
});

test('Zielpunkt und Distanz sind zueinander invers', () => {
  for (const brng of [0, 37, 90, 181, 275, 359]) {
    for (const d of [10, 1500, 50000, 400000]) {
      const p = geo.destination(BERLIN, brng, d);
      assert.ok(Math.abs(geo.distance(BERLIN, p) - d) < 0.5, `Distanz ${d} @ ${brng}°`);
      assert.ok(Math.abs(((geo.bearing(BERLIN, p) - brng + 540) % 360) - 180) < 0.5);
    }
  }
});

test('Mittelsenkrechte hält überall gleichen Abstand zu beiden Punkten', () => {
  for (const [a, b, half] of [[BERLIN, MUENCHEN, 300000], [BERLIN, HAMBURG, 80000],
                              [{ lat: 69.65, lng: 18.95 }, { lat: 69.7, lng: 19.2 }, 50000]]) {
    for (const p of geo.bisector(a, b, half, 33)) {
      assert.ok(Math.abs(geo.distance(p, a) - geo.distance(p, b)) < 1, 'Abweichung über 1 m');
    }
  }
});

test('Kreispunkte liegen exakt auf dem Radius', () => {
  for (const r of [250, 5000, 40000]) {
    for (const p of geo.circle(BERLIN, r, 32)) {
      assert.ok(Math.abs(geo.distance(BERLIN, p) - r) < 0.5);
    }
  }
});

test('Punkt-in-Polygon erkennt innen und außen', () => {
  const box = [{ lat: 52, lng: 13 }, { lat: 53, lng: 13 }, { lat: 53, lng: 14 }, { lat: 52, lng: 14 }];
  assert.equal(geo.pointInPolygon({ lat: 52.5, lng: 13.5 }, box), true);
  assert.equal(geo.pointInPolygon({ lat: 51.9, lng: 13.5 }, box), false);
  assert.equal(geo.pointInPolygon({ lat: 52.5, lng: 14.5 }, box), false);
});

test('Douglas-Peucker dünnt aus und behält die Endpunkte', () => {
  const line = Array.from({ length: 400 }, (_, i) => ({ lat: 52 + i * 0.001, lng: 13 + Math.sin(i / 40) * 0.0001 }));
  const s = geo.simplify(line, 0.0002);
  assert.ok(s.length < line.length / 4);
  assert.deepEqual(s[0], line[0]);
  assert.deepEqual(s[s.length - 1], line[line.length - 1]);
});

/* ---------- Fragetypen ---------- */

test('Radius schließt die richtige Seite aus', () => {
  const inside = { type: 'radius', center: BERLIN, radius: 10000, inside: true };
  const outside = { ...inside, inside: false };
  const near = geo.destination(BERLIN, 45, 5000);
  const far = geo.destination(BERLIN, 45, 20000);
  assert.equal(C.allows(inside, near), true);
  assert.equal(C.allows(inside, far), false);
  assert.equal(C.allows(outside, near), false);
  assert.equal(C.allows(outside, far), true);
});

test('Thermometer trennt an der Mittelsenkrechten', () => {
  const to = geo.destination(BERLIN, 90, 4000);
  const warm = { type: 'thermo', from: BERLIN, to, warmer: true };
  // Punkte direkt neben der Trennlinie müssen auf der jeweils richtigen Seite landen
  const mid = geo.midpoint(BERLIN, to);
  assert.equal(C.allows(warm, geo.destination(mid, 90, 50)), true);
  assert.equal(C.allows(warm, geo.destination(mid, 270, 50)), false);
  assert.equal(C.allows({ ...warm, warmer: false }, geo.destination(mid, 270, 50)), true);
});

test('Vergleichsfrage nutzt den eigenen Abstand als Kreisradius', () => {
  const c = { type: 'compare', ref: BERLIN, myPoint: geo.destination(BERLIN, 0, 12000), closer: true };
  assert.equal(C.compareDistance(c), geo.distance(c.myPoint, BERLIN));
  assert.equal(C.allows(c, geo.destination(BERLIN, 180, 5000)), true);
  assert.equal(C.allows(c, geo.destination(BERLIN, 180, 20000)), false);
});

test('Nächster Ort lässt nur die Zelle des genannten Ortes übrig', () => {
  const pois = [
    { id: 'a', lat: 52.5, lng: 13.0, name: 'A' },
    { id: 'b', lat: 52.5, lng: 13.4, name: 'B' },
    { id: 'c', lat: 52.5, lng: 13.8, name: 'C' },
  ];
  const c = { type: 'nearest', pois, chosenId: 'b' };
  assert.equal(C.allows(c, { lat: 52.5, lng: 13.41 }), true);
  assert.equal(C.allows(c, { lat: 52.5, lng: 13.05 }), false);
  assert.equal(C.allows(c, { lat: 52.5, lng: 13.79 }), false);
});

test('Verneintes Matching schließt genau die Zelle des genannten Ortes aus', () => {
  const pois = [
    { id: 'a', lat: 52.5, lng: 13.0, name: 'A' },
    { id: 'b', lat: 52.5, lng: 13.4, name: 'B' },
    { id: 'c', lat: 52.5, lng: 13.8, name: 'C' },
  ];
  const ja = { type: 'nearest', pois, chosenId: 'b' };
  const nein = { type: 'nearest', pois, chosenId: 'b', invert: true };
  const inB = { lat: 52.5, lng: 13.41 }, inA = { lat: 52.5, lng: 13.05 };
  assert.equal(C.allows(nein, inB), false, 'Zelle von B muss wegfallen');
  assert.equal(C.allows(nein, inA), true, 'außerhalb bleibt erlaubt');
  // Ja und Nein müssen einander exakt ergänzen
  for (const lng of [12.9, 13.1, 13.2, 13.39, 13.41, 13.6, 13.9]) {
    const p = { lat: 52.5, lng };
    assert.equal(C.allows(ja, p), !C.allows(nein, p), `bei lng ${lng}`);
  }
  // Zeichengeometrie: ein einzelner Ausstanz-Block statt einer Vereinigung
  const sh = C.shapes(nein);
  assert.equal(sh.length, 1);
  assert.equal(sh[0].kind, 'cutout');
  assert.equal(sh[0].parts.length, 2);
  assert.ok(sh[0].parts.every((p) => p.line.length >= 3 && p.excludeRef));
  assert.ok(C.describe(nein).startsWith('Nicht am nächsten'));
});

test('Restfläche von Ja und Nein ergibt zusammen das ganze Gebiet', () => {
  const pois = [
    { id: 'a', lat: 52.50, lng: 13.30, name: 'A' },
    { id: 'b', lat: 52.52, lng: 13.40, name: 'B' },
    { id: 'c', lat: 52.48, lng: 13.50, name: 'C' },
  ];
  const area = { type: 'circle', center: { lat: 52.5, lng: 13.4 }, radius: 12000 };
  const ja = C.remainingStats(area, [{ type: 'nearest', pois, chosenId: 'b' }], 20000);
  const nein = C.remainingStats(area, [{ type: 'nearest', pois, chosenId: 'b', invert: true }], 20000);
  assert.ok(Math.abs(ja.fraction + nein.fraction - 1) < 0.02,
    `Summe war ${(ja.fraction + nein.fraction).toFixed(3)}`);
});

test('Richtungsfrage prüft den Sektor auch über 0° hinweg', () => {
  const c = { type: 'sector', center: BERLIN, from: 315, to: 45, inside: true };
  assert.equal(C.allows(c, geo.destination(BERLIN, 0, 5000)), true);
  assert.equal(C.allows(c, geo.destination(BERLIN, 350, 5000)), true);
  assert.equal(C.allows(c, geo.destination(BERLIN, 180, 5000)), false);
});

test('Jeder Fragetyp liefert zeichenbare Geometrie', () => {
  const cs = [
    { type: 'radius', center: BERLIN, radius: 5000, inside: true },
    { type: 'thermo', from: BERLIN, to: HAMBURG, warmer: true },
    { type: 'compare', ref: BERLIN, myPoint: HAMBURG, closer: false },
    { type: 'area', ring: geo.circle(BERLIN, 8000, 12), inside: true },
    { type: 'nearest', pois: [{ id: 'a', ...BERLIN }, { id: 'b', ...HAMBURG }], chosenId: 'a' },
    { type: 'sector', center: BERLIN, from: 10, to: 80, inside: true },
  ];
  for (const c of cs) {
    const shapes = C.shapes(c);
    assert.ok(shapes.length >= 1, `${c.type} ohne Form`);
    for (const s of shapes) {
      const pts = s.ring || s.line;
      assert.ok(pts.length >= 3, `${c.type}: zu wenige Punkte`);
      assert.ok(pts.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)), `${c.type}: ungültige Koordinate`);
    }
    assert.ok(typeof C.describe(c) === 'string' && C.describe(c).length > 3);
  }
});

/* ---------- Restfläche ---------- */

test('Restflächen-Schätzung trifft den analytisch bekannten Wert', () => {
  const area = { type: 'circle', center: BERLIN, radius: 15000 };
  const st = C.remainingStats(area, [{ type: 'radius', center: BERLIN, radius: 5000, inside: true }], 20000);
  assert.ok(Math.abs(st.fraction - 1 / 9) < 0.01, `erwartet 11,1 %, war ${(st.fraction * 100).toFixed(1)} %`);

  // Halbebene durch den Mittelpunkt: exakt die Hälfte
  const half = C.remainingStats(area, [{
    type: 'thermo',
    from: geo.destination(BERLIN, 270, 4000),
    to: geo.destination(BERLIN, 90, 4000),
    warmer: true,
  }], 20000);
  assert.ok(Math.abs(half.fraction - 0.5) < 0.02, `erwartet 50 %, war ${(half.fraction * 100).toFixed(1)} %`);
});

test('Winzige Restgebiete werden nachgezogen statt zu zappeln', () => {
  const area = { type: 'circle', center: BERLIN, radius: 100000 };
  const st = C.remainingStats(area, [{ type: 'radius', center: BERLIN, radius: 2000, inside: true }], 2000);
  assert.ok(st.samples > 2000, 'keine Nachziehrunde gelaufen');
  assert.ok(st.fraction < 0.01 && st.fraction > 0);
  assert.equal(typeof C.formatFraction(st), 'string');
});

test('Zufallspunkt erfüllt alle aktiven Antworten', () => {
  const area = { type: 'circle', center: BERLIN, radius: 20000 };
  const list = [
    { type: 'radius', center: BERLIN, radius: 8000, inside: true },
    { type: 'thermo', from: BERLIN, to: geo.destination(BERLIN, 90, 3000), warmer: true },
  ];
  for (let i = 0; i < 20; i++) {
    const p = C.randomAllowedPoint(area, list);
    assert.ok(p && C.allowsAll(list, p) && C.areaContains(area, p));
  }
});

test('Widersprüchliche Antworten ergeben null Restfläche', () => {
  const area = { type: 'circle', center: BERLIN, radius: 20000 };
  const st = C.remainingStats(area, [
    { type: 'radius', center: BERLIN, radius: 3000, inside: true },
    { type: 'radius', center: BERLIN, radius: 3000, inside: false },
  ], 4000);
  assert.equal(st.remaining, 0);
  assert.equal(C.formatFraction(st), 'leer');
});

/* ---------- Kacheln ---------- */

test('Kachelliste deckt den Bereich ab und hält das Limit ein', () => {
  const b = { south: 52.4, north: 52.6, west: 13.3, east: 13.5 };
  const list = TM.tileList(b, 12, 14);
  assert.ok(list.length > 5);
  assert.ok(list.every((t) => t.z >= 12 && t.z <= 14));
  // Der Mittelpunkt muss unter den Kacheln sein
  const z = 14;
  const cx = TM.lngToX(13.4, z), cy = TM.latToY(52.5, z);
  assert.ok(list.some((t) => t.z === z && t.x === cx && t.y === cy));
  assert.ok(TM.tileList({ south: -60, north: 70, west: -170, east: 170 }, 1, 12, 500).length <= 501);
});
