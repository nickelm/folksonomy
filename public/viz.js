// Shared chart helpers for the live view and the dashboard.
//
// Both surfaces draw the same question, often at the same time on two screens in
// the same room, so anything that decides what a tag *looks like* lives here.
// A tag that is teal on the projector and orange on the dashboard is two tags as
// far as the audience is concerned.
//
// d3 arrives as a global from /vendor/d3.min.js rather than an import: there is
// no bundler in this project, and the student pages must not pay for d3 at all.

const { d3 } = window;

/**
 * A colour per label, stable as the counts move.
 *
 * Keyed on the label sorted alphabetically, NOT on rank. If colour followed rank
 * then every overtake would swap two colours mid-lecture, and the room would
 * read that as the tags themselves changing.
 */
export function colourScale(labels) {
  const domain = [...new Set(labels)].sort();
  return d3.scaleOrdinal()
    .domain(domain)
    .range(d3.schemeTableau10)
    .unknown('#8b909b');
}

/**
 * The n biggest, already sorted.
 *
 * Ties keep the order they arrived in - Array.sort is stable, so returning 0
 * preserves it. That matters more than it looks on the projector: the server
 * hands tags back oldest-first within a tie, so two tags on equal votes hold
 * still. Breaking ties alphabetically instead would make bars physically swap
 * places every time a vote created or broke a tie, and a bar sliding across its
 * neighbour reads as a glitch, not as information.
 *
 * Bars still reorder on a genuine overtake, which is worth watching.
 */
export function topN(items, n, value = (d) => d.count) {
  return [...items].sort((a, b) => value(b) - value(a)).slice(0, n);
}

/**
 * Font or bar size by share of the largest, on a square root.
 *
 * The same curve the tag cloud uses on the student page. Linear scaling makes a
 * single runaway tag flatten everything behind it into one indistinguishable
 * band, which loses the shape of the distribution the exercise is about.
 */
export function sqrtScale(count, max, min, top) {
  if (max <= 1) return min;
  return min + Math.sqrt(Math.max(0, count) / max) * (top - min);
}

/** Wrap an SVG text node onto at most `lines` lines, ellipsising the overflow. */
export function fitLabel(text, maxChars) {
  const value = String(text ?? '');
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

/** Device-pixel-aware canvas sizing. Returns the CSS size actually applied. */
export function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width: rect.width, height: rect.height, ctx };
}

export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
