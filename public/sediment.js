// Visual sedimentation, after Huron, Vuillemot & Fekete (InfoVis 2013).
//
// Every submission enters as a discrete token at the top of the screen. It falls,
// drifting and fading as it descends, until it reaches the column for its tag -
// and then it stops being itself. It sediments: it merges into the accumulated
// bar, loses its individual identity, and the aggregate grows by one.
//
// The point is that the transition from "my answer" to "the room's answer" is
// normally invisible - a number simply changes. Here a student can watch their
// own token drop and dissolve into the group's, which is the whole argument of
// the paper and the reason this is worth the canvas.
//
// Canvas rather than SVG because 150 phones answering at once is 150 nodes
// appearing in one second, and the DOM is the wrong tool for that.

import { sizeCanvas } from '/viz.js';

// Past this the projector is drawing more than anyone can follow anyway. New
// tokens are dropped rather than allowed to cost frames - a dropped token still
// counts, it just does not get an animation (see live.js).
const MAX_PARTICLES = 240;

const GRAVITY = 900;        // px/s^2
const DRIFT_SPEED = 1.4;    // radians/s of the horizontal wobble
const SPLASH_MS = 420;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {(label: string|null) => void} onLand called the instant a token merges
 */
export function createSediment(canvas, onLand) {
  let particles = [];
  let splashes = [];
  let frame = null;
  let last = 0;
  let view = sizeCanvas(canvas);

  function resize() {
    view = sizeCanvas(canvas);
  }

  /**
   * Release a token.
   *
   * `target` is a function, not a point: the bar it is heading for is growing
   * while the token is in the air, so where it should land is only known at the
   * moment it lands. Returns false when the cap turned it away.
   */
  function spawn({ label, colour, target }) {
    if (particles.length >= MAX_PARTICLES) return false;

    const aim = target();
    if (!aim) return false;

    particles.push({
      label,
      colour,
      target,
      // Enter spread around the column rather than exactly above it, so a burst
      // reads as a scatter of individuals instead of one thick line.
      x: aim.x + (Math.random() - 0.5) * Math.min(160, view.width * 0.25),
      y: -12 - Math.random() * 40,
      vy: 40 + Math.random() * 60,
      phase: Math.random() * Math.PI * 2,
      wobble: 6 + Math.random() * 14,
      radius: 5 + Math.random() * 3,
      born: performance.now(),
    });

    start();
    return true;
  }

  function step(now) {
    const dt = Math.min(0.05, (now - last) / 1000) || 0;
    last = now;

    const { ctx, width, height } = view;
    ctx.clearRect(0, 0, width, height);

    const survivors = [];

    for (const p of particles) {
      const aim = p.target();

      // The column went away - the tag was merged or cleared mid-flight. Land it
      // anyway so the count is never left holding a token that cannot arrive.
      if (!aim) {
        onLand(p.label);
        continue;
      }

      p.vy += GRAVITY * dt;
      p.y += p.vy * dt;
      p.phase += DRIFT_SPEED * dt;

      // Steer toward the column as it falls, so the drift never carries a token
      // to the wrong bar: the wobble is a decoration on top of a homing path.
      p.x += (aim.x - p.x) * Math.min(1, dt * 2.4);

      const age = (now - p.born) / 1000;
      const drawX = p.x + Math.sin(p.phase) * p.wobble;
      const decay = Math.max(0.35, 1 - age * 0.28);

      if (p.y >= aim.y) {
        splashes.push({ x: aim.x, y: aim.y, colour: p.colour, born: now });
        onLand(p.label);
        continue;
      }

      ctx.globalAlpha = decay;
      ctx.fillStyle = p.colour;
      ctx.beginPath();
      ctx.arc(drawX, p.y, p.radius * decay, 0, Math.PI * 2);
      ctx.fill();

      survivors.push(p);
    }

    particles = survivors;

    // The splash is the merge made visible: a ring that opens where the token
    // stopped existing, at the moment the bar it joined grows.
    splashes = splashes.filter((s) => {
      const t = (now - s.born) / SPLASH_MS;
      if (t >= 1) return false;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6 + t * 26, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });

    ctx.globalAlpha = 1;

    if (particles.length === 0 && splashes.length === 0) {
      frame = null;
      return;
    }
    frame = requestAnimationFrame(step);
  }

  function start() {
    if (frame !== null) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    // Land everything still in the air, or their counts stay held back forever.
    for (const p of particles) onLand(p.label);
    particles = [];
    splashes = [];
    const { ctx, width, height } = view;
    ctx.clearRect(0, 0, width, height);
  }

  return { spawn, resize, stop, count: () => particles.length };
}
