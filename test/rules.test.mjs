// Prüft die mitgelieferte Regeldatei und den Regel-Loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'rules/lifack.json'), 'utf8'));
const Rules = await import('../js/rules.js');
const State = await import('../js/state.js');

const MILE = 1609.344;

test('Mitgelieferte Regeldatei besteht die Prüfung', () => {
  assert.doesNotThrow(() => Rules.validateRules(data));
});

test('Spielgrößen tragen die Werte der Quelle', () => {
  const by = Object.fromEntries(data.gameSizes.map((g) => [g.id, g]));
  assert.deepEqual(Object.keys(by).sort(), ['large', 'medium', 'small']);
  assert.equal(by.small.hidingPeriodMinutes, 30);
  assert.equal(by.medium.hidingPeriodMinutes, 60);
  assert.equal(by.large.hidingPeriodMinutes, 180);
  // Versteckzone: ¼ Meile bei klein/mittel, ½ Meile bei groß
  assert.ok(Math.abs(by.small.hidingZoneRadiusM - MILE / 4) < 0.01);
  assert.ok(Math.abs(by.medium.hidingZoneRadiusM - MILE / 4) < 0.01);
  assert.ok(Math.abs(by.large.hidingZoneRadiusM - MILE / 2) < 0.01);
  assert.equal(by.large.photoMinutes, 20);
  assert.equal(by.small.photoMinutes, 10);
});

test('Sechs Kategorien mit den Ziehwerten der Quelle', () => {
  const by = Object.fromEntries(data.questions.map((q) => [q.id, q]));
  assert.deepEqual(Object.keys(by).sort(), ['matching', 'measuring', 'photos', 'radar', 'tentacles', 'thermometer']);
  assert.deepEqual([by.matching.draw, by.matching.pick], [3, 1]);
  assert.deepEqual([by.measuring.draw, by.measuring.pick], [3, 1]);
  assert.deepEqual([by.thermometer.draw, by.thermometer.pick], [2, 1]);
  assert.deepEqual([by.radar.draw, by.radar.pick], [2, 1]);
  assert.deepEqual([by.tentacles.draw, by.tentacles.pick], [4, 2]);
  assert.equal(by.photos.draw, 1);
  for (const q of Object.values(by)) assert.ok(q.minutes === 5 || q.minutesBySize, `${q.id}`);
});

test('Distanzen entsprechen exakt den Meilenwerten', () => {
  const radar = data.questions.find((q) => q.id === 'radar');
  const erwartet = [0.25, 0.5, 1, 3, 5, 10, 25, 50, 100];
  assert.equal(radar.options.length, erwartet.length);
  radar.options.forEach((o, i) => {
    assert.ok(Math.abs(o.meters - erwartet[i] * MILE) < 0.01, `${o.label}: ${o.meters}`);
  });
  const thermo = data.questions.find((q) => q.id === 'thermometer');
  assert.deepEqual(thermo.options.map((o) => o.meters / MILE), [0.5, 3, 10, 50]);
});

test('Größenabhängige Optionen sind richtig eingeschränkt', () => {
  const thermo = data.questions.find((q) => q.id === 'thermometer');
  assert.deepEqual(thermo.options.find((o) => o.meters === 10 * MILE).sizes, ['medium', 'large']);
  assert.deepEqual(thermo.options.find((o) => o.meters === 50 * MILE).sizes, ['large']);
  const tent = data.questions.find((q) => q.id === 'tentacles');
  // 1-Meilen-Orte ab mittel, 15-Meilen-Orte nur groß
  for (const o of tent.options) {
    assert.deepEqual(o.sizes, o.meters === MILE ? ['medium', 'large'] : ['large'], o.label);
  }
});

const Sources = await import('../js/sources.js');

function registries() {
  return {
    poi: new Set(Sources.POI_CATEGORIES.map((c) => c.id)),
    refs: new Set(Sources.REFERENCES.map((r) => r.id)),
  };
}

// Welche Registry eine Option meint, hängt am Fragetyp: Vergleiche brauchen
// Geometrie, Matching/Tentakel benannte Orte – außer die Quelle gibt es nur als Geometrie.
function knownFor(q, o, reg) {
  const typ = 'appType' in o ? o.appType : q.appType;
  const ids = Array.isArray(o.osm) ? o.osm : [o.osm];
  if (typ === 'compare') return ids.every((id) => reg.refs.has(id));
  return ids.every((id) => reg.poi.has(id) || reg.refs.has(id));
}

test('Jede OSM-Verknüpfung zeigt auf eine bekannte Quelle', () => {
  const reg = registries();
  assert.ok(reg.poi.size > 20 && reg.refs.size > 30, 'Registries nicht geladen');
  for (const q of data.questions) {
    for (const o of q.options) {
      if (!o.osm) continue;
      assert.ok(knownFor(q, o, reg), `${q.id}/${o.label}: unbekannt "${o.osm}"`);
    }
  }
});

