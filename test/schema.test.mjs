// Prüft, dass das Regelformat die Arten von Hausregeln ausdrücken kann, die Gruppen
// typischerweise aufstellen: Fristen, Strafen, Grenzfälle, Haltestellen als Zonen-
// mittelpunkt, kombinierte Quellen, Verwaltungsebenen, Höhe, freie Wahl, Freitext.
// Das Beispielregelwerk hier ist Testmaterial, kein mitgeliefertes Regelwerk.
import test from 'node:test';
import assert from 'node:assert/strict';

const Rules = await import('../js/rules.js');
const Phases = await import('../js/phases.js');
const Prefetch = await import('../js/prefetch.js');
const Zone = await import('../js/zone.js');

const MIN = 60000;

function beispiel() {
  return {
    schemaVersion: 2,
    id: 'beispiel', name: 'Beispiel-Hausregeln',
    gameSizes: [{ id: 's', label: 'Stadt', hidingPeriodMinutes: 30, hidingZoneRadiusM: 250, answerMinutes: 5, photoMinutes: 10 }],
    round: {
      scoring: 'longestSingleRound',
      deadlines: [
        { id: 'endgame-frist', label: 'Endgame nicht erreicht', afterMinutes: 240, from: 'roundStart', until: 'endgame', outcome: 'seekersLose' },
        { id: 'ende-frist', label: 'Runde nicht beendet', afterMinutes: 300, from: 'roundStart', until: 'found', outcome: 'seekersLose' },
      ],
      lateAnswer: {
        steps: [
          { overMinutes: 0, nextDrawDelta: -1 },
          { overMinutes: 5, nextQuestionFree: true },
        ],
        deductOvertimeFactor: 2,
        exemptionNote: 'Nicht bei wichtigem entlastendem Grund.',
      },
    },
    hidingZone: { anchorCategory: 'bus', anchorChoices: 2, anchorToleranceM: 5, lockAt: 'searchStart', rules: ['Zonenregel'] },
    endgame: { hiderMayMove: false, answerWithinM: 2, rules: ['Endgameregel'] },
    answering: { position: 'current', tieToleranceM: 10, rules: ['Antwortregel'] },
    transport: { allowed: ['Bus', 'Fähre'], forbidden: ['Regionalzug'], rules: [] },
    research: { allowed: ['Luftbild von oben'], forbidden: ['3D-Ansicht'] },
    sections: [{ title: 'Suchende', rules: ['Kaufregel'] }],
    questions: [
      {
        id: 'gleich', label: 'Gleich', draw: 3, pick: 1, minutes: 5, appType: 'nearest', nearestMode: 'same', tieBreak: 'yes',
        options: [
          { label: 'Haltestelle', osm: 'tram_subway' },
          { label: 'Linie oder Autobahn', osm: ['bus_route', 'tram_route', 'rail_route', 'motorway'], match: 'shape' },
          { label: 'Stadtteil', appType: 'area', adminLevel: 10 },
          { label: 'Fluss oder Bach', osm: 'stream', match: 'shape' },
          { label: 'Spielplatz', osm: 'playground' },
          { label: 'Freie Wahl', freeChoice: true },
        ],
      },
      {
        id: 'messen', label: 'Messen', draw: 3, pick: 1, minutes: 5, appType: 'compare', tieBreak: 'closer',
        options: [
          { label: 'Linie oder Autobahn', osm: ['bus_route', 'tram_route', 'rail_route', 'motorway'] },
          { label: 'Stadtbezirksgrenze', osm: 'admin_border', adminLevel: 9 },
          { label: 'Meeresspiegel', appType: 'elevation' },
          { label: 'Brücke', osm: 'bridge' },
          { label: 'Freie Wahl', freeChoice: true },
        ],
      },
      { id: 'radar', label: 'Radar', draw: 2, pick: 1, minutes: 5, appType: 'radius', tieBreak: 'inside', options: [{ label: '500 m', meters: 500 }] },
      { id: 'thermo', label: 'Thermometer', draw: 2, pick: 1, minutes: 5, appType: 'thermo', tieBreak: 'warmer', options: [{ label: '1 km', meters: 1000 }] },
      { id: 'foto', label: 'Foto', draw: 2, pick: 1, minutesBySize: { s: 10 }, appType: null, options: [{ label: 'Baum' }] },
    ],
  };
}

test('Ein Regelwerk mit allen erweiterten Feldern ist gültig', () => {
  assert.doesNotThrow(() => Rules.validateRules(beispiel()));
});

test('Versteckzone: Radius frei, Fläche in Hektar', () => {
  Rules.applyRules(beispiel());
  Rules.setSize('s');
  assert.equal(Rules.hidingZoneRadius(), 250);
  assert.ok(Math.abs(Zone.areaHectares(250) - 19.63) < 0.01);
  assert.equal(Zone.formatHectares(250), '20 ha');
  assert.equal(Zone.formatHectares(126), '5,0 ha');
});

