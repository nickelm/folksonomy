// Freetext questions: posting, voting, and the rules that keep both honest.
//
//   PRESENTER_PASSWORD=testpass BASE=http://localhost:8099 node scripts/freetext-test.mjs
//
// Builds its own sheet rather than using the seeded one, so it can be run
// repeatedly against a server that is already up.
//
// The behaviour worth guarding: one vote per person per answer, with a second
// tap undoing and the opposite tap flipping. Get that wrong and a score is a
// measure of who clicked most, not of what the room thinks.

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8099';
const WSB = BASE.replace('http', 'ws');
const PASSWORD = process.env.PRESENTER_PASSWORD || 'testpass';

let failures = 0;
const open = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}, token) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function client(slug) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  open.push(ws);
  const states = [];
  const errors = [];
  const acks = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state_update') states.push(msg);
    if (msg.type === 'error') errors.push(msg.reason);
    if (msg.type === 'vote_ack') acks.push(msg);
  });
  return {
    ws, states, errors, acks,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    latest: () => states[states.length - 1],
    question: (id) => states[states.length - 1].questions.find((q) => q.id === id),
  };
}

const responses = (question) => question.responses || [];
const byText = (question, text) => responses(question).find((r) => r.text === text);

// ---------------------------------------------------------------- setup

const { body: login } = await api('/api/presenter/login', {
  method: 'POST', body: JSON.stringify({ password: PASSWORD }),
});
const token = login.token;
check('presenter login', Boolean(token));

const { body: made } = await api('/api/sheets', {
  method: 'POST', body: JSON.stringify({ title: 'Freetext test sheet' }),
}, token);
const slug = made.sheet.slug;

const { body: qFree } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({ title: 'Why might HCI be hard?', type: 'freetext' }),
}, token);
const { body: qTags } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({ title: 'What is HCI?', type: 'tags' }),
}, token);

check('question type is stored', qFree.question.type === 'freetext', qFree.question.type);
check('type defaults sanely', qTags.question.type === 'tags');

const { body: bogus } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST', body: JSON.stringify({ title: 'Nonsense', type: 'interpretive-dance' }),
}, token);
check('an unknown type falls back to tags', bogus.question.type === 'tags');

await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'live' }),
}, token);

const free = qFree.question.id;
const tags = qTags.question.id;

const a = client(slug);
const b = client(slug);
const presenter = client(slug);
await Promise.all([a.ready, b.ready, presenter.ready]);
presenter.send({ type: 'authenticate', token });
await sleep(300);

// ---------------------------------------------------------------- gating

check('counts are visible before reveal', a.question(free).responseCount === 0);
check('answers are withheld before reveal', a.question(free).responses === undefined);

a.send({ type: 'submit_response', questionId: free, text: 'Too early', sessionId: 's1' });
await sleep(250);
check('inactive question refuses answers', a.errors.includes('question_not_active'));

presenter.send({ type: 'set_active', questionId: free });
await sleep(400);
check('activation reveals the feed', Array.isArray(a.question(free).responses));

// ---------------------------------------------------------------- posting

a.send({ type: 'submit_response', questionId: free, text: 'People are unpredictable', sessionId: 's1' });
await sleep(400);
check('an answer arrives', responses(a.question(free)).length === 1);
check('text is preserved verbatim',
  Boolean(byText(a.question(free), 'People are unpredictable')));

await sleep(900);
b.send({ type: 'submit_response', questionId: free, text: '   Testing   is    slow   ', sessionId: 's2' });
await sleep(400);
check('whitespace is collapsed, case is not',
  Boolean(byText(a.question(free), 'Testing is slow')));

await sleep(900);
a.send({
  type: 'submit_response', questionId: free, sessionId: 's1',
  text: 'x'.repeat(281),
});
await sleep(300);
check('over 280 characters is refused', a.errors.includes('invalid_response'));

