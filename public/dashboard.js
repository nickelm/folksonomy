// Dashboard: one question, six ways.
//
// The grid is the overview; any panel expands to fill the viewport when clicked,
// because several of these (the cloud, the co-occurrence graph) are unreadable
// at grid size and are there to be opened.
//
// Live data arrives on the same socket every other page uses. The derived views
// - co-occurrence, vote timing - come from a REST endpoint on a slow poll: they
// are expensive to compute and nobody is watching them change second to second.

import { createAdvance } from '/advance.js';
import { connect, loadJoinDetails } from '/common.js';
import { PANELS, coloursFor } from '/panels.js';

const slug = decodeURIComponent(location.pathname.replace(/^\/d\//, ''));

const titleEl = document.getElementById('sheet-title');
const subEl = document.getElementById('sheet-sub');
const joinUrlEl = document.getElementById('join-url');
const joinHintEl = document.getElementById('join-hint');
const qrEl = document.getElementById('qr');
const advanceHost = document.getElementById('advance');
const pickerEl = document.getElementById('picker');
const gridEl = document.getElementById('grid');
const emptyEl = document.getElementById('empty');

const ANALYTICS_INTERVAL_MS = 5000;
const RESIZE_DEBOUNCE_MS = 90;

/** @type {Map<string, {root, body, panel, timer}>} */
const mounted = new Map();

let state = null;
let analytics = null;
let selectedId = null;
let maximised = null;

// --------------------------------------------------------------------------
// Which question we are looking at
// --------------------------------------------------------------------------

/**
 * Questions with something to show.
 *
 * Filtered on `revealed`, not on whether data came along. Once a presenter has
 * signed in on this page, the socket carries the presenter payload, which
 * includes tags and answers for questions the class has not seen - and this
 * page may be on the projector.
 */
function available() {
  if (!state) return [];
  return state.questions.filter((q) => q.revealed);
}

function current() {
  const list = available();
  return list.find((q) => q.id === selectedId) || list[0] || null;
}

function selectQuestion(id) {
  if (selectedId !== id) {
    selectedId = id;
    // A different question is different data in every panel: throw the DOM
    // away rather than transition one question's chart into another's.
    for (const entry of mounted.values()) {
      clearTimeout(entry.timer);
      entry.root.remove();
    }
    mounted.clear();
  }
  // Repaint the tabs here too. Waiting for the next broadcast would leave
  // the highlight on the old question, and on a quiet sheet there may not
  // be a next broadcast for minutes.
  renderPicker();
  renderAll();
}

function renderPicker() {
  const list = available();
  const question = current();

  pickerEl.replaceChildren();

  list.forEach((q, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-tab';
    button.classList.toggle('is-current', q.id === question?.id);
    button.setAttribute('aria-pressed', String(q.id === question?.id));

    const number = document.createElement('span');
    number.className = 'picker-number';
    number.textContent = String(index + 1);

    const label = document.createElement('span');
    label.textContent = q.title;

    const kind = document.createElement('span');
    kind.className = 'picker-kind';
    kind.textContent = q.type === 'freetext' ? 'freetext' : 'tags';

    button.append(number, label, kind);
    button.addEventListener('click', () => {
      if (selectedId !== q.id) selectQuestion(q.id);
    });

    pickerEl.append(button);
  });

  pickerEl.hidden = list.length === 0;
}

// --------------------------------------------------------------------------
// Panels
// --------------------------------------------------------------------------

function mount(panel) {
  const root = document.createElement('section');
  root.className = 'panel-card';
  root.dataset.panel = panel.id;

  const head = document.createElement('header');
  head.className = 'panel-head';

  const title = document.createElement('h3');
  title.textContent = panel.title;

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'panel-expand';
  expand.title = 'Fill the screen';
  expand.setAttribute('aria-label', `Maximise ${panel.title}`);
  expand.textContent = '⤢';

  head.append(title, expand);

  const hint = document.createElement('p');
  hint.className = 'panel-hint';
  hint.textContent = panel.hint;

  const body = document.createElement('div');
  body.className = 'panel-body';

  root.append(head, hint, body);

  const entry = { root, body, panel, timer: null };

  const toggle = () => setMaximised(maximised === panel.id ? null : panel.id);
  expand.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  root.addEventListener('click', (event) => {
    // Let people select text in the raw feed without the panel jumping.
    if (window.getSelection()?.toString()) return;
    if (event.target.closest('a, button') && event.target !== root) return;
    toggle();
  });

  // One observer per panel is what makes maximising and window resizing the same
  // event as far as a panel is concerned - it only ever hears "you are this big".
  //
  // A resize is somebody doing something, so it redraws promptly. Only enough
  // delay to coalesce a window drag - not the panel's own data debounce, which
  // would leave a maximised cloud sitting at its old size for a full second
  // after the click that maximised it.
  new ResizeObserver(() => schedule(entry, RESIZE_DEBOUNCE_MS)).observe(body);

  mounted.set(panel.id, entry);
  gridEl.append(root);
  return entry;
}

/**
 * Draw one panel, after `delay` ms.
 *
 * Data updates pass the panel's own debounce: the word cloud's layout is a
 * spiral packing search, and re-running it on every 300ms broadcast would keep
 * it permanently mid-computation and never settle. Resizes pass a much shorter
 * one, because a resize is a person waiting for something to happen.
 */
function schedule(entry, delay = entry.panel.debounce || 0) {
  if (!delay) return paint(entry);

  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => paint(entry), delay);
  return undefined;
}

function paint(entry) {
  const question = current();
  if (!question) return;

  const rect = entry.body.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;

  const questionAnalytics = (analytics?.questions || []).find((q) => q.id === question.id);

  try {
    entry.panel.render({
      root: entry.body,
      question,
      analytics: questionAnalytics,
      colours: coloursFor(question),
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    });
  } catch (err) {
    // One panel throwing must not take the other five with it.
    entry.body.replaceChildren();
    const p = document.createElement('p');
    p.className = 'panel-empty';
    p.textContent = `This panel could not draw: ${err.message}`;
    entry.body.append(p);
  }
}

function renderAll() {
  const question = current();

  emptyEl.hidden = Boolean(question);
  gridEl.hidden = !question;
  if (!question) return;

  for (const panel of PANELS) {
    const entry = mounted.get(panel.id) || mount(panel);
    // A fresh mount paints from its ResizeObserver's first callback; an existing
    // one needs telling that the data moved.
    if (entry.root.isConnected && entry.body.childElementCount > 0) schedule(entry);
  }
}

// --------------------------------------------------------------------------
// Maximise
// --------------------------------------------------------------------------

function setMaximised(id) {
  maximised = id;
  gridEl.classList.toggle('has-max', Boolean(id));
  for (const [panelId, entry] of mounted) {
    entry.root.classList.toggle('is-max', panelId === id);
  }
  // No explicit repaint: changing the class resizes the body, and every panel's
  // ResizeObserver is already watching for exactly that.
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && maximised) setMaximised(null);
});

