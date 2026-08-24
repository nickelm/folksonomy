// Folksonomy sheets - live tag polling for a lecture hall.
//
// One process serves the student pages, the presenter pages, and the WebSocket
// that keeps both in sync. Sized for ~150 phones on classroom wifi.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import {
  addOptions, addQuestion, buildSheetState, clearResponses, clearTags, clearVotes,
  cloneSheet, countResponses, createSheet, deleteQuestion, deleteSheet, getQuestion,
  getSheetById, getSheetBySlug, listAliases, listAllSheets, listClusters, listOptions,
  listPublicSheets, listQuestions, listResponses, listTags, normalizeQuestionType,
  getChoice, recordChoice, recordResponse, recordResponseVote, recordTag, removeTag, seedFromFiles,
  setActiveQuestion, setSheetStatus, tagCooccurrence, updateQuestion, voteTimeline,
} from './db.js';
import { Clusterer } from './cluster.js';
import { MergeWorker } from './merge.js';
import { isValidSlug } from './slugs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD || '';

// How often a dirty sheet may be flushed to its subscribers. Broadcasting per
// submission would mean 150 messages x 150 sockets during an opening burst; at
// 300ms the room still feels instant and the fan-out stays bounded.
const BROADCAST_INTERVAL_MS = 300;

// Per-session submit throttle. Generous for a person, tight enough to blunt a
// script typed into a browser console halfway through the lecture.
const SUBMIT_INTERVAL_MS = 800;

// Voting gets its own, looser gate. Adding something is the expensive act worth
// rate limiting; agreeing with something already there is not, and it is done in
// bursts - reading down a feed and tapping three answers, or tapping two pills in
// a cloud. At 800ms most of those taps are silently refused, which looks exactly
// like the vote not registering.
const VOTE_INTERVAL_MS = 250;

// Per-tick ceiling on the sedimentation feed. A burst larger than this is one
// the projector could not draw anyway, so the surplus is dropped here rather
// than turned into particles the animation would immediately discard.
const MAX_SUBMISSIONS_PER_TICK = 300;

if (!PRESENTER_PASSWORD) {
  console.warn('[warn] PRESENTER_PASSWORD is not set - presenter controls are unusable');
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

const server = http.createServer(app);

// --------------------------------------------------------------------------
// Presenter auth
// --------------------------------------------------------------------------

// Tokens live in memory only. A restart logs the presenter out, which is a fair
// trade for not having to manage a session store for a single-instructor app.
const tokens = new Set();
const loginAttempts = new Map();

function passwordMatches(candidate) {
  if (!PRESENTER_PASSWORD || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(PRESENTER_PASSWORD);
  // timingSafeEqual throws on a length mismatch, so compare digests instead and
  // keep the comparison constant-time regardless of what was submitted.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function rateLimitLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 60_000;
  }
  record.count += 1;
  loginAttempts.set(ip, record);
  return record.count <= 10;
}

function tokenFromRequest(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  return next();
}

app.post('/api/presenter/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimitLogin(ip)) {
    return res.status(429).json({ error: 'too many attempts, wait a minute' });
  }
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.add(token);
  return res.json({ token });
});

