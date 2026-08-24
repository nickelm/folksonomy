// Tests the merge worker's queueing and validation with a stubbed API client.
//
// The network call is the one part not covered here; everything around it is -
// especially the guards that stop a wrong or invented merge target from
// destroying real student data.

import { MergeWorker } from '../merge.js';
import {
  addQuestion, createSheet, deleteSheet, listTags, recordTag, setSheetStatus,
} from '../db.js';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sheet = createSheet({ title: 'worker test scratch', status: 'live' });
const q = addQuestion(sheet.id, { title: 'What is HCI?', description: '' });
const labels = () => listTags(q.id).map((t) => t.label).sort();

// Stub stands in for client.messages.parse, recording what it was asked.
function stub(worker, reply) {
  const calls = [];
  worker.client = {
    messages: {
      async parse(request) {
        calls.push(request);
        return { parsed_output: reply(request) };
      },
    },
  };
  return calls;
}

try {
  const changed = [];
  const worker = new MergeWorker({
    apiKey: 'test-key',
    onChange: (id) => changed.push(id),
    log: () => {},
  });
  check('worker is enabled with a key', worker.enabled === true);

  recordTag({ questionId: q.id, rawTag: 'usability', sessionId: 'a' });
  recordTag({ questionId: q.id, rawTag: 'design', sessionId: 'b' });
  recordTag({ questionId: q.id, rawTag: 'usabilty', sessionId: 'c' });
  recordTag({ questionId: q.id, rawTag: 'usable', sessionId: 'd' });

  const calls = stub(worker, () => ({
    merges: [
      { tag: 'usabilty', merge_into: 'usability' },
      { tag: 'usable', merge_into: 'usability' },
    ],
  }));

  worker.enqueue(q.id, 'usabilty');
  worker.enqueue(q.id, 'usable');
  check('both tags queued as one batch', worker.pending.get(q.id).size === 2);

  await sleep(2400);

  check('one API call for the whole batch', calls.length === 1, `got ${calls.length}`);
  check('the batch used Haiku', calls[0]?.model === 'claude-haiku-4-5');
  check('a structured output schema was sent',
    calls[0]?.output_config?.format?.type === 'json_schema');
  check('the prompt carried the question',
    calls[0]?.messages[0].content.includes('What is HCI?'));
  check('the prompt carried both new tags',
    calls[0]?.messages[0].content.includes('usabilty')
    && calls[0]?.messages[0].content.includes('usable'));
  check('both variants merged away',
    JSON.stringify(labels()) === JSON.stringify(['design', 'usability']),
    JSON.stringify(labels()));
  check('the sheet was flagged for rebroadcast', changed.includes(sheet.id));

  // ---- the guards, exercised with deliberately bad model output ----

  recordTag({ questionId: q.id, rawTag: 'humans', sessionId: 'e' });
  const before = labels();

  const badCalls = stub(worker, () => ({
    merges: [
      // A target that does not exist. The model can and does invent these.
      { tag: 'humans', merge_into: 'people-centred computing' },
    ],
  }));
  worker.enqueue(q.id, 'humans');
  await sleep(2400);
  check('an invented merge target is ignored', badCalls.length === 1
    && JSON.stringify(labels()) === JSON.stringify(before), JSON.stringify(labels()));

  stub(worker, () => ({ merges: [{ tag: 'humans', merge_into: 'humans' }] }));
  worker.enqueue(q.id, 'humans');
  await sleep(2400);
  check('merging a tag into itself is ignored', labels().includes('humans'));

  // The model is only ever allowed to move the tags it was asked about; a reply
  // naming some other existing tag must not be able to delete it.
  stub(worker, () => ({ merges: [{ tag: 'design', merge_into: 'usability' }] }));
  worker.enqueue(q.id, 'humans');
  await sleep(2400);
  check('a tag outside the batch cannot be merged', labels().includes('design'));

  stub(worker, () => ({ merges: [{ tag: 'humans', merge_into: null }] }));
  worker.enqueue(q.id, 'humans');
  await sleep(2400);
  check('a null decision keeps the tag', labels().includes('humans'));

  // ---- a closed sheet must go quiet ----

  setSheetStatus(sheet.id, 'closed');
  const afterClose = stub(worker, () => ({ merges: [] }));
  worker.enqueue(q.id, 'humans');
  await sleep(2400);
  check('a closed sheet queues nothing', afterClose.length === 0);

  // ---- a failing API call must not take the app down ----

  setSheetStatus(sheet.id, 'live');
  worker.client = {
    messages: { async parse() { throw new Error('rate limited'); } },
  };
  recordTag({ questionId: q.id, rawTag: 'resilience', sessionId: 'f' });
  worker.enqueue(q.id, 'resilience');
  await sleep(2400);
  check('an API failure is swallowed', worker.stats.failures >= 1);
  check('the tag survives a failed merge check', labels().includes('resilience'));

  worker.stop();

  // ---- a worker with no key does nothing at all ----

  const off = new MergeWorker({ apiKey: '', onChange: () => {}, log: () => {} });
  check('no key means disabled', off.enabled === false);
  off.enqueue(q.id, 'anything');
  check('a disabled worker queues nothing', off.pending.size === 0);
} finally {
  deleteSheet(sheet.id);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
