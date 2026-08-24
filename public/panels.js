// The six dashboard panels.
//
// Each one is a small object with a render function and nothing else: no state,
// no timers, no listeners of its own. dashboard.js decides when a panel is
// visible and how big it is, then calls render. That is what lets the same panel
// draw itself in a 320px grid cell and again filling a 4K projector without
// knowing which is happening.
//
// A panel that has nothing to draw says so in words. An empty chart looks like a
// bug; "this needs clustering first" is an instruction.

import { colourScale, fitLabel, sqrtScale, topN } from '/viz.js';

const { d3 } = window;

// d3-cloud's UMD build has attached itself under different names across its
// releases. Resolve whichever is actually there rather than betting on one.
const cloudLayout = () =>
  window.d3?.layout?.cloud || window.d3?.cloud || window.cloud || null;

const TRANSITION_MS = 400;

// Enough to keep "the" and "and" out of a word cloud without pretending to do
// real language processing. Anything cleverer belongs in a different exercise.
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'are', 'but', 'not', 'you',
  'his', 'her', 'its', 'they', 'them', 'their', 'have', 'has', 'had', 'was',
  'were', 'been', 'being', 'from', 'into', 'than', 'then', 'there', 'these',
  'those', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'all', 'can',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'about', 'because',
  'people', 'thing', 'things', 'very', 'just', 'get', 'got', 'make', 'makes',
  'made', 'also', 'more', 'most', 'some', 'such', 'only', 'other', 'your',
  'our', 'out', 'too', 'own', 'same', 'each', 'both', 'any', 'lot',
]);

function empty(root, message) {
  root.replaceChildren();
  const p = document.createElement('p');
  p.className = 'panel-empty';
  p.textContent = message;
  root.append(p);
}

/** A tags question's tags, or a freetext question's themes, as one shape. */
function frequencies(question) {
  if (question.type !== 'freetext') {
    return (question.tags || []).map((t) => ({ label: t.label, count: t.count }));
  }

  const responses = question.responses || [];
  if (!responses.some((r) => r.clusterLabel)) return [];

  const byTheme = new Map();
  for (const r of responses) {
    const label = r.clusterLabel || 'Unclustered';
    byTheme.set(label, (byTheme.get(label) || 0) + 1);
  }
  return [...byTheme].map(([label, count]) => ({ label, count }));
}

