// Kleine DOM-Helfer: Elemente bauen, Sheets öffnen, Toasts zeigen.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// DOM-append fügt bei null den Text "null" ein. Dieser Helfer überspringt
// leere Kinder, damit bedingte Zeilen (`x ? el(...) : null`) gefahrlos sind.
export function append(node, ...children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------- Toast ---------- */
export function toast(text, kind = '') {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: `toast ${kind}`, text });
  root.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, kind === 'error' ? 4200 : 2400);
}
if (typeof document !== 'undefined') {
  document.addEventListener('jetlag:toast', (e) => toast(e.detail.text, e.detail.kind || ''));
}

/* ---------- Sheet ---------- */
// build(body, close) füllt den Inhalt; Rückgabe darf ein Array von Fußzeilen-Buttons sein.
export function openSheet(title, build, opts = {}) {
  const root = document.getElementById('sheet-root');
  const body = el('div', { class: 'sheet-body' });
  const foot = el('div', { class: 'sheet-foot' });
  const sheet = el('div', { class: 'sheet' },
    el('div', { class: 'sheet-head' },
      el('h2', { text: title }),
      el('button', { class: 'btn btn-small btn-ghost', onclick: () => close(), 'aria-label': 'Schließen' }, '✕'),
    ),
    body, foot,
  );
  const backdrop = el('div', {
    class: 'sheet-backdrop',
    onclick: (e) => { if (e.target === backdrop && opts.dismissable !== false) close(); },
  }, sheet);
  root.append(backdrop);

  let onClose = opts.onClose;
  function close(result) {
    backdrop.remove();
    if (onClose) onClose(result);
  }
  const buttons = build(body, close) || [];
  if (buttons.length) foot.append(...buttons); else foot.remove();
  return { close, body, sheet };
}

export function confirmSheet(title, message, { danger = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(title, (body, close) => {
      body.append(el('p', { text: message, style: { margin: '4px 0' } }));
      return [
        el('button', { class: 'btn grow', onclick: () => { done = true; close(); resolve(false); } }, 'Abbrechen'),
        el('button', {
          class: `btn grow ${danger ? 'btn-danger' : 'btn-primary'}`,
          onclick: () => { done = true; close(); resolve(true); },
        }, okLabel),
      ];
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}

export function promptSheet(title, { label = '', value = '', placeholder = '', multiline = false, okLabel = 'Speichern' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(title, (body, close) => {
      const input = el(multiline ? 'textarea' : 'input', { value, placeholder });
      if (multiline) input.value = value;
      body.append(el('label', { class: 'field' }, label, input));
      setTimeout(() => input.focus(), 60);
      const ok = () => { done = true; close(); resolve(input.value.trim() || null); };
      if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      return [
        el('button', { class: 'btn grow', onclick: () => { done = true; close(); resolve(null); } }, 'Abbrechen'),
        el('button', { class: 'btn grow btn-primary', onclick: ok }, okLabel),
      ];
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

/* ---------- Eingabe-Bausteine ---------- */
export function segmented(options, value, onChange) {
  const wrap = el('div', { class: 'seg' });
  options.forEach((o) => {
    const b = el('button', {
      class: o.value === value ? 'on' : '',
      onclick: () => {
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(o.value);
      },
    }, o.label);
    wrap.append(b);
  });
  return wrap;
}

export function pillRow(options, onPick, activeValue) {
  return el('div', { class: 'pills' }, options.map((o) => el('button', {
    class: `pill ${o.value === activeValue ? 'on' : ''}`,
    onclick: () => onPick(o.value),
  }, o.label)));
}

export function formatClock(ms, { withHours = null } = {}) {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const showH = withHours == null ? h > 0 : withHours;
  return `${neg ? '−' : ''}${showH ? `${h}:${pad(m)}` : m}:${pad(s)}`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
