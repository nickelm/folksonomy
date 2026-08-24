// End-to-end smoke test against a running server.
//
//   PRESENTER_PASSWORD=testpass BASE=http://localhost:8099 node scripts/smoke.mjs
//
// Run it against a FRESHLY SEEDED database (rm -rf data, restart) - it asserts
// on the starting state, so a re-run against a used sheet reports false failures.
//
// Covers the behaviour that is easy to get wrong and invisible until a lecture:
// reveal gating, vote de-duplication, closed-sheet enforcement, and auth.

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
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state_update') states.push(msg);
    if (msg.type === 'error') errors.push(msg.reason);
  });
  return {
    ws, states, errors,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    latest: () => states[states.length - 1],
    question: (id) => states[states.length - 1].questions.find((q) => q.id === id),
  };
}

const tagCount = (question, label) =>
  (question.tags || []).find((t) => t.label === label)?.count ?? null;

// ---------------------------------------------------------------- setup

const { body: login } = await api('/api/presenter/login', {
  method: 'POST', body: JSON.stringify({ password: PASSWORD }),
});
const token = login.token;
check('presenter login', Boolean(token));

const wrong = await api('/api/presenter/login', {
  method: 'POST', body: JSON.stringify({ password: 'not-it' }),
});
check('wrong password refused', wrong.status === 401);

const { body: all } = await api('/api/sheets', {}, token);
const slug = all.sheets[0].slug;

await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'live' }),
}, token);

const { body: pub } = await api('/api/public/sheets');
check('live sheet is listed for students', pub.sheets.some((s) => s.slug === slug));

const student = client(slug);
const other = client(slug);
const presenter = client(slug);
await Promise.all([student.ready, other.ready, presenter.ready]);
presenter.send({ type: 'authenticate', token });
await sleep(300);

const questions = student.latest().questions;
const q1 = questions[0].id;
const q2 = questions[1].id;

const tagQuestions = (state) => state.questions.filter((q) => q.type === 'tags');

check('six questions seeded', questions.length === 6, `got ${questions.length}`);
check('one of them is freetext',
  questions.filter((q) => q.type === 'freetext').length === 1);
check('clouds hidden before activation', questions.every((q) => q.tags === undefined));
check('feeds hidden before activation', questions.every((q) => q.responses === undefined));
check('presenter sees every cloud',
  tagQuestions(presenter.latest()).every((q) => Array.isArray(q.tags)));

// ---------------------------------------------------------------- writes

student.send({ type: 'submit_tag', questionId: q1, tag: 'early', sessionId: 's1' });
await sleep(250);
check('inactive question refuses input', student.errors.includes('question_not_active'));

presenter.send({ type: 'set_active', questionId: q1 });
await sleep(400);
check('activation reveals that cloud', Array.isArray(student.question(q1).tags));
check('unactivated questions stay hidden',
  student.latest().questions.filter((q) => q.id !== q1).every((q) => q.tags === undefined));

student.send({ type: 'submit_tag', questionId: q1, tag: 'Usability', sessionId: 's1' });
await sleep(400);
check('submitter is counted as a voter', tagCount(student.question(q1), 'usability') === 1);
check('tags are normalised to lowercase',
  (student.question(q1).tags || []).some((t) => t.label === 'usability'));

// Same session, same tag, typed again: the unique constraint should absorb it.
student.send({ type: 'submit_tag', questionId: q1, tag: 'usability', sessionId: 's1' });
await sleep(900);
check('re-typing an existing tag does not duplicate it',
  (student.question(q1).tags || []).filter((t) => t.label === 'usability').length === 1);
check('re-typing does not double-count the same session',
  tagCount(student.question(q1), 'usability') === 1);

other.send({ type: 'vote_tag', questionId: q1, tag: 'usability', sessionId: 's2' });
await sleep(400);
check('a second session adds a vote', tagCount(student.question(q1), 'usability') === 2);

other.send({ type: 'vote_tag', questionId: q1, tag: 'usability', sessionId: 's2' });
await sleep(900);
check('the same session cannot vote twice',
  tagCount(student.question(q1), 'usability') === 2);

other.send({ type: 'vote_tag', questionId: q1, tag: 'never-typed', sessionId: 's2' });
await sleep(300);
check('voting cannot invent a tag', other.errors.includes('unknown_tag'));

