// Student view of one folksonomy sheet.
//
// The whole file is organised around one constraint: state arrives every ~300ms
// while a student may be mid-word in a text field. So nothing is ever rebuilt
// from scratch. Question cards and tag pills are created once and then mutated
// in place, and the input element is never touched by an update.

import { connect, getSessionId, responseVoteStore, votedStore } from '/common.js';

const MAX_RESPONSE_LENGTH = 280;

const slug = decodeURIComponent(location.pathname.replace(/^\//, ''));
const sessionId = getSessionId();
const voted = votedStore(slug);
const myVotes = responseVoteStore(slug);

const titleEl = document.getElementById('sheet-title');
const subEl = document.getElementById('sheet-sub');
const bannerEl = document.getElementById('banner');
const listEl = document.getElementById('questions');

/** questionId -> { root, cloud, input, button, hint, pills: Map<tagId, el> } */
const cards = new Map();

let lastActiveId = null;
let status = 'draft';
let online = true;

// --------------------------------------------------------------------------
// Card construction (runs once per question)
// --------------------------------------------------------------------------

function buildCard(question) {
  if (question.type === 'freetext') return buildFreetextCard(question);
  if (question.type === 'choice') return buildChoiceCard(question);
  return buildTagCard(question);
}

function buildTagCard(question) {
  const root = document.createElement('section');
  root.className = 'question';

  const statusLine = document.createElement('p');
  statusLine.className = 'status-line';
  statusLine.hidden = true;

  const heading = document.createElement('h2');
  const desc = document.createElement('p');
  desc.className = 'desc';

  const form = document.createElement('form');
  form.className = 'tag-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = 'Type a tag...';
  input.autocomplete = 'off';
  input.autocapitalize = 'none';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Add a tag');

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Add';

  form.append(input, button);

  const hint = document.createElement('p');
  hint.className = 'hint';

  const locked = document.createElement('p');
  locked.className = 'locked';
  locked.textContent = 'Opens when we get there.';
  locked.hidden = true;

  const cloud = document.createElement('div');
  cloud.className = 'cloud';

  // Suggestions from the board appear here while the student types. A listbox
  // driven from the input (combobox pattern): the rows never take focus.
  const suggest = document.createElement('div');
  suggest.className = 'tag-suggest';
  suggest.id = `suggest-${question.id}`;
  suggest.setAttribute('role', 'listbox');
  suggest.setAttribute('aria-label', 'Tags already on the board');
  suggest.hidden = true;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', suggest.id);

  root.append(statusLine, heading, desc, form, suggest, hint, locked, cloud);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(question.id, input, hint);
  });

  input.addEventListener('input', () => renderSuggest(card, questionFor(question.id)));

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const open = !suggest.hidden;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) renderSuggest(card, questionFor(question.id));
      if (suggest.hidden) return;
      event.preventDefault();
      moveSuggest(card, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      // With a row highlighted, Enter votes for it. With none, the form submits
      // the typed text exactly as it always has.
      if (open && card.suggestActiveId !== null) {
        event.preventDefault();
        const row = card.suggestRows.get(card.suggestActiveId);
        if (row) pickSuggest(card, question.id, row.dataset.label);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeSuggest(card);
    }
  });

  // A tap on a row must not blur the input: on a phone that drops the keyboard,
  // and the next thing the student wants to do is type again.
  suggest.addEventListener('mousedown', (event) => event.preventDefault());
  suggest.addEventListener('click', (event) => {
    const row = event.target.closest('[role="option"]');
    if (row) pickSuggest(card, question.id, row.dataset.label);
  });

  const card = {
    type: 'tags',
    root, heading, desc, statusLine, form, input, button, hint, locked, cloud,
    pills: new Map(),
    suggest,
    suggestRows: new Map(),
    suggestActiveId: null,
  };
  cards.set(question.id, card);
  return card;
}

/**
 * A choice question: a fixed ballot, one pick.
 *
 * No text input, because the options are the question. The rows keep the order
 * they were authored in and never re-sort - a ballot that rearranges itself
 * under the thumb about to tap it makes people vote for the wrong thing.
 */
