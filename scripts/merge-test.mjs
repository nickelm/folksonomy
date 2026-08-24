// Direct tests of the merge machinery, which the smoke test cannot reach without
// an API key. Runs against the real database on a throwaway sheet.

import {
  addQuestion, createSheet, deleteSheet, listAliases, listTags, mergeTag, recordTag,
} from '../db.js';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sheet = createSheet({ title: 'merge test scratch' });
const q = addQuestion(sheet.id, { title: 'scratch', description: '' });
const count = (label) => listTags(q.id).find((t) => t.label === label)?.count ?? null;

try {
  // Alice says both words; Bob and Carol each say one.
  recordTag({ questionId: q.id, rawTag: 'usability', sessionId: 'alice' });
  recordTag({ questionId: q.id, rawTag: 'usable', sessionId: 'alice' });
  recordTag({ questionId: q.id, rawTag: 'usable', sessionId: 'bob' });
  recordTag({ questionId: q.id, rawTag: 'usability', sessionId: 'carol' });

  check('two separate tags before merging', listTags(q.id).length === 2);
  check('usability has alice + carol', count('usability') === 2);
  check('usable has alice + bob', count('usable') === 2);

  const canonical = listTags(q.id).find((t) => t.label === 'usability');
  check('merge reports success', mergeTag(q.id, 'usable', canonical.id) === true);

  check('one tag survives the merge', listTags(q.id).length === 1);
  // Alice voted for both words. She is still one person with one opinion, so the
  // total must be three, not four.
  check('a double voter collapses to a single vote', count('usability') === 3,
    `got ${count('usability')}`);
  check('the merged label is gone', count('usable') === null);

  const aliases = listAliases(q.id);
  check('the merge is recorded as an alias',
    aliases.length === 1 && aliases[0].alias === 'usable'
      && aliases[0].canonical === 'usability');

  // The point of storing the alias: the next student to type the folded word is
  // resolved locally, with no new tag and no second trip to the model.
  const again = recordTag({ questionId: q.id, rawTag: 'Usable', sessionId: 'dave' });
  check('a folded word resolves through the alias', again.ok && again.created === false);
  check('it votes for the canonical tag', again.label === 'usability');
  check('no duplicate tag reappears', listTags(q.id).length === 1);
  check('the canonical count grew', count('usability') === 4);

  // Guard rails on bad merge instructions.
  check('merging into a missing tag is refused', mergeTag(q.id, 'usability', 999999) === false);
  check('merging a missing tag is refused', mergeTag(q.id, 'ghost', canonical.id) === false);
  check('merging a tag into itself is refused',
    mergeTag(q.id, 'usability', canonical.id) === false);

  // A chain: merge C into B, then B into A. No alias may be left pointing at a
  // tag that no longer exists.
  recordTag({ questionId: q.id, rawTag: 'ease of use', sessionId: 'erin' });
  const ease = listTags(q.id).find((t) => t.label === 'ease of use');
  mergeTag(q.id, 'ease of use', canonical.id);
  const chained = listAliases(q.id);
  check('every alias points at a live tag',
    chained.every((a) => a.canonical === 'usability'), JSON.stringify(chained));
  check('the chained merge kept both voters', count('usability') === 5);
} finally {
  deleteSheet(sheet.id);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
