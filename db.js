// SQLite storage for folksonomy sheets.
//
// Everything here is synchronous (better-sqlite3). That is deliberate: the write
// volume is a lecture hall's worth of short tag submissions, and synchronous
// statements inside transactions are both faster and easier to reason about than
// a pool of async queries racing each other.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { generateSlug, isValidSlug, RESERVED_SLUGS } from './slugs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const DB_PATH = path.join(DATA_DIR, 'poll.db');
const SHEETS_DIR = path.join(HERE, 'sheets');

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_SESSION_PER_QUESTION = 10;

// A freetext answer is meant to be a sentence or two, not an essay: 280 keeps it
// readable in a feed on a phone and keeps the state payload bounded.
export const MAX_RESPONSE_LENGTH = 280;
export const MAX_RESPONSES_PER_SESSION_PER_QUESTION = 3;

// Ceiling on how many responses travel in a state broadcast. Well above a full
// lecture hall, but it stops one runaway question from making every tick huge.
export const MAX_RESPONSES_IN_STATE = 200;

export const QUESTION_TYPES = new Set(['tags', 'freetext', 'choice']);

// A choice question's options are the most anyone should have to read off a
// projector and pick between on a phone.
export const MAX_OPTIONS = 8;

export function normalizeQuestionType(raw) {
  return QUESTION_TYPES.has(raw) ? raw : 'tags';
}

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