app.get('/api/presenter/session', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// Broadcast
// --------------------------------------------------------------------------

/** @type {Map<number, Set<import('ws').WebSocket>>} sheetId -> sockets */
const rooms = new Map();
/** @type {Set<number>} sheets whose state changed since the last flush */
const dirty = new Set();
/** @type {Map<number, {student: string, presenter: string}>} last sent payloads */
const lastSent = new Map();
/** @type {Map<number, Array<object>>} sheetId -> submissions awaiting the next flush */
const submissions = new Map();

function room(sheetId) {
  if (!rooms.has(sheetId)) rooms.set(sheetId, new Set());
  return rooms.get(sheetId);
}

function markDirty(sheetId) {
  dirty.add(sheetId);
}

/**
 * Record one arrival for the live view's sedimentation animation.
 *
 * Only the projector wants these, so they are buffered per sheet and sent on the
 * same tick as the state - never to the phones, which would double their traffic
 * for an animation they do not draw.
 */
function noteSubmission(sheetId, item) {
  if (!submissions.has(sheetId)) submissions.set(sheetId, []);
  const queue = submissions.get(sheetId);
  if (queue.length >= MAX_SUBMISSIONS_PER_TICK) return;
  queue.push(item);
}

/**
 * Send each dirty sheet's state to its own subscribers.
 *
 * Two serialisations per sheet, not per socket: students and presenters see
 * different payloads (unrevealed clouds are withheld from students), but every
 * student gets a byte-identical string. Skipping an unchanged payload matters
 * more than it looks - without it, a heartbeat-driven re-render would fight the
 * student's on-screen keyboard.
 */
function flush() {
  if (dirty.size === 0) return;

  for (const sheetId of dirty) {
    const sockets = rooms.get(sheetId);
    if (!sockets || sockets.size === 0) {
      lastSent.delete(sheetId);
      submissions.delete(sheetId);
      continue;
    }

    // Submissions go out before the state that accounts for them. The live view
    // holds each bar back until its token lands, so the token has to be in the
    // air before the count that includes it arrives.
    const arrivals = submissions.get(sheetId);
    if (arrivals && arrivals.length > 0) {
      const frames = arrivals.map((item) => JSON.stringify({ type: 'submission', ...item }));
      for (const socket of sockets) {
        if (socket.readyState !== socket.OPEN || !socket.wantsSubmissions) continue;
        for (const frame of frames) socket.send(frame);
      }
      submissions.delete(sheetId);
    }

    const studentState = buildSheetState(sheetId, { forPresenter: false });
    if (!studentState) continue;
    const presenterState = buildSheetState(sheetId, { forPresenter: true });

    const connectedCount = sockets.size;
    const student = JSON.stringify({
      type: 'state_update', connectedCount, ...studentState,
    });
    const presenter = JSON.stringify({
      type: 'state_update', connectedCount, ...presenterState,
    });

    const previous = lastSent.get(sheetId) || {};
    const studentChanged = previous.student !== student;
    const presenterChanged = previous.presenter !== presenter;
    if (!studentChanged && !presenterChanged) continue;
    lastSent.set(sheetId, { student, presenter });

    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      const payload = socket.isPresenter ? presenter : student;
      if (socket.isPresenter ? presenterChanged : studentChanged) socket.send(payload);
    }
  }

  dirty.clear();
}

const flushTimer = setInterval(flush, BROADCAST_INTERVAL_MS);

function sendState(socket) {
  const state = buildSheetState(socket.sheetId, { forPresenter: socket.isPresenter });
  if (!state) return;
  socket.send(JSON.stringify({
    type: 'state_update',
    connectedCount: room(socket.sheetId).size,
    ...state,
  }));
}

const merger = new MergeWorker({ onChange: markDirty });

/** Tell the presenters watching a sheet how a clustering run is going. */
function broadcastClusterStatus(questionId, state, detail) {
  const question = getQuestion(questionId);
  if (!question) return;
  const sockets = rooms.get(question.sheet_id);
  if (!sockets) return;

  const frame = JSON.stringify({ type: 'cluster_status', questionId, state, detail });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN && socket.isPresenter) socket.send(frame);
  }
}

const clusterer = new Clusterer({
  onChange: markDirty,
  onStatus: broadcastClusterStatus,
});

// --------------------------------------------------------------------------
// WebSocket
// --------------------------------------------------------------------------

// Compression matters here for one reason: a freetext question's state carries
// every answer in the room, and prose deflates to a fraction of its size. The
// threshold keeps the small tag payloads out of it, where it would only add CPU.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: { threshold: 2048 },
});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost');
  const slug = url.searchParams.get('slug');
  const sheet = slug ? getSheetBySlug(slug) : null;

  if (!sheet) {
    socket.close(4004, 'unknown sheet');
    return;
  }

  socket.sheetId = sheet.id;
  socket.isPresenter = false;
  socket.isAlive = true;
  socket.lastSubmitAt = 0;
  socket.lastVoteAt = 0;
  // The projection view opts in to the per-arrival feed that drives its falling
  // tokens. Nothing else receives it.
  socket.wantsSubmissions = url.searchParams.get('role') === 'live';

  room(sheet.id).add(socket);
  sendState(socket);
  markDirty(sheet.id);

  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(socket, msg);
  });

  socket.on('close', () => {
    const sockets = rooms.get(socket.sheetId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        rooms.delete(socket.sheetId);
        lastSent.delete(socket.sheetId);
        submissions.delete(socket.sheetId);
      }
    }
    // The connected count is part of the payload, so a departure is a change.
    markDirty(socket.sheetId);
  });
});

