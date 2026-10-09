// Timer. Alles rechnet auf Zeitstempeln statt auf Intervall-Ticks:
// iOS friert Hintergrund-Timer ein, ein mitgezählter Intervall-Zähler wäre nach dem
// Aufwecken falsch. Der Tick zeichnet nur, er misst nicht.

import { getState, update, uid } from './state.js';
import { el, clear, openSheet, toast, formatClock, segmented, icon, iconButton, button } from './ui/ui.js';
import { wantAwake } from './wakelock.js';

// Die Anzeige ist sekundengenau – ein Vierteltakt hätte nur viermal so viele
// Aufwachvorgänge gekostet, ohne dass man etwas davon sieht.
const TICK_MS = 1000;

let ticker = null;
let audioCtx = null;

export function elapsed(t, now = Date.now()) {
  const base = t.accumulated || 0;
  return t.running && t.startedAt ? base + (now - t.startedAt) : base;
}

export function remaining(t, now = Date.now()) {
  return t.kind === 'countdown' ? t.duration - elapsed(t, now) : elapsed(t, now);
}

// meta: zusätzliche Angaben, z. B. { purpose: 'answer', categoryId } für Antwortfristen –
// damit lässt sich später auswerten, ob und wie weit eine Antwort zu spät kam.
export function createTimer({ name, kind = 'countdown', duration = 15 * 60000, autostart = true, meta = null }) {
  const t = {
    id: uid('tm'), name, kind, duration,
    accumulated: 0, startedAt: autostart ? Date.now() : null, running: autostart, alarmed: false,
    meta,
  };
  update((s) => { s.timers.push(t); }, 'Timer angelegt');
  ensureTicking();
  return t;
}

export function toggleTimer(id) {
  update((s) => {
    const t = s.timers.find((x) => x.id === id);
    if (!t) return;
    if (t.running) {
      t.accumulated = elapsed(t);
      t.running = false;
      t.startedAt = null;
    } else {
      t.startedAt = Date.now();
      t.running = true;
      if (t.kind === 'countdown' && remaining(t) <= 0) { t.accumulated = 0; t.alarmed = false; }
    }
  });
  ensureTicking();
}

export function resetTimer(id) {
  update((s) => {
    const t = s.timers.find((x) => x.id === id);
    if (!t) return;
    t.accumulated = 0;
    t.startedAt = t.running ? Date.now() : null;
    t.alarmed = false;
  });
}

// Zeit hinzufügen (ms > 0) oder abziehen (ms < 0). Beim Countdown ändert sich die
// Restzeit, bei der Stoppuhr die gemessene Zeit. Wird ein Countdown dadurch fällig,
// meldet er sich beim nächsten Takt wie gewohnt.
export function addTime(id, ms) {
  update((s) => {
    const t = s.timers.find((x) => x.id === id);
    if (!t) return;
    const now = Date.now();
    if (t.kind === 'countdown') {
      t.duration = Math.max(0, t.duration + ms);
      t.alarmed = t.alarmed && remaining(t, now) <= 0;
    } else {
      setElapsed(t, Math.max(0, elapsed(t, now) + ms), now);
    }
  });
  ensureTicking();
}

// Restzeit (Countdown) bzw. Stand (Stoppuhr) direkt setzen
export function setTimerValue(id, ms) {
  update((s) => {
    const t = s.timers.find((x) => x.id === id);
    if (!t) return;
    const now = Date.now();
    if (t.kind === 'countdown') {
      t.duration = Math.max(0, elapsed(t, now) + ms);
      t.alarmed = false;
    } else {
      setElapsed(t, Math.max(0, ms), now);
    }
  });
  ensureTicking();
}

function setElapsed(t, ms, now) {
  t.accumulated = ms;
  if (t.running) t.startedAt = now;
}

export function removeTimer(id) {
  update((s) => { s.timers = s.timers.filter((t) => t.id !== id); }, 'Timer gelöscht');
  ensureTicking();
}

/* ---------- Alarm ---------- */

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + i * 0.45);
      gain.gain.exponentialRampToValueAtTime(0.5, now + i * 0.45 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.45 + 0.32);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.45);
      osc.stop(now + i * 0.45 + 0.35);
    }
  } catch (e) { /* Ton ist Kür, kein Muss */ }
}

// Erster Nutzer-Tap schaltet Audio frei – iOS erlaubt Ton sonst nicht.
export function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* egal */ }
}

// Alarm für Regelereignisse (abgelaufene Fristen) – derselbe Ton wie bei Timern.
export function ringAlarm(text) {
  beep();
  if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 600]);
  toast(text, 'error');
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Jetlag Toolkit', { body: text }); } catch (e) { /* egal */ }
  }
}

function fireAlarm(t) {
  beep();
  if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 500]);
  toast(`${t.name} abgelaufen`, 'error');
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Jetlag Toolkit', { body: `${t.name} abgelaufen`, tag: t.id }); } catch (e) { /* egal */ }
  }
}

/* ---------- Wake Lock ---------- */

