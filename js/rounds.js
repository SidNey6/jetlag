// Teams, Runden, Protokoll und Wertung.
// Bewusst formatoffen: Gewertet wird die Dauer je Runde – wer daraus Punkte macht,
// entscheidet die Hausregel.

import { getState, update, uid } from './state.js';
import { el, clear, openSheet, confirmSheet, promptSheet, toast, formatClock, formatTime } from './ui/ui.js';
import { activeRound, currentPhase, netDuration, PHASE_LABEL, deadlineStatus as fristen } from './phases.js';
import * as Rules from './rules.js';
import { ringAlarm, elapsed, removeTimer } from './timers.js';
import { distance, formatDistance } from './geo.js';
import * as Loc from './location.js';
import * as Zone from './zone.js';
import { poiCategory } from './sources.js';

export { activeRound };

const COLORS = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#facc15'];

export function addTeam(name) {
  update((s) => {
    s.game.teams.push({ id: uid('tm'), name, color: COLORS[s.game.teams.length % COLORS.length] });
  }, 'Team angelegt');
}

export function startRound(teamId) {
  setTimeout(watchDeadlines, 0);
  update((s) => {
    for (const r of s.game.rounds) if (!r.endedAt) r.endedAt = Date.now();
    const r = { id: uid('rd'), teamId, startedAt: Date.now(), endedAt: null, note: '', deductionMs: 0, fired: {} };
    s.game.rounds.push(r);
    s.game.log.push({ id: uid('lg'), at: r.startedAt, kind: 'round', text: `Runde gestartet: ${teamName(teamId)}` });
  }, 'Runde gestartet');
}

export function endRound(id) {
  update((s) => {
    const r = s.game.rounds.find((x) => x.id === id);
    if (!r || r.endedAt) return;
    r.endedAt = Date.now();
    s.game.log.push({
      id: uid('lg'), at: r.endedAt, kind: 'round',
      text: `Runde beendet: ${teamName(r.teamId)} – ${formatClock(netDuration(r), { withHours: true })}`
        + (r.deductionMs ? ` (nach ${formatClock(r.deductionMs)} Abzug)` : ''),
    });
  }, 'Runde beendet');
}

/* ---------- Phasen ---------- */

export function markPhase(phase) {
  update((s) => {
    const r = s.game.rounds.find((x) => !x.endedAt);
    if (!r) return;
    const now = Date.now();
    if (phase === 'searchStart') { r.hidingEndAt = r.hidingEndAt || now; r.searchStartAt = r.searchStartAt || now; }
    if (phase === 'endgame') r.endgameAt = r.endgameAt || now;
    s.game.log.push({ id: uid('lg'), at: now, kind: 'round', text: `${PHASE_LABEL[phase]}: ${teamName(r.teamId)}` });
  }, `Phase: ${PHASE_LABEL[phase]}`);
  checkDeadlines();
}

/* ---------- Fristen ---------- */

// Fristen aus dem Regelwerk, z. B. "Endgame nach X Stunden nicht erreicht".
// Jede Frist löst höchstens einmal je Runde aus.
export function deadlineStatus(r, now = Date.now()) {
  return fristen(r, Rules.deadlines(), now);
}

const OUTCOME_LABEL = { seekersLose: 'Sucher verlieren', hiderLoses: 'Versteckende Seite verliert', note: 'Hinweis' };

export function checkDeadlines(now = Date.now()) {
  const r = activeRound();
  if (!r) return;
  for (const st of deadlineStatus(r, now)) {
    if (st.ausgeloest || st.erreicht || st.faellig == null || now < st.faellig) continue;
    const d = st.d;
    const ergebnis = d.outcomeLabel || OUTCOME_LABEL[d.outcome || 'note'];
    update((s) => {
      const x = s.game.rounds.find((y) => y.id === r.id);
      if (!x) return;
      x.fired = { ...(x.fired || {}), [d.id]: now };
      if (d.outcome && d.outcome !== 'note' && !x.verdict) {
        x.verdict = { deadlineId: d.id, outcome: d.outcome, label: ergebnis, at: now };
      }
      s.game.log.push({ id: uid('lg'), at: now, kind: 'deadline', text: `Frist abgelaufen: ${d.label || d.id} → ${ergebnis}` });
    });
    ringAlarm(`Frist abgelaufen: ${d.label || d.id} – ${ergebnis}`);
  }
}

// Fristen laufen über Stunden; dafür reicht ein ruhiger Takt, der im Hintergrund pausiert.
let deadlineTimer = null;
export function watchDeadlines() {
  const brauchts = !!activeRound() && Rules.deadlines().length > 0 && document.visibilityState === 'visible';
  if (brauchts && !deadlineTimer) deadlineTimer = setInterval(() => { checkDeadlines(); refreshRoundCard(); }, 15000);
  if (!brauchts && deadlineTimer) { clearInterval(deadlineTimer); deadlineTimer = null; }
}
document.addEventListener('visibilitychange', () => { checkDeadlines(); watchDeadlines(); });

