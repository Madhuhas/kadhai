/**
 * The 3D half of Kadhai's ASCII art: a tiny renderer that samples shapes (spheres,
 * cylinders, rings) as points, lights them, keeps the nearest per character cell
 * and writes a character from a brightness ramp. No canvas, no WebGL, no images:
 * the result is text in a <pre>, coloured by CSS like every other figure.
 *
 * It draws the crew (one model per agent, posed: resting, working, waving, walking,
 * cheering, slumped, asleep) and the kadhai in the middle of the kitchen. A figure
 * is re-drawn only when its pose changes, so a still kitchen costs nothing.
 */

const RAMP = '.:;=+*#%@';
let ramp = RAMP;

/**
 * The theme's own shading characters, darkest to brightest (its --ascii-ramp). Only printable
 * ASCII, never a space, '-' or '~' (those mean liquid); anything else falls back to the default.
 */
export function setRamp(chars) {
  const clean = [...new Set(String(chars ?? ''))].filter((c) => c > ' ' && c <= '~' && c !== '-' && c !== '~').join('');
  ramp = clean.length >= 3 ? clean : RAMP;
}
const LIGHT = norm([-0.55, 0.75, -0.6]); // towards the light: above, left, in front
const FILL = norm([0.3, -0.6, -0.75]); // a weak second light from below and in front: the fire, and the room

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ------------------------------------------------------------ transforms

const I = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const rot = (axis, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 'x') return { m: [1, 0, 0, 0, c, -s, 0, s, c], t: [0, 0, 0] };
  if (axis === 'y') return { m: [c, 0, s, 0, 1, 0, -s, 0, c], t: [0, 0, 0] };
  return { m: [c, -s, 0, s, c, 0, 0, 0, 1], t: [0, 0, 0] };
};
const move = (x, y, z) => ({ m: I.m, t: [x, y, z] });
const mulM = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const apM = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
/** a then b: the transform that applies `b` first, then `a` (a is the outer, parent one). */
const then = (a, b) => ({ m: mulM(a.m, b.m), t: (() => { const p = apM(a.m, b.t); return [p[0] + a.t[0], p[1] + a.t[1], p[2] + a.t[2]]; })() });
const chain = (...ts) => ts.reduce(then, I);
const ap = (T, p) => { const q = apM(T.m, p); return [q[0] + T.t[0], q[1] + T.t[1], q[2] + T.t[2]]; };

// ------------------------------------------------------------------ grid

/**
 * A character grid with a depth buffer and a simple perspective camera.
 * `scale` is columns per unit at the centre; rows are half as dense (a character is about twice as tall as wide).
 */
export class Grid {
  constructor(w, h, { scale, cx = w / 2, cy = h / 2, dist = 6, pitch = 0.18 }) {
    Object.assign(this, { w, h, scale, cx, cy, dist });
    this.view = rot('x', -pitch); // positive pitch: looking down at it, top towards us
    this.ch = new Array(w * h).fill(' ');
    this.z = new Float32Array(w * h).fill(-1e9);
    // What each character is made of ('rim', 'oil', 'hat'...): html() colours by it. Drawing code sets
    // `material` before each part; text() ignores it, so a plain drawing is exactly what it was.
    this.mat = new Array(w * h).fill('');
    this.material = '';
  }

  clear() {
    this.ch.fill(' ');
    this.z.fill(-1e9);
    this.mat.fill('');
    this.material = '';
  }

  /** Screen cell and nearness of a point in the world, or null when it falls outside. */
  project(p) {
    const q = apM(this.view.m, p);
    const d = 1 / (q[2] + this.dist);
    const x = Math.round(this.cx + q[0] * d * this.scale * this.dist);
    const y = Math.round(this.cy - q[1] * d * this.scale * this.dist * 0.5);
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return null;
    return { x, y, d };
  }

