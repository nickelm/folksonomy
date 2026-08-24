// Browser tests for the parts that only exist on screen.
//
// The one that matters most: a student typing a tag must not lose keystrokes when
// other people's submissions arrive. State lands every ~300ms, so any renderer
// that rebuilds the card would eat the word being typed.

import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8099';
const PASSWORD = process.env.PRESENTER_PASSWORD || 'testpass';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a fresh sheet to play with ----

const { token } = await (await fetch(`${BASE}/api/presenter/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})).json();

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const { sheet } = await (await fetch(`${BASE}/api/sheets`, {
  method: 'POST', headers: auth, body: JSON.stringify({ title: 'UI test sheet' }),
})).json();
const slug = sheet.slug;

for (const q of ['What is HCI?', 'What makes an interface bad?']) {
  await fetch(`${BASE}/api/sheets/${slug}/questions`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: q, description: 'Tag it.' }),
  });
}
await fetch(`${BASE}/api/sheets/${slug}/questions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    title: 'Art or engineering?', type: 'choice', options: ['Art', 'Engineering'],
  }),
});
await fetch(`${BASE}/api/sheets/${slug}/status`, {
  method: 'POST', headers: auth, body: JSON.stringify({ status: 'live' }),
});

const { questions } = await (await fetch(`${BASE}/api/sheets/${slug}/questions`, {
  headers: auth,
})).json();
const [qa, qb] = questions;

// A presenter socket, so the test can drive activation the way the UI would.
const control = new WebSocket(`${BASE.replace('http', 'ws')}/ws?slug=${slug}`);
await new Promise((r) => control.on('open', r));
control.send(JSON.stringify({ type: 'authenticate', token }));
await sleep(300);

const browser = await chromium.launch({ channel: 'chrome' });