function refreshWakeLock() {
  wantAwake('timers', getState().timers.some((t) => t.running));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ensureTicking();
    tick();
  } else if (ticker) {
    // Zeit läuft über Zeitstempel weiter – der Takt darf ruhen
    clearInterval(ticker);
    ticker = null;
  }
});

/* ---------- Tick ---------- */

function ensureTicking() {
  const running = getState().timers.some((t) => t.running);
  if (running && !ticker) ticker = setInterval(tick, TICK_MS);
  if (!running && ticker) { clearInterval(ticker); ticker = null; tick(); }
  refreshWakeLock();
}

function tick() {
  const s = getState();
  let changed = false;
  for (const t of s.timers) {
    if (t.kind === 'countdown' && t.running && !t.alarmed && remaining(t) <= 0) {
      t.alarmed = true;
      changed = true;
      fireAlarm(t);
    }
    // Eine abgelaufene Antwortfrist läuft ins Negative weiter: die Anzeige zeigt dann die Verspätung
  }
  if (changed) update(() => {});
  if (changed) renderTimers(); else updateFaces();
  updateBadge();
  document.dispatchEvent(new CustomEvent('jetlag:tick'));
}

export function startEngine() {
  ensureTicking();
  renderTimers();
}

/* ---------- Oberfläche ---------- */

const PRESETS = [
  { label: '1 Min', ms: 60000 }, { label: '3 Min', ms: 180000 }, { label: '5 Min', ms: 300000 },
  { label: '10 Min', ms: 600000 }, { label: '15 Min', ms: 900000 }, { label: '30 Min', ms: 1800000 },
  { label: '45 Min', ms: 2700000 }, { label: '1 Std', ms: 3600000 }, { label: '2 Std', ms: 7200000 },
];

export function openNewTimerSheet() {
  let kind = 'countdown';
  let duration = 900000;
  let name = '';
  openSheet('Neuer Timer', (body, close) => {
    const nameInput = el('input', { placeholder: 'z. B. Versteckzeit' });
    nameInput.addEventListener('input', () => { name = nameInput.value; });
    const durField = el('label', { class: 'field' }, 'Dauer',
      el('div', { class: 'pills' }, PRESETS.map((p) => el('button', {
        class: `pill ${p.ms === duration ? 'on' : ''}`,
        onclick: (e) => {
          duration = p.ms;
          durField.querySelectorAll('.pill').forEach((x) => x.classList.remove('on'));
          e.target.classList.add('on');
          minutes.value = String(Math.round(p.ms / 60000));
        },
      }, p.label))));
    const minutes = el('input', { type: 'number', inputmode: 'numeric', value: '15', min: '0' });
    minutes.addEventListener('input', () => {
      const v = parseFloat(minutes.value.replace(',', '.'));
      if (isFinite(v)) duration = Math.round(v * 60000);
    });
    durField.append(el('div', { class: 'row' }, el('label', { class: 'field grow' }, 'Minuten', minutes)));

    body.append(
      el('label', { class: 'field' }, 'Name', nameInput),
      el('label', { class: 'field' }, 'Art', segmented(
        [{ value: 'countdown', label: 'Countdown' }, { value: 'stopwatch', label: 'Stoppuhr' }],
        kind,
        (v) => { kind = v; durField.style.display = v === 'countdown' ? '' : 'none'; },
      )),
      durField,
    );

    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => {
          primeAudio();
          createTimer({ name: name || (kind === 'countdown' ? 'Countdown' : 'Stoppuhr'), kind, duration });
          close();
          renderTimers();
        },
      }, 'Starten'),
    ];
  });
}

// Nur die Ziffern austauschen, solange sich die Timerliste selbst nicht ändert.
// Ein kompletter DOM-Neuaufbau pro Sekunde ist auf älteren Geräten spürbar.
let renderedSignature = null;
const faceNodes = new Map();

export function updateFaces() {
  if (!faceNodes.size) return;
  const now = Date.now();
  for (const t of getState().timers) {
    const node = faceNodes.get(t.id);
    if (!node) continue;
    const rest = remaining(t, now);
    const over = t.kind === 'countdown' && rest <= 0;
    const text = formatClock(rest);
    if (node.face.textContent !== text) node.face.textContent = text;
    node.face.classList.toggle('over', over);
    if (node.bar) {
      node.bar.style.width = `${Math.max(0, Math.min(100, (rest / t.duration) * 100))}%`;
      node.bar.style.background = over ? 'var(--danger)' : 'var(--accent)';
    }
  }
}