/**
 * Tell one client what it actually has selected.
 *
 * A choice is single-select, so the client paints the new pick the moment it is
 * tapped rather than waiting a broadcast. When the server then refuses - the tap
 * was inside the throttle, the option had just been removed - the client would
 * otherwise be left showing a pick nobody recorded, with nothing in the state
 * payload to contradict it: which option is *yours* is the one thing a shared
 * broadcast cannot carry. So every select_choice is answered, refused or not.
 */
function ackChoice(socket, questionId, sessionId) {
  if (socket.readyState !== socket.OPEN) return;
  if (!sessionId || typeof sessionId !== 'string') return;
  socket.send(JSON.stringify({
    type: 'choice_ack',
    questionId,
    label: getChoice(questionId, sessionId),
  }));
}

function reject(socket, reason) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: 'error', reason }));
  }
}

function handleMessage(socket, msg) {
  const sheet = getSheetById(socket.sheetId);
  if (!sheet) return;

  if (msg.type === 'authenticate') {
    if (typeof msg.token === 'string' && tokens.has(msg.token)) {
      socket.isPresenter = true;
      sendState(socket);
    } else {
      reject(socket, 'bad_token');
    }
    return;
  }

  const STUDENT_WRITES = new Set([
    'submit_tag', 'vote_tag', 'submit_response', 'vote_response', 'select_choice',
  ]);

  // Which message belongs to which kind of question. A message aimed at the
  // wrong kind is a bug or a probe, never a student - the three UIs cannot send
  // each other's messages.
  const WRITES_FOR = {
    submit_tag: 'tags',
    vote_tag: 'tags',
    submit_response: 'freetext',
    vote_response: 'freetext',
    select_choice: 'choice',
  };

  if (STUDENT_WRITES.has(msg.type)) {
    // A closed sheet is an archive. Enforce that here, not only in the UI - the
    // page is trivially editable from a phone's browser console.
    if (sheet.status !== 'live') return reject(socket, 'sheet_not_live');

    const question = getQuestion(msg.questionId);
    if (!question || question.sheet_id !== sheet.id) return reject(socket, 'unknown_question');
    if (!question.active) return reject(socket, 'question_not_active');

    if (WRITES_FOR[msg.type] !== question.type) {
      return reject(socket, 'wrong_question_type');
    }

    // Creating something is throttled hard; voting for something that already
    // exists is throttled gently. They are different acts with different costs.
    const creates = msg.type === 'submit_tag' || msg.type === 'submit_response';
    const now = Date.now();

    if (creates) {
      if (now - socket.lastSubmitAt < SUBMIT_INTERVAL_MS) return reject(socket, 'too_fast');
      socket.lastSubmitAt = now;
    } else {
      if (now - socket.lastVoteAt < VOTE_INTERVAL_MS) {
        if (msg.type === 'select_choice') ackChoice(socket, question.id, msg.sessionId);
        return reject(socket, 'too_fast');
      }
      socket.lastVoteAt = now;
    }

    if (msg.type === 'submit_response') {
      const result = recordResponse({
        questionId: question.id,
        rawText: msg.text,
        sessionId: msg.sessionId,
      });
      if (!result.ok) return reject(socket, result.reason);

      markDirty(sheet.id);
      noteSubmission(sheet.id, {
        questionId: question.id, kind: 'freetext', label: null,
      });
      return undefined;
    }

    if (msg.type === 'vote_response') {
      const result = recordResponseVote({
        questionId: question.id,
        responseId: Number(msg.responseId),
        direction: Number(msg.direction),
        sessionId: msg.sessionId,
      });
      if (!result.ok) return reject(socket, result.reason);

      // Confirm the direction now in force, so a client whose optimistic guess
      // was wrong (a double tap that raced its own undo) can correct itself.
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          type: 'vote_ack',
          questionId: question.id,
          responseId: Number(msg.responseId),
          direction: result.direction,
        }));
      }
      markDirty(sheet.id);
      return undefined;
    }

    if (msg.type === 'select_choice') {
      const result = recordChoice({
        questionId: question.id,
        rawTag: msg.tag,
        sessionId: msg.sessionId,
      });
      ackChoice(socket, question.id, msg.sessionId);
      if (!result.ok) return reject(socket, result.reason);

      // Re-picking what you already had changes nothing, so nothing is broadcast
      // and no token falls. Only a real switch is an event.
      if (result.changed) {
        markDirty(sheet.id);
        noteSubmission(sheet.id, {
          questionId: question.id, kind: 'choice', label: result.label,
        });
      }
      return undefined;
    }

    const result = recordTag({
      questionId: question.id,
      rawTag: msg.tag,
      sessionId: msg.sessionId,
      // Tapping a pill may only vote; it must never invent a tag, even if the
      // client sends a label that has since been merged away.
      allowCreate: msg.type === 'submit_tag',
    });

    if (!result.ok) return reject(socket, result.reason);

    markDirty(sheet.id);
    // Only a vote that actually landed gets a token on the projector.
    if (result.counted) {
      noteSubmission(sheet.id, {
        questionId: question.id, kind: 'tag', label: result.label,
      });
    }
    // Only tags questions merge. A choice question cannot reach here, but say so
    // anyway: folding two options together would silently rewrite the ballot.
    if (result.created && question.type === 'tags') {
      merger.enqueue(question.id, result.label);
    }
    return undefined;
  }

  if (!socket.isPresenter) return reject(socket, 'not_authenticated');

  switch (msg.type) {
    case 'set_active': {
      if (sheet.status === 'closed') return reject(socket, 'sheet_closed');
      if (msg.questionId != null) {
        const question = getQuestion(msg.questionId);
        if (!question || question.sheet_id !== sheet.id) {
          return reject(socket, 'unknown_question');
        }
      }

      // Note what was open before we close it: a freetext question that has just
      // been put away is exactly the moment to group its answers, and it saves
      // the presenter remembering to press the button.
      const previous = listQuestions(sheet.id).find((q) => q.active);

      setActiveQuestion(sheet.id, msg.questionId ?? null);
      markDirty(sheet.id);

      if (previous && previous.type === 'freetext' && previous.id !== msg.questionId) {
        clusterer.run(previous.id);
      }
      return undefined;
    }
    case 'cluster_now': {
      const question = getQuestion(msg.questionId);
      if (!question || question.sheet_id !== sheet.id) {
        return reject(socket, 'unknown_question');
      }
      // Deliberately not awaited: a Haiku call takes seconds, and the socket
      // handler must not sit on it. Progress arrives as cluster_status.
      clusterer.run(question.id);
      return undefined;
    }
    case 'clear_tags': {
      const question = getQuestion(msg.questionId);
      if (!question || question.sheet_id !== sheet.id) {
        return reject(socket, 'unknown_question');
      }
      if (question.type === 'freetext') clearResponses(question.id);
      // A choice question's options are its content, not its answers. Clearing
      // it must leave the ballot standing or there is nothing left to vote on.
      else if (question.type === 'choice') clearVotes(question.id);
      else clearTags(question.id);
      markDirty(sheet.id);
      return undefined;
    }
    case 'remove_tag': {
      const question = getQuestion(msg.questionId);
      if (!question || question.sheet_id !== sheet.id) {
        return reject(socket, 'unknown_question');
      }
      removeTag(question.id, msg.tagId);
      markDirty(sheet.id);
      return undefined;
    }
    default:
      return undefined;
  }
}