  /** One lit surface point. `glow` brightens it; `char` draws it with that character instead of shading (liquids). */
  dot(p, n, glow = 0, char = null) {
    const s = this.project(p);
    if (!s) return;
    const i = s.y * this.w + s.x;
    if (s.d <= this.z[i]) return;
    const vn = apM(this.view.m, n);
    // Facing away from us: the far side of a closed shape, never drawn over the near side.
    if (vn[2] > 0.35 && !glow) return;
    this.z[i] = s.d;
    this.mat[i] = this.material;
    if (char) {
      this.ch[i] = char;
      return;
    }
    const key = Math.max(0, vn[0] * LIGHT[0] + vn[1] * LIGHT[1] + vn[2] * LIGHT[2]);
    const fill = Math.max(0, vn[0] * FILL[0] + vn[1] * FILL[1] + vn[2] * FILL[2]);
    const lum = key * 0.8 + fill * 0.3 + 0.1 + glow;
    this.ch[i] = ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(lum * ramp.length)))];
  }

  /** A character drawn on top (eyes, bubbles, zZ), if the point is not hidden behind something nearer. */
  mark(p, char, slack = 0.02, material = this.material) {
    const s = this.project(p);
    if (!s) return false;
    const i = s.y * this.w + s.x;
    if (this.z[i] > s.d + slack) return false;
    this.ch[i] = char;
    this.mat[i] = material;
    return true;
  }

  put(x, y, text, material = this.material) {
    for (let k = 0; k < text.length; k++) {
      const col = x + k;
      if (col >= 0 && col < this.w && y >= 0 && y < this.h && text[k] !== ' ') {
        this.ch[y * this.w + col] = text[k];
        this.mat[y * this.w + col] = material;
      }
    }
  }

  /**
   * The drawing as HTML: each run of characters made of one material is a <span class="m-<material>">,
   * which CSS colours (the art stays text; a theme decides the colours). Characters are escaped.
   */
  html() {
    const esc = (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c);
    const rows = [];
    for (let y = 0; y < this.h; y++) {
      let row = '';
      let open = null;
      let end = this.w;
      while (end > 0 && this.ch[y * this.w + end - 1] === ' ') end--;
      for (let x = 0; x < end; x++) {
        const i = y * this.w + x;
        const m = this.ch[i] === ' ' ? open : this.mat[i];
        if (m !== open) {
          if (open) row += '</span>';
          if (m) row += `<span class="m-${m}">`;
          open = m;
        }
        row += esc(this.ch[i]);
      }
      if (open) row += '</span>';
      rows.push(row);
    }
    return rows.join('\n');
  }

  text() {
    const rows = [];
    for (let y = 0; y < this.h; y++) rows.push(this.ch.slice(y * this.w, (y + 1) * this.w).join('').trimEnd());
    return rows.join('\n');
  }
}

// ------------------------------------------------------------ primitives

/** An ellipsoid (or part of one: polar angles from `top` to `bottom`, 0 = straight up). */
function ellipsoid(g, T, [rx, ry, rz], step, { top = 0, bottom = Math.PI, glow = 0, inside = false } = {}) {
  const big = Math.max(rx, ry, rz);
  const rings = Math.max(4, Math.ceil(((bottom - top) * big) / step));
  for (let i = 0; i <= rings; i++) {
    const th = top + ((bottom - top) * i) / rings;
    const st = Math.sin(th);
    const ct = Math.cos(th);
    const around = Math.max(6, Math.ceil((2 * Math.PI * big * st) / step));
    for (let j = 0; j < around; j++) {
      const ph = (2 * Math.PI * j) / around;
      const p = [rx * st * Math.cos(ph), ry * ct, rz * st * Math.sin(ph)];
      let n = norm([p[0] / (rx * rx), p[1] / (ry * ry), p[2] / (rz * rz)]);
      if (inside) n = [-n[0], -n[1], -n[2]];
      g.dot(ap(T, p), apM(T.m, n), glow);
    }
  }
}