function buildChoiceCard(question) {
  const root = document.createElement('section');
  root.className = 'question question-choice';

  const statusLine = document.createElement('p');
  statusLine.className = 'status-line';
  statusLine.hidden = true;

  const heading = document.createElement('h2');
  const desc = document.createElement('p');
  desc.className = 'desc';

  const hint = document.createElement('p');
  hint.className = 'hint';

  const locked = document.createElement('p');
  locked.className = 'locked';
  locked.textContent = 'Opens when we get there.';
  locked.hidden = true;

  const list = document.createElement('div');
  list.className = 'choices';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', question.title);

  root.append(statusLine, heading, desc, hint, locked, list);

  const card = {
    type: 'choice',
    // No form of its own, but render() speaks to every card the same way.
    root, heading, desc, statusLine, hint, locked, list,
    form: { hidden: true }, input: { disabled: true }, button: { disabled: true },
    rows: new Map(),
  };

  cards.set(question.id, card);
  return card;
}

function renderChoices(card, question, interactive) {
  const options = question.tags || [];
  const total = options.reduce((sum, o) => sum + o.count, 0);
  const mine = voted.chosen(question.id);
  const seen = new Set();

  options.forEach((option, index) => {
    seen.add(option.id);
    let row = card.rows.get(option.id);

    if (!row) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'choice';
      el.setAttribute('role', 'radio');

      const bar = document.createElement('span');
      bar.className = 'choice-bar';
      const label = document.createElement('span');
      label.className = 'choice-label';
      const count = document.createElement('span');
      count.className = 'choice-count';

      el.append(bar, label, count);
      row = { el, bar, label, count, _count: null };
      card.rows.set(option.id, row);
      card.list.append(el);

      el.addEventListener('click', () => {
        if (el.disabled) return;
        select(question.id, el.dataset.label, card.hint);
      });
    }

    row.el.dataset.label = option.label;
    row.label.textContent = option.label;

    if (row._count !== option.count) {
      row.count.textContent = option.count;
      if (row._count !== null && option.count > row._count) {
        row.el.classList.remove('just-bumped');
        void row.el.offsetWidth;
        row.el.classList.add('just-bumped');
      }
      row._count = option.count;
    }

    // Share of the room, not share of the leader: on a single-select question
    // the total IS everyone who answered, so a percentage is honest here in a
    // way it would not be on a tags question.
    const share = total > 0 ? option.count / total : 0;
    row.bar.style.width = `${(share * 100).toFixed(1)}%`;

    const isMine = mine === option.label;
    row.el.classList.toggle('is-mine', isMine);
    row.el.setAttribute('aria-checked', String(isMine));
    row.el.disabled = !interactive;
    row.el.title = interactive
      ? `Pick "${option.label}"`
      : `${option.label}: ${option.count} of ${total}`;

    const atIndex = card.list.children[index];
    if (atIndex !== row.el) card.list.insertBefore(row.el, atIndex || null);
  });

  for (const [id, row] of card.rows) {
    if (!seen.has(id)) {
      row.el.remove();
      card.rows.delete(id);
    }
  }
}

/**
 * A freetext question: a textarea, then a feed of everyone's answers.
 *
 * Built once and mutated afterwards, exactly like the tag cloud, and for the
 * same reason - state lands every 300ms and a student may be halfway through a
 * sentence. Nothing here is ever rebuilt or reassigned wholesale.
 */
