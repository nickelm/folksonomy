// Tests the freetext clusterer with a stubbed API client.
//
// Runs against the database directly, no server needed:
//   node scripts/cluster-test.mjs
//
// The network call is the one part not covered. Everything around it is - and
// what matters most here is the same thing that matters in worker-test: the
// model's answer is not trusted. An invented id, a duplicate assignment, or a
// theme with no name must not be able to put a wrong label on a real answer.

import { Clusterer } from '../cluster.js';
import {
  addQuestion, createSheet, deleteSheet, listResponses, recordResponse,
  setActiveQuestion, setSheetStatus,
} from '../db.js';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sheet = createSheet({ title: 'cluster test scratch', status: 'live' });
const q = addQuestion(sheet.id, {
  title: 'Why might HCI be hard?',
  description: 'One or two sentences.',
  type: 'freetext',
});
const tagQ = addQuestion(sheet.id, { title: 'What is HCI?', type: 'tags' });
setActiveQuestion(sheet.id, q.id);

const ANSWERS = [
  'People are unpredictable',
  'Everyone wants something different',
  'Testing with real users is slow',
  'You cannot ask people what they want',
  'Measuring whether a design worked is hard',
  'Nobody agrees on what good means',
];

for (const [i, text] of ANSWERS.entries()) {
  recordResponse({ questionId: q.id, rawText: text, sessionId: `s${i}` });
}

const stored = listResponses(q.id);
const idOf = (text) => stored.find((r) => r.text === text).id;
const labels = () =>
  new Map(listResponses(q.id).map((r) => [r.text, r.clusterLabel]));

/** Stand in for client.messages.parse, recording what it was asked. */
function stub(clusterer, reply) {
  const calls = [];
  clusterer.client = {
    messages: {
      async parse(request) {
        calls.push(request);
        return { parsed_output: reply(request) };
      },
    },
  };
  return calls;
}

function make() {
  return new Clusterer({ apiKey: 'test-key', onChange: () => {}, log: () => {} });
}

