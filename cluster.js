// Theme clustering for freetext questions, with Claude Haiku.
//
// Separate from merge.js on purpose. Merging is a continuous stream: one tag at
// a time, forever, while the class types. Clustering is a single pass over a
// question that is finished - triggered by the presenter, or automatically when
// a freetext question is closed. Different shape, different guarantees.
//
// What they share is the habit that matters: the model's answer is treated as a
// suggestion and re-checked against the rows that actually exist. A hallucinated
// id must never end up as a label on somebody's real answer.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { getQuestion, listResponses, setClusterLabels } from './db.js';

const MODEL = 'claude-haiku-4-5';

// Below this there is nothing to cluster - four answers are four answers, and
// grouping them into "themes" would be a machine inventing structure.
const MIN_RESPONSES = 4;

// A lecture hall produces a few hundred at most, and the whole point is that the
// model sees all of them at once. Past this we take the newest and say so.
const MAX_RESPONSES = 400;

const MIN_THEMES = 4;
const MAX_THEMES = 6;

const ClusterDecision = z.object({
  themes: z.array(
    z.object({
      label: z.string(),
      response_ids: z.array(z.number()),
    }),
  ),
});

const SYSTEM_PROMPT = [
  'You group short free-text answers written by students in a lecture into themes.',
  '',
  `Find between ${MIN_THEMES} and ${MAX_THEMES} themes. Assign every answer to exactly one.`,
  '',
  'A good theme label:',
  '- names what the answers in it actually claim, not the topic in general',
  '  ("People are unpredictable" beats "Human factors")',
  '- is 2-5 words, in the register the students used',
  '- distinguishes its group from every other group',
  '',
  'Do NOT:',
  '- invent an id that was not given to you',
  '- put one answer in two themes, or leave one out',
  '- create a catch-all "Other" or "Miscellaneous" theme; if an answer fits badly,',
  '  put it in the closest theme you have',
  '',
  'Prefer fewer, sharper themes over many overlapping ones.',
].join('\n');

export class Clusterer {
  /**
   * @param {object} options
   * @param {(sheetId: number) => void} options.onChange called after labels are written
   * @param {(questionId: number, state: string, detail?: string) => void} [options.onStatus]
   */
  constructor({
    onChange,
    onStatus,
    apiKey = process.env.ANTHROPIC_API_KEY,
    log = console.log,
  } = {}) {
    this.onChange = onChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.log = log;
    this.enabled = Boolean(apiKey);
    this.client = this.enabled ? new Anthropic({ apiKey }) : null;

    /** @type {Set<number>} questions with a call in flight */
    this.inFlight = new Set();

    this.stats = { runs: 0, labelled: 0, failures: 0 };
  }

  /**
   * Cluster one question's responses.
   *
   * Never throws: every caller is either a WebSocket handler or a question being
   * deactivated mid-lecture, and neither should be able to fail because an API
   * call did. Problems come back as a status string instead.
   *
   * @returns {Promise<{ok: boolean, reason?: string, themes?: number}>}
   */
  async run(questionId) {
    if (!this.enabled) {
      this.onStatus(questionId, 'unavailable', 'no API key');
      return { ok: false, reason: 'clustering_unavailable' };
    }
    if (this.inFlight.has(questionId)) {
      return { ok: false, reason: 'clustering_in_progress' };
    }

    const question = getQuestion(questionId);
    if (!question || question.type !== 'freetext') {
      return { ok: false, reason: 'not_a_freetext_question' };
    }

    const responses = listResponses(questionId, MAX_RESPONSES);
    if (responses.length < MIN_RESPONSES) {
      this.onStatus(questionId, 'too_few');
      return { ok: false, reason: 'too_few_responses' };
    }

    this.inFlight.add(questionId);
    this.onStatus(questionId, 'running');

    try {
      const decision = await this.ask(question, responses);
      this.stats.runs += 1;

      const labels = this.resolve(decision, responses);
      if (labels.size === 0) {
        this.onStatus(questionId, 'error', 'nothing usable came back');
        return { ok: false, reason: 'no_usable_themes' };
      }

      setClusterLabels(questionId, labels);
      this.stats.labelled += labels.size;

      const themes = new Set(labels.values()).size;
      this.log(`[cluster] question ${questionId}: ${themes} themes over ${labels.size} responses`);
      this.onStatus(questionId, 'done');
      this.onChange(question.sheet_id);
      return { ok: true, themes };
    } catch (err) {
      this.stats.failures += 1;
      this.log(`[cluster] question ${questionId} failed: ${err.message}`);
      this.onStatus(questionId, 'error', err.message);
      return { ok: false, reason: 'clustering_failed' };
    } finally {
      this.inFlight.delete(questionId);
    }
  }

  async ask(question, responses) {
    const userPrompt = [
      `Question the students answered: "${question.title}"`,
      question.description ? `Clarification shown to them: "${question.description}"` : '',
      '',
      `${responses.length} answers, as "id: text":`,
      ...responses.map((r) => `${r.id}: ${r.text}`),
    ].filter(Boolean).join('\n');

    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(ClusterDecision) },
    });

    return response.parsed_output ?? null;
  }

  /**
   * Turn the model's answer into labels we are willing to write.
   *
   * Every id is checked against the responses we actually sent, and the first
   * theme to claim an id keeps it. Anything the model missed is simply left
   * unlabelled - a response with no theme renders as "Unclustered", which is
   * honest, where quietly filing it under the nearest theme would not be.
   */
  resolve(decision, responses) {
    const labels = new Map();
    if (!decision) return labels;

    const known = new Set(responses.map((r) => r.id));

    for (const theme of decision.themes ?? []) {
      const label = typeof theme.label === 'string' ? theme.label.trim() : '';
      if (!label || label.length > 60) continue;

      for (const raw of theme.response_ids ?? []) {
        const id = Number(raw);
        if (!known.has(id)) continue;  // invented, or already cleared
        if (labels.has(id)) continue;  // claimed by an earlier theme
        labels.set(id, label);
      }
    }

    return labels;
  }
}
