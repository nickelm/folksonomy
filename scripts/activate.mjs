// Activate the first question of a sheet, for load testing.
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:8099';
const slug = process.env.SLUG;
const password = process.env.PRESENTER_PASSWORD || 'testpass';

const { token } = await (await fetch(`${BASE}/api/presenter/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
})).json();

const { questions } = await (await fetch(`${BASE}/api/sheets/${slug}/questions`, {
  headers: { Authorization: `Bearer ${token}` },
})).json();

const questionId = questions[0].id;
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?slug=${slug}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'authenticate', token }));
await sleep(300);
ws.send(JSON.stringify({ type: 'set_active', questionId }));
await sleep(500);
ws.close();
console.log(questionId);
process.exit(0);
