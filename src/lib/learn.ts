// A neural surrogate for drainage, trained on snapshots of the invasion-percolation simulation.
//
// The network scores each patch of pore space on the fluid front from purely local inputs, so a
// patch's score only changes when something nearby changes. That lets the prediction cache scores
// and recompute only around newly filled patches, which keeps a larger network fast.

import { B, INLET, rng, simulator, makeRockSteps, type Rock } from './porous.ts';

// ---- Patches -------------------------------------------------------------------------------

// `throat[4b + side]` is the widest gap the fluid can pass through across that edge of patch b
// (sides: 0 left, 1 right, 2 up, 3 down), measured on the fine grid: the entry criterion that
// invasion percolation actually uses.
export type Patches = { bw: number; bh: number; size: Float32Array; pore: Uint8Array; map: Int32Array; throat: Float32Array };

export function patchesOf(rock: Rock): Patches {
  const bw = Math.ceil(rock.W / B), bh = Math.ceil(rock.H / B);
  const size = new Float32Array(bw * bh), pore = new Uint8Array(bw * bh), map = new Int32Array(rock.W * rock.H);
  for (let y = 0; y < rock.H; y++) for (let x = 0; x < rock.W; x++) {
    const i = y * rock.W + x, b = ((y / B) | 0) * bw + ((x / B) | 0);
    map[i] = b;
    if (!rock.solid[i]) { pore[b] = 1; size[b] = Math.max(size[b], rock.rad[i]); }
  }
  const throat = new Float32Array(bw * bh * 4);
  const { W, H, solid, rad } = rock;
  const gap = (i: number, j: number) => (solid[i] || solid[j] ? 0 : Math.min(rad[i], rad[j]));
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = by * bw + bx, x0 = bx * B, y0 = by * B;
    let l = 0, r = 0, u = 0, d = 0;
    for (let k = 0; k < B; k++) {
      const y = y0 + k, x = x0 + k;
      if (y < H) {
        if (x0 > 0) l = Math.max(l, gap(y * W + x0, y * W + x0 - 1));
        const xr = x0 + B - 1;
        if (xr + 1 < W) r = Math.max(r, gap(y * W + xr, y * W + xr + 1));
      }
      if (x < W) {
        if (y0 > 0) u = Math.max(u, gap(y0 * W + x, (y0 - 1) * W + x));
        const yd = y0 + B - 1;
        if (yd + 1 < H) d = Math.max(d, gap(yd * W + x, (yd + 1) * W + x));
      }
    }
    throat.set([l, r, u, d], b * 4);
  }
  return { bw, bh, size, pore, map, throat };
}

// ---- Inputs --------------------------------------------------------------------------------

export const FEATURES = [
  'Pore size',
  'Size vs. nearby',
  'Entry throat',
  'Next throat',
  'Wet sides',
  'Wet around',
  'Wet in 5×5',
  'Filled last step',
  'Filled step before',
];
export const NF = FEATURES.length;
const S = 18; // pore sizes are scaled by this

// `age(b)` is the step at which patch b filled (Infinity if dry); `t` is the current step.
function features(p: Patches, age: (b: number) => number, t: number, b: number, out: Float32Array, o: number) {
  const { bw, bh, size, pore, throat } = p, x = b % bw, y = (b / bw) | 0, own = Math.min(size[b], S);
  let localMax = 0, entry = 0, beyond = 0, n4 = 0, n8 = 0, w25 = 0, c25 = 0, f1 = 0, f2 = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
    const j = yy * bw + xx;
    if (!pore[j]) continue;
    const sj = Math.min(size[j], S), aj = age(j), wet = aj <= t;
    localMax = Math.max(localMax, sj);
    c25++; if (wet) w25++;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (!dx && !dy)) continue;
    const side = !dx || !dy;
    const edge = dx === -1 ? 0 : dx === 1 ? 1 : dy === -1 ? 2 : 3;
    if (wet) {
      n8++;
      if (side) { n4++; entry = Math.max(entry, Math.min(throat[b * 4 + edge], S)); }
      if (aj === t) f1++; else if (aj === t - 1) f2++;
    } else if (side) beyond = Math.max(beyond, Math.min(throat[b * 4 + edge], S));
  }
  out[o] = own / S;
  out[o + 1] = own / Math.max(localMax, 1);
  out[o + 2] = entry / S;
  out[o + 3] = beyond / S;
  out[o + 4] = n4 / 4;
  out[o + 5] = n8 / 8;
  out[o + 6] = c25 ? w25 / c25 : 0;
  out[o + 7] = Math.min(f1, 3) / 3;
  out[o + 8] = Math.min(f2, 3) / 3;
}

