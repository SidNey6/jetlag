// Würfel, Münze und eigene Listen (Karten, Flüche, Aufgaben).
// Die Listen sind absichtlich leer vorbelegt: Regelwerke unterscheiden sich,
// hier trägt jede Gruppe ihr eigenes ein.

import { getState, update, uid } from './state.js';
import { el, clear, openSheet, confirmSheet, promptSheet, toast } from './ui/ui.js';
import { logNote } from './rounds.js';

const DICE = [2, 4, 6, 8, 10, 12, 20, 100];

function rollDie(sides) {
  // crypto statt Math.random: bei Würfen, die eine Runde entscheiden, will man
  // keine Diskussion über die Qualität des Zufalls
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / sides) * sides;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return (buf[0] % sides) + 1;
}

export function pickRandom(items) {
  if (!items.length) return null;
  return items[rollDie(items.length) - 1];
}

export function openDiceSheet() {
  openSheet('Würfel', (body, close) => {
    const result = el('div', { class: 'timer-face', style: { textAlign: 'center', fontSize: '54px' }, text: '–' });
    const history = el('div', { class: 'hint', style: { textAlign: 'center' } });
    const past = [];
    const roll = (sides) => {
      const v = rollDie(sides);
      result.textContent = String(v);
      past.unshift(`W${sides}: ${v}`);
      history.textContent = past.slice(0, 8).join('  ·  ');
      if (navigator.vibrate) navigator.vibrate(18);
    };
    body.append(result, history,
      el('div', { class: 'pills' }, DICE.map((d) => el('button', { class: 'pill', onclick: () => roll(d) }, `W${d}`))),
      el('button', {
        class: 'btn btn-wide',
        onclick: () => {
          const v = rollDie(2);
          result.textContent = v === 1 ? 'Kopf' : 'Zahl';
          past.unshift(`Münze: ${result.textContent}`);
          history.textContent = past.slice(0, 8).join('  ·  ');
        },
      }, '🪙 Münze werfen'));
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Fertig')];
  });
}

export function openListsSheet() {
  openSheet('Eigene Listen', (body, close) => {
    const render = () => {
      clear(body);
      const s = getState();
      if (!s.lists.length) {
        body.append(el('div', { class: 'empty' },
          el('div', { text: 'Noch keine Liste.' }),
          el('div', { class: 'hint', style: { marginTop: '6px' }, text: 'Zum Beispiel „Flüche", „Fragekarten" oder „Aufgaben" – eine Zeile je Eintrag.' })));
      }
      for (const list of s.lists) {
        body.append(el('div', { class: 'card' },
          el('div', { class: 'card-title' }, el('span', { class: 'grow', text: list.name }), el('span', { class: 'card-sub', text: `${list.items.length} Einträge` }),),
          list.drawn?.length ? el('div', { class: 'card-sub', text: `gezogen: ${list.drawn.length}` }) : null,
          el('div', { class: 'row row-wrap' },
            el('button', {
              class: 'btn btn-small btn-primary',
              onclick: () => {
                const pool = list.items.filter((i) => !(list.drawn || []).includes(i));
                const pick = pickRandom(pool.length ? pool : list.items);
                if (!pick) return toast('Liste ist leer', 'error');
                update((st) => {
                  const l = st.lists.find((x) => x.id === list.id);
                  if (!pool.length) l.drawn = [];
                  l.drawn = [...(l.drawn || []), pick];
                });
                logNote(`Gezogen aus „${list.name}": ${pick}`);
                showDraw(list.name, pick);
                render();
              },
            }, '🎴 Ziehen'),
            el('button', {
              class: 'btn btn-small',
              onclick: async () => {
                const text = await promptSheet(list.name, {
                  label: 'Einträge, eine Zeile je Eintrag', multiline: true, value: list.items.join('\n'),
                });
                if (text == null) return;
                update((st) => {
                  const l = st.lists.find((x) => x.id === list.id);
                  l.items = text.split('\n').map((x) => x.trim()).filter(Boolean);
                }, 'Liste bearbeitet');
                render();
              },
            }, 'Bearbeiten'),
            list.drawn?.length ? el('button', {
              class: 'btn btn-small',
              onclick: () => { update((st) => { st.lists.find((x) => x.id === list.id).drawn = []; }); render(); },
            }, 'Stapel zurück') : null,
            el('div', { class: 'spacer' }),
            el('button', {
              class: 'btn btn-small btn-danger',
              onclick: async () => {
                if (!(await confirmSheet('Liste löschen?', list.name, { danger: true, okLabel: 'Löschen' }))) return;
                update((st) => { st.lists = st.lists.filter((x) => x.id !== list.id); }, 'Liste gelöscht');
                render();
              },
            }, '✕'),
          ),
        ));
      }
      body.append(el('button', {
        class: 'btn btn-wide',
        onclick: async () => {
          const name = await promptSheet('Neue Liste', { label: 'Name', placeholder: 'Flüche' });
          if (!name) return;
          const text = await promptSheet(name, { label: 'Einträge, eine Zeile je Eintrag', multiline: true });
          update((st) => {
            st.lists.push({ id: uid('ls'), name, items: (text || '').split('\n').map((x) => x.trim()).filter(Boolean), drawn: [] });
          }, 'Liste angelegt');
          render();
        },
      }, '+ Liste anlegen'));
    };
    render();
    return [];
  });
}

function showDraw(listName, text) {
  openSheet(listName, (body, close) => {
    body.append(el('div', { style: { fontSize: '20px', fontWeight: '600', textAlign: 'center', padding: '18px 4px' }, text }));
    return [el('button', { class: 'btn grow btn-primary', onclick: () => close() }, 'Verstanden')];
  });
  if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
}
