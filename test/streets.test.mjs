// Prüft die Endgame-Rechnung: Straßennetz, abgelaufene Stücke, Lückenschätzung, GPS-Filter, GPX.
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../js/streets.js');

// Kleines Gitter: drei Straßen von West nach Ost, drei von Süd nach Nord, je 300 m lang,
// 150 m Abstand. Knoten-IDs wie in OSM, damit Kreuzungen verbunden sind.
const O = { lat: 50.7320, lng: 7.0970 };
const M_LAT = 111320, M_LNG = 111320 * Math.cos(O.lat * Math.PI / 180);
const at = (x, y) => ({ lat: O.lat + y / M_LAT, lng: O.lng + x / M_LNG });
const id = (i, j) => i * 10 + j;

function gitter() {
  const ways = [];
  for (let j = 0; j < 3; j++) {
    ways.push({ id: 100 + j, nodes: [0, 1, 2].map((i) => id(i, j)), pts: [0, 1, 2].map((i) => { const p = at(i * 150, j * 150); return [p.lat, p.lng]; }) });
    ways.push({ id: 200 + j, nodes: [0, 1, 2].map((i) => id(j, i)), pts: [0, 1, 2].map((i) => { const p = at(j * 150, i * 150); return [p.lat, p.lng]; }) });
  }
  return S.buildNetwork(ways, { origin: O });
}

test('Netz: Kreuzungen sind verbunden, Stücke etwa 15 m lang', () => {
  const net = gitter();
  assert.equal(net.nodes.length, 9);
  assert.equal(net.edges.length, 12);
  const len = net.pieces.reduce((s, p) => s + p.len, 0);
  assert.ok(Math.abs(len - 1800) < 2, `Gesamtlänge ${len}`);
  assert.ok(net.pieces.every((p) => p.len <= 15.01));
});

test('Ablaufen markiert nur die Straße, auf der man geht', () => {
  const net = gitter();
  const st = S.emptyStates(net);
  // Mittlere West-Ost-Straße (y = 150) von x = 0 bis x = 300, 5 m daneben
  S.markTrack(net, st, [at(0, 155), at(100, 154), at(200, 156), at(300, 155)], 20);
  const c = S.coverage(net, st, at(150, 150), 1000);
  // 300 m Straße plus je 20 m in die Querstraßen an den drei Kreuzungen
  assert.ok(c.walked >= 300 && c.walked < 300 + 6 * 25, `abgelaufen ${c.walked}`);
  assert.equal(c.guessed, 0);
  // Die parallele Straße 150 m entfernt bleibt offen
  const lines = S.linesByState(net, st);
  assert.ok(lines[S.OPEN].length > 0 && lines[S.WALKED].length > 0);
});

test('Schätzung überschreibt nie echte Aufzeichnung', () => {
  const net = gitter();
  const st = S.emptyStates(net);
  S.markTrack(net, st, [at(0, 0), at(300, 0)], 10);
  const vorher = S.coverage(net, st, O, 1000).walked;
  const weg = S.shortestPath(net, at(0, 0), at(300, 300));
  assert.ok(weg, 'Weg gefunden');
  assert.ok(Math.abs(weg.length - 600) < 1, `Weglänge ${weg.length}`);
  S.markGuessed(net, st, weg.edges);
  const nachher = S.coverage(net, st, O, 1000);
  assert.equal(nachher.walked, vorher);
  assert.ok(nachher.guessed > 0);
});

test('Kürzester Weg rastet nur nahe am Netz ein', () => {
  const net = gitter();
  assert.equal(S.shortestPath(net, at(-500, -500), at(300, 300), { snapM: 60 }), null);
  const w = S.shortestPath(net, at(5, 5), at(148, 152));
  assert.equal(w.edges.length, 2);
});

test('Zeichnen beschränkt sich auf die Zone', () => {
  const net = gitter();
  const st = S.emptyStates(net);
  const alle = S.linesByState(net, st)[S.OPEN].flat().length;
  const zone = S.linesByState(net, st, at(0, 0), 100)[S.OPEN].flat().length;
  assert.ok(zone > 0 && zone < alle);
});

test('Stand lässt sich speichern und wiederherstellen', () => {
  const net = gitter();
  const st = S.emptyStates(net);
  S.markTrack(net, st, [at(0, 0), at(150, 0)], 10);
  const text = S.encodeStates(st);
  assert.deepEqual([...S.decodeStates(text, st.length)], [...st]);
  // Passt die Länge nicht (anderes Netz), gibt es einen leeren Stand
  assert.equal(S.decodeStates(text, st.length + 1).reduce((a, b) => a + b, 0), 0);
});

test('GPS-Filter: Sprünge, Lücken, ungenaue Punkte', () => {
  const t = 1_000_000;
  const a = { ...at(0, 0), t };
  assert.equal(S.classifyFix(null, { ...at(0, 0), t, accuracy: 8 }), 'append');
  assert.equal(S.classifyFix(a, { ...at(2, 0), t: t + 2000, accuracy: 8 }), 'skip', 'zu nah');
  assert.equal(S.classifyFix(a, { ...at(10, 0), t: t + 5000, accuracy: 80 }), 'skip', 'zu ungenau');
  assert.equal(S.classifyFix(a, { ...at(10, 0), t: t + 6000, accuracy: 8 }), 'append');
  assert.equal(S.classifyFix(a, { ...at(200, 0), t: t + 3000, accuracy: 8 }), 'jump', '67 m/s zu Fuß');
  assert.equal(S.classifyFix(a, { ...at(200, 0), t: t + 3000, accuracy: 8 }, { rejected: 3 }), 'append', 'nach drei Sprüngen akzeptieren');
  assert.equal(S.classifyFix(a, { ...at(300, 0), t: t + 5 * 60000, accuracy: 8 }), 'gap');
});

test('GPX: schreiben und wieder lesen', () => {
  const segs = [
    [{ ...at(0, 0), t: Date.UTC(2026, 9, 9, 12, 0, 0) }, { ...at(30, 0), t: Date.UTC(2026, 9, 9, 12, 0, 20) }],
    [{ ...at(100, 100), t: Date.UTC(2026, 9, 9, 12, 5, 0) }],
  ];
  const gpx = S.toGpx(segs, 'Test <&>');
  assert.match(gpx, /Test &lt;&amp;&gt;/);
  const back = S.parseGpx(gpx);
  assert.equal(back.length, 2);
  assert.equal(back[0].length, 2);
  assert.ok(Math.abs(back[0][1].lat - segs[0][1].lat) < 1e-6);
  assert.equal(back[0][1].t, segs[0][1].t);
  // Fremde Schreibweise: lon vor lat, selbstschließende Punkte, Route statt Spur
  const fremd = '<gpx><rte><rtept lon="7.1" lat="50.7"/><rtept lon="7.2" lat="50.8"></rtept></rte></gpx>';
  const r = S.parseGpx(fremd);
  assert.equal(r[0].length, 2);
  assert.equal(r[0][0].lng, 7.1);
  assert.equal(r[0][0].t, null);
});
