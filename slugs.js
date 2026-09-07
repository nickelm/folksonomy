// Memorable URL slugs: adjective + animal, concatenated, lowercase — "braveotter".
//
// These get read off a projector and typed into phone keyboards by 150 people at
// once, so every word is chosen to be unambiguous when heard and when spelled:
// no homophones, no silent letters, no doubled-letter traps, nothing that invites
// a British/American spelling split.

const ADJECTIVES = [
  'brave', 'calm', 'clever', 'cool', 'crisp', 'eager', 'early', 'fair',
  'fast', 'fine', 'firm', 'fresh', 'glad', 'good', 'grand', 'happy',
  'jolly', 'keen', 'kind', 'lively', 'loyal', 'lucky', 'merry', 'mighty',
  'neat', 'noble', 'quick', 'quiet', 'rapid', 'ready', 'rich', 'royal',
  'sharp', 'shiny', 'silent', 'smart', 'snappy', 'solid', 'spry', 'stout',
  'sunny', 'super', 'swift', 'tidy', 'tough', 'trusty', 'vivid', 'warm',
  'wise', 'witty', 'young', 'zesty',
];

const ANIMALS = [
  'badger', 'bison', 'cobra', 'condor', 'crane', 'dingo', 'dolphin', 'donkey',
  'dragon', 'eagle', 'falcon', 'ferret', 'finch', 'gecko', 'gibbon', 'heron',
  'ibex', 'iguana', 'jackal', 'jaguar', 'koala', 'lemur', 'lizard', 'llama',
  'lynx', 'magpie', 'marmot', 'meerkat', 'mongoose', 'monkey', 'moose', 'ocelot',
  'osprey', 'otter', 'panda', 'panther', 'parrot', 'pelican', 'penguin', 'pigeon',
  'puffin', 'python', 'quokka', 'rabbit', 'raven', 'robin', 'salmon', 'sardine',
  'shark', 'sparrow', 'tapir', 'tiger', 'toucan', 'turtle', 'walrus', 'weasel',
  'wombat', 'zebra',
];

// Slugs that would shadow a real route or a static file. Checked on both
// generated and user-supplied slugs.
export const RESERVED_SLUGS = new Set([
  'api', 'presenter', 'ws', 'static', 'public', 'assets', 'admin', 'login',
  'logout', 'health', 'favicon.ico', 'robots.txt', 'index.html', 'sheet.html',
  'presenter.html', 'control.html', 'index.js', 'sheet.js', 'presenter.js',
  'control.js', 'styles.css',
  // Added with the live view, the dashboard, and the /s /p /d URL aliases.
  'live', 'dashboard', 'vendor', 'live.html', 'live.js', 'sediment.js',
  'dashboard.html', 'dashboard.js', 'panels.js', 'viz.js', 'common.js',
  'auth.js', 'notfound.html', 'advance.js',
]);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** True if `slug` is a shape we are willing to put in a URL. */
export function isValidSlug(slug) {
  return typeof slug === 'string'
    && SLUG_PATTERN.test(slug)
    && !RESERVED_SLUGS.has(slug);
}

// U+0300..U+036F, the combining diacritical marks left behind by NFKD.
// Built from char codes rather than written inline so the source stays ASCII —
// the raw marks are invisible in an editor and easy to mangle.
const COMBINING_MARKS = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g',
);

/** Turn arbitrary text into a slug-shaped string, or '' if nothing usable remains. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Generate a word-pair slug that `isTaken` rejects.
 *
 * ~3000 combinations, so collisions are rare but not impossible across a
 * semester. After 20 misses we stop trusting randomness and append a counter
 * rather than looping forever.
 */
export function generateSlug(isTaken) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = `${pick(ADJECTIVES)}${pick(ANIMALS)}`;
    if (!RESERVED_SLUGS.has(slug) && !isTaken(slug)) return slug;
  }

  const base = `${pick(ADJECTIVES)}${pick(ANIMALS)}`;
  for (let n = 2; n < 1000; n += 1) {
    const slug = `${base}${n}`;
    if (!isTaken(slug)) return slug;
  }

  throw new Error('could not generate an unused slug');
}