// Phones sleep and wifi drops without closing the socket. Without this sweep the
// connected count drifts upward all lecture and dead sockets accumulate.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

// --------------------------------------------------------------------------
// Sheet + question API (presenter only)
// --------------------------------------------------------------------------

function publicUrlFor(req, slug) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/${slug}`;
  return `${req.protocol}://${req.get('host')}/${slug}`;
}

app.get('/api/sheets', requireAuth, (req, res) => {
  res.json({ sheets: listAllSheets() });
});

app.get('/api/public/sheets', (req, res) => {
  res.json({ sheets: listPublicSheets() });
});

app.post('/api/sheets', requireAuth, (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });

  const requested = req.body?.slug ? String(req.body.slug).trim().toLowerCase() : null;
  if (requested && !isValidSlug(requested)) {
    return res.status(400).json({ error: 'that slug is not usable' });
  }

  const sheet = createSheet({ title, slug: requested });
  return res.status(201).json({ sheet, url: publicUrlFor(req, sheet.slug) });
});

app.post('/api/sheets/:slug/clone', requireAuth, (req, res) => {
  const source = getSheetBySlug(req.params.slug);
  if (!source) return res.status(404).json({ error: 'no such sheet' });

  const title = String(req.body?.title || '').trim();
  const sheet = cloneSheet(source.id, title);
  return res.status(201).json({ sheet, url: publicUrlFor(req, sheet.slug) });
});

