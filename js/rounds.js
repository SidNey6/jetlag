// Teams, Runden, Protokoll und Wertung.
// Bewusst formatoffen: Gewertet wird die Dauer je Runde – wer daraus Punkte macht,
// entscheidet die Hausregel.

import { getState, update, uid } from './state.js';
import { el, clear, openSheet, confirmSheet, promptSheet, toast, formatClock, formatTime } from './ui/ui.js';

const COLORS = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#facc15'];

export function activeRound() {
  return getState().game.rounds.find((r) => !r.endedAt) || null;
}

export function addTeam(name) {
  update((s) => {
    s.game.teams.push({ id: uid('tm'), name, color: COLORS[s.game.teams.length % COLORS.length] });
  }, 'Team angelegt');
}

export function startRound(teamId) {
  update((s) => {
    for (const r of s.game.rounds) if (!r.endedAt) r.endedAt = Date.now();
    const r = { id: uid('rd'), teamId, startedAt: Date.now(), endedAt: null, note: '' };
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
      text: `Runde beendet: ${teamName(r.teamId)} – ${formatClock(r.endedAt - r.startedAt, { withHours: true })}`,
    });
  }, 'Runde beendet');
}

export function teamName(id) {
  const t = getState().game.teams.find((x) => x.id === id);
  return t ? t.name : 'unbekannt';
}

export function logNote(text) {
  update((s) => { s.game.log.push({ id: uid('lg'), at: Date.now(), kind: 'note', text }); });
}

export function scoreboard() {
  const s = getState();
  const now = Date.now();
  return s.game.teams.map((t) => {
    const rounds = s.game.rounds.filter((r) => r.teamId === t.id);
    const total = rounds.reduce((sum, r) => sum + ((r.endedAt || now) - r.startedAt), 0);
    const best = rounds.reduce((m, r) => Math.max(m, (r.endedAt || now) - r.startedAt), 0);
    return { team: t, rounds: rounds.length, total, best };
  }).sort((a, b) => b.total - a.total);
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
    lines.push(`  ${formatTime(r.startedAt)}–${r.endedAt ? formatTime(r.endedAt) : 'läuft'}  ${teamName(r.teamId)}  ${r.endedAt ? formatClock(r.endedAt - r.startedAt, { withHours: true }) : ''}`);
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
    host.append(el('div', { class: 'card' },
      el('div', { class: 'card-sub', text: 'Laufende Runde' }),
      el('div', { class: 'card-title' }, teamName(round.teamId)),
      el('div', { class: 'timer-face', id: 'round-clock', text: formatClock(Date.now() - round.startedAt, { withHours: true }) }),
      el('div', { class: 'card-sub', text: `seit ${formatTime(round.startedAt)}` }),
      el('button', { class: 'btn btn-primary btn-wide', onclick: () => { endRound(round.id); render(); } }, 'Runde beenden'),
    ));
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
  if (clock && r) clock.textContent = formatClock(Date.now() - r.startedAt, { withHours: true });
});