function wordFrequencies(responses) {
  const counts = new Map();
  for (const r of responses) {
    // Split on anything that is not a letter or an apostrophe, so "don't" holds
    // together but "user-friendly" becomes two words, which is the right call
    // for a frequency cloud.
    for (const raw of String(r.text).toLowerCase().split(/[^a-z'À-ɏ]+/)) {
      const word = raw.replace(/^'+|'+$/g, '');
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

function svgIn(root, width, height) {
  root.replaceChildren();
  return d3.select(root).append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`);
}

// --------------------------------------------------------------------------
// 1. Ranked frequency bars
// --------------------------------------------------------------------------

const rankedBars = {
  id: 'bars',
  title: 'Ranked frequency',
  hint: 'Sorted by votes. The default readout.',
  render({ root, question, colours, width, height }) {
    const data = topN(frequencies(question), Math.max(6, Math.floor(height / 34)));
    if (data.length === 0) {
      return empty(root, question.type === 'freetext'
        ? 'Themes appear here once clustering has run.'
        : 'No tags yet.');
    }

    const padLeft = Math.min(180, Math.max(70, width * 0.28));
    const padRight = 52;
    const svg = svgIn(root, width, height);
    const rowHeight = Math.min(46, (height - 8) / data.length);

    const y = d3.scaleBand()
      .domain(data.map((d) => d.label))
      .range([4, 4 + rowHeight * data.length])
      .paddingInner(0.24);

    const x = d3.scaleLinear()
      .domain([0, Math.max(1, d3.max(data, (d) => d.count))])
      .range([padLeft, width - padRight]);

    const fontSize = Math.max(10, Math.min(15, y.bandwidth() * 0.62));

    svg.selectAll('rect').data(data, (d) => d.label).join('rect')
      .attr('rx', 4)
      .attr('x', padLeft)
      .attr('y', (d) => y(d.label))
      .attr('height', y.bandwidth())
      .attr('fill', (d) => colours(d.label))
      .transition().duration(TRANSITION_MS)
      .attr('width', (d) => Math.max(1, x(d.count) - padLeft));

    svg.selectAll('text.name').data(data, (d) => d.label).join('text')
      .attr('class', 'name')
      .attr('x', padLeft - 8)
      .attr('y', (d) => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '.35em')
      .attr('text-anchor', 'end')
      .attr('font-size', fontSize)
      .text((d) => fitLabel(d.label, Math.floor(padLeft / (fontSize * 0.55))));

    svg.selectAll('text.value').data(data, (d) => d.label).join('text')
      .attr('class', 'value')
      .attr('y', (d) => y(d.label) + y.bandwidth() / 2)
      .attr('dy', '.35em')
      .attr('font-size', fontSize)
      .text((d) => d.count)
      .transition().duration(TRANSITION_MS)
      .attr('x', (d) => x(d.count) + 6);

    return undefined;
  },
};

// --------------------------------------------------------------------------
// 2. Word cloud
// --------------------------------------------------------------------------

const wordCloud = {
  id: 'cloud',
  title: 'Word cloud',
  hint: 'Size is frequency. Position carries no meaning.',
  // The layout is a physics-ish spiral search, expensive and asynchronous. It
  // must not run on every broadcast, so the dashboard debounces this one.
  debounce: 900,
  render({ root, question, colours, width, height }) {
    const layout = cloudLayout();
    if (!layout) return empty(root, 'd3-cloud is not loaded. Run npm install.');

    const source = question.type === 'freetext'
      ? wordFrequencies(question.responses || [])
      : frequencies(question);

    const data = topN(source, 60);
    if (data.length === 0) return empty(root, 'Nothing to draw yet.');

    const max = d3.max(data, (d) => d.count) || 1;
    const scale = Math.min(width, height * 1.6) / 320;
    const words = data.map((d) => ({
      text: d.label,
      size: sqrtScale(d.count, max, 12, 54) * Math.max(0.55, Math.min(1.6, scale)),
      count: d.count,
    }));

    // Stamped before the layout starts so a later run can invalidate this one:
    // the callback below may arrive after the panel has been resized or the
    // question switched, and must not paint over whatever replaced it.
    const token = String(Date.now() + Math.random());
    root.dataset.cloudToken = token;

    layout()
      .size([width, height])
      .words(words)
      .padding(2)
      .rotate(0)                       // Rotated words are slower to read and
      .font('system-ui')               // buy nothing but decoration.
      .fontSize((d) => d.size)
      .on('end', (placed) => {
        // The layout is async: by the time it finishes the panel may have been
        // resized or the question switched. Draw only if we are still wanted.
        if (!root.isConnected || root.dataset.cloudToken !== token) return;

        const svg = svgIn(root, width, height);
        svg.append('g')
          .attr('transform', `translate(${width / 2},${height / 2})`)
          .selectAll('text')
          .data(placed)
          .join('text')
          .attr('text-anchor', 'middle')
          .attr('transform', (d) => `translate(${d.x},${d.y})`)
          .attr('font-size', (d) => d.size)
          .attr('font-family', 'system-ui, sans-serif')
          .attr('fill', (d) => colours(d.text))
          .text((d) => d.text)
          .append('title')
          .text((d) => `${d.text}: ${d.count}`);
      })
      .start();

    return undefined;
  },
};

// --------------------------------------------------------------------------
// 3. Theme clusters
// --------------------------------------------------------------------------

const themeClusters = {
  id: 'themes',
  title: 'Theme clusters',
  hint: 'Answers grouped by Claude, one column per theme.',
  render({ root, question, colours }) {
    if (question.type !== 'freetext') {
      return empty(root, 'Themes apply to freetext questions.');
    }

    const responses = question.responses || [];
    if (responses.length === 0) return empty(root, 'No answers yet.');
    if (!responses.some((r) => r.clusterLabel)) {
      return empty(root, 'Not clustered yet. Press "Find themes" in the presenter view.');
    }

    const byTheme = new Map();
    for (const r of responses) {
      const label = r.clusterLabel || 'Unclustered';
      if (!byTheme.has(label)) byTheme.set(label, []);
      byTheme.get(label).push(r);
    }

    // Unclustered is the leftovers, not a finding. It goes last.
    const ordered = [...byTheme].sort((a, b) => {
      if (a[0] === 'Unclustered') return 1;
      if (b[0] === 'Unclustered') return -1;
      return b[1].length - a[1].length;
    });

    root.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'theme-grid';

    for (const [label, members] of ordered) {
      const column = document.createElement('div');
      column.className = 'theme-column';
      column.style.setProperty('--theme-colour', colours(label));

      const head = document.createElement('h4');
      head.textContent = `${label} (${members.length})`;

      column.append(head);
      for (const r of [...members].sort((a, b) => b.score - a.score)) {
        const item = document.createElement('p');
        item.className = 'theme-item';
        item.textContent = r.text;
        column.append(item);
      }
      grid.append(column);
    }

    root.append(grid);
    return undefined;
  },
};

// --------------------------------------------------------------------------
// 4. Tag co-occurrence
// --------------------------------------------------------------------------

const cooccurrence = {
  id: 'cooccurrence',
  title: 'Tags that travel together',
  hint: 'A line means the same people chose both. Thicker means more of them.',
  render({ root, question, analytics, colours, width, height }) {
    if (question.type === 'freetext') {
      return empty(root, 'Co-occurrence applies to tag questions.');
    }
    if (question.type === 'choice') {
      return empty(root, 'Everyone picks exactly one option, so nothing travels together.');
    }

    const links = (analytics?.cooccurrence || []).map((d) => ({ ...d }));
    if (links.length === 0) {
      return empty(root, 'Nothing yet. This needs people who picked more than one tag.');
    }

    const counts = new Map((question.tags || []).map((t) => [t.label, t.count]));
    const names = new Set(links.flatMap((l) => [l.source, l.target]));
    const nodes = [...names].map((label) => ({ id: label, count: counts.get(label) || 1 }));

    const maxCount = d3.max(nodes, (d) => d.count) || 1;
    const maxWeight = d3.max(links, (d) => d.weight) || 1;
    const radius = (d) => sqrtScale(d.count, maxCount, 5, Math.min(26, width / 14));

    // Run the simulation to rest, then draw once. A live force layout on a
    // dashboard panel is a distraction and a battery drain; the useful part is
    // the arrangement, not watching it settle.
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d) => d.id)
        .distance((d) => 90 - 40 * (d.weight / maxWeight))
        .strength(0.5))
      .force('charge', d3.forceManyBody().strength(-160))
      .force('centre', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius((d) => radius(d) + 4))
      .stop();

    simulation.tick(300);

    // Keep everything inside the panel: the simulation has no idea there is one.
    for (const n of nodes) {
      n.x = Math.max(radius(n) + 2, Math.min(width - radius(n) - 2, n.x));
      n.y = Math.max(radius(n) + 2, Math.min(height - radius(n) - 2, n.y));
    }

    const svg = svgIn(root, width, height);

    svg.append('g').selectAll('line').data(links).join('line')
      .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y)
      .attr('stroke', 'currentColor')
      .attr('stroke-opacity', (d) => 0.15 + 0.5 * (d.weight / maxWeight))
      .attr('stroke-width', (d) => 1 + 4 * (d.weight / maxWeight));

    const node = svg.append('g').selectAll('g').data(nodes).join('g')
      .attr('transform', (d) => `translate(${d.x},${d.y})`);

    node.append('circle')
      .attr('r', radius)
      .attr('fill', (d) => colours(d.id));

    node.append('title').text((d) => `${d.id}: ${d.count} votes`);

    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => radius(d) + 12)
      .attr('font-size', 11)
      .text((d) => fitLabel(d.id, 16));

    return undefined;
  },
};

// --------------------------------------------------------------------------
// 5. Formation timeline
// --------------------------------------------------------------------------

const timeline = {
  id: 'timeline',
  title: 'How the vocabulary formed',
  hint: 'Each line is a tag accumulating. The dot is when it first appeared.',
  render({ root, question, analytics, colours, width, height }) {
    if (question.type === 'freetext') {
      return empty(root, 'The timeline applies to tag questions.');
    }

    const events = analytics?.timeline || [];
    if (events.length < 2) return empty(root, 'Not enough votes yet.');

    const start = events[0].at;
    const end = events[events.length - 1].at;
    if (end <= start) return empty(root, 'All the votes landed at once.');

    const tracked = topN(question.tags || [], 8).map((t) => t.label);
    const wanted = new Set(tracked);
    if (wanted.size === 0) return empty(root, 'No tags yet.');

    const BINS = 40;
    const step = (end - start) / BINS;

    // One cumulative series per tag. Bucketing rather than plotting every event
    // keeps the line count flat whether the class cast 40 votes or 4000.
    const series = new Map(tracked.map((label) => [label, {
      label,
      points: Array.from({ length: BINS + 1 }, (unused, i) => ({ t: start + i * step, v: 0 })),
      firstAt: null,
    }]));

    for (const e of events) {
      if (!wanted.has(e.label)) continue;
      const entry = series.get(e.label);
      if (entry.firstAt === null) entry.firstAt = e.at;
      const bin = Math.min(BINS, Math.floor((e.at - start) / step));
      for (let i = bin; i <= BINS; i += 1) entry.points[i].v += 1;
    }

    const padLeft = 34;
    const padBottom = 22;
    const padTop = 8;

    const x = d3.scaleLinear().domain([start, end]).range([padLeft, width - 8]);
    const y = d3.scaleLinear()
      .domain([0, Math.max(1, d3.max([...series.values()], (s) => s.points[BINS].v))])
      .range([height - padBottom, padTop]);

    const svg = svgIn(root, width, height);

    svg.append('g')
      .attr('transform', `translate(0,${height - padBottom})`)
      .attr('class', 'axis')
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 110)))
        .tickFormat((d) => `${Math.round((d - start) / 60000)}m`));

    svg.append('g')
      .attr('transform', `translate(${padLeft},0)`)
      .attr('class', 'axis')
      .call(d3.axisLeft(y).ticks(Math.max(2, Math.floor(height / 40))).tickFormat(d3.format('d')));

    const line = d3.line()
      .x((d) => x(d.t))
      .y((d) => y(d.v))
      .curve(d3.curveMonotoneX);

    for (const entry of series.values()) {
      svg.append('path')
        .datum(entry.points)
        .attr('fill', 'none')
        .attr('stroke', colours(entry.label))
        .attr('stroke-width', 2)
        .attr('d', line)
        .append('title')
        .text(entry.label);

      if (entry.firstAt !== null) {
        svg.append('circle')
          .attr('cx', x(entry.firstAt))
          .attr('cy', y(0))
          .attr('r', 3.5)
          .attr('fill', colours(entry.label))
          .append('title')
          .text(`${entry.label} first appeared`);
      }
    }

    return undefined;
  },
};

// --------------------------------------------------------------------------
// 6. Raw feed
// --------------------------------------------------------------------------

const rawFeed = {
  id: 'raw',
  title: 'Raw responses',
  hint: 'Unaggregated. Freetext by score, tags in the order they were cast.',
  render({ root, question, analytics, colours }) {
    root.replaceChildren();
    const list = document.createElement('div');
    list.className = 'raw-list';

    if (question.type === 'freetext') {
      const responses = [...(question.responses || [])]
        .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);
      if (responses.length === 0) return empty(root, 'No answers yet.');

      for (const r of responses) {
        const row = document.createElement('div');
        row.className = 'raw-row';

        const score = document.createElement('span');
        score.className = 'raw-score';
        score.textContent = r.score > 0 ? `+${r.score}` : String(r.score);
        score.classList.toggle('is-positive', r.score > 0);
        score.classList.toggle('is-negative', r.score < 0);

        const text = document.createElement('span');
        text.className = 'raw-text';
        text.textContent = r.text;

        row.append(score, text);

        if (r.clusterLabel) {
          const theme = document.createElement('span');
          theme.className = 'raw-theme';
          theme.textContent = r.clusterLabel;
          theme.style.setProperty('--theme-colour', colours(r.clusterLabel));
          row.append(theme);
        }

        list.append(row);
      }
    } else {
      const events = [...(analytics?.timeline || [])].reverse();
      if (events.length === 0) return empty(root, 'No votes yet.');

      const first = events[events.length - 1].at;
      for (const e of events) {
        const row = document.createElement('div');
        row.className = 'raw-row';

        const dot = document.createElement('span');
        dot.className = 'raw-dot';
        dot.style.background = colours(e.label);

        const text = document.createElement('span');
        text.className = 'raw-text';
        text.textContent = e.label;

        const when = document.createElement('span');
        when.className = 'raw-when';
        const seconds = Math.round((e.at - first) / 1000);
        when.textContent = seconds < 60
          ? `${seconds}s`
          : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

        row.append(dot, text, when);
        list.append(row);
      }
    }

    root.append(list);
    return undefined;
  },
};

export const PANELS = [rankedBars, wordCloud, themeClusters, cooccurrence, timeline, rawFeed];

/**
 * The colour scale for a question, shared by every panel drawing it.
 *
 * Built from the full label set - tags, themes, and the words a cloud will find -
 * so a label keeps its colour no matter which panel is showing it.
 */
export function coloursFor(question) {
  const labels = [
    ...(question.tags || []).map((t) => t.label),
    ...new Set((question.responses || []).map((r) => r.clusterLabel).filter(Boolean)),
  ];

  if (question.type === 'freetext') {
    labels.push(...wordFrequencies(question.responses || []).map((w) => w.label));
  }

  return colourScale(labels);
}