// Der eigentliche Punkt: für keine Option darf die App nach einem Punkt fragen.
test('Keine Option verlangt manuelle Eingaben', () => {
  const reg = registries();
  const offen = [];
  for (const q of data.questions) {
    for (const o of q.options) {
      const typ = 'appType' in o ? o.appType : q.appType;
      if (typ === null) {
        if (q.appType !== null) assert.ok(o.note, `${q.id}/${o.label}: Ausnahme ohne Begründung`);
        continue;
      }
      if (typ === 'radius' || typ === 'thermo' || typ === 'elevation') continue;
      if (typ === 'area' && o.adminLevel) continue;
      if (o.freeChoice) continue;
      if (!o.osm || !knownFor(q, o, reg)) offen.push(`${q.id}/${o.label}`);
    }
  }
  assert.deepEqual(offen, [], `Ohne automatische Auflösung: ${offen.join(', ')}`);
});

test('Ausgedehnte Bezugsobjekte sind als Linie hinterlegt', () => {
  for (const id of ['motorway', 'coastline', 'border_country', 'river', 'highspeed', 'stream', 'ferry', 'admin_border']) {
    assert.equal(Sources.reference(id)?.geom, 'line', `${id} müsste als Linie gemessen werden`);
  }
  for (const id of ['bus_route', 'tram_route', 'rail_route', 'subway_route']) {
    assert.equal(Sources.reference(id)?.geom, 'lines', `${id} ist eine Linienrelation`);
  }
});

test('Platzhalter in Abfragen werden aus der Regeloption gefüllt', () => {
  const spec = Sources.reference('admin_border');
  assert.deepEqual(Sources.referenceStatements(spec, { adminLevel: 9 }),
    ['way["boundary"="administrative"]["admin_level"="9"]']);
  assert.throws(() => Sources.referenceStatements(spec, {}), /adminLevel/);
  // Vereinigung mehrerer Filter bleibt erhalten
  assert.equal(Sources.poiStatements(Sources.poiCategory('tram_subway')).length, 2);
});

test('Deck ergibt die Kartenzahl der Quelle', () => {
  const sum = (a) => a.reduce((s, c) => s + c.count, 0);
  assert.equal(sum(data.deck.timeBonuses), 55);
  assert.equal(sum(data.deck.powerups), 21);
  assert.equal(sum(data.deck.curses), 24);
  assert.equal(data.deck.blanks, 25);
  assert.deepEqual(data.deck.timeBonuses.map((t) => t.minutes), [5, 10, 15, 20, 30]);
});

test('Loader filtert Optionen nach eingestellter Spielgröße', () => {
  Rules.applyRules(data);
  Rules.setSize('small');
  assert.equal(Rules.currentSize().id, 'small');
  assert.equal(Rules.optionsFor('thermometer').length, 2, 'klein: nur ½ und 3 Meilen');
  assert.equal(Rules.optionsFor('tentacles').length, 0, 'klein: keine Tentacles');
  assert.equal(Rules.answerMinutes('photos'), 10);

  Rules.setSize('large');
  assert.equal(Rules.optionsFor('thermometer').length, 4);
  assert.equal(Rules.optionsFor('tentacles').length, 8);
  assert.equal(Rules.answerMinutes('photos'), 20);
  assert.equal(Rules.answerMinutes('radar'), 5);

  Rules.setSize('medium');
  assert.equal(Rules.optionsFor('tentacles').length, 4, 'mittel: nur die 1-Meilen-Orte');
  assert.deepEqual(Rules.distancePresets('radar').map((m) => m / MILE), [0.25, 0.5, 1, 3, 5, 10, 25, 50, 100]);
  assert.equal(Rules.drawLabel(Rules.category('tentacles')), '4 ziehen, 2 behalten');
  assert.ok(Math.abs(Rules.hidingZoneRadius() - MILE / 4) < 0.01);
  assert.equal(Rules.hidingPeriodMinutes(), 60);
});

test('Kaputte Regelwerke werden mit klarer Meldung abgewiesen', () => {
  const bad = (mut, teil) => {
    const copy = JSON.parse(JSON.stringify(data));
    mut(copy);
    assert.throws(() => Rules.validateRules(copy), (e) => e.message.includes(teil), teil);
  };
  bad((d) => { delete d.gameSizes; }, 'gameSizes');
  bad((d) => { d.gameSizes[0].hidingPeriodMinutes = 0; }, 'hidingPeriodMinutes');
  bad((d) => { delete d.questions; }, 'questions');
  bad((d) => { delete d.questions[0].options[0].label; }, 'label');
  bad((d) => { d.questions[0].options[0].sizes = ['winzig']; }, 'unbekannte Spielgröße');
  bad((d) => { delete d.questions[3].minutes; }, 'minutes');
  assert.throws(() => Rules.validateRules(null), /kein Objekt/);
});

test('Zurücksetzen auf das mitgelieferte Regelwerk räumt den Zustand auf', () => {
  Rules.applyRules(data, 'Testregeln');
  assert.equal(Rules.isCustom(), true);
  State.update((s) => { s.rules = null; });
  assert.equal(Rules.isCustom(), false);
});