/** A cylinder from a to b (in T's space), radius r, with flat ends unless `open`. */
function cylinder(g, T, a, b, r, step, { open = false } = {}) {
  const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...axis) || 1e-6;
  const w = axis.map((v) => v / len);
  const u = norm(Math.abs(w[1]) < 0.9 ? [w[2], 0, -w[0]] : [0, -w[2], w[1]]);
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const around = Math.max(6, Math.ceil((2 * Math.PI * r) / step));
  const along = Math.max(1, Math.ceil(len / step));
  for (let j = 0; j < around; j++) {
    const ph = (2 * Math.PI * j) / around;
    const n = [u[0] * Math.cos(ph) + v[0] * Math.sin(ph), u[1] * Math.cos(ph) + v[1] * Math.sin(ph), u[2] * Math.cos(ph) + v[2] * Math.sin(ph)];
    for (let i = 0; i <= along; i++) {
      const k = i / along;
      g.dot(ap(T, [a[0] + axis[0] * k + n[0] * r, a[1] + axis[1] * k + n[1] * r, a[2] + axis[2] * k + n[2] * r]), apM(T.m, n));
    }
    if (!open) {
      for (let rr = 0; rr < r; rr += step) {
        g.dot(ap(T, [b[0] + n[0] * rr, b[1] + n[1] * rr, b[2] + n[2] * rr]), apM(T.m, w));
        g.dot(ap(T, [a[0] + n[0] * rr, a[1] + n[1] * rr, a[2] + n[2] * rr]), apM(T.m, [-w[0], -w[1], -w[2]]));
      }
    }
  }
}

/** A ring lying flat (in the x-z plane of T), big radius R, tube radius r. */
function torus(g, T, R, r, step, { from = 0, to = 2 * Math.PI, glow = 0 } = {}) {
  const around = Math.max(8, Math.ceil(((to - from) * R) / step));
  const tube = Math.max(5, Math.ceil((2 * Math.PI * r) / step));
  for (let i = 0; i <= around; i++) {
    const a = from + ((to - from) * i) / around;
    for (let j = 0; j < tube; j++) {
      const b = (2 * Math.PI * j) / tube;
      const n = [Math.cos(b) * Math.cos(a), Math.sin(b), Math.cos(b) * Math.sin(a)];
      g.dot(ap(T, [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), (R + r * Math.cos(b)) * Math.sin(a)]), apM(T.m, n), glow);
    }
  }
}

// ---------------------------------------------------------------- the crew

/** The figure's grid: 20 columns by 13 rows, feet on the bottom row. */
export const FIGURE_W = 24;
export const FIGURE_H = 18;
const STEP = 0.03;

function hat(g, T, kind) {
  const s = STEP;
  if (kind === 'toque') {
    cylinder(g, T, [0, 2.02, 0], [0, 2.26, 0], 0.27, s);
    ellipsoid(g, then(T, move(0, 2.36, 0)), [0.36, 0.17, 0.36], s);
  } else if (kind === 'tall') {
    cylinder(g, T, [0, 2.02, 0], [0, 2.52, 0], 0.23, s);
    ellipsoid(g, then(T, move(0, 2.58, 0)), [0.3, 0.12, 0.3], s);
  } else if (kind === 'puff') {
    ellipsoid(g, then(T, move(0, 2.24, 0)), [0.42, 0.26, 0.42], s);
  } else if (kind === 'bandana') {
    ellipsoid(g, then(T, move(0, 1.98, 0)), [0.33, 0.17, 0.33], s, { bottom: Math.PI / 2 });
    ellipsoid(g, then(T, move(0.05, 1.98, 0.33)), [0.09, 0.08, 0.09], s);
  } else if (kind === 'cap') {
    ellipsoid(g, then(T, move(0, 1.98, 0)), [0.32, 0.2, 0.32], s, { bottom: Math.PI / 2 });
    ellipsoid(g, then(T, move(0, 2.0, -0.34)), [0.22, 0.03, 0.18], s);
  } else {
    // beanie, with a bobble on top
    ellipsoid(g, then(T, move(0, 1.97, 0)), [0.32, 0.26, 0.32], s, { bottom: Math.PI / 2 });
    ellipsoid(g, then(T, move(0, 2.27, 0)), [0.09, 0.09, 0.09], s);
  }
}