/* ---------- Verspätete Antworten ---------- */

export function answerReceived(timerId, { excused = false } = {}) {
  const t = getState().timers.find((x) => x.id === timerId);
  if (!t) return;
  const over = elapsed(t) - t.duration;
  removeTimer(timerId);

  if (over <= 0) {
    logNote(`Antwort rechtzeitig (${formatClock(-over)} vor Fristende)`);
    toast('Antwort rechtzeitig', 'ok');
    return;
  }
  const spaet = formatClock(over);
  if (excused) {
    logNote(`Antwort ${spaet} zu spät – entschuldigt, keine Folgen`);
    toast('Entschuldigt vermerkt');
    return;
  }
  const la = Rules.lateAnswerRules();
  const step = Rules.lateAnswerStep(over, la);
  const faktor = la && la.deductOvertimeFactor ? la.deductOvertimeFactor : 0;
  const abzug = Math.round(over * faktor);
  const folgen = [];

  update((s) => {
    if (step) {
      s.game.pending = {
        nextDrawDelta: step.nextDrawDelta || 0,
        nextQuestionFree: !!step.nextQuestionFree,
        label: step.label || null,
      };
      if (step.nextQuestionFree) folgen.push('nächste Frage gratis');
      else if (step.nextDrawDelta) folgen.push(`nächste Frage ${step.nextDrawDelta > 0 ? '+' : '−'}${Math.abs(step.nextDrawDelta)} Karte${Math.abs(step.nextDrawDelta) === 1 ? '' : 'n'}`);
    }
    const r = s.game.rounds.find((x) => !x.endedAt);
    if (r && abzug) {
      r.deductionMs = (r.deductionMs || 0) + abzug;
      folgen.push(`${formatClock(abzug)} von der Rundenzeit abgezogen`);
    }
    s.game.log.push({
      id: uid('lg'), at: Date.now(), kind: 'late',
      text: `Antwort ${spaet} zu spät${folgen.length ? ' → ' + folgen.join(' · ') : ''}`,
    });
  }, 'Verspätete Antwort');
  toast(`Antwort ${spaet} zu spät${folgen.length ? ': ' + folgen.join(', ') : ''}`, folgen.length ? 'error' : '');
}

document.addEventListener('jetlag:answer', (e) => {
  answerReceived(e.detail.timerId, { excused: !!e.detail.excused });
  render();
});

export function teamName(id) {
  const t = getState().game.teams.find((x) => x.id === id);
  return t ? t.name : 'unbekannt';
}

export function logNote(text) {
  update((s) => { s.game.log.push({ id: uid('lg'), at: Date.now(), kind: 'note', text }); });
}

// Gewertet wird die Nettozeit (abzüglich Strafen); sortiert nach der Wertungsart des
// Regelwerks – längste einzelne Runde oder Summe.
export function scoreboard() {
  const s = getState();
  const now = Date.now();
  const mode = Rules.scoringMode();
  return s.game.teams.map((t) => {
    const rounds = s.game.rounds.filter((r) => r.teamId === t.id);
    const total = rounds.reduce((sum, r) => sum + netDuration(r, now), 0);
    const best = rounds.reduce((m, r) => Math.max(m, netDuration(r, now)), 0);
    const deductions = rounds.reduce((sum, r) => sum + (r.deductionMs || 0), 0);
    return { team: t, rounds: rounds.length, total, best, deductions };
  }).sort((a, b) => (mode === 'totalTime' ? b.total - a.total : b.best - a.best));
}

export function exportText() {
  const s = getState();
  const lines = ['Jetlag-Protokoll', new Date().toLocaleString('de-DE'), ''];
  lines.push('WERTUNG');
  for (const row of scoreboard()) {
    lines.push(`  ${row.team.name}: gesamt ${formatClock(row.total, { withHours: true })}, beste Runde ${formatClock(row.best, { withHours: true })}, ${row.rounds} Runden`);
  }
  lines.push('', 'RUNDEN');
  for (const r of s.game.rounds) {
    lines.push(`  ${formatTime(r.startedAt)}–${r.endedAt ? formatTime(r.endedAt) : 'läuft'}  ${teamName(r.teamId)}  ${r.endedAt ? formatClock(netDuration(r), { withHours: true }) : ''}`
      + (r.deductionMs ? `  (−${formatClock(r.deductionMs)})` : '') + (r.verdict ? `  [${r.verdict.label}]` : ''));
  }
  lines.push('', 'EREIGNISSE');
  for (const e of s.game.log) lines.push(`  ${formatTime(e.at)}  ${e.text}`);
  return lines.join('\n');
}

