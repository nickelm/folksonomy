// Live control for one sheet, built to be projected while it is driven.
//
// Shares the tag-cloud approach with the student page - pills are mutated in
// place, never rebuilt - because a cloud that reflows on every broadcast is
// unreadable on a projector and impossible to point at while talking.

import { api, checkSession, getToken, login } from '/auth.js';
import { connect } from '/common.js';

const slug = decodeURIComponent(location.pathname.replace(/^\/presenter\//, ''));

const loginPanel = document.getElementById('login');
const stage = document.getElementById('stage');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const titleEl = document.getElementById('sheet-title');
const joinUrlEl = document.getElementById('join-url');
const qrEl = document.getElementById('qr');
const connectedEl = document.getElementById('connected');
const statusBadge = document.getElementById('status-badge');
const listEl = document.getElementById('questions');

const qTitle = document.getElementById('q-title');
const qDesc = document.getElementById('q-desc');
const qType = document.getElementById('q-type');
const qOptions = document.getElementById('q-options');
const optionsField = document.getElementById('options-field');
const optionsHint = document.getElementById('options-hint');
const addBtn = document.getElementById('add-question');
const addHint = document.getElementById('add-hint');

const cards = new Map();
let socket = null;
let sheetStatus = 'draft';

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

async function boot() {
  if (await checkSession()) {
    start();
  } else {
    loginPanel.hidden = false;
    passwordInput.focus();
  }
}

async function doLogin() {
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    await login(passwordInput.value);
    passwordInput.value = '';
    loginPanel.hidden = true;
    start();
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener('click', doLogin);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

async function start() {
  stage.hidden = false;

  for (const [id, prefix] of [
    ['link-student', ''],
    ['link-live', 'live/'],
    ['link-dashboard', 'd/'],
  ]) {
    document.getElementById(id).href = `/${prefix}${encodeURIComponent(slug)}`;
  }

  await loadJoinDetails();

  socket = connect({
    slug,
    onState: render,
    onClusterStatus,
    onStatus(status) {
      if (status === 'online') socket?.send({ type: 'authenticate', token: getToken() });
    },
  });
}

async function loadJoinDetails() {
  try {
    const { url } = await (await fetch(`/api/sheets/${slug}/join`)).json();
    joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
    const svg = await (await fetch(`/api/sheets/${slug}/qr.svg`)).text();
    qrEl.innerHTML = svg;
  } catch {
    joinUrlEl.textContent = `${location.host}/${slug}`;
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function buildCard(question) {
  const root = document.createElement('section');
  root.className = 'question';

  const heading = document.createElement('h2');
  const desc = document.createElement('p');
  desc.className = 'desc';

  const controls = document.createElement('div');
  controls.className = 'q-controls';

  const activate = document.createElement('button');
  activate.className = 'btn btn-small btn-primary';

  const clear = document.createElement('button');
  clear.className = 'btn btn-small btn-danger';
  clear.textContent = 'Clear tags';

  const remove = document.createElement('button');
  remove.className = 'btn btn-small btn-danger';
  remove.textContent = 'Delete question';

  const cluster = document.createElement('button');
  cluster.className = 'btn btn-small';
  cluster.textContent = 'Find themes';
  cluster.title = 'Group these answers into themes with Claude';
  cluster.hidden = true;

  const meta = document.createElement('span');
  meta.className = 'stat-label';

  controls.append(activate, clear, cluster, remove, meta);

  const typeBadge = document.createElement('span');
  typeBadge.className = 'badge badge-type';

  const cloud = document.createElement('div');
  cloud.className = 'cloud';

  const feed = document.createElement('div');
  feed.className = 'feed feed-compact';
  feed.hidden = true;

  root.append(typeBadge, heading, desc, controls, cloud, feed);

  cluster.addEventListener('click', () => {
    socket?.send({ type: 'cluster_now', questionId: question.id });
    cluster.disabled = true;
    cluster.textContent = 'Thinking...';
  });

  activate.addEventListener('click', () => {
    socket?.send({
      type: 'set_active',
      questionId: root.dataset.active === 'true' ? null : question.id,
    });
  });

  clear.addEventListener('click', () => {
    const label = root.dataset.tagCount || '0';
    if (!confirm(`Delete all ${label} tags on "${heading.textContent}"?`)) return;
    socket?.send({ type: 'clear_tags', questionId: question.id });
  });

  remove.addEventListener('click', async () => {
    if (!confirm(`Delete the question "${heading.textContent}" and everything on it?`)) return;
    await api(`/api/questions/${question.id}`, { method: 'DELETE' });
  });

  const card = {
    root, heading, desc, activate, clear, remove, cluster, meta, typeBadge,
    cloud, feed, pills: new Map(), rows: new Map(),
  };
  cards.set(question.id, card);
  return card;
}

/**
 * The presenter's read of a freetext question: the answers, smallest useful
 * form. Not interactive - this page is for driving the room, and the responses
 * are here so the presenter can read one out, not vote on it.
 */
function renderFeed(card, question) {
  const responses = question.responses || [];
  const seen = new Set();

  responses.forEach((response, index) => {
    seen.add(response.id);
    let row = card.rows.get(response.id);

    if (!row) {
      row = document.createElement('article');
      row.className = 'response';

      const score = document.createElement('span');
      score.className = 'response-score';
      const text = document.createElement('p');
      text.className = 'response-text';
      const theme = document.createElement('span');
      theme.className = 'response-theme';

      row.append(score, text, theme);
      card.rows.set(response.id, row);
      card.feed.append(row);
    }

    row.querySelector('.response-score').textContent =
      response.score > 0 ? `+${response.score}` : String(response.score);
    row.querySelector('.response-text').textContent = response.text;

    const theme = row.querySelector('.response-theme');
    theme.textContent = response.clusterLabel || '';
    theme.hidden = !response.clusterLabel;

    const atIndex = card.feed.children[index];
    if (atIndex !== row) card.feed.insertBefore(row, atIndex || null);
  });

  for (const [id, row] of card.rows) {
    if (!seen.has(id)) {
      row.remove();
      card.rows.delete(id);
    }
  }
}

function scaleFor(count, max) {
  if (max <= 1) return 1.15;
  return 1.15 + Math.sqrt(count / max) * 1.15;
}

function renderCloud(card, question) {
  const tags = question.tags || [];
  const max = tags.reduce((m, t) => Math.max(m, t.count), 1);
  const seen = new Set();

  tags.forEach((tag, index) => {
    seen.add(tag.id);
    let pill = card.pills.get(tag.id);

    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'tag';

      const label = document.createElement('span');
      label.className = 'label';
      const count = document.createElement('span');
      count.className = 'count';

      const kill = document.createElement('button');
      kill.className = 'tag-remove';
      kill.type = 'button';
      kill.textContent = 'x';
      kill.title = 'Remove this tag';
      kill.addEventListener('click', () => {
        socket?.send({ type: 'remove_tag', questionId: question.id, tagId: tag.id });
      });

      pill.append(label, count, kill);
      card.pills.set(tag.id, pill);
      card.cloud.append(pill);
    }

    pill.querySelector('.label').textContent = tag.label;
    pill.querySelector('.count').textContent = tag.count;
    pill.style.fontSize = `${scaleFor(tag.count, max).toFixed(3)}rem`;

    const atIndex = card.cloud.children[index];
    if (atIndex !== pill) card.cloud.insertBefore(pill, atIndex || null);
  });

  for (const [tagId, pill] of card.pills) {
    if (!seen.has(tagId)) {
      pill.remove();
      card.pills.delete(tagId);
    }
  }
}

function render(state) {
  sheetStatus = state.sheet.status;
  titleEl.textContent = state.sheet.title;
  document.title = `${state.sheet.title} - presenter`;

  connectedEl.textContent = state.connectedCount;
  statusBadge.className = `badge badge-${sheetStatus}`;
  statusBadge.textContent = sheetStatus === 'live' ? 'Open to class' : sheetStatus;

  const closed = sheetStatus === 'closed';

  for (const question of state.questions) {
    const card = cards.get(question.id) || buildCard(question);
    if (!card.root.isConnected) listEl.append(card.root);

    card.heading.textContent = question.title;
    card.desc.textContent = question.description;
    card.desc.hidden = !question.description;

    card.root.classList.toggle('is-active', question.active);
    card.root.dataset.active = String(question.active);

    const freetext = question.type === 'freetext';
    const choice = question.type === 'choice';
    card.typeBadge.textContent = question.type;

    const responses = question.responses || [];
    const answerCount = freetext
      ? (question.responseCount ?? responses.length)
      : (question.tags || []).length;

    // The number of votes cast, not the net score: an answer with one up and one
    // down had two people vote on it, and reporting that as zero would tell the
    // presenter nobody engaged with the one answer the room disagreed about.
    const voteCount = freetext
      ? responses.reduce((sum, r) => sum + r.voteCount, 0)
      : (question.tags || []).reduce((sum, t) => sum + t.count, 0);

    card.root.dataset.tagCount = String(answerCount);

    card.activate.textContent = question.active ? 'Stop this question' : 'Ask this question';
    card.activate.disabled = closed;
    card.clear.disabled = closed || answerCount === 0;
    if (freetext) card.clear.textContent = 'Clear answers';
    else if (choice) card.clear.textContent = 'Clear votes';
    else card.clear.textContent = 'Clear tags';
    // Clearing a ballot removes the votes but keeps the options, so it stays
    // available even before anyone has voted - there is always something to undo.
    if (choice) card.clear.disabled = closed || voteCount === 0;
    card.remove.disabled = closed;

    // Under four answers there is nothing to find themes in, and the server
    // would refuse anyway - so say so with the button rather than an error.
    card.cluster.hidden = !freetext;
    if (freetext && !card.cluster.dataset.busy) {
      card.cluster.disabled = answerCount < 4;
      card.cluster.title = answerCount < 4
        ? 'Needs at least four answers'
        : 'Group these answers into themes with Claude';
    }

    let noun = 'tags';
    if (freetext) noun = 'answers';
    else if (choice) noun = 'options';
    const detail = `${answerCount} ${noun}, ${voteCount} votes`;
    card.meta.textContent = question.revealed
      ? detail
      : `${detail} - not shown to students yet`;

    card.cloud.hidden = freetext;
    card.feed.hidden = !freetext;
    if (freetext) renderFeed(card, question);
    else renderCloud(card, question);
  }

  state.questions.forEach((question, index) => {
    const card = cards.get(question.id);
    if (listEl.children[index] !== card.root) {
      listEl.insertBefore(card.root, listEl.children[index] || null);
    }
  });

  for (const [id, card] of cards) {
    if (!state.questions.some((q) => q.id === id)) {
      card.root.remove();
      cards.delete(id);
    }
  }

  addBtn.disabled = closed;
  qTitle.disabled = closed;
  qDesc.disabled = closed;
  qType.disabled = closed;
  qOptions.disabled = closed;
}

/** Reflect a clustering run on the button that started it. */
function onClusterStatus({ questionId, state, detail }) {
  const card = cards.get(questionId);
  if (!card) return;

  const busy = state === 'running';
  card.cluster.dataset.busy = busy ? '1' : '';
  card.cluster.disabled = busy;

  if (busy) {
    card.cluster.textContent = 'Thinking...';
    return;
  }

  card.cluster.textContent = 'Find themes';
  if (state === 'done') {
    card.cluster.title = 'Group these answers into themes with Claude';
  } else if (state === 'unavailable') {
    card.cluster.disabled = true;
    card.cluster.title = 'No ANTHROPIC_API_KEY is set on the server';
  } else if (state === 'too_few') {
    card.cluster.disabled = true;
    card.cluster.title = 'Needs at least four answers';
  } else if (state === 'error') {
    card.cluster.title = `That did not work: ${detail || 'unknown error'}`;
  }
}

function syncTypeFields() {
  const type = qType.value;
  optionsField.hidden = type === 'freetext';
  qOptions.placeholder = type === 'choice' ? 'art, engineering' : 'optional starting words';
  optionsHint.textContent = type === 'choice'
    ? 'Comma separated, at least two. Students pick exactly one.'
    : 'Comma separated, optional. Starting words the class can still add to.';
}

qType.addEventListener('change', syncTypeFields);
syncTypeFields();

addBtn.addEventListener('click', async () => {
  const title = qTitle.value.trim();
  if (!title) {
    addHint.textContent = 'Needs a question first.';
    addHint.classList.add('is-error');
    return;
  }
  addBtn.disabled = true;
  try {
    await api(`/api/sheets/${slug}/questions`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: qDesc.value.trim(),
        type: qType.value,
        options: qOptions.value.split(',').map((o) => o.trim()).filter(Boolean),
      }),
    });
    qTitle.value = '';
    qDesc.value = '';
    qOptions.value = '';
    addHint.classList.remove('is-error');
    addHint.textContent = 'Added.';
  } catch (err) {
    addHint.classList.add('is-error');
    addHint.textContent = err.message;
  } finally {
    addBtn.disabled = false;
  }
});

boot();