/** What the right hand holds, at the end of the arm (local: the hand is at the origin). */
function tool(g, T, kind) {
  const s = STEP * 0.8;
  if (kind === 'knife') {
    cylinder(g, T, [0, 0.02, 0], [0, -0.14, 0], 0.035, s); // handle
    const was = g.material;
    g.material = 'blade';
    ellipsoid(g, then(T, move(0, -0.34, -0.03)), [0.025, 0.2, 0.08], s);
    g.material = was;
  } else if (kind === '#') ellipsoid(g, then(T, move(0, -0.12, -0.05)), [0.16, 0.2, 0.03], s); // clipboard
  else if (kind === 'U') {
    cylinder(g, T, [0, 0, 0], [0, -0.05, -0.22], 0.03, s);
    ellipsoid(g, then(T, move(0, -0.08, -0.38)), [0.2, 0.04, 0.2], s); // pan
  } else {
    cylinder(g, T, [0, 0.02, 0], [0, -0.32, 0], 0.03, s); // handle
    const head = kind === 'Y' ? [0.08, 0.13, 0.08] : kind === '*' ? [0.07, 0.11, 0.07] : [0.11, 0.06, 0.11];
    ellipsoid(g, then(T, move(0, -0.38, 0)), head, s);
  }
}

/** One arm, hanging from the shoulder: `raise` lifts it out sideways, `swing` brings it forward. */
function arm(g, T, side, raise, swing, holding) {
  const A = chain(T, move(side * 0.4, 1.2, 0), rot('z', side * raise), rot('x', -swing));
  g.material = 'coat';
  cylinder(g, A, [0, 0, 0], [0, -0.48, 0], 0.09, STEP);
  g.material = 'skin';
  ellipsoid(g, then(A, move(0, -0.52, 0)), [0.11, 0.11, 0.11], STEP);
  g.material = 'tool';
  if (holding) tool(g, then(A, move(0, -0.52, 0)), holding);
}

/**
 * Draw one cook. `look` comes from ascii.js (hat, head, tool); `pose` says how it stands:
 *   yaw, headYaw, headPitch, bob (up/down), lean (forward), armL/armR [raise, swing], step (walking),
 *   eyes ('o' open, '-' shut, '^' happy), holding (the tool, or nothing).
 */