try {
  check('six answers stored', stored.length === 6, `got ${stored.length}`);

  // ------------------------------------------------------------ happy path

  const clusterer = make();
  check('enabled with a key', clusterer.enabled === true);

  const calls = stub(clusterer, () => ({
    themes: [
      {
        label: 'People are unpredictable',
        response_ids: [
          idOf('People are unpredictable'),
          idOf('Everyone wants something different'),
          idOf('Nobody agrees on what good means'),
        ],
      },
      {
        label: 'Evaluation is expensive',
        response_ids: [
          idOf('Testing with real users is slow'),
          idOf('Measuring whether a design worked is hard'),
          idOf('You cannot ask people what they want'),
        ],
      },
    ],
  }));

  const result = await clusterer.run(q.id);
  check('the run reports success', result.ok === true);
  check('it found two themes', result.themes === 2, String(result.themes));
  check('one call was made', calls.length === 1);
  check('every answer was sent',
    ANSWERS.every((text) => calls[0].messages[0].content.includes(text)));
  check('the question text was sent',
    calls[0].messages[0].content.includes('Why might HCI be hard?'));

  const first = labels();
  check('labels are written back',
    first.get('People are unpredictable') === 'People are unpredictable');
  check('the second theme lands too',
    first.get('Testing with real users is slow') === 'Evaluation is expensive');
  check('nothing is left unlabelled',
    [...first.values()].every((v) => typeof v === 'string' && v.length > 0));

  // ------------------------------------------------- distrusting the model

  const invented = make();
  stub(invented, () => ({
    themes: [
      { label: 'Real theme', response_ids: [idOf('People are unpredictable')] },
      { label: 'Ghost theme', response_ids: [999999, -1] },
    ],
  }));
  await invented.run(q.id);

  const afterInvented = labels();
  check('an invented id is discarded',
    afterInvented.get('People are unpredictable') === 'Real theme');
  check('a theme of only invented ids labels nothing',
    [...afterInvented.values()].filter((v) => v === 'Ghost theme').length === 0);
  check('answers the model dropped are cleared, not left stale',
    afterInvented.get('Testing with real users is slow') === null,
    String(afterInvented.get('Testing with real users is slow')));

  const duplicated = make();
  stub(duplicated, () => ({
    themes: [
      { label: 'First claim', response_ids: [idOf('People are unpredictable')] },
      { label: 'Second claim', response_ids: [idOf('People are unpredictable')] },
    ],
  }));
  await duplicated.run(q.id);
  check('a duplicate assignment goes to the first theme',
    labels().get('People are unpredictable') === 'First claim');

  const nameless = make();
  stub(nameless, () => ({
    themes: [
      { label: '   ', response_ids: [idOf('People are unpredictable')] },
      { label: 'x'.repeat(200), response_ids: [idOf('Testing with real users is slow')] },
      { label: 'Kept', response_ids: [idOf('Nobody agrees on what good means')] },
    ],
  }));
  await nameless.run(q.id);

  const afterNameless = labels();
  check('a blank theme name is refused',
    afterNameless.get('People are unpredictable') === null);
  check('an absurdly long theme name is refused',
    afterNameless.get('Testing with real users is slow') === null);
  check('the usable theme still applies',
    afterNameless.get('Nobody agrees on what good means') === 'Kept');

  const garbage = make();
  stub(garbage, () => ({ themes: [] }));
  const garbageResult = await garbage.run(q.id);
  check('an empty response is reported, not written',
    garbageResult.ok === false && garbageResult.reason === 'no_usable_themes');
  check('the previous labels survive an unusable run',
    labels().get('Nobody agrees on what good means') === 'Kept');

  // ---------------------------------------------------------------- guards

  const thrower = make();
  thrower.client = { messages: { async parse() { throw new Error('rate limited'); } } };
  const threw = await thrower.run(q.id);
  check('an API failure is caught, not thrown',
    threw.ok === false && threw.reason === 'clustering_failed');

  const wrongType = make();
  stub(wrongType, () => ({ themes: [] }));
  const typeResult = await wrongType.run(tagQ.id);
  check('a tags question is refused', typeResult.reason === 'not_a_freetext_question');

  const thin = createSheet({ title: 'thin scratch', status: 'live' });
  const thinQ = addQuestion(thin.id, { title: 'Thin', type: 'freetext' });
  setActiveQuestion(thin.id, thinQ.id);
  for (const [i, text] of ['one', 'two', 'three'].entries()) {
    recordResponse({ questionId: thinQ.id, rawText: text, sessionId: `t${i}` });
  }

  const tooFew = make();
  const tooFewCalls = stub(tooFew, () => ({ themes: [] }));
  const thinResult = await tooFew.run(thinQ.id);
  check('under four answers is skipped', thinResult.reason === 'too_few_responses');
  check('and costs no API call', tooFewCalls.length === 0);
  deleteSheet(thin.id);

  const keyless = new Clusterer({ apiKey: '', onChange: () => {}, log: () => {} });
  check('no key means disabled', keyless.enabled === false);
  const keylessResult = await keyless.run(q.id);
  check('a keyless run reports why rather than crashing',
    keylessResult.ok === false && keylessResult.reason === 'clustering_unavailable');

  // A closed sheet is an archive. Clustering it is harmless - it only groups
  // what is already there - but the status should still be reported honestly.
  setSheetStatus(sheet.id, 'closed');
  const closed = make();
  stub(closed, () => ({
    themes: [{ label: 'After the bell', response_ids: [idOf('People are unpredictable')] }],
  }));
  const closedResult = await closed.run(q.id);
  check('a closed sheet can still be clustered', closedResult.ok === true);

  // ------------------------------------------------------------- statuses

  const statuses = [];
  const watched = new Clusterer({
    apiKey: 'test-key',
    onChange: () => {},
    onStatus: (id, state) => statuses.push(state),
    log: () => {},
  });
  stub(watched, () => ({
    themes: [{ label: 'Watched', response_ids: [idOf('People are unpredictable')] }],
  }));
  await watched.run(q.id);
  check('progress is reported as running then done',
    statuses.join(',') === 'running,done', statuses.join(','));
} finally {
  deleteSheet(sheet.id);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
