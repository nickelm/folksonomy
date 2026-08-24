// Screenshot helper, not a test. Sets up a sheet with both question types and
// captures the student page and the presenter console for eyeballing.
//
//   node scripts/shots.mjs

import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8099';
const PASSWORD = process.env.PRESENTER_PASSWORD || 'testpass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await (await fetch(`${BASE}/api/presenter/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})).json();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const { sheet } = await (await fetch(`${BASE}/api/sheets`, {
  method: 'POST', headers: auth, body: JSON.stringify({ title: 'HCI — Lecture 1' }),
})).json();
const slug = sheet.slug;

for (const q of [
  { title: 'What makes an interface bad?', type: 'tags', description: "Tag a pet peeve." },
  {
    title: 'Why might HCI be hard?',
    type: 'freetext',
    description: "One or two sentences. You can upvote others' answers.",
  },
]) {
  await fetch(`${BASE}/api/sheets/${slug}/questions`, {
    method: 'POST', headers: auth, body: JSON.stringify(q),
  });
}
await fetch(`${BASE}/api/sheets/${slug}/status`, {
  method: 'POST', headers: auth, body: JSON.stringify({ status: 'live' }),
});

const { questions } = await (await fetch(`${BASE}/api/sheets/${slug}/questions`, {
  headers: auth,
})).json();
const [qTags, qFree] = questions;

const WSB = BASE.replace('http', 'ws');
const control = new WebSocket(`${WSB}/ws?slug=${slug}`);
await new Promise((r) => control.on('open', r));
control.send(JSON.stringify({ type: 'authenticate', token }));
await sleep(300);

async function send(msg) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(msg));
  await sleep(140);
  ws.close();
}

control.send(JSON.stringify({ type: 'set_active', questionId: qTags.id }));
await sleep(400);
for (const [i, tag] of ['tiny buttons', 'tiny buttons', 'popups', 'popups', 'popups',
  'no undo', 'slow', 'tiny buttons'].entries()) {
  await send({ type: 'submit_tag', questionId: qTags.id, tag, sessionId: `t${i}` });
}

control.send(JSON.stringify({ type: 'set_active', questionId: qFree.id }));
await sleep(400);

const ANSWERS = [
  'People are unpredictable and they never do what you expect them to do.',
  'You cannot just ask people what they want, they tell you the wrong thing.',
  'Testing with real users is slow and expensive, so it gets skipped.',
  'Measuring whether a design actually worked is genuinely hard.',
  'Nobody agrees on what "good" means for an interface.',
];
for (const [i, text] of ANSWERS.entries()) {
  await send({ type: 'submit_response', questionId: qFree.id, text, sessionId: `f${i}` });
}

const { questions: withIds } = await (await fetch(`${BASE}/api/sheets/${slug}/export.json`, {
  headers: auth,
})).json();
const responses = withIds.find((q) => q.type === 'freetext').responses;

for (const [i, r] of responses.entries()) {
  for (let v = 0; v <= (responses.length - i - 1); v += 1) {
    await send({
      type: 'vote_response', questionId: qFree.id, responseId: r.id,
      direction: 1, sessionId: `voter-${v}`,
    });
  }
}
await send({
  type: 'vote_response', questionId: qFree.id, responseId: responses.at(-1).id,
  direction: -1, sessionId: 'grump',
});

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const student = await phone.newPage();
  await student.goto(`${BASE}/${slug}`);
  await student.waitForSelector('.response');
  // Vote from the browser so a pressed button shows in the shot.
  await student.locator('.response').first().locator('.vote-up').click();
  await sleep(600);
  await student.screenshot({ path: 'scripts/shot-student-freetext.png', fullPage: true });

  const desk = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const presenter = await desk.newPage();
  await presenter.goto(`${BASE}/presenter/${slug}`);
  await presenter.waitForSelector('#password');
  await presenter.fill('#password', PASSWORD);
  await presenter.click('#login-btn');
  await presenter.waitForSelector('.question');
  await sleep(800);
  await presenter.screenshot({ path: 'scripts/shot-presenter.png', fullPage: true });
} finally {
  await browser.close();
  control.close();
}

console.log(`captured. sheet: ${BASE}/${slug}`);
process.exit(0);
