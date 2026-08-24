// Choice questions: a fixed ballot, one pick each.
//
//   PRESENTER_PASSWORD=testpass BASE=http://localhost:8099 node scripts/choice-test.mjs
//
// The property everything else rests on: the counts sum to the number of people
// who answered. That is what makes a percentage on the projector true. So the
// tests here are mostly about the ways a second tap could break it - switching,
// re-picking, and picking something that is not on the ballot.
//
// Also covers seeded options on a tags question, which share the mechanism:
// they are options nobody has to use.

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

/** One student, one socket - the throttle is per connection, as it is in a hall. */
async function as(sessionId, message) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ ...message, sessionId }));
  await sleep(140);
  ws.close();
}

const options = (question) => question.tags || [];
const countOf = (question, label) =>
  options(question).find((o) => o.label === label)?.count ?? null;
const total = (question) => options(question).reduce((n, o) => n + o.count, 0);

// ---------------------------------------------------------------- setup

const { body: login } = await api('/api/presenter/login', {
  method: 'POST', body: JSON.stringify({ password: PASSWORD }),
});
const token = login.token;

const { body: made } = await api('/api/sheets', {
  method: 'POST', body: JSON.stringify({ title: 'Choice test sheet' }),
}, token);
const slug = made.sheet.slug;

const { body: created } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({
    title: 'Is HCI closer to art or engineering?',
    type: 'choice',
    options: ['Art', 'Engineering', 'Both'],
  }),
}, token);
check('a choice question is created', created.question.type === 'choice');

const { status: tooFew } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({ title: 'Yes?', type: 'choice', options: ['Yes'] }),
}, token);
check('one option is refused', tooFew === 400, `got ${tooFew}`);

const { status: noneAtAll } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST', body: JSON.stringify({ title: 'Nothing', type: 'choice' }),
}, token);
check('no options at all is refused', noneAtAll === 400, `got ${noneAtAll}`);

// A yes/no question is just a choice with two options.
const { body: yesNo } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({ title: 'Have you built a UI before?', type: 'choice', options: ['Yes', 'No'] }),
}, token);

// Seeded starting words on an ordinary tags question.
const { body: seeded } = await api(`/api/sheets/${slug}/questions`, {
  method: 'POST',
  body: JSON.stringify({
    title: 'What is HCI?', type: 'tags', options: ['usability', 'design'],
  }),
}, token);

await api(`/api/sheets/${slug}/status`, {
  method: 'POST', body: JSON.stringify({ status: 'live' }),
}, token);

const choice = created.question.id;
const binary = yesNo.question.id;
const tagged = seeded.question.id;

const a = client(slug);
const presenter = client(slug);
await Promise.all([a.ready, presenter.ready]);
presenter.send({ type: 'authenticate', token });
await sleep(300);
presenter.send({ type: 'set_active', questionId: choice });
await sleep(400);

// ---------------------------------------------------------------- the ballot

check('the options are on the question', options(a.question(choice)).length === 3);
check('they start at zero', total(a.question(choice)) === 0);
check('they keep the order they were authored in',
  options(a.question(choice)).map((o) => o.label).join(',') === 'art,engineering,both');
check('they are marked as authored',
  options(a.question(choice)).every((o) => o.seeded === 1));

// ---------------------------------------------------------------- picking

a.send({ type: 'select_choice', questionId: choice, tag: 'art', sessionId: 'p1' });
await sleep(400);
check('a pick counts', countOf(a.question(choice), 'art') === 1);

a.send({ type: 'select_choice', questionId: choice, tag: 'art', sessionId: 'p1' });
await sleep(400);
check('re-picking the same option changes nothing',
  countOf(a.question(choice), 'art') === 1);

a.send({ type: 'select_choice', questionId: choice, tag: 'engineering', sessionId: 'p1' });
await sleep(400);
check('switching moves the vote rather than adding one',
  countOf(a.question(choice), 'art') === 0
  && countOf(a.question(choice), 'engineering') === 1);

for (const [session, pick] of [
  ['p2', 'art'], ['p3', 'art'], ['p4', 'both'], ['p5', 'engineering'],
]) {
  await as(session, { type: 'select_choice', questionId: choice, tag: pick });
}
await sleep(500);

check('everyone is counted once',
  total(a.question(choice)) === 5, `total ${total(a.question(choice))}, 5 sessions`);
check('the tally is right',
  `${countOf(a.question(choice), 'art')}/${countOf(a.question(choice), 'engineering')}/${countOf(a.question(choice), 'both')}` === '2/2/1');

// ---------------------------------------------------------------- guards

a.send({ type: 'select_choice', questionId: choice, tag: 'neither', sessionId: 'p1' });
await sleep(300);
check('an option not on the ballot is refused', a.errors.includes('unknown_option'));
check('and nothing was invented', options(a.question(choice)).length === 3);

a.send({ type: 'submit_tag', questionId: choice, tag: 'sneaky', sessionId: 'p9' });
await sleep(300);
check('a free-typed tag cannot be added to a ballot',
  a.errors.includes('wrong_question_type'));