export function render() {
  const host = document.getElementById('game-body');
  if (!host || document.getElementById('panel-game').hidden) return;
  const s = getState();
  clear(host);

  const round = activeRound();
  if (round) {
    host.append(roundCard(round));
  } else {
    host.append(el('div', { class: 'card' },
      el('div', { class: 'card-title', text: 'Keine Runde aktiv' }),
      s.game.teams.length
        ? el('div', { class: 'pills' }, s.game.teams.map((t) => el('button', {
          class: 'pill', onclick: () => { startRound(t.id); render(); },
        }, `▶︎ ${t.name}`)))
        : el('div', { class: 'hint', text: 'Erst ein Team anlegen.' }),
    ));
  }

  const rows = scoreboard();
  if (rows.length) {
    host.append(el('div', { class: 'card' },
      el('div', { class: 'card-title', text: 'Wertung' }),
      el('table', { class: 'scores' },
        el('tr', {}, el('th', { text: 'Team' }), el('th', { class: 'num', text: 'Gesamt' }), el('th', { class: 'num', text: 'Beste' }), el('th', { class: 'num', text: 'Rd.' })),
        rows.map((r) => el('tr', {},
          el('td', {}, el('span', { class: 'dot', style: { background: r.team.color, display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', marginRight: '6px' } }), r.team.name),
          el('td', { class: 'num mono', text: formatClock(r.total, { withHours: true }) }),
          el('td', { class: 'num mono', text: formatClock(r.best, { withHours: true }) }),
          el('td', { class: 'num', text: String(r.rounds) }))),
      ),
    ));
  }

  host.append(el('div', { class: 'row row-wrap' },
    el('button', {
      class: 'btn btn-small',
      onclick: async () => {
        const name = await promptSheet('Team anlegen', { label: 'Name', placeholder: 'Team Blau' });
        if (name) { addTeam(name); render(); }
      },
    }, '+ Team'),
    el('button', {
      class: 'btn btn-small',
      onclick: async () => {
        const text = await promptSheet('Notiz ins Protokoll', { label: 'Text', multiline: true });
        if (text) { logNote(text); render(); toast('Notiert', 'ok'); }
      },
    }, '+ Notiz'),
    el('button', { class: 'btn btn-small', onclick: () => openTeamManager() }, 'Teams verwalten'),
  ));

  const log = [...s.game.log].reverse().slice(0, 80);
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: `Protokoll (${s.game.log.length})` }),
    log.length
      ? el('div', {}, log.map((e) => el('div', { class: 'log-entry' },
        el('time', { text: formatTime(e.at) }), el('span', { text: e.text }))))
      : el('div', { class: 'hint', text: 'Jede ausgewertete Frage landet automatisch hier.' }),
  ));
}

function roundCard(round) {
  const box = el('div', { class: 'card', id: 'round-card' });
  fillRoundCard(box, round);
  return box;
}

function refreshRoundCard() {
  const r = activeRound();
  const box = document.getElementById('round-card');
  if (box && r) fillRoundCard(box, r);
}