// WAL lets readers run while a write is in flight, which matters when 150 sockets
// trigger state reads between submissions.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sheets (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',
    source_file TEXT UNIQUE,
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS questions (
    id          INTEGER PRIMARY KEY,
    sheet_id    INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL DEFAULT 'tags',
    active      INTEGER NOT NULL DEFAULT 0,
    revealed    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    seeded      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    UNIQUE (question_id, label)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id          INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (question_id, tag_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS tag_aliases (
    question_id      INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    alias            TEXT NOT NULL,
    canonical_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (question_id, alias)
  );

  CREATE TABLE IF NOT EXISTS responses (
    id            INTEGER PRIMARY KEY,
    question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL,
    text          TEXT NOT NULL,
    cluster_label TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS response_votes (
    id          INTEGER PRIMARY KEY,
    response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    session_id  TEXT NOT NULL,
    direction   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (response_id, session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_questions_sheet ON questions(sheet_id, position);
  CREATE INDEX IF NOT EXISTS idx_responses_question   ON responses(question_id);
  CREATE INDEX IF NOT EXISTS idx_response_votes_resp  ON response_votes(response_id);
  CREATE INDEX IF NOT EXISTS idx_tags_question   ON tags(question_id);
  CREATE INDEX IF NOT EXISTS idx_votes_tag       ON votes(tag_id);
  CREATE INDEX IF NOT EXISTS idx_votes_question  ON votes(question_id);
`);

/**
 * Add a column to an existing table, once.
 *
 * CREATE TABLE IF NOT EXISTS silently does nothing when the table is already
 * there, so a database from before a column existed never gains it. A droplet
 * mid-semester has exactly that database, and losing it would lose the semester.
 */
function addColumnIfMissing(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

addColumnIfMissing('questions', 'type', "type TEXT NOT NULL DEFAULT 'tags'");
addColumnIfMissing('tags', 'seeded', 'seeded INTEGER NOT NULL DEFAULT 0');
// A per-question steer for theme clustering: extra guidance appended to the
// clustering prompt, such as "name the interface failure, not the product".
// Only freetext questions use it; it is harmless on the others.
addColumnIfMissing('questions', 'cluster_hint', "cluster_hint TEXT NOT NULL DEFAULT ''");
// The same kind of steer for tag merging: context appended to the merge prompt,
// such as "tags are candidate design rules; merge only the same rule".
addColumnIfMissing('questions', 'merge_hint', "merge_hint TEXT NOT NULL DEFAULT ''");
// Space-separated leading words to drop from a new tag before it is looked up,
// so "be consistent" and "consistent" are one tag with no API round trip. Per
// question, because a global rule would turn "use cases" into "cases".
addColumnIfMissing('questions', 'strip_prefixes', "strip_prefixes TEXT NOT NULL DEFAULT ''");

/**
 * Fold a raw submission into its canonical stored form, or return null if it is
 * not a usable tag. Used by both the submit and the vote path, so the two can
 * never disagree about what "the same tag" means.
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!cleaned) return null;
  if (cleaned.length > MAX_TAG_LENGTH) return null;
  return cleaned;
}

/**
 * Canonical form of a strip-prefix list: lowercase single words, space-separated.
 * Accepts an array or a string, so the sheet file and the API can use either.
 */
export function normalizeStripPrefixes(raw) {
  const words = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
  return [...new Set(
    words.map((w) => String(w).trim().toLowerCase()).filter((w) => /^[\p{L}\p{N}'-]+$/u.test(w)),
  )].join(' ');
}

/**
 * Drop one leading word from an already-normalized tag if it is in `prefixes`.
 * A tag that is nothing but the prefix ("show") is left alone rather than erased.
 */
export function stripTagPrefix(label, prefixes) {
  if (!label || !prefixes) return label;
  const space = label.indexOf(' ');
  if (space < 0) return label;
  const first = label.slice(0, space);
  return prefixes.split(' ').includes(first) ? label.slice(space + 1) : label;
}

/**
 * Clean a freetext answer, or return null if it is not usable.
 *
 * Unlike normalizeTag this does NOT lowercase: a tag is a token in a shared
 * vocabulary, a response is somebody's prose and should read back as they wrote
 * it. Whitespace is still collapsed so a wall of blank lines cannot be posted.
 */
export function normalizeResponseText(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  if (cleaned.length > MAX_RESPONSE_LENGTH) return null;
  return cleaned;
}

// --------------------------------------------------------------------------
// Sheets
// --------------------------------------------------------------------------

const slugTaken = db.prepare('SELECT 1 FROM sheets WHERE slug = ?');

export function slugExists(slug) {
  return slugTaken.get(slug) !== undefined;
}

export function getSheetBySlug(slug) {
  return db.prepare('SELECT * FROM sheets WHERE slug = ?').get(slug);
}

export function getSheetById(id) {
  return db.prepare('SELECT * FROM sheets WHERE id = ?').get(id);
}

/** Sheets students may see: live first, then closed, newest first. Drafts excluded. */
export function listPublicSheets() {
  return db.prepare(`
    SELECT slug, title, status, created_at, closed_at
      FROM sheets
     WHERE status IN ('live', 'closed')
     ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END, created_at DESC
  `).all();
}

/** Every sheet, with response totals, for the presenter index. */
export function listAllSheets() {
  return db.prepare(`
    SELECT s.id, s.slug, s.title, s.status, s.created_at, s.closed_at,
           (SELECT COUNT(*) FROM questions q WHERE q.sheet_id = s.id) AS question_count,
           (SELECT COUNT(*) FROM votes v
              JOIN questions q ON q.id = v.question_id
             WHERE q.sheet_id = s.id) AS vote_count,
           (SELECT COUNT(DISTINCT v.session_id) FROM votes v
              JOIN questions q ON q.id = v.question_id
             WHERE q.sheet_id = s.id) AS participant_count
      FROM sheets s
     ORDER BY CASE s.status WHEN 'live' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
              s.created_at DESC
  `).all();
}

export function createSheet({ title, slug, status = 'draft', sourceFile = null }) {
  const chosen = slug && isValidSlug(slug) && !slugExists(slug)
    ? slug
    : generateSlug(slugExists);

  const info = db.prepare(`
    INSERT INTO sheets (slug, title, status, source_file, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chosen, title, status, sourceFile, Date.now());

  return getSheetById(info.lastInsertRowid);
}

export function setSheetStatus(sheetId, status) {
  if (status === 'closed') {
    // Closing reveals everything and stops the clock: the sheet becomes a
    // read-only record students can come back to weeks later.
    db.transaction(() => {
      db.prepare('UPDATE sheets SET status = ?, closed_at = ? WHERE id = ?')
        .run('closed', Date.now(), sheetId);
      db.prepare('UPDATE questions SET revealed = 1, active = 0 WHERE sheet_id = ?')
        .run(sheetId);
    })();
  } else {
    db.prepare('UPDATE sheets SET status = ?, closed_at = NULL WHERE id = ?')
      .run(status, sheetId);
  }
  return getSheetById(sheetId);
}

/** Copy a sheet's questions into a fresh sheet, leaving all responses behind. */
export function cloneSheet(sourceSheetId, title) {
  return db.transaction(() => {
    const source = getSheetById(sourceSheetId);
    const sheet = createSheet({ title: title || `${source.title} (copy)` });
    const insert = db.prepare(`
      INSERT INTO questions
        (sheet_id, position, title, description, type, cluster_hint, merge_hint, strip_prefixes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const q of listQuestions(sourceSheetId)) {
      const info = insert.run(
        sheet.id, q.position, q.title, q.description, q.type, q.cluster_hint ?? '',
        q.merge_hint ?? '', q.strip_prefixes ?? '',
      );
      // Seeded options are part of the question, not part of the answers, so a
      // clone starts with them and with nothing else: a cloned choice question
      // needs its ballot, and last year's starting words are worth keeping,
      // but last year's students' words are not.
      const authored = listOptions(q.id).filter((o) => o.seeded).map((o) => o.label);
      addOptions(info.lastInsertRowid, authored);
    }
    return sheet;
  })();
}

export function deleteSheet(sheetId) {
  db.prepare('DELETE FROM sheets WHERE id = ?').run(sheetId);
}

// --------------------------------------------------------------------------
// Questions
// --------------------------------------------------------------------------

export function listQuestions(sheetId) {
  return db.prepare(
    'SELECT * FROM questions WHERE sheet_id = ? ORDER BY position, id',
  ).all(sheetId);
}

export function getQuestion(questionId) {
  return db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
}

/**
 * Add a question, optionally starting it off with some options already on it.
 *
 * For a `choice` question the options ARE the question - there is nothing to
 * answer without them. For a `tags` question they are a seed: words the class
 * starts from and can add to, which is how you put "art" and "engineering" on
 * the board without deciding for anyone that those are the only two answers.
 *
 * Options carry no votes. They exist, at zero, until somebody picks one.
 */
export function addQuestion(sheetId, {
  title, description = '', type = 'tags', options = [], clusterHint = '',
  mergeHint = '', stripPrefixes = '',
}) {
  return db.transaction(() => {
    const next = db.prepare(
      'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM questions WHERE sheet_id = ?',
    ).get(sheetId).pos;

    const info = db.prepare(`
      INSERT INTO questions
        (sheet_id, position, title, description, type, cluster_hint, merge_hint, strip_prefixes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sheetId, next, title, description, normalizeQuestionType(type), clusterHint || '',
      mergeHint || '', normalizeStripPrefixes(stripPrefixes),
    );

    addOptions(info.lastInsertRowid, options);
    return getQuestion(info.lastInsertRowid);
  })();
}

/**
 * Put labels on a question without voting for them.
 *
 * Insertion order is preserved and is what a choice question is displayed in -
 * an option list that reordered itself as votes arrived would be unusable, and
 * dishonest besides, because the order an option was authored in is not
 * information about the answer.
 */
export function addOptions(questionId, labels) {
  if (!Array.isArray(labels) || labels.length === 0) return [];

  // seeded = 1 is what separates an option somebody authored from a word a
  // student produced. Without it a clone cannot tell which to carry over, and
  // merging cannot tell which it must not fold away.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO tags (question_id, label, seeded, created_at) VALUES (?, ?, 1, ?)',
  );

  const added = [];
  db.transaction(() => {
    const now = Date.now();
    for (const raw of labels.slice(0, MAX_OPTIONS)) {
      const label = normalizeTag(raw);
      if (!label) continue;
      insert.run(questionId, label, now + added.length);
      added.push(label);
    }
  })();

  return added;
}

/**
 * A question's options in the order they were authored, with their counts.
 *
 * listTags sorts by popularity, which is right for a cloud and wrong for a
 * ballot: options that swap places under the thumb about to tap them is how
 * people vote for the wrong thing.
 */
export function listOptions(questionId) {
  return db.prepare(`
    SELECT t.id, t.label, t.seeded, COUNT(v.id) AS count
      FROM tags t
      LEFT JOIN votes v ON v.tag_id = t.id
     WHERE t.question_id = ?
     GROUP BY t.id
     ORDER BY t.created_at ASC, t.id ASC
  `).all(questionId);
}

export function updateQuestion(questionId, fields) {
  const current = getQuestion(questionId);
  if (!current) return null;

  // Changing type once answers exist would orphan them - a tags question's votes
  // mean nothing on a freetext one. Hold the type still rather than lose data.
  const answered = db.prepare(`
    SELECT (SELECT COUNT(*) FROM votes WHERE question_id = ?)
         + (SELECT COUNT(*) FROM responses WHERE question_id = ?) AS n
  `).get(questionId, questionId).n > 0;

  db.prepare(`
    UPDATE questions SET title = ?, description = ?, position = ?, type = ?, cluster_hint = ?,
                         merge_hint = ?, strip_prefixes = ?
    WHERE id = ?
  `).run(
    fields.title ?? current.title,
    fields.description ?? current.description,
    fields.position ?? current.position,
    answered || fields.type == null
      ? current.type
      : normalizeQuestionType(fields.type),
    fields.clusterHint ?? current.cluster_hint ?? '',
    fields.mergeHint ?? current.merge_hint ?? '',
    fields.stripPrefixes != null
      ? normalizeStripPrefixes(fields.stripPrefixes)
      : current.strip_prefixes ?? '',
    questionId,
  );

  return getQuestion(questionId);
}

export function deleteQuestion(questionId) {
  db.prepare('DELETE FROM questions WHERE id = ?').run(questionId);
}

/**
 * Make one question active within its sheet, or pass null to deactivate all.
 * Activating is also what reveals a question's cloud to students, permanently.
 */
export function setActiveQuestion(sheetId, questionId) {
  db.transaction(() => {
    db.prepare('UPDATE questions SET active = 0 WHERE sheet_id = ?').run(sheetId);
    if (questionId != null) {
      db.prepare(
        'UPDATE questions SET active = 1, revealed = 1 WHERE id = ? AND sheet_id = ?',
      ).run(questionId, sheetId);
    }
  })();
}

// --------------------------------------------------------------------------
// Tags and votes
// --------------------------------------------------------------------------

export function listTags(questionId) {
  return db.prepare(`
    SELECT t.id, t.label, t.seeded, COUNT(v.id) AS count
      FROM tags t
      LEFT JOIN votes v ON v.tag_id = t.id
     WHERE t.question_id = ?
     GROUP BY t.id
     ORDER BY count DESC, t.created_at ASC
  `).all(questionId);
}

const findTag = db.prepare('SELECT * FROM tags WHERE question_id = ? AND label = ?');
const findAlias = db.prepare(
  'SELECT canonical_tag_id FROM tag_aliases WHERE question_id = ? AND alias = ?',
);
const countSessionTags = db.prepare(
  'SELECT COUNT(*) AS n FROM votes WHERE question_id = ? AND session_id = ?',
);
const findStripPrefixes = db.prepare('SELECT strip_prefixes FROM questions WHERE id = ?');

/**
 * Record a submission or a vote. Both paths converge here, because "type a tag
 * that already exists" and "tap that tag" have to mean exactly the same thing.
 *
 * Returns { ok, created, tagId, label, reason }. `created` is true only when a
 * genuinely new tag was inserted, which is the signal the merge worker waits for.
 */
export function recordTag({ questionId, rawTag, sessionId, allowCreate = true }) {
  const exact = normalizeTag(rawTag);
  if (!exact) return { ok: false, reason: 'invalid_tag' };
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid_session' };
  }

  // "be consistent" lands on "consistent" - unless "be consistent" itself is
  // already on the board (a seeded option, or a tag from before the question
  // had prefixes), in which case the exact word still wins.
  const stripped = stripTagPrefix(exact, findStripPrefixes.get(questionId)?.strip_prefixes);

  const lookup = (label) => {
    // An alias means this word was already folded into another tag. Resolve it
    // locally rather than troubling the model with a word we have already judged.
    const alias = findAlias.get(questionId, label);
    return alias
      ? db.prepare('SELECT * FROM tags WHERE id = ?').get(alias.canonical_tag_id)
      : findTag.get(questionId, label);
  };

  return db.transaction(() => {
    const label = stripped;
    let tag = lookup(exact) || (stripped !== exact ? lookup(stripped) : undefined);

    let created = false;

    if (!tag) {
      if (!allowCreate) return { ok: false, reason: 'unknown_tag' };

      const { n } = countSessionTags.get(questionId, sessionId);
      if (n >= MAX_TAGS_PER_SESSION_PER_QUESTION) {
        return { ok: false, reason: 'session_tag_limit' };
      }

      const info = db.prepare(
        'INSERT INTO tags (question_id, label, created_at) VALUES (?, ?, ?)',
      ).run(questionId, label, Date.now());
      tag = { id: info.lastInsertRowid, label };
      created = true;
    }

    // The UNIQUE constraint enforces one vote per tag per session, so a repeat
    // tap is a no-op rather than an error. `counted` says whether it actually
    // changed anything: the live view needs to know, because a token falling and
    // merging into a bar that does not grow is an animation telling a lie.
    const info = db.prepare(`
      INSERT OR IGNORE INTO votes (question_id, tag_id, session_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(questionId, tag.id, sessionId, Date.now());

    return {
      ok: true, created, counted: info.changes > 0, tagId: tag.id, label: tag.label,
    };
  })();
}

/**
 * Pick exactly one option, replacing whatever this session picked before.
 *
 * Single-select is the point: it is what makes the totals sum to the number of
 * people who answered, and therefore what makes a percentage mean anything. So
 * changing your mind moves the vote rather than adding one.
 *
 * Re-picking what you already have is a no-op, not a toggle. A ballot with no
 * option selected is not a state this question has.
 */
export function recordChoice({ questionId, rawTag, sessionId }) {
  const label = normalizeTag(rawTag);
  if (!label) return { ok: false, reason: 'invalid_tag' };
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid_session' };
  }

  return db.transaction(() => {
    // No creation here, ever: the options are the question.
    const tag = findTag.get(questionId, label);
    if (!tag) return { ok: false, reason: 'unknown_option' };

    const existing = db.prepare(
      'SELECT tag_id FROM votes WHERE question_id = ? AND session_id = ?',
    ).get(questionId, sessionId);

    if (existing && existing.tag_id === tag.id) {
      return { ok: true, changed: false, tagId: tag.id, label: tag.label };
    }

    db.prepare('DELETE FROM votes WHERE question_id = ? AND session_id = ?')
      .run(questionId, sessionId);
    db.prepare(`
      INSERT INTO votes (question_id, tag_id, session_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(questionId, tag.id, sessionId, Date.now());

    return { ok: true, changed: true, tagId: tag.id, label: tag.label };
  })();
}

/** What this session currently has selected on a choice question, or null. */
export function getChoice(questionId, sessionId) {
  const row = db.prepare(`
    SELECT t.label
      FROM votes v
      JOIN tags t ON t.id = v.tag_id
     WHERE v.question_id = ? AND v.session_id = ?
  `).get(questionId, sessionId);
  return row ? row.label : null;
}

/** Drop every vote on a question but keep its options standing. */
export function clearVotes(questionId) {
  db.prepare('DELETE FROM votes WHERE question_id = ?').run(questionId);
}

export function clearTags(questionId) {
  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE question_id = ?').run(questionId);
    db.prepare('DELETE FROM tag_aliases WHERE question_id = ?').run(questionId);
    db.prepare('DELETE FROM tags WHERE question_id = ?').run(questionId);
  })();
}

export function removeTag(questionId, tagId) {
  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE tag_id = ? AND question_id = ?')
      .run(tagId, questionId);
    db.prepare('DELETE FROM tag_aliases WHERE canonical_tag_id = ?').run(tagId);
    db.prepare('DELETE FROM tags WHERE id = ? AND question_id = ?')
      .run(tagId, questionId);
  })();
}

/**
 * Fold `fromLabel` into the tag `intoTagId`, permanently.
 *
 * The UPDATE OR IGNORE matters: a session that voted for both tags would collide
 * on the (question, tag, session) unique index. Ignoring those rows silently
 * merges the duplicate vote, which is what we want — one person's two words for
 * one idea is still one vote.
 */
export function mergeTag(questionId, fromLabel, intoTagId) {
  return db.transaction(() => {
    const from = findTag.get(questionId, fromLabel);
    if (!from || from.id === intoTagId) return false;

    // A seeded option was put there on purpose. Folding "art" into a student's
    // "artistic" would quietly delete the word the question was built around -
    // and the merge is one-way, so there would be no getting it back.
    if (from.seeded) return false;

    const into = db.prepare('SELECT * FROM tags WHERE id = ? AND question_id = ?')
      .get(intoTagId, questionId);
    if (!into) return false;

    db.prepare('UPDATE OR IGNORE votes SET tag_id = ? WHERE tag_id = ?')
      .run(intoTagId, from.id);
    db.prepare('DELETE FROM votes WHERE tag_id = ?').run(from.id);

    // Re-point any alias aimed at the tag we are about to delete, so no dangling
    // chain is left behind.
    db.prepare('UPDATE tag_aliases SET canonical_tag_id = ? WHERE canonical_tag_id = ?')
      .run(intoTagId, from.id);

    db.prepare(`
      INSERT OR REPLACE INTO tag_aliases (question_id, alias, canonical_tag_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(questionId, from.label, intoTagId, Date.now());

    db.prepare('DELETE FROM tags WHERE id = ?').run(from.id);
    return true;
  })();
}

export function listAliases(questionId) {
  return db.prepare(`
    SELECT a.alias, t.label AS canonical
      FROM tag_aliases a
      JOIN tags t ON t.id = a.canonical_tag_id
     WHERE a.question_id = ?
     ORDER BY a.created_at
  `).all(questionId);
}

// --------------------------------------------------------------------------
// Freetext responses and their votes
// --------------------------------------------------------------------------

/**
 * Responses for a question, best-scored first.
 *
 * Ties break on age, so a fresh answer never leapfrogs an equally-scored older
 * one and the feed does not shuffle under the reader on every broadcast.
 */
export function listResponses(questionId, limit = MAX_RESPONSES_IN_STATE) {
  return db.prepare(`
    SELECT r.id, r.text, r.cluster_label AS clusterLabel, r.created_at AS createdAt,
           COALESCE(SUM(v.direction), 0) AS score,
           COUNT(v.id) AS voteCount
      FROM responses r
      LEFT JOIN response_votes v ON v.response_id = r.id
     WHERE r.question_id = ?
     GROUP BY r.id
     ORDER BY score DESC, r.created_at ASC
     LIMIT ?
  `).all(questionId, limit);
}

export function countResponses(questionId) {
  return db.prepare('SELECT COUNT(*) AS n FROM responses WHERE question_id = ?')
    .get(questionId).n;
}

const countSessionResponses = db.prepare(
  'SELECT COUNT(*) AS n FROM responses WHERE question_id = ? AND session_id = ?',
);

/**
 * Store one freetext answer.
 *
 * Returns { ok, responseId, text, reason } so the caller can broadcast the new
 * item without reading it back.
 */
export function recordResponse({ questionId, rawText, sessionId }) {
  const text = normalizeResponseText(rawText);
  if (!text) return { ok: false, reason: 'invalid_response' };
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid_session' };
  }

  return db.transaction(() => {
    const { n } = countSessionResponses.get(questionId, sessionId);
    if (n >= MAX_RESPONSES_PER_SESSION_PER_QUESTION) {
      return { ok: false, reason: 'session_response_limit' };
    }

    const info = db.prepare(`
      INSERT INTO responses (question_id, session_id, text, created_at)
      VALUES (?, ?, ?, ?)
    `).run(questionId, sessionId, text, Date.now());

    return { ok: true, responseId: info.lastInsertRowid, text };
  })();
}

/**
 * Up- or down-vote a response, idempotently per session.
 *
 * Three cases in one transaction: a fresh vote is inserted, the same direction
 * again undoes it, and the opposite direction flips it. Returns the direction
 * now in force (0 for none), so a client that got out of step can be corrected
 * rather than left disagreeing with the score it is showing.
 */
export function recordResponseVote({ questionId, responseId, direction, sessionId }) {
  if (direction !== 1 && direction !== -1) return { ok: false, reason: 'invalid_direction' };
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid_session' };
  }

  return db.transaction(() => {
    const response = db.prepare(
      'SELECT id FROM responses WHERE id = ? AND question_id = ?',
    ).get(responseId, questionId);
    if (!response) return { ok: false, reason: 'unknown_response' };

    const existing = db.prepare(
      'SELECT id, direction FROM response_votes WHERE response_id = ? AND session_id = ?',
    ).get(responseId, sessionId);

    if (!existing) {
      db.prepare(`
        INSERT INTO response_votes (response_id, session_id, direction, created_at)
        VALUES (?, ?, ?, ?)
      `).run(responseId, sessionId, direction, Date.now());
      return { ok: true, direction };
    }

    if (existing.direction === direction) {
      db.prepare('DELETE FROM response_votes WHERE id = ?').run(existing.id);
      return { ok: true, direction: 0 };
    }

    db.prepare('UPDATE response_votes SET direction = ?, created_at = ? WHERE id = ?')
      .run(direction, Date.now(), existing.id);
    return { ok: true, direction };
  })();
}

/** Write cluster labels back. Anything not named is cleared, not left stale. */
export function setClusterLabels(questionId, labelByResponseId) {
  db.transaction(() => {
    db.prepare('UPDATE responses SET cluster_label = NULL WHERE question_id = ?')
      .run(questionId);
    const set = db.prepare(
      'UPDATE responses SET cluster_label = ? WHERE id = ? AND question_id = ?',
    );
    for (const [id, label] of labelByResponseId) set.run(label, Number(id), questionId);
  })();
}

export function listClusters(questionId) {
  return db.prepare(`
    SELECT COALESCE(cluster_label, '') AS label, COUNT(*) AS count
      FROM responses
     WHERE question_id = ?
     GROUP BY COALESCE(cluster_label, '')
     ORDER BY count DESC, label ASC
  `).all(questionId);
}

export function clearResponses(questionId) {
  db.transaction(() => {
    db.prepare(`
      DELETE FROM response_votes
       WHERE response_id IN (SELECT id FROM responses WHERE question_id = ?)
    `).run(questionId);
    db.prepare('DELETE FROM responses WHERE question_id = ?').run(questionId);
  })();
}

// --------------------------------------------------------------------------
// Sheet state, as sent over the wire
// --------------------------------------------------------------------------

/**
 * Build the broadcast payload for a sheet.
 *
 * `forPresenter` decides whether unrevealed clouds are included at all. Students
 * get them omitted rather than hidden in CSS — a tag the class has not been shown
 * yet should not be sitting in the page source waiting to be read.
 */
export function buildSheetState(sheetId, { forPresenter = false } = {}) {
  const sheet = getSheetById(sheetId);
  if (!sheet) return null;

  const questions = listQuestions(sheetId).map((q) => {
    const entry = {
      id: q.id,
      title: q.title,
      description: q.description,
      type: q.type,
      active: Boolean(q.active),
      revealed: Boolean(q.revealed),
    };

    // Counts are safe to send always - they say how many people answered, not
    // what anybody said, so they cannot be used to read ahead.
    if (q.type === 'freetext') {
      entry.responseCount = countResponses(q.id);
      if (forPresenter || q.revealed) entry.responses = listResponses(q.id);
    } else if (forPresenter || q.revealed) {
      // Same shape either way, so every chart downstream is unchanged; only the
      // order differs, and only because a ballot must not reorder itself.
      entry.tags = q.type === 'choice' ? listOptions(q.id) : listTags(q.id);
    }

    return entry;
  });

  const active = questions.find((q) => q.active);

  return {
    sheet: {
      slug: sheet.slug,
      title: sheet.title,
      status: sheet.status,
      closedAt: sheet.closed_at,
    },
    activeQuestionId: active ? active.id : null,
    questions,
  };
}

// --------------------------------------------------------------------------
// Derived views, for the dashboard
// --------------------------------------------------------------------------
//
// None of this is on the hot path. The dashboard polls it every few seconds,
// which is the right cadence for something nobody is typing into - and keeps it
// out of the 300ms broadcast that the phones depend on staying small.

/**
 * Which tags the same person picked together.
 *
 * The self-join is on session_id within one question, so a pair is counted once
 * per person who chose both. tag_id ordering keeps each pair one row rather than
 * two mirrored ones. Pairs seen only once are dropped: with 150 students, a
 * single co-occurrence is noise and would bury the real structure in hairball.
 */
export function tagCooccurrence(questionId, { minCount = 2, limit = 80 } = {}) {
  return db.prepare(`
    SELECT ta.label AS source, tb.label AS target, COUNT(*) AS weight
      FROM votes a
      JOIN votes b ON b.session_id  = a.session_id
                  AND b.question_id = a.question_id
                  AND b.tag_id      > a.tag_id
      JOIN tags ta ON ta.id = a.tag_id
      JOIN tags tb ON tb.id = b.tag_id
     WHERE a.question_id = ?
     GROUP BY a.tag_id, b.tag_id
    HAVING weight >= ?
     ORDER BY weight DESC
     LIMIT ?
  `).all(questionId, minCount, limit);
}

/**
 * Every vote as (label, when), oldest first.
 *
 * The dashboard turns this into both the formation timeline and the raw feed,
 * so it is returned unaggregated - bucketing here would throw away the ordering
 * the raw feed is for.
 */
export function voteTimeline(questionId, limit = 4000) {
  return db.prepare(`
    SELECT t.label AS label, v.created_at AS at
      FROM votes v
      JOIN tags t ON t.id = v.tag_id
     WHERE v.question_id = ?
     ORDER BY v.created_at ASC
     LIMIT ?
  `).all(questionId, limit);
}

// --------------------------------------------------------------------------
// Seeding from sheets/*.json
// --------------------------------------------------------------------------

/**
 * Seed sheets from JSON files, once each.
 *
 * Idempotency keys on the filename, not the slug. That is what lets a file leave
 * its slug out and still be safely re-read on every boot — and it means questions
 * edited later in the presenter UI are never clobbered by the file they came from.
 */
export function seedFromFiles(log = console.log) {
  if (!fs.existsSync(SHEETS_DIR)) return [];

  const seeded = [];
  const files = fs.readdirSync(SHEETS_DIR).filter((f) => f.endsWith('.json')).sort();

  for (const file of files) {
    if (db.prepare('SELECT 1 FROM sheets WHERE source_file = ?').get(file)) continue;

    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(path.join(SHEETS_DIR, file), 'utf8'));
    } catch (err) {
      log(`[seed] skipping ${file}: ${err.message}`);
      continue;
    }

    if (!spec || typeof spec.title !== 'string' || !Array.isArray(spec.questions)) {
      log(`[seed] skipping ${file}: needs a title and a questions array`);
      continue;
    }

    let wanted = spec.slug || null;
    if (wanted && (!isValidSlug(wanted) || RESERVED_SLUGS.has(wanted))) {
      log(`[seed] ${file}: slug "${wanted}" is unusable, generating one instead`);
      wanted = null;
    }

    const sheet = db.transaction(() => {
      const created = createSheet({
        title: spec.title,
        slug: wanted,
        status: spec.status === 'live' ? 'live' : 'draft',
        sourceFile: file,
      });
      for (const q of spec.questions) {
        if (!q || typeof q.title !== 'string') continue;
        addQuestion(created.id, {
          title: q.title,
          description: typeof q.description === 'string' ? q.description : '',
          type: normalizeQuestionType(q.type),
          options: Array.isArray(q.options) ? q.options : [],
          clusterHint: typeof q.clusterHint === 'string' ? q.clusterHint : '',
          mergeHint: typeof q.mergeHint === 'string' ? q.mergeHint : '',
          stripPrefixes: q.stripPrefixes ?? '',
        });
      }
      return created;
    })();

    log(`[seed] ${file} -> /${sheet.slug} ("${sheet.title}")`);
    seeded.push(sheet);
  }

  return seeded;
}
