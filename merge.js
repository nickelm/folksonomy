// Background tag merging with Claude Haiku.
//
// The contract this module lives under: merging must NEVER be on the critical
// path. A student types a tag, it is stored and broadcast immediately, and some
// time later it may quietly fold into a tag that means the same thing. If the
// API is slow, rate-limited, or not configured at all, the app carries on and
// the cloud simply keeps both words.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { getQuestion, getSheetById, listTags, mergeTag } from './db.js';

const MODEL = 'claude-haiku-4-5';

// One call per question per interval, carrying up to BATCH_SIZE new tags. Asking
// about tags one at a time would drain far too slowly under a burst: 150 students
// answering at once can produce dozens of genuinely new words in a few seconds.
const MIN_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;

// Past this many distinct tags the prompt gets long and the judgement gets worse,
// so we show the model only the most-voted tags as merge candidates.
const MAX_CANDIDATES = 60;

const MergeDecision = z.object({
  merges: z.array(
    z.object({
      tag: z.string(),
      merge_into: z.string().nullable(),
    }),
  ),
});

const SYSTEM_PROMPT = [
  'You clean up a live folksonomy built by students answering a question in a lecture.',
  '',
  'For each new tag, decide whether it is just a different way of writing an existing tag.',
  '',
  'Merge ONLY for:',
  '- singular/plural ("button" / "buttons")',
  '- spelling or typo variants ("usabilty" / "usability")',
  '- casing, spacing, or punctuation differences ("user friendly" / "user-friendly")',
  '- abbreviations and their expansions ("ux" / "user experience")',
  '- true synonyms that name the same idea ("hard to use" / "difficult to use")',
  '',
  'Do NOT merge:',
  '- related but distinct concepts ("art" and "design", "react" and "javascript")',
  '- opposites or alternatives, even when they answer the same question',
  '  ("art" and "engineering" are competing answers, never a merge)',
  '- a specific thing into a general one ("figma" into "design tools")',
  '',
  'When you are unsure, do not merge. A folksonomy with two similar tags is fine;',
  'one that collapses distinct student opinions is broken.',
  '',
  'Return one entry for every new tag, with merge_into set to the exact existing',
  'tag it duplicates, or null to keep it as its own tag.',
].join('\n');

export class MergeWorker {
  /**
   * @param {object} options
   * @param {(sheetId: number) => void} options.onChange called after tags actually move
   */
  constructor({ onChange, apiKey = process.env.ANTHROPIC_API_KEY, log = console.log } = {}) {
    this.onChange = onChange || (() => {});
    this.log = log;
    this.enabled = Boolean(apiKey);
    this.client = this.enabled ? new Anthropic({ apiKey }) : null;

    /** @type {Map<number, Set<string>>} questionId -> pending new labels */
    this.pending = new Map();
    /** @type {Map<number, any>} questionId -> timer */
    this.timers = new Map();
    /** @type {Set<number>} questions with a call in flight */
    this.inFlight = new Set();

    this.stats = { calls: 0, merged: 0, failures: 0 };

    if (!this.enabled) {
      this.log('[merge] ANTHROPIC_API_KEY not set - tag merging is disabled');
    }
  }

  /** Note that `label` is a brand-new tag on `questionId` and schedule a check. */
  enqueue(questionId, label) {
    if (!this.enabled) return;

    const question = getQuestion(questionId);
    if (!question) return;

    // A closed sheet is an archive. Nothing should still be moving in it.
    const sheet = getSheetById(question.sheet_id);
    if (!sheet || sheet.status === 'closed') return;

    if (!this.pending.has(questionId)) this.pending.set(questionId, new Set());
    this.pending.get(questionId).add(label);
    this.schedule(questionId);
  }

  schedule(questionId) {
    if (this.timers.has(questionId) || this.inFlight.has(questionId)) return;

    const timer = setTimeout(() => {
      this.timers.delete(questionId);
      this.flush(questionId).catch((err) => {
        this.stats.failures += 1;
        this.log(`[merge] question ${questionId} failed: ${err.message}`);
      });
    }, MIN_INTERVAL_MS);

    // Do not hold the process open just to run a merge check.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(questionId, timer);
  }

  async flush(questionId) {
    const queue = this.pending.get(questionId);
    if (!queue || queue.size === 0) return;

    const batch = [...queue].slice(0, BATCH_SIZE);
    for (const label of batch) queue.delete(label);
    if (queue.size === 0) this.pending.delete(questionId);

    this.inFlight.add(questionId);
    try {
      await this.processBatch(questionId, batch);
    } finally {
      this.inFlight.delete(questionId);
      // Anything that arrived while we were waiting gets the next slot.
      if (this.pending.has(questionId)) this.schedule(questionId);
    }
  }

  async processBatch(questionId, batch) {
    const question = getQuestion(questionId);
    if (!question) return;

    const all = listTags(questionId);
    const byLabel = new Map(all.map((t) => [t.label, t]));

    // Only tags that still exist are mergeable - one may have been cleared, or
    // already folded away, while this batch sat in the queue.
    const newLabels = batch.filter((label) => byLabel.has(label));
    if (newLabels.length === 0) return;

    // A tag in this batch must not become another batch member's merge target;
    // otherwise two new words can chase each other into an unstable pair.
    const newSet = new Set(newLabels);
    const candidates = all
      .filter((t) => !newSet.has(t.label))
      .slice(0, MAX_CANDIDATES);

    if (candidates.length === 0) return;

    const decision = await this.ask(question, candidates, newLabels);
    this.stats.calls += 1;
    if (decision) this.apply(questionId, decision, newSet, byLabel);
  }

  async ask(question, candidates, newLabels) {
    const userPrompt = [
      `Question the students are answering: "${question.title}"`,
      question.description ? `Clarification shown to them: "${question.description}"` : '',
      '',
      'Existing tags (label, votes):',
      ...candidates.map((t) => `- ${t.label} (${t.count})`),
      '',
      'New tags to judge:',
      ...newLabels.map((label) => `- ${label}`),
    ].filter(Boolean).join('\n');

    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(MergeDecision) },
    });

    return response.parsed_output ?? null;
  }

  /**
   * Apply the model's decision, distrusting all of it.
   *
   * A wrong merge is destructive and invisible to the student it happens to, so
   * every proposed pair is re-checked against the tags that actually exist right
   * now rather than against the snapshot the model was shown.
   */
  apply(questionId, decision, newSet, byLabel) {
    let changed = false;

    for (const entry of decision.merges ?? []) {
      const from = typeof entry.tag === 'string' ? entry.tag.trim().toLowerCase() : '';
      const into = typeof entry.merge_into === 'string'
        ? entry.merge_into.trim().toLowerCase()
        : null;

      if (!into) continue;
      if (!newSet.has(from)) continue;   // not a tag we asked about
      if (into === from) continue;       // merging into itself
      if (newSet.has(into)) continue;    // target is itself unjudged
      if (!byLabel.has(into)) continue;  // invented target

      if (mergeTag(questionId, from, byLabel.get(into).id)) {
        changed = true;
        this.stats.merged += 1;
        this.log(`[merge] "${from}" -> "${into}" on question ${questionId}`);
      }
    }

    if (changed) {
      const question = getQuestion(questionId);
      if (question) this.onChange(question.sheet_id);
    }
  }

  /** Cancel pending timers so the process can exit cleanly. */
  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