function fillRoundCard(box, round) {
  clear(box);
  const now = Date.now();
  const phase = currentPhase(round);
  const s = getState();
  const unit = s.settings.unit;

  box.append(
    el('div', { class: 'card-sub', text: `Laufende Runde · ${PHASE_LABEL[phase]}` }),
    el('div', { class: 'card-title' }, teamName(round.teamId)),
    el('div', { class: 'timer-face', id: 'round-clock', text: formatClock(netDuration(round, now), { withHours: true }) }),
    el('div', { class: 'card-sub', text: `seit ${formatTime(round.startedAt)}`
      + (round.deductionMs ? ` · ${formatClock(round.deductionMs)} Abzug eingerechnet` : '') }),
  );
  if (round.verdict) {
    box.append(el('div', { class: 'toast error', style: { position: 'static' }, text: `Entschieden: ${round.verdict.label}` }));
  }

  // Fristen des Regelwerks
  for (const st of deadlineStatus(round, now)) {
    const titel = st.d.label || st.d.id;
    let text;
    if (st.ausgeloest) text = `abgelaufen → ${st.d.outcomeLabel || OUTCOME_LABEL[st.d.outcome || 'note']}`;
    else if (st.erreicht) text = 'erreicht';
    else if (st.faellig == null) text = `startet mit „${PHASE_LABEL[st.d.from || 'roundStart']}"`;
    else text = `noch ${formatClock(st.rest, { withHours: true })}`;
    box.append(el('div', { class: 'row' },
      el('span', { class: 'grow card-sub', text: titel }),
      el('span', { class: 'mono card-sub', text })));
  }

  // Ausstehende Folge einer verspäteten Antwort
  if (s.game.pending && (s.game.pending.nextDrawDelta || s.game.pending.nextQuestionFree)) {
    box.append(el('div', { class: 'hint', text: s.game.pending.nextQuestionFree
      ? 'Nächste Frage: gratis (verspätete Antwort)'
      : `Nächste Frage: ${s.game.pending.nextDrawDelta} Karte(n) (verspätete Antwort)` }));
  }

  // Endgame-Regeln: Bewegung und Antwortabstand zum Versteckpunkt
  const eg = Rules.endgameRules();
  if (phase === 'endgame' && (eg.answerWithinM != null || eg.hiderMayMove === false)) {
    const teile = [];
    if (eg.hiderMayMove === false) teile.push('nicht mehr bewegen');
    if (eg.answerWithinM != null) teile.push(`Antworten nur innerhalb ${formatDistance(eg.answerWithinM, unit)} vom Versteckpunkt`);
    box.append(el('div', { class: 'hint', text: `Endgame: ${teile.join(', ')}` }));
    const me = Loc.current();
    if (s.hidingSpot && me && eg.answerWithinM != null) {
      const d = distance(me, s.hidingSpot);
      const ok = d <= eg.answerWithinM;
      const genau = me.accuracy ? ` (GPS ±${Math.round(me.accuracy)} m)` : '';
      box.append(el('div', { class: 'card-sub', style: { color: ok ? 'var(--ok)' : 'var(--warn)' },
        text: `Abstand zum Versteckpunkt: ${formatDistance(d, unit)}${genau}` }));
    }
  }

  // Versteckzone: Fläche, Sperre und – falls das Regelwerk eine Haltestellenart nennt –
  // der Weg dorthin
  const hz = Rules.hidingZoneRules();
  if (s.hidingZone) {
    const lock = Zone.zoneLockedSince();
    box.append(el('div', { class: 'card-sub', text: `Versteckzone ${s.hidingZone.name || ''}: ${Zone.zoneSummary(s.hidingZone.radius)}`
      + (lock ? ` · festgelegt seit ${formatTime(lock.at)}` : '') }));
  }

  const knoepfe = el('div', { class: 'row row-wrap' });
  if (hz.anchorCategory && !Zone.zoneLockedSince()) {
    const cat = poiCategory(hz.anchorCategory);
    knoepfe.append(el('button', { class: 'btn btn-small', onclick: () => Zone.openAnchorPicker() },
      `⭕ Zone an ${cat ? cat.label : 'Haltestelle'}`));
  }
  if (phase === 'roundStart') {
    knoepfe.append(el('button', { class: 'btn btn-small', onclick: () => { markPhase('searchStart'); render(); } }, 'Versteckzeit vorbei · Suche beginnt'));
  }
  if (phase === 'searchStart') {
    knoepfe.append(el('button', { class: 'btn btn-small', onclick: () => { markPhase('endgame'); render(); } }, 'Endgame erreicht'));
  }
  knoepfe.append(el('button', { class: 'btn btn-small btn-primary', onclick: () => { endRound(round.id); render(); } }, 'Gefunden · Runde beenden'));
  box.append(knoepfe);
}

function openTeamManager() {
  openSheet('Teams', (body, close) => {
    const s = getState();
    if (!s.game.teams.length) body.append(el('div', { class: 'empty', text: 'Noch keine Teams.' }));
    for (const t of s.game.teams) {
      body.append(el('div', { class: 'row' },
        el('span', { class: 'dot', style: { background: t.color, width: '12px', height: '12px', borderRadius: '50%' } }),
        el('span', { class: 'grow', text: t.name }),
        el('button', {
          class: 'btn btn-small',
          onclick: async () => {
            const name = await promptSheet('Team umbenennen', { label: 'Name', value: t.name });
            if (name) { update((st) => { const x = st.game.teams.find((y) => y.id === t.id); if (x) x.name = name; }, 'Team umbenannt'); close(); render(); }
          },
        }, 'Umbenennen'),
        el('button', {
          class: 'btn btn-small btn-danger',
          onclick: async () => {
            if (!(await confirmSheet('Team löschen?', `${t.name} und dessen Runden entfernen.`, { danger: true, okLabel: 'Löschen' }))) return;
            update((st) => {
              st.game.teams = st.game.teams.filter((y) => y.id !== t.id);
              st.game.rounds = st.game.rounds.filter((r) => r.teamId !== t.id);
            }, 'Team gelöscht');
            close(); render();
          },
        }, 'Löschen'),
      ));
    }
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Fertig')];
  });
}

// Sekundengenaue Anzeige der laufenden Runde, ohne das ganze Panel neu zu bauen
document.addEventListener('jetlag:tick', () => {
  const clock = document.getElementById('round-clock');
  const r = activeRound();
  if (clock && r) clock.textContent = formatClock(netDuration(r), { withHours: true });
  checkDeadlines();
});
