// Browser tests for the live projection view and the dashboard.
//
//   PRESENTER_PASSWORD=testpass BASE=http://localhost:8099 node scripts/views-test.mjs
//
// The check that matters most is the last one in the live-view section: the
// sedimentation animation deliberately holds a bar back until its token lands,
// so the drawn number is *supposed* to disagree with the server for about a
// second. If that lag can ever fail to resolve, the projector shows a wrong
// count for the rest of the lecture. So: submit a known number, wait, and
// insist the chart agrees.

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

/** Poll until `fn` returns truthy, or give up. Returns what it last saw. */
async function until(fn, timeout = 5000, interval = 150) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

// ---------------------------------------------------------------- setup

const { token } = await (await fetch(`${BASE}/api/presenter/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})).json();

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const { sheet } = await (await fetch(`${BASE}/api/sheets`, {
  method: 'POST', headers: auth, body: JSON.stringify({ title: 'Views test sheet' }),
})).json();
const slug = sheet.slug;

for (const q of [
  { title: 'What makes an interface bad?', type: 'tags', description: 'Tag a pet peeve.' },
  { title: 'Why might HCI be hard?', type: 'freetext', description: 'One or two sentences.' },
  { title: 'What is HCI?', type: 'tags', description: 'One or two words.' },
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
const [qTags, qFree, qFresh] = questions;

const WSB = BASE.replace('http', 'ws');
const control = new WebSocket(`${WSB}/ws?slug=${slug}`);
await new Promise((r) => control.on('open', r));
control.send(JSON.stringify({ type: 'authenticate', token }));
await sleep(300);

/** A throwaway student socket, so each submission comes from its own session. */
async function submitTag(sessionId, tag, questionId = qTags.id) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'submit_tag', questionId, tag, sessionId }));
  await sleep(120);
  ws.close();
}

async function voteTag(sessionId, tag, questionId = qTags.id) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'vote_tag', questionId, tag, sessionId }));
  await sleep(120);
  ws.close();
}

async function submitResponse(sessionId, text) {
  const ws = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'submit_response', questionId: qFree.id, text, sessionId }));
  await sleep(120);
  ws.close();
}

const browser = await chromium.launch({ channel: 'chrome' });

try {
  // ------------------------------------------------------------ live view

  const hall = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const live = await hall.newPage();
  const liveErrors = [];
  live.on('pageerror', (err) => liveErrors.push(err.message));

  await live.goto(`${BASE}/live/${slug}`);
  await live.waitForSelector('#idle:visible');

  check('the live view waits when nothing is active',
    (await live.locator('#idle').innerText()).includes('Waiting'));
  check('d3 loaded from /vendor', await live.evaluate(() => typeof window.d3?.select === 'function'));

  control.send(JSON.stringify({ type: 'set_active', questionId: qTags.id }));
  await live.waitForSelector('#stage:visible');

  check('the active question is shown full screen',
    (await live.locator('#q-title').innerText()).includes('What makes an interface bad?'));
  check('the description is shown too',
    (await live.locator('#q-desc').innerText()).includes('pet peeve'));
  check('the particle canvas is present', await live.locator('#particles').count() === 1);

  const TAGS = [
    ['v1', 'tiny buttons'], ['v2', 'tiny buttons'], ['v3', 'tiny buttons'],
    ['v4', 'popups'], ['v5', 'popups'], ['v6', 'slow'],
  ];
  for (const [session, tag] of TAGS) await submitTag(session, tag);

  const bars = await until(async () => {
    const n = await live.locator('.chart-svg .bars rect').count();
    return n >= 3 ? n : null;
  });
  check('a bar is drawn per tag', bars === 3, `got ${bars}`);

  check('bars carry the shared colour scale',
    await live.evaluate(() => {
      const fills = [...document.querySelectorAll('.chart-svg .bars rect')]
        .map((r) => r.getAttribute('fill'));
      return new Set(fills).size === fills.length && fills.every((f) => f && f !== 'none');
    }));

  // The sedimentation lag is a real, intended disagreement with the server.
  // What must never happen is that it fails to resolve.
  const settled = await until(async () => {
    const total = await live.evaluate(() =>
      [...document.querySelectorAll('.chart-svg .values text')]
        .reduce((sum, t) => sum + (Number(t.textContent) || 0), 0));
    return total === 6 ? total : null;
  }, 6000);
  check('every held-back token is eventually released', settled === 6,
    `chart totals ${settled}, server has 6`);

  check('the tallest bar is the most-voted tag',
    await live.evaluate(() => {
      const rects = [...document.querySelectorAll('.chart-svg .bars rect')];
      const heights = rects.map((r) => Number(r.getAttribute('height')));
      const labels = [...document.querySelectorAll('.chart-svg .labels text')]
        .map((t) => t.textContent);
      return labels[heights.indexOf(Math.max(...heights))] === 'tiny buttons';
    }));

  // The canvas should actually have been painted during the burst above.
  await submitTag('v7', 'popups');
  const painted = await until(async () => live.evaluate(() => {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  }), 3000, 60);
  check('tokens are drawn on the canvas', painted === true);

  await live.screenshot({ path: 'scripts/shot-live.png' });

  // ---- a tag nobody has said before ----

  // Its submission reaches the client just ahead of the state that gives it a
  // bar, so without deferral there would be nothing to aim at and no token.
  control.send(JSON.stringify({ type: 'set_active', questionId: qFresh.id }));
  await sleep(900);

  const blank = () => live.evaluate(() => {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  });

  check('the canvas starts blank on an untouched question', await blank() === true);

  await submitTag('fresh-1', 'affordance', qFresh.id);
  const freshToken = await until(async () => (await blank()) ? null : true, 3000, 60);
  check('a tag nobody has said before still gets a token', freshToken === true);

  const rose = await until(async () => {
    const shown = await live.evaluate(() => {
      const t = document.querySelector('.chart-svg .values text');
      return t ? Number(t.textContent) : null;
    });
    return shown === 1 ? shown : null;
  }, 5000);
  check('and its bar settles at one', rose === 1);

  // ---- a tap that changes nothing should not animate ----

  await until(async () => (await blank()) === true, 4000, 100);
  check('the canvas clears once everything has landed', await blank() === true);

  // Same session, same tag: the unique constraint absorbs it, so nothing counted
  // and nothing should fall.
  await voteTag('fresh-1', 'affordance', qFresh.id);
  await sleep(1200);
  check('a duplicate vote drops no token', await blank() === true);

  // A different person voting for it, though, is a real arrival.
  await voteTag('fresh-2', 'affordance', qFresh.id);
  const realToken = await until(async () => (await blank()) ? null : true, 3000, 60);
  check('a second person voting does drop one', realToken === true);

  // ---- freetext on the projector ----

  control.send(JSON.stringify({ type: 'set_active', questionId: qFree.id }));
  await sleep(600);

  for (const [i, text] of [
    'People are unpredictable',
    'Testing with real users is slow',
    'Nobody agrees on what good means',
  ].entries()) {
    await submitResponse(`f${i}`, text);
  }

  const cards = await until(async () => {
    const n = await live.locator('.live-card').count();
    return n >= 3 ? n : null;
  });
  check('unclustered freetext projects the answers themselves', cards === 3, `got ${cards}`);
  check('the answers are readable, not summarised',
    (await live.locator('.live-cards').innerText()).includes('People are unpredictable'));

  check('the live view logged no errors', liveErrors.length === 0, liveErrors.join(' | '));

  // ------------------------------------------------------------ dashboard

  const dash = await hall.newPage();
  const dashErrors = [];
  dash.on('pageerror', (err) => dashErrors.push(err.message));

  await dash.goto(`${BASE}/d/${slug}`);
  await dash.waitForSelector('.panel-card');

  await dash.waitForSelector('.join-qr svg');
  check('the dashboard shows the join address',
    (await dash.locator('.join-url').innerText()).includes(slug));
  check('and the QR code', await dash.locator('.join-qr svg').count() === 1);
  check('no presenter control without a token',
    await dash.locator('.advance-next:visible').count() === 0);
  check('but a way to sign in', await dash.locator('.advance-signin:visible').count() === 1);

  check('d3-cloud loaded from /vendor',
    await dash.evaluate(() => typeof window.d3?.layout?.cloud === 'function'));
  check('all six panels mount', await dash.locator('.panel-card').count() === 6);
  check('every revealed question is offered',
    await dash.locator('.picker-tab').count() === 3);
  check('the picker marks the current question',
    await dash.locator('.picker-tab.is-current').count() === 1);

  // Panels start on the first question, which is the tags one.
  await dash.waitForSelector('[data-panel=bars] svg rect');
  check('ranked bars draw',
    await dash.locator('[data-panel=bars] svg rect').count() === 3);

  const cloudWords = await until(async () => {
    const n = await dash.locator('[data-panel=cloud] svg text').count();
    return n > 0 ? n : null;
  });
  check('the word cloud lays out', cloudWords === 3, `got ${cloudWords}`);

  check('word cloud words do not overlap their own boxes',
    await dash.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-panel=cloud] svg text')];
      return nodes.every((n) => n.getBoundingClientRect().width > 0);
    }));

  check('themes report that clustering has not run',
    (await dash.locator('[data-panel=themes]').innerText()).includes('Not clustered')
    || (await dash.locator('[data-panel=themes]').innerText()).includes('freetext'));

  const raw = await dash.locator('[data-panel=raw]').innerText();
  check('the raw feed lists individual votes', raw.includes('tiny buttons'));

  // Co-occurrence needs someone who picked two tags; nobody has yet.
  check('co-occurrence explains its own empty state',
    (await dash.locator('[data-panel=cooccurrence]').innerText()).includes('more than one'));

  const both = new WebSocket(`${WSB}/ws?slug=${slug}`);
  await new Promise((r) => both.on('open', r));
  control.send(JSON.stringify({ type: 'set_active', questionId: qTags.id }));
  await sleep(400);
  for (const tag of ['tiny buttons', 'popups']) {
    both.send(JSON.stringify({
      type: 'submit_tag', questionId: qTags.id, tag, sessionId: 'pair-1',
    }));
    await sleep(900);
  }
  for (const tag of ['tiny buttons', 'popups']) {
    both.send(JSON.stringify({
      type: 'submit_tag', questionId: qTags.id, tag, sessionId: 'pair-2',
    }));
    await sleep(900);
  }
  both.close();

  const edges = await until(async () => {
    const n = await dash.locator('[data-panel=cooccurrence] svg line').count();
    return n > 0 ? n : null;
  }, 9000);
  check('co-occurrence draws an edge once two people pick the same pair',
    edges === 1, `got ${edges}`);

  const timelineLines = await until(async () => {
    const n = await dash.locator('[data-panel=timeline] svg path[stroke-width="2"]').count();
    return n > 0 ? n : null;
  }, 8000);
  check('the formation timeline draws a line per tag',
    timelineLines === 3, `got ${timelineLines}`);

  // ---- maximise ----

  await dash.locator('[data-panel=cloud] .panel-expand').click();
  await dash.waitForSelector('.panel-card.is-max');

  check('only one panel is maximised', await dash.locator('.panel-card.is-max').count() === 1);
  check('the maximised panel fills the viewport',
    await dash.evaluate(() => {
      const box = document.querySelector('.panel-card.is-max').getBoundingClientRect();
      return Math.abs(box.width - window.innerWidth) < 2
        && Math.abs(box.height - window.innerHeight) < 2;
    }));
  check('the other panels are hidden',
    await dash.locator('.panel-card:not(.is-max):visible').count() === 0);

  // Maximising resizes the body, which is what tells the panel to redraw. The
  // real test is that the drawing grew to fit, not merely that the type is big:
  // an SVG left at its old size sits in the corner of the maximised panel.
  const refitted = await until(async () => dash.evaluate(() => {
    const svg = document.querySelector('[data-panel=cloud] svg');
    const body = document.querySelector('[data-panel=cloud] .panel-body');
    if (!svg) return false;
    const drawn = svg.getBoundingClientRect();
    const box = body.getBoundingClientRect();
    return Math.abs(drawn.width - box.width) < 4 && drawn.width > 800;
  }), 4000);
  check('the maximised cloud re-lays out to fill the panel', refitted === true);

  check('and no word is clipped by the panel edge',
    await dash.evaluate(() => {
      const svg = document.querySelector('[data-panel=cloud] svg').getBoundingClientRect();
      return [...document.querySelectorAll('[data-panel=cloud] svg text')]
        .map((t) => t.getBoundingClientRect())
        .every((w) => w.left >= svg.left - 1 && w.right <= svg.right + 1
                   && w.top >= svg.top - 1 && w.bottom <= svg.bottom + 1);
    }));

  await dash.screenshot({ path: 'scripts/shot-dashboard-max.png' });

  await dash.keyboard.press('Escape');
  await sleep(400);
  check('escape restores the grid', await dash.locator('.panel-card.is-max').count() === 0);
  check('every panel is back', await dash.locator('.panel-card:visible').count() === 6);

  // ---- switching question ----

  await dash.locator('.picker-tab').nth(1).click();
  await sleep(700);

  check('the picker highlight follows the switch',
    await dash.evaluate(() => {
      const tabs = [...document.querySelectorAll('.picker-tab')];
      return tabs[1].classList.contains('is-current')
        && !tabs[0].classList.contains('is-current');
    }));

  const themes = await dash.locator('[data-panel=themes] .panel-empty').innerText();
  check('the freetext question offers clustering',
    themes.includes('Not clustered'), themes.slice(0, 60));

  // The cloud is debounced, so it lands a beat after everything else.
  const freeWords = await until(async () => {
    const n = await dash.locator('[data-panel=cloud] svg text').count();
    return n > 0 ? n : null;
  }, 5000);
  check('the cloud switches to word frequencies from the answers',
    freeWords > 0, `got ${freeWords}`);
  check('stopwords are left out of it',
    await dash.evaluate(() => {
      const words = [...document.querySelectorAll('[data-panel=cloud] svg text')]
        .map((t) => t.firstChild?.nodeValue);
      return words.includes('unpredictable') && !words.includes('with');
    }));

  const freeRaw = await dash.locator('[data-panel=raw]').innerText();
  check('the raw feed switches to answers', freeRaw.includes('People are unpredictable'));
  check('co-occurrence steps aside on freetext',
    (await dash.locator('[data-panel=cooccurrence]').innerText()).includes('tag questions'));

  // ---- the presenter's Next, from the dashboard ----
  // At this point qTags is active and the picker is on qFree.

  const activeId = async () => {
    const { questions: qs } = await (await fetch(`${BASE}/api/sheets/${slug}/questions`, {
      headers: auth,
    })).json();
    return qs.find((q) => q.active)?.id ?? null;
  };

  await dash.locator('.advance-signin').click();
  await dash.fill('.advance-password', PASSWORD);
  await dash.keyboard.press('Enter');
  await dash.waitForSelector('.advance-next:visible');
  check('signing in reveals Next', true);
  check('Next says what it will open',
    (await dash.locator('.advance-upcoming').innerText()).includes('Why might HCI be hard?'));

  await dash.locator('.advance-next').click();
  check('Next opens the question after the active one',
    await until(async () => (await activeId()) === qFree.id) === true);

  await dash.locator('.advance-next').click();
  check('and again the one after that',
    await until(async () => (await activeId()) === qFresh.id) === true);
  const followed = await until(async () => dash.evaluate(() => {
    const tabs = [...document.querySelectorAll('.picker-tab')];
    return tabs[2]?.classList.contains('is-current');
  }));
  check('the picker follows the active question', followed === true);
  check('at the last question the button stops instead',
    await until(async () => (await dash.locator('.advance-next').innerText()) === 'Stop') === true);

  await dash.keyboard.press('n');
  check('the N key ends the last question',
    await until(async () => (await activeId()) === null) === true);
  check('and offers the first one again',
    await until(async () => (await dash.locator('.advance-upcoming').innerText())
      .includes('What makes an interface bad?')) === true);

  // ---- and from the live view, in a tab that already holds a token ----

  const lectern = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await lectern.addInitScript(
    (t) => sessionStorage.setItem('folksonomy.presenterToken', t), token,
  );
  const lecternLive = await lectern.newPage();
  const lecternErrors = [];
  lecternLive.on('pageerror', (err) => lecternErrors.push(err.message));
  await lecternLive.goto(`${BASE}/live/${slug}`);
  await lecternLive.waitForSelector('.advance-next:visible');
  check('a tab holding a presenter token gets Next on the live view', true);

  await lecternLive.keyboard.press('ArrowRight');
  check('the right arrow opens the first question from the live view',
    await until(async () => (await activeId()) === qTags.id) === true);
  await lecternLive.waitForSelector('#stage:visible');
  check('and the projector shows it',
    (await lecternLive.locator('#q-title').innerText()).includes('What makes an interface bad?'));
  check('the plain live view still shows only the sign-in link',
    await live.locator('.advance-next:visible').count() === 0
    && await live.locator('.advance-signin').count() === 1);
  check('the lectern live view logged no errors',
    lecternErrors.length === 0, lecternErrors.join(' | '));

  await dash.screenshot({ path: 'scripts/shot-dashboard.png', fullPage: true });

  check('the dashboard logged no errors', dashErrors.length === 0, dashErrors.join(' | '));
} finally {
  await browser.close();
  control.close();
  await fetch(`${BASE}/api/sheets/${slug}`, { method: 'DELETE', headers: auth });
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
