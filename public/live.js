// Projection view: the currently active question, and nothing else.
//
// Read from the back of a lecture hall, so everything here is sized for distance
// and there are no controls at all - the presenter drives from /presenter/:slug
// on the lectern machine and this screen only ever reflects it.
//
// Two layers. Underneath, an SVG bar chart that transitions as votes arrive: the
// baseline, and the thing that has to be right. On top, a canvas of falling
// tokens that sediment into those bars. If the canvas were removed the chart
// would still be complete and correct, which is deliberate.

import { connect } from '/common.js';
import { createSediment } from '/sediment.js';
import { colourScale, fitLabel, prefersReducedMotion, sqrtScale, topN } from '/viz.js';

const { d3 } = window;

const slug = decodeURIComponent(location.pathname.replace(/^\/live\//, ''));

const titleEl = document.getElementById('q-title');
const descEl = document.getElementById('q-desc');
const sheetEl = document.getElementById('sheet-title');
const countEl = document.getElementById('connected');
const idleEl = document.getElementById('idle');
const stageEl = document.getElementById('stage');
const chartEl = document.getElementById('chart');
const cardsEl = document.getElementById('cards');
const canvas = document.getElementById('particles');

const MAX_BARS = 12;
const TRANSITION_MS = 420;

// How long a token may stay unaccounted for before the count stops waiting.
// Long enough for the longest fall, short enough that a lost token never leaves
// the projected number visibly wrong.
const INFLIGHT_TTL_MS = 2500;

const animate = !prefersReducedMotion();

let svg = null;
let sediment = null;
let colours = colourScale([]);
let active = null;
let barGeometry = new Map();   // label -> {x, y, width}

/**
 * Tokens still falling, per label, as spawn timestamps.
 *
 * This is what makes the animation mean something. The server has already
 * counted a submission by the time we hear about it, but the bar must not grow
 * until the token reaches it - otherwise the token lands on a bar that already
 * absorbed it and the merge is invisible. So the drawn value is the server's
 * count minus whatever is still in the air.
 */
const inFlight = new Map();

/** Submissions waiting for a bar to aim at. Drained after each state update. */
const deferred = [];
const DEFERRED_TTL_MS = 1200;

/**
 * Retry the submissions that arrived before their bar existed.
 *
 * Returns true if any were released, which tells render() to draw once more -
 * spawning a token holds its count back, and the bar must be redrawn at the
 * held-back value before the eye sees it at the full one.
 */
function drainDeferred() {
  if (deferred.length === 0) return false;

  const cutoff = performance.now() - DEFERRED_TTL_MS;
  const waiting = deferred.splice(0, deferred.length);
  let released = false;

  for (const item of waiting) {
    if (item.at < cutoff) continue;              // gave up on this one
    if (!barGeometry.has(item.label)) {
      deferred.push(item);                       // still no bar; wait another tick
      continue;
    }
    onSubmission(item);
    released = true;
  }

  return released;
}

function pending(label) {
  const queue = inFlight.get(label);
  if (!queue || queue.length === 0) return 0;

  // Anything past its deadline is a token we lost track of - a tag merged away
  // mid-flight, a tab backgrounded so rAF stopped. Let the count catch up.
  const cutoff = performance.now() - INFLIGHT_TTL_MS;
  while (queue.length > 0 && queue[0] < cutoff) queue.shift();
  return queue.length;
}

function hold(label) {
  if (!inFlight.has(label)) inFlight.set(label, []);
  inFlight.get(label).push(performance.now());
}

function release(label) {
  const queue = inFlight.get(label);
  if (queue && queue.length > 0) queue.shift();
  draw();
}

function clearHolds() {
  inFlight.clear();
}

// --------------------------------------------------------------------------
// Data for the current question
// --------------------------------------------------------------------------

/**
 * What the chart is actually showing, whatever kind of question it is.
 *
 * Tags plot themselves. Freetext has no natural bars until clustering has run,
 * so before that it is not a bar chart at all - it is the answers themselves,
 * which is the only honest thing to project.
 */
function seriesFor(question) {
  if (!question) return { mode: 'idle', bars: [], cards: [] };

  if (question.type === 'freetext') {
    const responses = question.responses || [];
    const themed = responses.filter((r) => r.clusterLabel);

    if (themed.length > 0) {
      const byTheme = new Map();
      for (const r of responses) {
        const label = r.clusterLabel || 'Unclustered';
        byTheme.set(label, (byTheme.get(label) || 0) + 1);
      }
      return {
        mode: 'bars',
        bars: topN([...byTheme].map(([label, count]) => ({ label, count })), MAX_BARS),
        cards: [],
      };
    }

    return {
      mode: 'cards',
      bars: [],
      cards: topN(responses, 6, (d) => d.score),
      total: question.responseCount ?? responses.length,
    };
  }

  return { mode: 'bars', bars: topN(question.tags || [], MAX_BARS), cards: [] };
}

// --------------------------------------------------------------------------
// The chart
// --------------------------------------------------------------------------

function ensureSvg() {
  if (svg) return svg;
  svg = d3.select(chartEl).append('svg')
    .attr('class', 'chart-svg')
    .attr('preserveAspectRatio', 'none');
  svg.append('g').attr('class', 'bars');
  svg.append('g').attr('class', 'labels');
  svg.append('g').attr('class', 'values');
  return svg;
}

function draw() {
  const series = seriesFor(active);

  idleEl.hidden = series.mode !== 'idle';
  stageEl.hidden = series.mode === 'idle';
  chartEl.hidden = series.mode !== 'bars';
  cardsEl.hidden = series.mode !== 'cards';
  canvas.hidden = !animate || series.mode === 'idle';

  if (series.mode === 'cards') return drawCards(series);
  if (series.mode !== 'bars') {
    barGeometry = new Map();
    return undefined;
  }
  return drawBars(series.bars);
}

function drawBars(bars) {
  const rect = chartEl.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 10 || height < 10) return;

  // Room under the bars for a label, and above them for a value.
  const padBottom = Math.min(120, Math.max(56, height * 0.16));
  const padTop = Math.min(90, Math.max(44, height * 0.12));

  // The drawn value lags the server's while tokens are still falling.
  const data = bars.map((d) => ({
    label: d.label,
    value: Math.max(0, d.count - pending(d.label)),
    server: d.count,
  }));

  colours = colourScale(bars.map((d) => d.label));

  const x = d3.scaleBand()
    .domain(data.map((d) => d.label))
    .range([0, width])
    .paddingInner(0.22)
    .paddingOuter(0.1);

  // Never scale to a maximum below 1, or the first vote fills the screen and
  // every vote after it makes the chart look like it is shrinking.
  const max = Math.max(1, d3.max(data, (d) => Math.max(d.value, 1)) ?? 1);
  const y = d3.scaleLinear().domain([0, max]).range([height - padBottom, padTop]);

  svg = ensureSvg();
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

  const t = svg.transition().duration(TRANSITION_MS).ease(d3.easeCubicOut);
  const baseline = height - padBottom;
  const labelSize = Math.max(13, Math.min(30, x.bandwidth() * 0.19));
  const valueSize = Math.max(16, Math.min(46, x.bandwidth() * 0.3));

  svg.select('.bars').selectAll('rect')
    .data(data, (d) => d.label)
    .join(
      (enter) => enter.append('rect')
        .attr('rx', 6)
        .attr('x', (d) => x(d.label))
        .attr('width', x.bandwidth())
        .attr('y', baseline)
        .attr('height', 0)
        .attr('fill', (d) => colours(d.label)),
      (update) => update,
      (exit) => exit.transition(t).attr('height', 0).attr('y', baseline).remove(),
    )
    .transition(t)
    .attr('x', (d) => x(d.label))
    .attr('width', x.bandwidth())
    .attr('y', (d) => y(d.value))
    .attr('height', (d) => Math.max(0, baseline - y(d.value)))
    .attr('fill', (d) => colours(d.label));

  svg.select('.labels').selectAll('text')
    .data(data, (d) => d.label)
    .join(
      (enter) => enter.append('text')
        .attr('text-anchor', 'middle')
        .attr('y', baseline + labelSize + 12)
        .attr('opacity', 0),
      (update) => update,
      (exit) => exit.transition(t).attr('opacity', 0).remove(),
    )
    // Truncate to what the band can hold. Twelve bars of long tags would
    // otherwise write over each other, which is worse than an ellipsis.
    .text((d) => fitLabel(d.label, Math.max(6, Math.floor(x.bandwidth() / (labelSize * 0.56)))))
    .transition(t)
    .attr('x', (d) => x(d.label) + x.bandwidth() / 2)
    .attr('y', baseline + labelSize + 12)
    .attr('font-size', labelSize)
    .attr('opacity', 1);

  svg.select('.values').selectAll('text')
    .data(data, (d) => d.label)
    .join(
      (enter) => enter.append('text')
        .attr('text-anchor', 'middle')
        .attr('opacity', 0),
      (update) => update,
      (exit) => exit.remove(),
    )
    .transition(t)
    .attr('x', (d) => x(d.label) + x.bandwidth() / 2)
    .attr('y', (d) => y(d.value) - 12)
    .attr('font-size', valueSize)
    .attr('opacity', (d) => (d.value > 0 ? 1 : 0))
    .tween('text', function tween(d) {
      // Count up rather than snap: at the back of a hall a number that changes
      // instantly is easy to miss entirely.
      const node = this;
      const from = Number(node.textContent) || 0;
      const interpolate = d3.interpolateRound(from, d.value);
      return (step) => { node.textContent = interpolate(step); };
    });

  // Where a falling token should aim. Recomputed here so it always reflects the
  // bar's live position, including mid-transition.
  barGeometry = new Map(data.map((d) => [d.label, {
    x: x(d.label) + x.bandwidth() / 2,
    y: y(d.value),
    width: x.bandwidth(),
  }]));
}

function drawCards(series) {
  const total = series.total ?? series.cards.length;
  cardsEl.dataset.total = total === 1 ? '1 answer so far' : `${total} answers so far`;

  const max = Math.max(1, d3.max(series.cards, (d) => Math.abs(d.score)) ?? 1);

  d3.select(cardsEl).selectAll('.live-card')
    .data(series.cards, (d) => d.id)
    .join(
      (enter) => {
        const card = enter.append('div').attr('class', 'live-card').style('opacity', 0);
        card.append('p').attr('class', 'live-card-text');
        card.append('span').attr('class', 'live-card-score');
        return card;
      },
      (update) => update,
      (exit) => exit.transition().duration(TRANSITION_MS).style('opacity', 0).remove(),
    )
    .call((card) => {
      card.select('.live-card-text')
        .text((d) => d.text)
        .style('font-size', (d) => `${sqrtScale(Math.abs(d.score), max, 1.15, 1.9).toFixed(2)}rem`);
      card.select('.live-card-score')
        .text((d) => (d.score > 0 ? `+${d.score}` : String(d.score)))
        .classed('is-positive', (d) => d.score > 0)
        .classed('is-negative', (d) => d.score < 0);
    })
    .transition().duration(TRANSITION_MS)
    .style('opacity', 1);

  barGeometry = new Map();
}

// --------------------------------------------------------------------------
// Arrivals
// --------------------------------------------------------------------------

/**
 * A single submission just landed on the server. Put a token in the air for it.
 *
 * If a token cannot be spawned - the cap is full, motion is off, the question is
 * not the one on screen - the count is simply not held back, so the bar grows on
 * the next broadcast as it would without any of this. Nothing is ever lost, the
 * arrival just is not animated.
 */
function onSubmission({ questionId, kind, label }) {
  if (!animate || !sediment) return;
  if (!active || active.id !== questionId) return;

  // A freetext answer has no column of its own until clustering has run, so it
  // falls into the single accumulating pile the cards represent.
  const target = kind === 'freetext' ? null : label;

  // A brand-new tag has no bar yet - its submission reaches us just ahead of the
  // state that creates one. Hold it for a moment rather than dropping it: a tag
  // appearing for the first time is the clearest case the animation has, a bar
  // rising from nothing under its own token.
  if (target !== null && !barGeometry.has(target)) {
    deferred.push({ questionId, kind, label, at: performance.now() });
    return;
  }

  const spawned = sediment.spawn({
    label: target,
    colour: target === null ? '#7aa2f7' : colours(target),
    target: () => {
      if (target === null) {
        const rect = chartEl.getBoundingClientRect();
        return { x: rect.width / 2, y: rect.height - 40 };
      }
      return barGeometry.get(target) || null;
    },
  });

  if (spawned && target !== null) hold(target);
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

function render(state) {
  sheetEl.textContent = state.sheet.title;
  countEl.textContent = state.connectedCount;

  const next = state.questions.find((q) => q.active) || null;
  const changed = (next?.id ?? null) !== (active?.id ?? null);

  // Point at the new question before tearing the old one down. Stopping the
  // particle layer lands everything still in the air, and every landing triggers
  // a redraw - which would otherwise repaint the outgoing question into an SVG
  // about to be deleted.
  active = next;

  if (changed) {
    // Tokens in the air belong to a chart that no longer exists. Drop them
    // rather than hold back counts on the new one.
    clearHolds();
    deferred.length = 0;
    if (svg) { svg.remove(); svg = null; }
    d3.select(cardsEl).selectAll('.live-card').remove();
    sediment?.stop();
  }

  titleEl.textContent = next ? next.title : '';
  descEl.textContent = next ? next.description : '';
  descEl.hidden = !next?.description;
  document.title = next ? `${next.title} - live` : `${state.sheet.title} - live`;

  // Draw first so a new tag has a bar to aim at, then release anything that was
  // waiting for one, then draw again at the held-back counts. A bar entering for
  // the first time starts at zero height, so the intermediate draw is invisible.
  draw();
  if (drainDeferred()) draw();
}

if (animate) {
  sediment = createSediment(canvas, release);
}

let latest = null;

connect({
  slug,
  role: 'live',
  onState(state) {
    latest = state;
    render(state);
  },
  onSubmission,
  onStatus(status) {
    // A reconnect means we may have missed arrivals, so nothing in the air can
    // be trusted to correspond to anything. Start the accounting over.
    if (status === 'offline') {
      clearHolds();
      sediment?.stop();
    }
  },
});

const redraw = () => {
  sediment?.resize();
  if (latest) draw();
};

window.addEventListener('resize', redraw);
new ResizeObserver(redraw).observe(chartEl);