export function renderTimers() {
  const host = document.getElementById('timer-list');
  if (!host || document.getElementById('panel-timers').hidden) { updateBadge(); return; }
  const s = getState();
  const now = Date.now();

  const signature = s.timers.map((t) => `${t.id}:${t.running}:${t.kind}:${t.duration}:${t.name}`).join('|');
  if (signature === renderedSignature) { updateFaces(); updateBadge(); return; }
  renderedSignature = signature;
  faceNodes.clear();
  clear(host);

  if (!s.timers.length) {
    host.append(el('div', { class: 'empty' },
      el('div', { text: 'Keine Timer.' }),
      el('div', { class: 'hint', style: { marginTop: '6px' }, text: 'Versteckzeit, Fragen-Sperre, Fluchdauer – beliebig viele parallel.' })));
    updateBadge();
    return;
  }

  for (const t of s.timers) {
    const rest = remaining(t, now);
    const over = t.kind === 'countdown' && rest <= 0;
    const face = el('div', { class: `timer-face ${over ? 'over' : ''}`, text: formatClock(rest) });
    const bar = t.kind === 'countdown'
      ? el('i', { style: { width: `${Math.max(0, Math.min(100, (rest / t.duration) * 100))}%`, background: over ? 'var(--danger)' : 'var(--accent)' } })
      : null;
    faceNodes.set(t.id, { face, bar });
    host.append(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('span', { class: 'grow', text: t.name }),
        el('span', { class: 'card-sub', text: t.kind === 'countdown' ? 'Countdown' : 'Stoppuhr' })),
      face,
      bar ? el('div', { class: 'progress' }, bar) : null,
      // Antwortfristen enden nicht von selbst: erst "Antwort da" zeigt, ob und wie weit
      // sie überzogen wurde – daran hängen die Folgen aus dem Regelwerk.
      t.meta && t.meta.purpose === 'answer' ? el('div', { class: 'row row-wrap' },
        button('check', 'Antwort da',
          () => document.dispatchEvent(new CustomEvent('jetlag:answer', { detail: { timerId: t.id } })),
          'btn btn-small btn-primary'),
        button('check', 'Entschuldigt',
          () => document.dispatchEvent(new CustomEvent('jetlag:answer', { detail: { timerId: t.id, excused: true } }))),
      ) : null,
      el('div', { class: 'row timer-controls' },
        iconButton(t.running ? 'pause' : 'play', () => { primeAudio(); toggleTimer(t.id); renderTimers(); },
          t.running ? 'Pause' : 'Start', 'icon-btn-solid'),
        el('div', { class: 'stepper' },
          el('button', { onclick: () => { addTime(t.id, -60000); updateFaces(); }, 'aria-label': 'Eine Minute weniger' }, icon('minus')),
          el('span', { class: 'stepper-label', text: '1 min' }),
          el('button', { onclick: () => { addTime(t.id, 60000); updateFaces(); }, 'aria-label': 'Eine Minute mehr' }, icon('plus'))),
        iconButton('sliders', () => openAdjustSheet(t.id), 'Zeit anpassen'),
        el('div', { class: 'spacer' }),
        iconButton('reset', () => { resetTimer(t.id); renderTimers(); }, 'Zurücksetzen'),
        iconButton('trash', () => { removeTimer(t.id); renderTimers(); }, 'Löschen', 'danger'),
      ),
    ));
  }
  updateBadge();
}

// Zeit gezielt korrigieren: z. B. weil eine Nachricht verspätet ankam
function openAdjustSheet(id) {
  const t = getState().timers.find((x) => x.id === id);
  if (!t) return;
  const countdown = t.kind === 'countdown';
  let takt = null;
  openSheet(`${t.name} anpassen`, (body, close) => {
    const readout = el('div', { class: 'timer-face', style: { textAlign: 'center' } });
    const paint = () => {
      const cur = getState().timers.find((x) => x.id === id);
      if (cur) readout.textContent = formatClock(remaining(cur));
    };
    paint();
    const step = (min) => el('button', {
      class: 'pill',
      onclick: () => { addTime(id, min * 60000); paint(); renderTimers(); },
    }, `${min > 0 ? '+' : '−'}${Math.abs(min)} min`);

    const input = el('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', placeholder: 'Minuten' });
    body.append(
      readout,
      el('div', { class: 'hint', style: { textAlign: 'center' }, text: countdown ? 'Restzeit' : 'Gemessene Zeit' }),
      el('div', { class: 'pills pills-center' }, step(-10), step(-5), step(-1)),
      el('div', { class: 'pills pills-center' }, step(1), step(5), step(10)),
      el('label', { class: 'field' }, countdown ? 'Restzeit setzen (Minuten)' : 'Stand setzen (Minuten)',
        el('div', { class: 'row' }, input,
          el('button', {
            class: 'btn',
            onclick: () => {
              const v = parseFloat(String(input.value).replace(',', '.'));
              if (!isFinite(v) || v < 0) return toast('Keine gültige Zahl', 'error');
              setTimerValue(id, Math.round(v * 60000));
              paint();
              renderTimers();
            },
          }, 'Setzen'))),
    );
    takt = setInterval(paint, 1000);
    return [el('button', { class: 'btn grow btn-primary', onclick: () => close() }, 'Fertig')];
  }, { onClose: () => clearInterval(takt) });
}

function updateBadge() {
  const badge = document.getElementById('badge-timers');
  if (!badge) return;
  const running = getState().timers.filter((t) => t.running).length;
  badge.hidden = running === 0;
  badge.textContent = String(running);
}