export function drawFigure(g, look, pose) {
  g.clear();
  // A positive yaw turns the face to the right of the screen (towards +x): the rotation is the other way round.
  const T = chain(move(0, pose.bob ?? 0, 0), rot('y', -(pose.yaw ?? 0)));
  // Legs: from the hips, swinging opposite each other when walking.
  for (const side of [-1, 1]) {
    const L = chain(T, move(side * 0.17, 0.62, 0), rot('x', side * (pose.step ?? 0)));
    g.material = 'legs';
    cylinder(g, L, [0, 0, 0], [0, -0.56, 0], 0.11, STEP);
    g.material = 'shoes';
    ellipsoid(g, then(L, move(0, -0.58, -0.06)), [0.13, 0.06, 0.18], STEP);
  }
  const U = chain(T, move(0, 0.62, 0), rot('x', pose.lean ?? 0), move(0, -0.62, 0));
  // Body: a round coat.
  g.material = 'coat';
  ellipsoid(g, then(U, move(0, 0.95, 0)), [0.42, 0.4, 0.32], STEP);
  const [lr, ls] = pose.armL ?? [0.18, 0];
  const [rr, rs] = pose.armR ?? [0.18, 0];
  arm(g, U, -1, lr, ls, null);
  arm(g, U, 1, rr, rs, pose.holding ?? null);
  // At the station: a cutting board on the counter in front, with the pieces chopped so far.
  if (pose.board != null) {
    g.material = 'board';
    ellipsoid(g, then(T, move(0, 0.66, -0.62)), [0.46, 0.035, 0.22], STEP);
    g.material = 'veg';
    ellipsoid(g, then(T, move(-0.3, 0.74, -0.66)), [0.1, 0.07, 0.07], STEP); // what is left to chop
    for (let k = 0; k < pose.board; k++) ellipsoid(g, then(T, move(0.02 + (k % 4) * 0.09, 0.71, -0.58 - Math.floor(k / 4) * 0.08)), [0.035, 0.03, 0.035], STEP);
  }
  // Carrying the chopped food to the pot in a bowl, held in both hands; tipped forward to pour it in.
  if (pose.bowl) {
    const B = chain(U, move(0, pose.bowl.y ?? 1.0, -0.56), rot('x', pose.bowl.tilt ?? 0));
    g.material = 'bowl';
    ellipsoid(g, B, [0.26, 0.15, 0.2], STEP, { top: Math.PI / 2 });
    if (!pose.bowl.empty) {
      g.material = 'veg';
      for (let k = 0; k < 4; k++) ellipsoid(g, then(B, move(-0.12 + k * 0.08, 0.02, (k % 2) * 0.05 - 0.02)), [0.045, 0.04, 0.045], STEP);
    }
  }
  // Head, hat and face, turned a little further than the body when looking at something.
  // The head is big, the way small figures read best; the hat sits on it (shifted down to fit).
  const H = chain(U, move(0, 1.32, 0), rot('y', -(pose.headYaw ?? 0)), rot('x', pose.headPitch ?? 0), move(0, -1.32, 0));
  const head = look.head === 'square' ? [0.43, 0.39, 0.39] : look.head === 'angle' ? [0.38, 0.43, 0.38] : [0.41, 0.41, 0.41];
  g.material = 'skin';
  ellipsoid(g, then(H, move(0, 1.68, 0)), head, STEP);
  g.material = 'hat';
  hat(g, then(H, move(0, 0.02, 0)), look.hat);
  g.material = 'eye';
  const eye = pose.eyes ?? 'o';
  for (const side of [-1, 1]) g.mark(ap(H, [side * 0.15, 1.72, -0.38]), eye, 0.04);
  g.mark(ap(H, [0, 1.55, -0.4]), eye === '^' ? 'v' : eye === '-' ? '~' : '-', 0.04);
}

// ---------------------------------------------------------------- the kadhai

export const POT_W = 58;
export const POT_H = 23;

/**
 * The kadhai: a deep round pan with a rolled rim and two loop handles, on a flame.
 * `spin` turns it; `t` (seconds) moves the oil, the bubbles, the steam and the fire while cooking.
 */