function isFront(p: Patches, wet: (b: number) => boolean, b: number) {
  if (!p.pore[b] || wet(b)) return false;
  const { bw, bh } = p, x = b % bw, y = (b / bw) | 0;
  return (x > 0 && wet(b - 1)) || (x < bw - 1 && wet(b + 1)) || (y > 0 && wet(b - bw)) || (y < bh - 1 && wet(b + bw));
}

// ---- Training data -------------------------------------------------------------------------

export type Dataset = { X: Float32Array; Y: Uint8Array; rate: number; steps: number };

// Simulate drainage in a training rock and turn snapshots into (inputs, fills next) pairs.
// A generator, so the caller can spread the work over frames; it yields progress in [0, 1].
export function* datasetSteps(rock: Rock, seed: number, cap = 4000): Generator<number, Dataset> {
  const sim = simulator(rock);
  while (sim.step()) if (sim.frame % 60 === 0) yield Math.min(0.4, sim.frame / 1500);
  yield 0.4;
  const p = patchesOf(rock), bt = new Float64Array(p.bw * p.bh);
  yield 0.4;
  const lists: number[][] = Array.from({ length: bt.length }, () => []);
  for (let i = 0; i < rock.W * rock.H; i++) if (!rock.solid[i]) lists[p.map[i]].push(sim.time[i] < 0 ? Infinity : sim.time[i]);
  yield 0.4;
  lists.forEach((l, b) => { bt[b] = l.length ? l.sort((a, c) => a - c)[Math.ceil(l.length / 2) - 1] : Infinity; });
  const age = (b: number) => bt[b];

  const rand = rng(seed + 7);
  const pos: Float32Array[] = [], neg: Float32Array[] = [];
  for (let t = 1; t < sim.frame - 1; t += 2) {
    if (t % 25 === 1) yield 0.4 + (0.6 * t) / sim.frame;
    const wet = (b: number) => bt[b] <= t;
    for (let b = 0; b < bt.length; b++) {
      if (!isFront(p, wet, b)) continue;
      const y = bt[b] <= t + 1;
      if (!y && rand() > 0.35) continue; // negatives are plentiful; thin them as we go
      const f = new Float32Array(NF);
      features(p, age, t, b, f, 0);
      (y ? pos : neg).push(f);
    }
  }
  yield 1;
  const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const P = shuffle(pos).slice(0, cap), Nn = shuffle(neg).slice(0, P.length * 2);
  const rows = shuffle([...P.map((f) => [f, 1] as const), ...Nn.map((f) => [f, 0] as const)]);
  const X = new Float32Array(rows.length * NF), Y = new Uint8Array(rows.length);
  rows.forEach(([f, y], s) => { X.set(f, s * NF); Y[s] = y; });
  let filled = 0;
  for (let b = 0; b < bt.length; b++) if (bt[b] > 0 && bt[b] < Infinity) filled++;
  return { X, Y, rate: filled / sim.frame, steps: sim.frame };
}

// Generate a training rock and its dataset, as one sliceable generator.
export function* trainingData(W: number, H: number, rockSeed: number, seed: number): Generator<number, Dataset> {
  const rockGen = makeRockSteps(W, H, rockSeed);
  let r = rockGen.next();
  while (!r.done) { yield 0.2 * r.value; r = rockGen.next(); }
  const dataGen = datasetSteps(r.value, seed);
  let d = dataGen.next();
  while (!d.done) { yield 0.2 + 0.8 * d.value; d = dataGen.next(); }
  return d.value;
}