check('the ballot is unchanged', options(a.question(choice)).length === 3);

a.send({ type: 'submit_response', questionId: choice, text: 'nope', sessionId: 'p9' });
await sleep(300);
check('nor can a freetext answer',
  a.errors.filter((e) => e === 'wrong_question_type').length === 2);

presenter.send({ type: 'set_active', questionId: tagged });
await sleep(400);
a.send({ type: 'select_choice', questionId: tagged, tag: 'usability', sessionId: 'p1' });
await sleep(300);
check('select_choice is refused on a tags question',
  a.errors.filter((e) => e === 'wrong_question_type').length === 3);

// ---------------------------------------------------------------- seeded tags

check('a tags question can start with words on it',
  options(a.question(tagged)).map((o) => o.label).sort().join(',') === 'design,usability');
check('which nobody has voted for yet', total(a.question(tagged)) === 0);

a.send({ type: 'vote_tag', questionId: tagged, tag: 'usability', sessionId: 'p1' });
await sleep(400);
check('a starting word can be voted for like any other',
  countOf(a.question(tagged), 'usability') === 1);

await as('p2', { type: 'submit_tag', questionId: tagged, tag: 'affordance' });
await sleep(400);
check('and students can still add their own',
  countOf(a.question(tagged), 'affordance') === 1);
check('a student word is not marked as authored',
  options(a.question(tagged)).find((o) => o.label === 'affordance')?.seeded === 0);

// ------------------------------------------------------- rapid tapping

// Switching your mind twice in a second is a person changing their mind, not an
// attack. It used to hit the submission throttle and be silently refused.
presenter.send({ type: 'set_active', questionId: choice });
await sleep(400);

const quick = client(slug);
await quick.ready;
await sleep(200);
quick.send({ type: 'select_choice', questionId: choice, tag: 'art', sessionId: 'fast' });
await sleep(300);
quick.send({ type: 'select_choice', questionId: choice, tag: 'both', sessionId: 'fast' });
await sleep(500);
check('a quick change of mind is not throttled away',
  !quick.errors.includes('too_fast') && countOf(a.question(choice), 'both') === 2,
  quick.errors.join(',') || 'no errors');

// Creating things still is.
presenter.send({ type: 'set_active', questionId: tagged });
await sleep(400);
quick.errors.length = 0;
quick.send({ type: 'submit_tag', questionId: tagged, tag: 'one', sessionId: 'fast' });
quick.send({ type: 'submit_tag', questionId: tagged, tag: 'two', sessionId: 'fast' });
await sleep(500);
check('but adding two new tags in a burst still is',
  quick.errors.includes('too_fast'));

// ---------------------------------------------------------------- clearing

presenter.send({ type: 'set_active', questionId: choice });
await sleep(400);
presenter.send({ type: 'clear_tags', questionId: choice });
await sleep(400);

check('clearing a ballot removes the votes',
  total(a.question(choice)) === 0);
check('but leaves the ballot standing',
  options(a.question(choice)).length === 3,
  'otherwise there is nothing left to vote on');

// ---------------------------------------------------------------- cloning

const { body: clone } = await api(`/api/sheets/${slug}/clone`, {
  method: 'POST', body: JSON.stringify({ title: 'Next year' }),
}, token);
const { body: cloned } = await api(`/api/sheets/${clone.sheet.slug}/export.json`, {}, token);

const clonedChoice = cloned.questions.find((q) => q.type === 'choice');
check('a clone keeps the ballot',
  (clonedChoice?.options || []).map((o) => o.label).join(',') === 'art,engineering,both');
check('with no votes on it',
  (clonedChoice?.options || []).every((o) => o.count === 0));

const clonedTags = cloned.questions.find((q) => q.title === 'What is HCI?');
check('a clone keeps authored starting words',
  (clonedTags?.tags || []).map((t) => t.label).sort().join(',') === 'design,usability');
check('and drops what the students added',
  !(clonedTags?.tags || []).some((t) => t.label === 'affordance'));

// ---------------------------------------------------------------- export

const { body: csv } = await api(`/api/sheets/${slug}/export.csv`, {}, token);
check('the CSV names the type', csv.includes(',choice,'));
check('and lists the options', csv.includes('art'));

// ---------------------------------------------------------------- yes/no

presenter.send({ type: 'set_active', questionId: binary });
await sleep(400);
check('a yes/no question is just two options',
  options(a.question(binary)).map((o) => o.label).join(',') === 'yes,no');

for (const [session, pick] of [['y1', 'yes'], ['y2', 'no'], ['y3', 'yes']]) {
  await as(session, { type: 'select_choice', questionId: binary, tag: pick });
}
await sleep(500);
check('and tallies like one',
  `${countOf(a.question(binary), 'yes')}/${countOf(a.question(binary), 'no')}` === '2/1');

// ---------------------------------------------------------------- cleanup

await api(`/api/sheets/${slug}`, { method: 'DELETE' }, token);
await api(`/api/sheets/${clone.sheet.slug}`, { method: 'DELETE' }, token);
for (const ws of open) ws.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