test('Fristen: Endgame- und Spielende-Frist mit Folge', () => {
  Rules.applyRules(beispiel());
  const start = Date.now() - 241 * MIN;
  const ohneEndgame = { startedAt: start };
  const [eg, ende] = Phases.deadlineStatus(ohneEndgame, Rules.deadlines(), Date.now());
  assert.ok(Date.now() >= eg.faellig, 'Endgame-Frist ist abgelaufen');
  assert.equal(eg.erreicht, false);
  assert.equal(eg.d.outcome, 'seekersLose');
  assert.ok(ende.rest > 0, 'Spielende-Frist läuft noch');

  const mitEndgame = { startedAt: start, endgameAt: start + 200 * MIN };
  assert.equal(Phases.deadlineStatus(mitEndgame, Rules.deadlines())[0].erreicht, true);
  // Zu spät erreicht zählt nicht
  const zuSpaet = { startedAt: start, endgameAt: start + 250 * MIN };
  assert.equal(Phases.deadlineStatus(zuSpaet, Rules.deadlines())[0].erreicht, false);
});

test('Verspätete Antworten: gestufte Folgen und Zeitabzug', () => {
  Rules.applyRules(beispiel());
  assert.equal(Rules.lateAnswerStep(0), null, 'pünktlich');
  assert.equal(Rules.lateAnswerStep(-30000), null);
  assert.equal(Rules.lateAnswerStep(2 * MIN).nextDrawDelta, -1, 'knapp zu spät: eine Karte weniger');
  assert.equal(Rules.lateAnswerStep(5 * MIN).nextQuestionFree, true, 'ab 5 Minuten gratis');
  assert.equal(Rules.lateAnswerStep(12 * MIN).nextQuestionFree, true);
  assert.equal(Rules.lateAnswerRules().deductOvertimeFactor, 2);
  // Rundenzeit netto: Abzug wird abgezogen
  const r = { startedAt: 0, endedAt: 60 * MIN, deductionMs: 8 * MIN };
  assert.equal(Phases.netDuration(r), 52 * MIN);
});

test('Ziehwerte je Kategorie frei einstellbar, auch für Fotos', () => {
  Rules.applyRules(beispiel());
  assert.equal(Rules.drawLabel(Rules.category('foto')), '2 ziehen, 1 behalten');
  assert.equal(Rules.answerMinutes('foto'), 10);
});

test('Grenzfall-Regeln je Kategorie mit Toleranz', () => {
  Rules.applyRules(beispiel());
  assert.equal(Rules.tieBreak('radar'), 'inside');
  assert.equal(Rules.tieBreak('thermo'), 'warmer');
  assert.equal(Rules.tieBreak('messen'), 'closer');
  assert.equal(Rules.tieBreak('gleich'), 'yes');
  assert.equal(Rules.tieToleranceM(), 10);
  assert.equal(Rules.nearestMode('gleich'), 'same');
});

test('Textregeln landen in lesbaren Blöcken', () => {
  Rules.applyRules(beispiel());
  const bloecke = Rules.textBlocks();
  const titel = bloecke.map((b) => b.title);
  for (const t of ['Verkehrsmittel', 'Recherche', 'Versteckzone', 'Antworten', 'Endgame', 'Suchende']) {
    assert.ok(titel.includes(t), `Block ${t} fehlt`);
  }
  const verkehr = bloecke.find((b) => b.title === 'Verkehrsmittel');
  assert.deepEqual(verkehr.chips.find((c) => c.kind === 'no').items, ['Regionalzug']);
});

test('Vorabladen leitet alle nötigen Quellen aus dem Regelwerk ab', () => {
  Rules.applyRules(beispiel());
  const q = Prefetch.neededSources();
  for (const id of ['tram_subway', 'playground', 'bus']) assert.ok(q.pois.includes(id), `Ortskategorie ${id} fehlt`);
  const refs = q.refs.map((r) => r.id);
  for (const id of ['bus_route', 'tram_route', 'rail_route', 'motorway', 'stream', 'bridge', 'admin_border']) {
    assert.ok(refs.includes(id), `Bezugsobjekt ${id} fehlt`);
  }
  assert.equal(q.refs.find((r) => r.id === 'admin_border').params.adminLevel, 9);
  assert.deepEqual(q.adminLevels, [10]);
  assert.equal(q.elevation, true);
});

test('Fehler in erweiterten Feldern werden mit Stelle gemeldet', () => {
  const bad = (mut, teil) => {
    const d = beispiel();
    mut(d);
    assert.throws(() => Rules.validateRules(d), (e) => e.message.includes(teil), `erwartet: ${teil}`);
  };
  bad((d) => { delete d.round.deadlines[0].until; }, 'until');
  bad((d) => { d.round.deadlines[0].outcome = 'irgendwas'; }, 'outcome');
  bad((d) => { d.round.lateAnswer.steps[0].overMinutes = -1; }, 'overMinutes');
  bad((d) => { d.questions[0].tieBreak = 'vielleicht'; }, 'tieBreak');
  bad((d) => { d.hidingZone.anchorCategory = 'raumschiff'; }, 'anchorCategory');
  bad((d) => { d.hidingZone.lockAt = 'irgendwann'; }, 'lockAt');
  bad((d) => { d.questions[0].options[1].osm = ['bus_route', 'teleporter']; }, 'teleporter');
  bad((d) => { d.questions[0].options[2].adminLevel = 42; }, 'adminLevel');
  bad((d) => { d.transport.forbidden = 'ICE'; }, 'transport.forbidden');
  bad((d) => { d.sections[0] = { rules: [] }; }, 'title');
});