export function dataset(rock: Rock, seed: number, cap?: number): Dataset {
  const it = datasetSteps(rock, seed, cap);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// ---- The network ---------------------------------------------------------------------------

// A multilayer perceptron with tanh hidden layers and a sigmoid output, trained by Adam.
export function network(layers: number[], seed: number) {
  const rand = rng(seed);
  const L = layers.length - 1;
  const wOff: number[] = [], bOff: number[] = [];
  let n = 0;
  for (let l = 0; l < L; l++) { wOff.push(n); n += layers[l] * layers[l + 1]; bOff.push(n); n += layers[l + 1]; }
  const w = new Float32Array(n);
  for (let l = 0; l < L; l++) { // Xavier-style initialisation
    const s = Math.sqrt(6 / (layers[l] + layers[l + 1]));
    for (let q = 0; q < layers[l] * layers[l + 1]; q++) w[wOff[l] + q] = (rand() * 2 - 1) * s;
  }
  const m = new Float32Array(n), v = new Float32Array(n), g = new Float32Array(n);
  const act = layers.map((k) => new Float32Array(k)), delta = layers.map((k) => new Float32Array(k));
  let step = 0, seen = 0;

  function forward(x: Float32Array, o: number) {
    act[0].set(x.subarray(o, o + layers[0]));
    for (let l = 0; l < L; l++) {
      const nin = layers[l], nout = layers[l + 1], a = act[l], z = act[l + 1];
      for (let k = 0; k < nout; k++) {
        let s = w[bOff[l] + k];
        const row = wOff[l] + k * nin;
        for (let j = 0; j < nin; j++) s += w[row + j] * a[j];
        z[k] = l < L - 1 ? Math.tanh(s) : 1 / (1 + Math.exp(-s));
      }
    }
    return act[L][0];
  }

  function backward(y: number, scale: number) {
    delta[L][0] = (act[L][0] - y) * scale;
    for (let l = L - 1; l >= 0; l--) {
      const nin = layers[l], nout = layers[l + 1], a = act[l], d = delta[l + 1];
      if (l > 0) delta[l].fill(0);
      for (let k = 0; k < nout; k++) {
        const dk = d[k], row = wOff[l] + k * nin;
        g[bOff[l] + k] += dk;
        for (let j = 0; j < nin; j++) {
          g[row + j] += dk * a[j];
          if (l > 0) delta[l][j] += dk * w[row + j];
        }
      }
      if (l > 0) for (let j = 0; j < nin; j++) delta[l][j] *= 1 - a[j] * a[j];
    }
  }

  // Train on one mini-batch. Returns the batch's summed loss.
  function batch(X: Float32Array, Y: Uint8Array, s0: number, s1: number, lr = 0.004) {
    g.fill(0);
    let total = 0;
    for (let s = s0; s < s1; s++) {
      const p = forward(X, s * layers[0]), y = Y[s];
      total -= y ? Math.log(p + 1e-7) : Math.log(1 - p + 1e-7);
      backward(y, 1 / (s1 - s0));
    }
    step++; seen += s1 - s0;
    const c1 = 1 - 0.9 ** step, c2 = 1 - 0.999 ** step;
    for (let q = 0; q < n; q++) {
      m[q] = 0.9 * m[q] + 0.1 * g[q]; v[q] = 0.999 * v[q] + 0.001 * g[q] * g[q];
      w[q] -= (lr * (m[q] / c1)) / (Math.sqrt(v[q] / c2) + 1e-8);
    }
    return total;
  }

  function loss(X: Float32Array, Y: Uint8Array) {
    let total = 0;
    for (let s = 0; s < Y.length; s++) { const p = forward(X, s * layers[0]); total -= Y[s] ? Math.log(p + 1e-7) : Math.log(1 - p + 1e-7); }
    return total / Y.length;
  }

  // weight(l, j, k): from unit j in layer l to unit k in layer l + 1.
  const weight = (l: number, j: number, k: number) => w[wOff[l] + k * layers[l] + j];
  return { layers, forward, batch, loss, weight, params: n, get seen() { return seen; } };
}
export type Network = ReturnType<typeof network>;

// ---- Prediction ----------------------------------------------------------------------------

// Roll the flow forward with the network alone. Each step the highest-scoring patches on the front
// fill, at the rate learned from the training rock. Scores are cached and only recomputed within
// two patches of anything that changed in the last two steps.
export function rollout(rock: Rock, net: Network, rate: number) {
  const { W, H, solid } = rock, p = patchesOf(rock), N = W * H, nb = p.bw * p.bh;
  const age = new Float64Array(nb).fill(Infinity);
  for (let b = 0; b < nb; b++) if ((b % p.bw) * B < INLET && p.pore[b]) age[b] = 0;
  const state = new Uint8Array(N);
  for (let i = 0; i < N; i++) state[i] = solid[i] ? 1 : age[p.map[i]] === 0 || i % W < INLET ? 2 : 0;
  const cells: number[][] = Array.from({ length: nb }, () => []);
  for (let i = 0; i < N; i++) if (!solid[i]) cells[p.map[i]].push(i);

  let t = 0, budget = 0;
  const wetAt = (b: number) => age[b] <= t, ageOf = (b: number) => age[b];
  const score = new Float32Array(nb), inFront = new Uint8Array(nb), dirty = new Uint8Array(nb);
  let front: number[] = [];
  const x = new Float32Array(NF);
  const consider = (b: number) => { if (!inFront[b] && isFront(p, wetAt, b)) { inFront[b] = 1; front.push(b); dirty[b] = 1; } };
  for (let b = 0; b < nb; b++) consider(b);
  let recent: number[] = [], before: number[] = [];

  const touch = (b: number) => {
    const bx = b % p.bw, by = (b / p.bw) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = bx + dx, yy = by + dy;
      if (xx >= 0 && yy >= 0 && xx < p.bw && yy < p.bh) dirty[yy * p.bw + xx] = 1;
    }
  };

  // Fill patches one at a time, like the physics: after each fill, its neighbourhood is rescored
  // at once, so a burst into a pore body can continue within the same step.
  function step() {
    budget += rate;
    let k = Math.floor(budget);
    budget -= k;
    const filled: number[] = [];
    while (k-- > 0) {
      let best = -1, bestScore = -1;
      for (const b of front) {
        if (!inFront[b]) continue;
        if (dirty[b]) { features(p, ageOf, t, b, x, 0); score[b] = net.forward(x, 0); dirty[b] = 0; }
        if (score[b] > bestScore) { bestScore = score[b]; best = b; }
      }
      if (best < 0) break;
      age[best] = t; inFront[best] = 0; filled.push(best);
      for (const i of cells[best]) state[i] = 2;
      const bx = best % p.bw, by = (best / p.bw) | 0;
      if (bx > 0) consider(best - 1); if (bx < p.bw - 1) consider(best + 1);
      if (by > 0) consider(best - p.bw); if (by < p.bh - 1) consider(best + p.bw);
      touch(best);
    }
    front = front.filter((b) => inFront[b]);
    // Freshness changes for anything filled in the last two steps, so their neighbourhoods rescore.
    for (const b of recent) touch(b);
    for (const b of before) touch(b);
    before = recent; recent = filled;
    t++;
  }
  return { state, step };
}

// Fraction of the pore space filled in either state that is filled in both.
export function overlap(rock: Rock, a: Uint8Array, b: Uint8Array) {
  let both = 0, either = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % rock.W < INLET) continue;
    const u = a[i] === 2, v = b[i] === 2;
    if (u && v) both++; if (u || v) either++;
  }
  return either ? both / either : 1;
}