function buildFreetextCard(question) {
  const root = document.createElement('section');
  root.className = 'question question-freetext';

  const statusLine = document.createElement('p');
  statusLine.className = 'status-line';
  statusLine.hidden = true;

  const heading = document.createElement('h2');
  const desc = document.createElement('p');
  desc.className = 'desc';

  const form = document.createElement('form');
  form.className = 'response-form';

  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = MAX_RESPONSE_LENGTH;
  input.placeholder = 'Type your answer...';
  input.setAttribute('aria-label', 'Your answer');

  const formRow = document.createElement('div');
  formRow.className = 'response-form-row';

  const counter = document.createElement('span');
  counter.className = 'counter';

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Post';

  formRow.append(counter, button);
  form.append(input, formRow);

  function updateCounter() {
    const left = MAX_RESPONSE_LENGTH - input.value.length;
    counter.textContent = `${left} left`;
    counter.classList.toggle('is-low', left <= 30);
  }
  updateCounter();
  input.addEventListener('input', updateCounter);

  const hint = document.createElement('p');
  hint.className = 'hint';

  const locked = document.createElement('p');
  locked.className = 'locked';
  locked.textContent = 'Opens when we get there.';
  locked.hidden = true;

  const feedHead = document.createElement('div');
  feedHead.className = 'feed-head';

  const feedCount = document.createElement('span');
  feedCount.className = 'stat-label';

  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'btn btn-small sort-toggle';

  feedHead.append(feedCount, sortBtn);

  const feed = document.createElement('div');
  feed.className = 'feed';

  root.append(statusLine, heading, desc, form, hint, locked, feedHead, feed);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitResponse(question.id, input, hint, updateCounter);
  });

  // Enter posts, shift+Enter is a newline. On a phone this is the difference
  // between one tap and hunting for a button below the keyboard.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  const card = {
    type: 'freetext',
    root, heading, desc, statusLine, form, input, button, hint, locked,
    feed, feedHead, feedCount, sortBtn,
    rows: new Map(),
    groups: new Map(),
    newestFirst: false,
  };

  sortBtn.addEventListener('click', () => {
    card.newestFirst = !card.newestFirst;
    if (card.lastQuestion) renderFeed(card, card.lastQuestion, card.lastInteractive);
  });

  cards.set(question.id, card);
  return card;
}

// --------------------------------------------------------------------------
// Suggestions (tags questions)
// --------------------------------------------------------------------------
//
// While a student types, the tags already on the board that contain what they
// have typed so far are listed under the input, most voted first. The point is
// vocabulary convergence: seeing "usability 12" under a half-typed word tells
// the student the class already has it, and one tap agrees with it rather than
// putting "useability" up next to it. Typing a fresh word and pressing Add
// works exactly as before - the list is an offer, not a gate.
//
// Same rules as the cloud: rows are created once, keyed by tag id, mutated in
// place and reordered by moving them. The input is only ever read.

const MAX_SUGGESTIONS = 5;