app.post('/api/sheets/:slug/status', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });

  const status = String(req.body?.status || '');
  if (!['draft', 'live', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft, live, or closed' });
  }
  if (sheet.status === 'closed' && status !== 'closed') {
    return res.status(409).json({ error: 'a closed sheet cannot be reopened from here' });
  }

  const updated = setSheetStatus(sheet.id, status);
  markDirty(sheet.id);
  return res.json({ sheet: updated });
});

app.delete('/api/sheets/:slug', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });
  deleteSheet(sheet.id);
  rooms.delete(sheet.id);
  lastSent.delete(sheet.id);
  return res.json({ ok: true });
});

app.get('/api/sheets/:slug/questions', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });
  return res.json({ questions: listQuestions(sheet.id) });
});

app.post('/api/sheets/:slug/questions', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });

  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });

  const type = normalizeQuestionType(req.body?.type);
  const options = Array.isArray(req.body?.options) ? req.body.options : [];

  if (type === 'choice' && options.filter((o) => String(o).trim()).length < 2) {
    return res.status(400).json({ error: 'a choice question needs at least two options' });
  }

  const question = addQuestion(sheet.id, {
    title,
    description: String(req.body?.description || '').trim(),
    type,
    options,
  });
  markDirty(sheet.id);
  return res.status(201).json({ question });
});

app.post('/api/questions/:id/options', requireAuth, (req, res) => {
  const question = getQuestion(Number(req.params.id));
  if (!question) return res.status(404).json({ error: 'no such question' });
  if (question.type === 'freetext') {
    return res.status(400).json({ error: 'a freetext question has no options' });
  }

  const added = addOptions(question.id, req.body?.options);
  markDirty(question.sheet_id);
  return res.status(201).json({ options: listOptions(question.id), added });
});

app.patch('/api/questions/:id', requireAuth, (req, res) => {
  const question = getQuestion(Number(req.params.id));
  if (!question) return res.status(404).json({ error: 'no such question' });

  const updated = updateQuestion(question.id, {
    title: req.body?.title != null ? String(req.body.title).trim() : undefined,
    description: req.body?.description != null ? String(req.body.description).trim() : undefined,
    position: req.body?.position != null ? Number(req.body.position) : undefined,
    type: req.body?.type != null ? normalizeQuestionType(req.body.type) : undefined,
  });
  markDirty(question.sheet_id);
  return res.json({ question: updated });
});

app.delete('/api/questions/:id', requireAuth, (req, res) => {
  const question = getQuestion(Number(req.params.id));
  if (!question) return res.status(404).json({ error: 'no such question' });
  deleteQuestion(question.id);
  markDirty(question.sheet_id);
  return res.json({ ok: true });
});

// --------------------------------------------------------------------------
// Export and QR
// --------------------------------------------------------------------------

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/api/sheets/:slug/export.csv', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });

  const rows = [[
    'question_position', 'question_title', 'question_type',
    'item', 'score', 'cluster',
  ]];
  for (const question of listQuestions(sheet.id)) {
    if (question.type === 'freetext') {
      for (const r of listResponses(question.id, Number.MAX_SAFE_INTEGER)) {
        rows.push([
          question.position, question.title, question.type,
          r.text, r.score, r.clusterLabel || '',
        ]);
      }
    } else if (question.type === 'choice') {
      for (const option of listOptions(question.id)) {
        rows.push([question.position, question.title, question.type,
          option.label, option.count, '']);
      }
    } else {
      for (const tag of listTags(question.id)) {
        rows.push([question.position, question.title, question.type, tag.label, tag.count, '']);
      }
    }
  }

  res.type('text/csv').set(
    'Content-Disposition',
    `attachment; filename="${sheet.slug}.csv"`,
  );
  return res.send(rows.map((row) => row.map(csvCell).join(',')).join('\n'));
});

app.get('/api/sheets/:slug/export.json', requireAuth, (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });

  const questions = listQuestions(sheet.id).map((question) => {
    const entry = {
      position: question.position,
      title: question.title,
      description: question.description,
      type: question.type,
    };

    if (question.type === 'freetext') {
      entry.responses = listResponses(question.id, Number.MAX_SAFE_INTEGER);
      entry.clusters = listClusters(question.id);
    } else if (question.type === 'choice') {
      entry.options = listOptions(question.id);
    } else {
      entry.tags = listTags(question.id);
      // The merge history is the interesting part for a folksonomy exercise: it
      // shows which words the class produced before they were folded together.
      entry.merges = listAliases(question.id);
    }

    return entry;
  });

  res.set('Content-Disposition', `attachment; filename="${sheet.slug}.json"`);
  return res.json({
    slug: sheet.slug,
    title: sheet.title,
    status: sheet.status,
    createdAt: sheet.created_at,
    closedAt: sheet.closed_at,
    exportedAt: Date.now(),
    questions,
  });
});