// --------------------------------------------------------------------------
// Data
// --------------------------------------------------------------------------

async function loadAnalytics() {
  try {
    const response = await fetch(`/api/sheets/${encodeURIComponent(slug)}/analytics`);
    if (!response.ok) return;
    analytics = await response.json();
    for (const entry of mounted.values()) schedule(entry);
  } catch {
    // A dropped poll is not worth surfacing; the next one is five seconds away.
  }
}

let socket = null;

const advance = createAdvance({
  host: advanceHost,
  send: (msg) => socket?.send(msg) ?? false,
});

socket = connect({
  slug,
  onState(next) {
    const previousActive = state ? state.activeQuestionId : undefined;
    state = next;
    titleEl.textContent = next.sheet.title;
    document.title = `${next.sheet.title} - dashboard`;

    const closed = next.sheet.status === 'closed';
    const badge = next.sheet.status === 'live' ? 'Live now' : next.sheet.status;
    subEl.textContent = `${badge} · ${next.connectedCount} connected`;

    // The address stays: it is where the record lives. The QR code is an
    // invitation to join, and a closed sheet takes nobody in.
    qrEl.hidden = closed;
    joinHintEl.textContent = closed
      ? 'This sheet is closed. The address stays as the record.'
      : 'Open this address on your phone, or scan the code.';

    advance.update(next);

    // Follow the presenter: when the active question moves, so does the view.
    // Only on a change, not on first load - somebody opening the dashboard
    // afterwards to browse should land on the first question, not the last.
    const activeMoved = previousActive !== undefined
      && next.activeQuestionId != null
      && next.activeQuestionId !== previousActive;
    if (activeMoved) selectQuestion(next.activeQuestionId);
    else {
      renderPicker();
      renderAll();
    }
  },
  onStatus(status) {
    if (status === 'online') advance.online();
  },
  onError(reason) {
    advance.error(reason);
  },
});

loadJoinDetails(slug, { urlEl: joinUrlEl, qrEl });
loadAnalytics();
setInterval(loadAnalytics, ANALYTICS_INTERVAL_MS);