// Throttle: two submissions back to back from one socket.
student.send({ type: 'submit_tag', questionId: q1, tag: 'fast-one', sessionId: 's1' });
student.send({ type: 'submit_tag', questionId: q1, tag: 'fast-two', sessionId: 's1' });
await sleep(300);
check('rapid-fire submissions are throttled', student.errors.includes('too_fast'));

// ---------------------------------------------------------------- auth boundary

student.send({ type: 'set_active', questionId: q2 });
await sleep(300);
check('students cannot drive the sheet', student.errors.includes('not_authenticated'));
check('the active question did not move', student.latest().activeQuestionId === q1);

student.send({ type: 'clear_tags', questionId: q1 });
await sleep(300);
check('students cannot clear a cloud',
  (student.question(q1).tags || []).length > 0);

const noToken = await api(`/api/sheets/${slug}/export.csv`);
check('export refuses an unauthenticated request', noToken.status === 401);

// ---------------------------------------------------------------- reveal persistence

presenter.send({ type: 'set_active', questionId: q2 });
await sleep(400);
check('a revealed cloud stays visible after moving on',
  Array.isArray(student.question(q1).tags));
check('the newly active question is revealed', Array.isArray(student.question(q2).tags));
check('untouched questions are still hidden',
  student.latest().questions.filter((q) => ![q1, q2].includes(q.id))
    .every((q) => q.tags === undefined));

// ---------------------------------------------------------------- export

const csv = await api(`/api/sheets/${slug}/export.csv`, {}, token);
check('CSV export works', csv.status === 200 && String(csv.body).includes('usability'));

const json = await api(`/api/sheets/${slug}/export.json`, {}, token);
check('JSON export includes merge history',
  json.status === 200 && Array.isArray(json.body.questions[0].merges));

const qr = await fetch(`${BASE}/api/sheets/${slug}/qr.svg`);
const qrBody = await qr.text();
check('QR code renders', qr.status === 200 && qrBody.startsWith('<svg'));

// ---------------------------------------------------------------- clone

const clone = await api(`/api/sheets/${slug}/clone`, {
  method: 'POST', body: JSON.stringify({ title: 'Second section' }),
}, token);
const cloneSlug = clone.body.sheet.slug;
check('clone gets a fresh slug', cloneSlug !== slug, cloneSlug);

const cloneQs = await api(`/api/sheets/${cloneSlug}/questions`, {}, token);
check('clone copies every question', cloneQs.body.questions.length === 6);
check('clone preserves question types',
  cloneQs.body.questions.filter((q) => q.type === 'freetext').length === 1);

const cloneExport = await api(`/api/sheets/${cloneSlug}/export.json`, {}, token);
check('clone starts with no responses',
  cloneExport.body.questions.every((q) => {
    const items = q.tags || q.options || q.responses || [];
    return items.every((i) => (i.count ?? i.score ?? 0) === 0);
  }));
check('clone carries the authored starting words',
  cloneExport.body.questions
    .find((q) => q.title.startsWith('Is HCI closer'))
    .tags.map((t) => t.label).sort().join(',') === 'art,engineering');

const originalStill = await api(`/api/sheets/${slug}/export.json`, {}, token);
check('cloning leaves the original untouched',
  originalStill.body.questions[0].tags.length > 0);

// ---------------------------------------------------------------- closing

await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'closed' }),
}, token);
await sleep(400);

check('closing reveals every cloud',
  tagQuestions(student.latest()).every((q) => Array.isArray(q.tags)));
check('closing reveals every feed',
  student.latest().questions
    .filter((q) => q.type === 'freetext')
    .every((q) => Array.isArray(q.responses)));
check('closed status reaches the client', student.latest().sheet.status === 'closed');

student.errors.length = 0;
student.send({ type: 'submit_tag', questionId: q1, tag: 'too-late', sessionId: 's1' });
await sleep(300);
check('a closed sheet refuses new tags', student.errors.includes('sheet_not_live'));
check('nothing was written after closing',
  !(student.question(q1).tags || []).some((t) => t.label === 'too-late'));

const reopen = await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'live' }),
}, token);
check('a closed sheet cannot be reopened from the API', reopen.status === 409);

// ---------------------------------------------------------------- teardown

for (const ws of open) ws.close();
await sleep(200);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