/**
 * Derived data for the dashboard: co-occurrence and vote timing.
 *
 * Public, and gated exactly the way the socket payload is - an unrevealed
 * question returns nothing at all. The dashboard is a lens on what the class has
 * already been shown, never a way around the reveal.
 */
app.get('/api/sheets/:slug/analytics', (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });

  const token = tokenFromRequest(req);
  const forPresenter = Boolean(token && tokens.has(token));

  const questions = listQuestions(sheet.id).map((question) => {
    const entry = { id: question.id, type: question.type };
    if (!forPresenter && !question.revealed) return entry;

    // Nothing derived to add for freetext: its panels all read the themes and
    // scores that are already in the socket payload.
    if (question.type !== 'freetext') {
      entry.cooccurrence = tagCooccurrence(question.id);
      entry.timeline = voteTimeline(question.id);
    }
    return entry;
  });

  res.set('Cache-Control', 'no-store');
  return res.json({ slug: sheet.slug, questions });
});

// Public: it only ever encodes a URL that is itself public.
app.get('/api/sheets/:slug/qr.svg', async (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).send('no such sheet');

  try {
    const svg = await QRCode.toString(publicUrlFor(req, sheet.slug), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600');
    return res.send(svg);
  } catch (err) {
    return res.status(500).send('could not render QR code');
  }
});

app.get('/api/sheets/:slug/join', (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) return res.status(404).json({ error: 'no such sheet' });
  return res.json({ url: publicUrlFor(req, sheet.slug) });
});

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------

const PUBLIC_DIR = path.join(HERE, 'public');

/**
 * Serve d3 straight out of node_modules.
 *
 * No bundler in this project and no CDN either: a lecture hall's wifi is not
 * something to make the projector depend on, and the droplet should keep working
 * with the network unplugged. Serving the published UMD builds costs one mount
 * and no build step. Only the live view and the dashboard load them - the phones
 * never see d3, which is the whole reason this is not a global script tag.
 */
const VENDOR = [
  ['d3.min.js', 'd3/dist/d3.min.js'],
  ['d3.layout.cloud.js', 'd3-cloud/build/d3.layout.cloud.js'],
];

for (const [name, relative] of VENDOR) {
  const full = path.join(HERE, 'node_modules', ...relative.split('/'));
  if (!fs.existsSync(full)) {
    console.warn(`[warn] ${relative} is missing - run npm install; charts will not draw`);
    continue;
  }
  app.get(`/vendor/${name}`, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(full);
  });
}

app.use(express.static(PUBLIC_DIR, {
  // HTML must not be cached: a student reloading mid-lecture has to get the
  // current page, not one a proxy held onto.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store');
  },
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/presenter', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'presenter.html'));
});

app.get('/presenter/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'control.html'));
});

app.get('/live/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'live.html'));
});

app.get('/d/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

// Short aliases. The bare slug stays canonical because it is the one a presenter
// reads out loud to a room - "/s/" is two more syllables for no benefit at the
// lectern - but a typed or pasted /s/ and /p/ should still land somewhere right.
app.get('/s/:slug', (req, res) => res.redirect(302, `/${encodeURIComponent(req.params.slug)}`));
app.get('/p/:slug', (req, res) => {
  res.redirect(302, `/presenter/${encodeURIComponent(req.params.slug)}`);
});

// Registered last so a sheet slug can never shadow /presenter, /api, or a static
// file. Unknown slugs fall through to a 404 page rather than the sheet view.
app.get('/:slug', (req, res) => {
  const sheet = getSheetBySlug(req.params.slug);
  if (!sheet) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, 'notfound.html'));
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'sheet.html'));
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

const seeded = seedFromFiles();
if (seeded.length === 0) console.log('[seed] no new sheet files to load');

server.listen(PORT, () => {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.log(`Folksonomy sheets listening on port ${PORT}`);
  console.log(`  students  ${base}/`);
  console.log(`  presenter ${base}/presenter`);
});

function shutdown() {
  console.log('\nshutting down');
  clearInterval(flushTimer);
  clearInterval(heartbeat);
  merger.stop();
  for (const socket of wss.clients) socket.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  // Do not let a half-open socket hold the lectern hostage.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
