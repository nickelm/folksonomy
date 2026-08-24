// Open a lecture hall's worth of connections and submit into one question.
//
//   BASE=http://localhost:8099 SLUG=xxxx CLIENTS=150 node scripts/loadtest.js
//   MODE=freetext ... node scripts/loadtest.js
//
// What matters is not that it survives - it is the ratio at the end. Every client
// submitting should NOT produce one broadcast per submission; the server coalesces
// on a 300ms tick, so expect a few frames per second, not one per tag.
//
// MODE=freetext is the harder case and the reason it is here. A freetext state
// payload carries every answer in the room, so 150 people posting 280 characters
// each is two orders of magnitude more bytes per frame than a tag cloud. Watch
// per-client bytes: permessage-deflate should be keeping it in single-digit KB.

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8099';
const WSB = BASE.replace('http', 'ws');
const SLUG = process.env.SLUG;
const CLIENTS = Number(process.env.CLIENTS || 150);
const QUESTION_ID = Number(process.env.QUESTION_ID || 0);
const MODE = process.env.MODE === 'freetext' ? 'freetext' : 'tags';

if (!SLUG) {
  console.error('set SLUG to a live sheet slug');
  process.exit(1);
}

const WORDS = [
  'usability', 'design', 'humans', 'interface', 'buttons', 'feedback', 'affordance',
  'accessibility', 'ux', 'people', 'screens', 'input', 'clarity', 'friction',
  'delight', 'confusion', 'menus', 'icons', 'touch', 'layout',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clients = [];
let framesReceived = 0;
let bytesReceived = 0;

console.log(`opening ${CLIENTS} connections to /${SLUG} ...`);

for (let i = 0; i < CLIENTS; i += 1) {
  const ws = new WebSocket(`${WSB}/ws?slug=${SLUG}`);
  ws.on('message', (raw) => {
    framesReceived += 1;
    bytesReceived += raw.length;
  });
  ws.on('error', (err) => console.error('socket error:', err.message));
  clients.push(ws);
}

await Promise.all(clients.map((ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.OPEN) resolve();
  else ws.on('open', resolve);
})));

const connected = clients.filter((ws) => ws.readyState === WebSocket.OPEN).length;
console.log(`${connected} connected`);

let questionId = QUESTION_ID;
if (!questionId) {
  const state = await new Promise((resolve) => {
    const probe = new WebSocket(`${WSB}/ws?slug=${SLUG}`);
    probe.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state_update') {
        probe.close();
        resolve(msg);
      }
    });
  });
  questionId = state.activeQuestionId;
}

if (!questionId) {
  console.error('no active question - activate one from the presenter view first');
  process.exit(1);
}

// Reset the counters so the measurement covers the burst, not the joining.
await sleep(500);
framesReceived = 0;
bytesReceived = 0;

const started = Date.now();
console.log(`bursting ${connected} ${MODE} submissions at question ${questionId} ...`);

clients.forEach((ws, i) => {
  if (ws.readyState !== WebSocket.OPEN) return;

  if (MODE === 'freetext') {
    // Long answers on purpose: the worst case for payload size is everyone
    // using their full allowance, which is exactly what a keen cohort does.
    const filler = WORDS[i % WORDS.length].repeat(6).slice(0, 180);
    ws.send(JSON.stringify({
      type: 'submit_response',
      questionId,
      text: `Answer ${i}: ${filler} and something about ${WORDS[(i * 7) % WORDS.length]}.`,
      sessionId: `load-${i}`,
    }));
    return;
  }

  ws.send(JSON.stringify({
    type: 'submit_tag',
    questionId,
    // Mostly overlapping vocabulary, with some long-tail novelty - roughly how a
    // real room answers.
    tag: i % 4 === 0 ? `${WORDS[i % WORDS.length]}-${i}` : WORDS[i % WORDS.length],
    sessionId: `load-${i}`,
  }));
});

await sleep(4000);
const elapsed = (Date.now() - started) / 1000;

const framesPerClient = framesReceived / Math.max(connected, 1);
console.log('');
console.log(`elapsed              ${elapsed.toFixed(1)}s`);
console.log(`submissions sent     ${connected}`);
console.log(`frames received      ${framesReceived} across all clients`);
console.log(`frames per client    ${framesPerClient.toFixed(1)}`);
console.log(`total bytes          ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`);
console.log(`per-client bytes     ${(bytesReceived / connected / 1024).toFixed(1)} KB`);
console.log('');
console.log(framesPerClient < connected / 4
  ? `coalescing works: ${framesPerClient.toFixed(1)} frames per client, not ${connected}`
  : `NOT coalescing: ${framesPerClient.toFixed(1)} frames per client`);

for (const ws of clients) ws.close();
await sleep(300);
process.exit(0);