export function drawKadhai(g, { spin, t, cooking, splash = 0 }) {
  g.clear();
  const T = rot('y', spin);
  const s = 0.05;
  const R = 1.55; // radius of the bowl's sphere
  const rim = 0.56 * Math.PI; // where the bowl stops
  const rimY = Math.cos(rim) * 0.95;
  const rimR = Math.sin(rim) * R;
  // The bowl: outside, and the inside seen over the rim.
  g.material = 'iron';
  ellipsoid(g, T, [R, 0.95, R], s, { top: rim, bottom: Math.PI, glow: cooking ? 0.12 : 0 });
  g.material = 'inside';
  ellipsoid(g, T, [R * 0.97, 0.92, R * 0.97], s, { top: rim, bottom: Math.PI, inside: true, glow: -0.3 });
  g.material = 'oil';
  // Oil (or whatever is cooking): a surface inside, rippling while the crew works.
  const oilY = -0.3;
  const oilR = Math.sqrt(Math.max(0, 1 - (oilY / 0.92) ** 2)) * R * 0.97;
  for (let r = 0; r < oilR; r += s * 0.9) {
    const around = Math.max(6, Math.ceil((2 * Math.PI * r) / s));
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around;
      const wave = cooking ? 0.18 * Math.sin(r * 7 - t * 5 + a * 2) : 0;
      const ripple = cooking ? Math.sin(r * 9 - t * 6 + a * 3) : Math.sin(r * 9 + a * 3) * 0.3;
      g.dot(ap(T, [r * Math.cos(a), oilY, r * Math.sin(a)]), norm([wave * Math.cos(a), 1, wave * Math.sin(a)]), 0, ripple > 0.55 ? '~' : ripple < -0.7 ? '.' : '-');
    }
  }
  // The rolled rim and the handles.
  g.material = 'rim';
  torus(g, then(T, move(0, rimY, 0)), rimR, 0.08, s, { glow: 0.35 });
  for (const side of [-1, 1]) {
    const Hd = chain(T, move(side * (rimR + 0.04), rimY + 0.02, 0), rot('z', side * 0.25));
    torus(g, then(Hd, rot('y', side > 0 ? 0 : Math.PI)), 0.24, 0.05, s, { from: -Math.PI / 2, to: Math.PI / 2 });
  }
  if (cooking) {
    // Bubbles rise in the oil and pop.
    for (let k = 0; k < 9; k++) {
      const life = (t * 0.9 + k * 0.37) % 1;
      const a = k * 2.4 + Math.floor(t * 0.9 + k * 0.37) * 1.7;
      const r = (0.25 + ((k * 0.61) % 0.7)) * oilR;
      g.mark(ap(T, [r * Math.cos(a), oilY + 0.03, r * Math.sin(a)]), life < 0.45 ? 'o' : life < 0.75 ? 'O' : '.', 0.2, 'bubble');
    }
    // Something was just tipped in (splash 0..1): a ring of drops spreads out and falls back.
    if (splash > 0 && splash < 1) {
      const ring = 0.2 + splash * 0.9;
      const lift = Math.sin(Math.PI * splash) * 0.35;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        g.mark(ap(T, [ring * Math.cos(a), oilY + lift, ring * Math.sin(a) * 0.9]), splash < 0.5 ? '*' : "'", 0.6, 'bubble');
      }
      g.mark(ap(T, [0, oilY + 0.05, 0]), 'O', 0.6, 'veg');
    }
  }
  const top = g.project([0, rimY, 0]);
  // The fire and the stove go under the lowest row the pan reaches on screen.
  let lowest = 0;
  for (let i = g.ch.length - 1; i >= 0; i--) {
    if (g.ch[i] !== ' ') {
      lowest = Math.floor(i / g.w);
      break;
    }
  }
  const row = Math.min(g.h - 1, lowest + 3);
  const mid = Math.round(g.w / 2);
  g.put(mid - 16, row, '_[=============================]_', 'stove');
  if (cooking) {
    const shift = Math.floor(t * 6) % 3;
    g.put(mid - 12, row - 1, '(  )  ( ) (  ) (  ) ( ) ( '.slice(shift, shift + 24), 'fire');
    g.put(mid - 10, row - 2, ' ) ( ) ) ( ( ) ( ) ) ('.slice(shift, shift + 20), 'flame');
  } else g.put(mid - 4, row - 1, '. . . .', 'stove');
  // Steam above the rim, drifting up while it cooks.
  if (cooking && top) {
    for (let k = 0; k < 7; k++) {
      const p = (t * 0.6 + k / 7) % 1;
      const y = top.y - 2 - Math.floor(p * 5);
      const x = Math.round(g.w / 2 + (k - 3) * 4 + Math.sin(t * 2 + k) * 2);
      if (y >= 0) g.put(x, y, p < 0.5 ? '(' : p < 0.8 ? '~' : '.', 'steam');
      if (y >= 0) g.put(x + 1, y, p < 0.5 ? ')' : '', 'steam');
    }
  }
}