try {
  // iPhone SE, the narrowest screen the plan promises to support.
  const phone = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await phone.newPage();
  await page.goto(`${BASE}/${slug}`);
  await page.waitForSelector('.question');

  const cards = page.locator('.question');
  check('every question renders', await cards.count() === 3);

  check('nothing is answerable before activation',
    await page.locator('.tag-form:visible').count() === 0);
  check('unopened questions show a placeholder',
    await page.locator('.locked:visible').count() === 3);

  control.send(JSON.stringify({ type: 'set_active', questionId: qa.id }));
  await page.waitForSelector('.question.is-active');

  check('the active card is highlighted', await page.locator('.question.is-active').count() === 1);
  check('exactly one input is enabled',
    await page.locator('.question.is-active input:not([disabled])').count() === 1);
  check('the others stay locked',
    await page.locator('.question:not(.is-active) .locked:visible').count() === 2);

  // ---- submit from the page ----

  const input = page.locator('.question.is-active input');
  await input.fill('usability');
  await page.locator('.question.is-active button[type=submit]').click();
  await page.waitForSelector('.question.is-active .tag');

  check('the tag appears in the cloud',
    (await page.locator('.question.is-active .cloud').innerText()).includes('usability'));
  check('the input is cleared after submitting', await input.inputValue() === '');
  check('the submitter sees it as their own',
    await page.locator('.question.is-active .tag.is-mine').count() === 1);

  // ---- the keystroke test ----

  // Someone else floods the room with tags while our student types a word.
  // One socket per noise-maker: the per-session throttle is per connection, so
  // flooding from a single socket would be silently swallowed and prove nothing.
  const word = 'affordance';
  const noise = await Promise.all([...word].map(async () => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?slug=${slug}`);
    await new Promise((r) => ws.on('open', r));
    return ws;
  }));

  await input.click();
  let flooded = 0;

  for (const letter of word) {
    await page.keyboard.type(letter);
    // One inbound broadcast per keystroke, far harsher than a real room.
    noise[flooded].send(JSON.stringify({
      type: 'submit_tag',
      questionId: qa.id,
      tag: `noise-${flooded}`,
      sessionId: `noise-${flooded}`,
    }));
    flooded += 1;
    await sleep(120);
  }

  await sleep(600);
  const typed = await input.inputValue();
  check('keystrokes survive a flood of updates', typed === word, `typed "${typed}"`);
  check('focus stayed in the input',
    await page.evaluate(() => document.activeElement?.tagName) === 'INPUT');
  check('the flood actually arrived',
    (await page.locator('.question.is-active .tag').count()) > 3);

  for (const ws of noise) ws.close();

  // ---- voting by tapping ----

  await input.fill('');
  const fresh = page.locator('.question.is-active .tag:not(.is-mine)').first();
  const pillLabel = await fresh.locator('.label').innerText();
  const beforeVote = Number(await fresh.locator('.count').innerText());
  await fresh.click();
  await sleep(600);

  const afterVote = Number(
    await page.locator(`.question.is-active .tag:has(.label:text-is("${pillLabel}")) .count`)
      .first().innerText(),
  );
  check('tapping a pill records a vote', afterVote === beforeVote + 1,
    `${beforeVote} -> ${afterVote}`);

  await page.locator(`.question.is-active .tag:has(.label:text-is("${pillLabel}"))`)
    .first().click();
  await sleep(700);
  const afterSecond = Number(
    await page.locator(`.question.is-active .tag:has(.label:text-is("${pillLabel}")) .count`)
      .first().innerText(),
  );
  check('tapping twice does not double-count', afterSecond === afterVote,
    `${afterVote} -> ${afterSecond}`);

  // ---- no horizontal scroll at 375px ----

  const overflows = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('the page does not scroll sideways at 375px', overflows === false);

  const tooSmall = await page.evaluate(() => {
    const sizes = [...document.querySelectorAll('.tag')]
      .map((el) => parseFloat(getComputedStyle(el).fontSize));
    return sizes.filter((s) => s < 15).length;
  });
  check('every pill stays readable', tooSmall === 0, `${tooSmall} under 15px`);

  const tapTargets = await page.evaluate(() => {
    // Only what is actually on screen - a hidden control legitimately measures 0.
    const els = [...document.querySelectorAll('.tag, .tag-form button')]
      .filter((el) => el.offsetParent !== null);
    return els.filter((el) => el.getBoundingClientRect().height < 36).length;
  });
  check('tap targets are big enough', tapTargets === 0, `${tapTargets} under 36px`);

  await page.screenshot({ path: 'scripts/shot-student.png', fullPage: true });

  // ---- moving on reveals the next question, and keeps the last one ----

  control.send(JSON.stringify({ type: 'set_active', questionId: qb.id }));
  await sleep(700);

  check('the previous cloud is still shown',
    await page.locator('.question').first().locator('.tag').count() > 0);
  check('the previous question is read-only',
    await page.locator('.question').first().locator('.tag[disabled]').count() > 0);
  check('the new question is now answerable',
    await page.locator('.question.is-active input:not([disabled])').count() === 1);

  // ---- the presenter view, at projector size ----

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const control2 = await desk.newPage();
  await control2.goto(`${BASE}/presenter/${slug}`);
  await control2.waitForSelector('#login:not([hidden])');
  await control2.fill('#password', PASSWORD);
  await control2.click('#login-btn');
  await control2.waitForSelector('#stage:not([hidden])');

  check('the join URL is shown', (await control2.locator('#join-url').innerText()).includes(slug));
  check('the QR code rendered', await control2.locator('#qr svg').count() === 1);

  const urlSize = await control2.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.join-url')).fontSize));
  check('the join URL is big enough to read from the back', urlSize >= 28,
    `${urlSize}px`);

  check('the presenter sees counts on every cloud',
    await control2.locator('.question .tag .count').count() > 0);
  check('the presenter sees clouds for unopened questions too',
    await control2.locator('.question').count() === 3);

  const connected = Number(await control2.locator('#connected').innerText());
  check('the connected count is live', connected >= 2, `${connected}`);

  await control2.screenshot({ path: 'scripts/shot-presenter.png', fullPage: true });

  // Per-tag removal, the thing that saves a projected screen from one bad word.
  const before = await control2.locator('.question').first().locator('.tag').count();
  await control2.locator('.question').first().locator('.tag .tag-remove').first().click();
  await sleep(700);
  const after = await control2.locator('.question').first().locator('.tag').count();
  check('a single tag can be removed', after === before - 1, `${before} -> ${after}`);

  // The student page should follow along without a reload.
  await sleep(500);
  const studentTags = await page.locator('.question').first().locator('.tag').count();
  check('the removal reaches the students', studentTags === after, `${studentTags}`);

  // ---- two tabs of one browser are two people ----

  // The report this came from: opening a second tab, voting, and watching the
  // count refuse to move. The id used to live in localStorage, which every tab
  // of a browser shares, so the second vote hit the unique constraint and
  // vanished with no error at all.
  control.send(JSON.stringify({ type: 'set_active', questionId: qa.id }));
  await page.waitForSelector('.question.is-active .tag');

  const second = await phone.newPage();
  await second.goto(`${BASE}/${slug}`);
  await second.waitForSelector('.question.is-active .tag');

  const idOf = (p) => p.evaluate(() => sessionStorage.getItem('folksonomy.sessionId'));
  check('each tab gets its own identity', await idOf(page) !== await idOf(second),
    'two tabs of one browser must be able to vote separately');
  check('and it is not left in localStorage',
    await page.evaluate(() => localStorage.getItem('folksonomy.sessionId')) === null);

  const pillCount = async (p) => Number(
    await p.locator('.question.is-active .tag').first().locator('.count').innerText(),
  );

  const wasAt = await pillCount(page);
  await second.locator('.question.is-active .tag').first().click();
  await sleep(700);
  const nowAt = await pillCount(page);
  check('clicking an existing tag in the second tab votes',
    nowAt === wasAt + 1, `${wasAt} -> ${nowAt}`);

  // Tapping the same pill again in the same tab is still one vote.
  await second.locator('.question.is-active .tag').first().click();
  await sleep(700);
  check('but the same tab cannot vote twice',
    await pillCount(page) === nowAt, 'one vote per tab per tag');

  await second.close();

  // ---- the choice ballot ----

  const { questions: all } = await (await fetch(`${BASE}/api/sheets/${slug}/questions`, {
    headers: auth,
  })).json();
  const ballot = all.find((q) => q.type === 'choice');

  control.send(JSON.stringify({ type: 'set_active', questionId: ballot.id }));
  await page.waitForSelector('.question.is-active .choice:not([disabled])');

  const choices = page.locator('.question.is-active .choice');
  check('the ballot renders its options', await choices.count() === 2);
  check('in the order they were authored',
    (await choices.first().innerText()).toLowerCase().includes('art'));
  check('there is no way to type a new one',
    await page.locator('.question.is-active .tag-form:visible').count() === 0);

  await choices.first().click();
  await page.waitForSelector('.question.is-active .choice.is-mine');
  check('picking marks it as mine', await page.locator('.choice.is-mine').count() === 1);

  // Past the vote throttle, the way a person changing their mind would be.
  await sleep(400);
  await choices.nth(1).click();
  await sleep(700);
  check('switching moves the mark, it does not add one',
    await page.locator('.choice.is-mine').count() === 1);
  const marked = (await page.locator('.choice.is-mine').allInnerTexts()).join('|');
  check('and the mark is on the new pick',
    marked.toLowerCase().includes('engineering'), JSON.stringify(marked));

  const tally = await page.evaluate(() =>
    [...document.querySelectorAll('.question.is-active .choice-count')]
      .map((c) => Number(c.textContent)));
  check('the totals sum to one voter', tally.reduce((a, b) => a + b, 0) === 1,
    tally.join('/'));

  // A tap the server refuses must not leave the page showing a pick nobody has.
  // Two clicks inside the throttle: the second is rejected, and the mark has to
  // fall back to what is actually recorded rather than staying where it landed.
  await choices.first().click();
  await choices.nth(0).click();
  await sleep(900);
  const stillMine = (await page.locator('.choice.is-mine').allInnerTexts()).join('|');
  const serverSide = await page.evaluate(() =>
    [...document.querySelectorAll('.question.is-active .choice')]
      .filter((c) => Number(c.querySelector('.choice-count').textContent) > 0)
      .map((c) => c.querySelector('.choice-label').textContent).join('|'));
  check('a refused tap does not leave the page disagreeing with the server',
    stillMine.toLowerCase().includes(serverSide.toLowerCase()),
    `marked ${JSON.stringify(stillMine)}, recorded ${JSON.stringify(serverSide)}`);

  await page.screenshot({ path: 'scripts/shot-choice.png', fullPage: true });

  // ---- closing, seen from the student page ----

  await fetch(`${BASE}/api/sheets/${slug}/status`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'closed' }),
  });
  await page.waitForSelector('.banner-closed');

  check('students see the closed banner', await page.locator('.banner-closed').count() === 1);
  check('all inputs are gone once closed',
    await page.locator('.tag-form:visible').count() === 0);
  check('every cloud is revealed once closed',
    await page.locator('.locked:visible').count() === 0);
  check('pills are no longer clickable',
    await page.locator('.tag:not([disabled])').count() === 0);
  check('the ballot is no longer clickable',
    await page.locator('.choice:not([disabled])').count() === 0);

  await page.screenshot({ path: 'scripts/shot-closed.png', fullPage: true });
} finally {
  await browser.close();
  control.close();
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