/** The server's normalizeTag, minus the length check. */
function normalizeQuery(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Tags containing `query`: prefix matches first, then by votes, then the order
 * the server sent (itself by votes). Labels are stored normalized, so only the
 * query needs folding.
 */
function matchTags(tags, query, limit = MAX_SUGGESTIONS) {
  const q = normalizeQuery(query);
  if (!q) return [];
  return tags
    .map((tag, index) => ({ tag, index, at: tag.label.indexOf(q) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) =>
      (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1)
      || b.tag.count - a.tag.count
      || a.index - b.index)
    .slice(0, limit)
    .map((hit) => hit.tag);
}

function questionFor(questionId) {
  return latest?.questions.find((q) => q.id === questionId) || null;
}

function renderSuggest(card, question) {
  if (card.input.disabled || !question?.tags) {
    closeSuggest(card);
    return;
  }
  const matches = matchTags(question.tags, card.input.value);
  if (matches.length === 0) {
    closeSuggest(card);
    return;
  }

  const seen = new Set();
  matches.forEach((tag, index) => {
    seen.add(tag.id);
    let row = card.suggestRows.get(tag.id);

    if (!row) {
      row = document.createElement('div');
      row.className = 'tag-suggest-row';
      row.id = `${card.suggest.id}-${tag.id}`;
      row.setAttribute('role', 'option');
      row._tagId = tag.id;

      const text = document.createElement('span');
      text.className = 'label';
      const count = document.createElement('span');
      count.className = 'count';
      row.append(text, count);

      card.suggestRows.set(tag.id, row);
      card.suggest.append(row);
    }

    row.dataset.label = tag.label;
    row.querySelector('.label').textContent = tag.label;
    row.querySelector('.count').textContent = tag.count;
    row.classList.toggle('is-mine', voted.has(question.id, tag.label));

    const atIndex = card.suggest.children[index];
    if (atIndex !== row) card.suggest.insertBefore(row, atIndex || null);
  });

  for (const [tagId, row] of card.suggestRows) {
    if (!seen.has(tagId)) {
      row.remove();
      card.suggestRows.delete(tagId);
    }
  }

  // A highlighted tag that was merged away between broadcasts must not leave
  // Enter voting for whatever moved into its slot.
  if (card.suggestActiveId !== null && !seen.has(card.suggestActiveId)) {
    card.suggestActiveId = null;
  }
  applySuggestActive(card);

  card.suggest.hidden = false;
  card.input.setAttribute('aria-expanded', 'true');
}

function applySuggestActive(card) {
  let activeRow = null;
  for (const [tagId, row] of card.suggestRows) {
    const active = tagId === card.suggestActiveId;
    row.classList.toggle('is-active', active);
    row.setAttribute('aria-selected', String(active));
    if (active) activeRow = row;
  }
  if (activeRow) card.input.setAttribute('aria-activedescendant', activeRow.id);
  else card.input.removeAttribute('aria-activedescendant');
}

function closeSuggest(card) {
  if (!card?.suggest) return;
  card.suggest.hidden = true;
  card.suggestActiveId = null;
  card.input.setAttribute('aria-expanded', 'false');
  card.input.removeAttribute('aria-activedescendant');
}

/** Move the highlight. Index -1 is "what I typed", so Up from the top row returns to it. */
function moveSuggest(card, delta) {
  const ids = [...card.suggest.children].map((row) => row._tagId);
  const index = ids.indexOf(card.suggestActiveId);
  const next = Math.max(-1, Math.min(ids.length - 1, index + delta));
  card.suggestActiveId = next === -1 ? null : ids[next];
  applySuggestActive(card);
}

function pickSuggest(card, questionId, label) {
  if (!vote(questionId, label, card.hint)) return;
  card.input.value = '';
  closeSuggest(card);
  showHint(card.hint, `Voted for "${label}".`);
}

// --------------------------------------------------------------------------
// Sending
// --------------------------------------------------------------------------

let socket = null;

function submit(questionId, input, hint) {
  const value = input.value.trim();
  if (!value) return;

  const sent = socket?.send({ type: 'submit_tag', questionId, tag: value, sessionId });
  if (!sent) {
    showHint(hint, 'Not connected - reconnecting...', true);
    return;
  }

  // Record the vote optimistically so the pill reads as mine the moment the
  // broadcast lands, rather than a beat later.
  voted.add(questionId, normalizeQuery(value));
  input.value = '';
  closeSuggest(cards.get(questionId));
  showHint(hint, 'Added.');
}

function vote(questionId, label, hint) {
  const sent = socket?.send({ type: 'vote_tag', questionId, tag: label, sessionId });
  if (!sent) {
    showHint(hint, 'Not connected - reconnecting...', true);
    return false;
  }
  voted.add(questionId, label);
  return true;
}

function select(questionId, label, hint) {
  const sent = socket?.send({ type: 'select_choice', questionId, tag: label, sessionId });
  if (!sent) {
    showHint(hint, 'Not connected - reconnecting...', true);
    return;
  }
  // Single-select locally too, so the previous pick clears the instant this one
  // is tapped rather than a broadcast later.
  voted.select(questionId, label);
  showHint(hint, 'Recorded.');
}

function submitResponse(questionId, input, hint, updateCounter) {
  const value = input.value.trim();
  if (!value) return;

  const sent = socket?.send({
    type: 'submit_response', questionId, text: value, sessionId,
  });
  if (!sent) {
    showHint(hint, 'Not connected - reconnecting...', true);
    return;
  }

  input.value = '';
  updateCounter();
  showHint(hint, 'Posted.');
}

function voteResponse(questionId, responseId, direction, hint) {
  const sent = socket?.send({
    type: 'vote_response', questionId, responseId, direction, sessionId,
  });
  if (!sent) {
    showHint(hint, 'Not connected - reconnecting...', true);
    return null;
  }
  return myVotes.toggle(questionId, responseId, direction);
}

let hintTimers = new WeakMap();

function showHint(hint, text, isError = false) {
  hint.textContent = text;
  hint.classList.toggle('is-error', isError);
  clearTimeout(hintTimers.get(hint));
  hintTimers.set(hint, setTimeout(() => { hint.textContent = ''; }, 2500));
}

const REASONS = {
  too_fast: 'One at a time - try again in a moment.',
  session_tag_limit: 'You have added plenty here. Vote for an existing tag instead.',
  invalid_tag: 'That tag is empty or too long.',
  question_not_active: 'That question is not open right now.',
  sheet_not_live: 'This sheet is not taking responses.',
  unknown_tag: 'That tag is no longer there - it may have been merged.',
  invalid_response: `Answers need to be between 1 and ${MAX_RESPONSE_LENGTH} characters.`,
  session_response_limit: 'You have posted plenty here. Vote on someone else instead.',
  unknown_response: 'That answer is no longer there.',
  wrong_question_type: 'That did not go through.',
  unknown_option: 'That option is no longer on the ballot.',
};

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

const MIN_SCALE = 1;
const MAX_SCALE = 2.1;

/**
 * Size a pill by vote share.
 *
 * Square root, not linear: with one runaway tag a linear scale flattens
 * everything else into indistinguishable mush, which loses exactly the shape of
 * the distribution the exercise is about.
 */
function scaleFor(count, max) {
  if (max <= 1) return MIN_SCALE;
  const share = Math.sqrt(count / max);
  return MIN_SCALE + share * (MAX_SCALE - MIN_SCALE);
}

function renderCloud(card, question, interactive) {
  const tags = question.tags || [];
  const max = tags.reduce((m, t) => Math.max(m, t.count), 1);
  const seen = new Set();

  tags.forEach((tag, index) => {
    seen.add(tag.id);
    let pill = card.pills.get(tag.id);

    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'tag';
      pill.dataset.label = tag.label;

      const text = document.createElement('span');
      text.className = 'label';
      const count = document.createElement('span');
      count.className = 'count';
      pill.append(text, count);

      pill.addEventListener('click', () => {
        if (pill.disabled) return;
        vote(question.id, pill.dataset.label, card.hint);
      });

      card.pills.set(tag.id, pill);
      card.cloud.append(pill);
      pill._count = null;
    }

    pill.dataset.label = tag.label;
    pill.querySelector('.label').textContent = tag.label;

    if (pill._count !== tag.count) {
      pill.querySelector('.count').textContent = tag.count;
      // Only pulse an existing pill that grew - not one appearing for the first
      // time, or every arrival would jitter the whole cloud.
      if (pill._count !== null && tag.count > pill._count) {
        pill.classList.remove('just-bumped');
        void pill.offsetWidth;
        pill.classList.add('just-bumped');
      }
      pill._count = tag.count;
    }

    pill.style.fontSize = `${scaleFor(tag.count, max).toFixed(3)}rem`;
    pill.classList.toggle('is-mine', voted.has(question.id, tag.label));
    pill.disabled = !interactive;
    pill.title = interactive
      ? `Vote for "${tag.label}"`
      : `${tag.label}: ${tag.count} vote${tag.count === 1 ? '' : 's'}`;

    // Keep DOM order matching vote order. Re-appending an element that is
    // already in the right place is a no-op, so this does not thrash.
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

const UNCLUSTERED = 'Unclustered';

/**
 * Draw the response feed.
 *
 * Rows are created once and kept in a Map, like the tag pills. Ordering is done
 * by moving existing elements, never by re-creating them, so a vote landing
 * elsewhere cannot steal the tap you are halfway through making.
 *
 * Once clustering has run the rows are nested under headings. The heading
 * elements are cached too - rebuilding them would drop every row inside.
 */
function renderFeed(card, question, interactive) {
  const responses = question.responses || [];

  card.lastQuestion = question;
  card.lastInteractive = interactive;

  const total = question.responseCount ?? responses.length;
  card.feedCount.textContent = total === 1 ? '1 answer' : `${total} answers`;
  card.sortBtn.textContent = card.newestFirst ? 'Newest first' : 'Top first';
  card.sortBtn.title = card.newestFirst ? 'Sort by score instead' : 'Sort by newest instead';
  card.feedHead.hidden = responses.length === 0;

  const sorted = [...responses].sort(card.newestFirst
    ? (a, b) => b.createdAt - a.createdAt
    : (a, b) => b.score - a.score || a.createdAt - b.createdAt);

  const clustered = sorted.some((r) => r.clusterLabel);

  // Which container each row belongs in: the feed itself, or a cluster's body.
  const groupsWanted = new Map();
  if (clustered) {
    for (const response of sorted) {
      const label = response.clusterLabel || UNCLUSTERED;
      if (!groupsWanted.has(label)) groupsWanted.set(label, []);
      groupsWanted.get(label).push(response);
    }
    // Unclustered is a leftover, not a theme. It goes last however it sorted.
    if (groupsWanted.has(UNCLUSTERED)) {
      const leftovers = groupsWanted.get(UNCLUSTERED);
      groupsWanted.delete(UNCLUSTERED);
      groupsWanted.set(UNCLUSTERED, leftovers);
    }
  }

  const seen = new Set();

  function placeRow(response, container, index) {
    seen.add(response.id);
    let row = card.rows.get(response.id);

    if (!row) {
      row = buildResponseRow(card, question, response);
      card.rows.set(response.id, row);
    }

    row.text.textContent = response.text;

    if (row._score !== response.score) {
      row.score.textContent = response.score > 0 ? `+${response.score}` : String(response.score);
      row.score.classList.toggle('is-positive', response.score > 0);
      row.score.classList.toggle('is-negative', response.score < 0);
      if (row._score != null && response.score !== row._score) {
        row.el.classList.remove('just-bumped');
        void row.el.offsetWidth;
        row.el.classList.add('just-bumped');
      }
      row._score = response.score;
    }

    const mine = myVotes.get(question.id, response.id);
    row.up.classList.toggle('is-mine', mine === 1);
    row.down.classList.toggle('is-mine', mine === -1);
    row.up.disabled = !interactive;
    row.down.disabled = !interactive;
    row.up.setAttribute('aria-pressed', String(mine === 1));
    row.down.setAttribute('aria-pressed', String(mine === -1));

    const atIndex = container.children[index];
    if (atIndex !== row.el) container.insertBefore(row.el, atIndex || null);
  }

  if (clustered) {
    let groupIndex = 0;
    for (const [label, members] of groupsWanted) {
      let group = card.groups.get(label);
      if (!group) {
        const el = document.createElement('div');
        el.className = 'cluster';
        const head = document.createElement('h3');
        head.className = 'cluster-head';
        const body = document.createElement('div');
        body.className = 'cluster-body';
        el.append(head, body);
        group = { el, head, body };
        card.groups.set(label, group);
      }
      group.head.textContent = `${label} (${members.length})`;
      group.el.classList.toggle('is-leftover', label === UNCLUSTERED);

      members.forEach((response, i) => placeRow(response, group.body, i));

      const atIndex = card.feed.children[groupIndex];
      if (atIndex !== group.el) card.feed.insertBefore(group.el, atIndex || null);
      groupIndex += 1;
    }

    for (const [label, group] of card.groups) {
      if (!groupsWanted.has(label)) {
        group.el.remove();
        card.groups.delete(label);
      }
    }
  } else {
    // Clustering was undone or never ran: rows live directly in the feed again.
    for (const [label, group] of card.groups) {
      group.el.remove();
      card.groups.delete(label);
    }
    sorted.forEach((response, i) => placeRow(response, card.feed, i));
  }

  for (const [id, row] of card.rows) {
    if (!seen.has(id)) {
      row.el.remove();
      card.rows.delete(id);
    }
  }
}

function buildResponseRow(card, question, response) {
  const el = document.createElement('article');
  el.className = 'response';

  const text = document.createElement('p');
  text.className = 'response-text';

  const votes = document.createElement('div');
  votes.className = 'response-votes';

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'vote vote-up';
  up.textContent = '\u25B2';
  up.title = 'Agree';
  up.setAttribute('aria-label', 'Agree with this answer');

  const score = document.createElement('span');
  score.className = 'response-score';

  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'vote vote-down';
  down.textContent = '\u25BC';
  down.title = 'Disagree';
  down.setAttribute('aria-label', 'Disagree with this answer');

  votes.append(up, score, down);
  el.append(votes, text);

  const row = { el, text, score, up, down, _score: null };

  for (const [button, direction] of [[up, 1], [down, -1]]) {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const next = voteResponse(question.id, response.id, direction, card.hint);
      if (next === null) return;
      // Paint the button immediately; the score itself waits for the broadcast,
      // which is the only place that knows what everyone else did.
      row.up.classList.toggle('is-mine', next === 1);
      row.down.classList.toggle('is-mine', next === -1);
      row.up.setAttribute('aria-pressed', String(next === 1));
      row.down.setAttribute('aria-pressed', String(next === -1));
    });
  }

  return row;
}

function render(state) {
  status = state.sheet.status;

  titleEl.textContent = state.sheet.title;
  document.title = `${state.sheet.title} - folksonomy`;

  const isClosed = status === 'closed';
  const isLive = status === 'live';

  subEl.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `badge badge-${isClosed ? 'closed' : status}`;
  badge.textContent = isClosed ? 'Closed' : status;
  subEl.append(badge, ` ${state.connectedCount} here now`);

  if (!online) {
    setBanner('banner-offline', 'Connection lost. Trying to reconnect...');
  } else if (isClosed) {
    setBanner('banner-closed',
      'This sheet is closed. It stays here as a record of what the class said.');
  } else if (status === 'draft') {
    setBanner('banner-draft', 'This sheet has not been opened yet.');
  } else {
    bannerEl.hidden = true;
  }

  for (const question of state.questions) {
    const card = cards.get(question.id) || buildCard(question);
    if (!card.root.isConnected) listEl.append(card.root);

    card.heading.textContent = question.title;
    card.desc.textContent = question.description;
    card.desc.hidden = !question.description;

    const isActive = question.active && isLive;
    // Only the active question of a live sheet accepts anything. A revealed but
    // inactive cloud is there to look at, not to vote in.
    const interactive = isActive;

    card.root.classList.toggle('is-active', isActive);
    card.root.classList.toggle('is-inactive', !isActive && !isClosed);
    card.root.classList.toggle('is-closed', isClosed);

    card.statusLine.hidden = !isActive;
    card.statusLine.textContent = 'Answering now';

    if (card.type !== 'choice') {
      card.form.hidden = !interactive;
      card.input.disabled = !interactive;
      card.button.disabled = !interactive;
    }

    if (card.type === 'choice') {
      const revealed = Boolean(question.tags);
      card.locked.hidden = revealed;
      card.list.hidden = !revealed;
      if (revealed) renderChoices(card, question, interactive);
    } else if (card.type === 'freetext') {
      const revealed = Boolean(question.responses);
      card.locked.hidden = revealed;
      card.feed.hidden = !revealed;
      card.feedHead.hidden = !revealed;
      if (revealed) renderFeed(card, question, interactive);
    } else {
      const revealed = Boolean(question.tags);
      card.locked.hidden = revealed;
      card.cloud.hidden = !revealed;
      if (revealed) renderCloud(card, question, interactive);
      // An open list follows the board: counts and order stay current, and a
      // tag merged away disappears from it. The input itself is left alone.
      if (!interactive) closeSuggest(card);
      else if (!card.suggest.hidden) renderSuggest(card, question);
    }
  }

  // Order the cards to match the server, without disturbing any that are already
  // in position (which would blur an input or cancel a tap in progress).
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

  handleActiveChange(state.activeQuestionId, isLive);
}

function setBanner(className, text) {
  bannerEl.className = `banner ${className}`;
  bannerEl.textContent = text;
  bannerEl.hidden = false;
}

/**
 * Bring a newly opened question into view.
 *
 * Only on an actual change, and only when it is off screen - scrolling someone
 * away from what they are reading is worse than making them scroll themselves.
 */
function handleActiveChange(activeId, isLive) {
  if (!isLive || activeId === lastActiveId) {
    lastActiveId = activeId;
    return;
  }
  lastActiveId = activeId;
  if (activeId == null) return;

  const card = cards.get(activeId);
  if (!card) return;

  const box = card.root.getBoundingClientRect();
  const offscreen = box.top < 0 || box.bottom > window.innerHeight;
  if (offscreen) card.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

let latest = null;

socket = connect({
  slug,
  onState(state) {
    latest = state;
    online = true;
    render(state);
  },
  onStatus(next) {
    online = next === 'online';
    if (latest) render(latest);
  },
  // The server is the authority on what a tap resolved to. This only ever fires
  // when the optimistic guess was wrong - a double tap racing its own undo.
  // Same idea for a ballot: the server's word on which option is mine.
  onChoiceAck({ questionId, label }) {
    if (voted.chosen(questionId) === label) return;
    voted.select(questionId, label);
    if (latest) render(latest);
  },
  onVoteAck({ questionId, responseId, direction }) {
    if (myVotes.get(questionId, responseId) === direction) return;
    myVotes.set(questionId, responseId, direction);
    if (latest) render(latest);
  },
  onError(reason) {
    const card = cards.get(lastActiveId);
    if (card) showHint(card.hint, REASONS[reason] || 'That did not go through.', true);
  },
});