await sleep(900);
a.send({ type: 'submit_response', questionId: free, text: '   ', sessionId: 's1' });
await sleep(300);
check('an empty answer is refused',
  a.errors.filter((e) => e === 'invalid_response').length === 2);

// The per-session cap is 3. One is already in; add two more, then a fourth.
for (const text of ['Second from s1', 'Third from s1', 'Fourth from s1']) {
  await sleep(900);
  a.send({ type: 'submit_response', questionId: free, text, sessionId: 's1' });
}
await sleep(500);
check('the per-session cap holds', a.errors.includes('session_response_limit'));
check('the capped answer was not stored', !byText(a.question(free), 'Fourth from s1'));

// ---------------------------------------------------------------- voting

const target = byText(a.question(free), 'People are unpredictable');

b.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: 1, sessionId: 's2' });
await sleep(400);
check('an upvote scores +1', byText(a.question(free), 'People are unpredictable').score === 1);

b.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: 1, sessionId: 's2' });
await sleep(400);
check('the same direction again undoes it',
  byText(a.question(free), 'People are unpredictable').score === 0);
check('the undo is acknowledged', b.acks.at(-1)?.direction === 0);

b.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: 1, sessionId: 's2' });
await sleep(400);
b.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: -1, sessionId: 's2' });
await sleep(400);
check('the opposite direction flips rather than stacks',
  byText(a.question(free), 'People are unpredictable').score === -1);
check('the flip is acknowledged', b.acks.at(-1)?.direction === -1);

a.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: 1, sessionId: 's1' });
await sleep(400);
check('a second person cancels the first out',
  byText(a.question(free), 'People are unpredictable').score === 0);

b.send({ type: 'vote_response', questionId: free, responseId: target.id, direction: 0, sessionId: 's2' });
await sleep(300);
check('direction 0 is refused', b.errors.includes('invalid_direction'));

b.send({ type: 'vote_response', questionId: free, responseId: 999999, direction: 1, sessionId: 's2' });
await sleep(300);
check('an unknown response id is refused', b.errors.includes('unknown_response'));

// ---------------------------------------------------------------- ordering

const ranked = responses(a.question(free));
const scores = ranked.map((r) => r.score);
check('the feed is score-sorted',
  scores.every((s, i) => i === 0 || scores[i - 1] >= s), scores.join(','));

// ---------------------------------------------------------------- type guards

a.send({ type: 'submit_tag', questionId: free, tag: 'nope', sessionId: 's1' });
await sleep(300);
check('a tag aimed at a freetext question is refused',
  a.errors.includes('wrong_question_type'));

presenter.send({ type: 'set_active', questionId: tags });
await sleep(400);
a.send({ type: 'submit_response', questionId: tags, text: 'nope', sessionId: 's1' });
await sleep(300);
check('an answer aimed at a tags question is refused',
  a.errors.filter((e) => e === 'wrong_question_type').length === 2);

// ---------------------------------------------------------------- closing

check('the feed stays visible once the question moves on',
  Array.isArray(a.question(free).responses),
  'results are meant to be permanent');

await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'closed' }),
}, token);
await sleep(400);

presenter.send({ type: 'set_active', questionId: free });
await sleep(300);
a.send({ type: 'submit_response', questionId: free, text: 'After the bell', sessionId: 's3' });
await sleep(300);
check('a closed sheet refuses answers', a.errors.includes('sheet_not_live'));

// ---------------------------------------------------------------- export

const { body: json } = await api(`/api/sheets/${slug}/export.json`, {}, token);
const exported = json.questions.find((q) => q.type === 'freetext');
check('the export carries responses', (exported?.responses || []).length >= 3);

const { status: csvStatus, body: csv } = await api(`/api/sheets/${slug}/export.csv`, {}, token);
check('the CSV export still works', csvStatus === 200 && csv.includes('People are unpredictable'));

// ---------------------------------------------------------------- cleanup

await api(`/api/sheets/${slug}`, { method: 'DELETE' }, token);
for (const ws of open) ws.close();

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
