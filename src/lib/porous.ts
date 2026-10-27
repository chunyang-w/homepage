// Drainage in a 2D porous medium, and a small neural network that learns to predict it.
//
// Physics: polydisperse grains on a grid, with a non-wetting fluid invading from the left by
// invasion percolation. The fluid always enters the widest open pore next, so it pauses at
// narrow throats and bursts through pore bodies.
//
// Learning: the network sees only local, current information about each patch of pore space
// on the fluid front, and learns from snapshots of one simulated rock which patches fill next.
// On a new rock it rolls the flow forward on its own, ranking the front at every step.

export const SCALE = 2; // grid cells per CSS pixel
export const INLET = 7 * SCALE; // open reservoir on the left face
export const B = 4; // the network works on B×B-cell patches

export type Rock = { W: number; H: number; solid: Uint8Array; rad: Float32Array; pores: number };
type Grain = { x: number; y: number; r: number };

export function rng(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Heap {
  keys: number[] = []; vals: number[] = [];
  get size() { return this.keys.length; }
  push(k: number, v: number) {
    const K = this.keys, V = this.vals; K.push(k); V.push(v);
    let i = K.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] >= K[i]) break; [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p; }
  }
  peek() { return this.keys[0]; }
  pop() {
    const K = this.keys, V = this.vals, top = V[0], lk = K.pop()!, lv = V.pop()!;
    if (K.length) {
      K[0] = lk; V[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < K.length && K[l] > K[m]) m = l;
        if (r < K.length && K[r] > K[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m;
      }
    }
    return top;
  }
}

// Grains that never touch, then the signed distance to the nearest grain surface.
// The distance field is computed per grain over its own bounding box, which is far cheaper
// than querying neighbours for every cell.
export function makeRock(W: number, H: number, seed: number): Rock {
  const rand = rng(seed);
  const cell = 36, cols = Math.ceil(W / cell) + 2, rows = Math.ceil(H / cell) + 2;
  const buckets: Grain[][] = Array.from({ length: cols * rows }, () => []);
  const bi = (x: number, y: number) => (Math.floor(y / cell) + 1) * cols + Math.floor(x / cell) + 1;
  const grains: Grain[] = [];
  for (let i = 0; i < 60000; i++) {
    const r = 8 + Math.pow(rand(), 1.5) * 26;
    const x = rand() * W, y = -8 + rand() * (H + 16);
    const loose = 0.5 + 0.5 * Math.sin(x / 140 + seed) * Math.cos(y / 50);
    const gap = 3.5 + Math.pow(rand(), 3) * 22 + loose * 7;
    let ok = true;
    const b = bi(x, y);
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) {
      const k = b + dy * cols + dx; if (k < 0 || k >= buckets.length) continue;
      for (const g of buckets[k]) if (Math.hypot(g.x - x, g.y - y) < g.r + r + gap) { ok = false; break; }
    }
    if (ok) { const g = { x, y, r }; buckets[b].push(g); grains.push(g); }
  }
  const rad = new Float32Array(W * H).fill(40); // pores farther than this from a grain are rare
  const REACH = 40;
  for (const g of grains) {
    const x0 = Math.max(0, Math.floor(g.x - g.r - REACH)), x1 = Math.min(W - 1, Math.ceil(g.x + g.r + REACH));
    const y0 = Math.max(0, Math.floor(g.y - g.r - REACH)), y1 = Math.min(H - 1, Math.ceil(g.y + g.r + REACH));
    for (let y = y0; y <= y1; y++) {
      const dy = y - g.y, row = y * W;
      for (let x = x0; x <= x1; x++) {
        const e = Math.sqrt((x - g.x) * (x - g.x) + dy * dy) - g.r;
        if (e < rad[row + x]) rad[row + x] = e;
      }
    }
  }
  const solid = new Uint8Array(W * H);
  let pores = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x < INLET) rad[i] = Math.max(rad[i], INLET - x + 1);
    if (rad[i] <= 0) solid[i] = 1; else if (x >= INLET) pores++;
  }
  return { W, H, solid, rad, pores };
}

function neighbours(i: number, W: number, N: number, out: number[]) {
  out.length = 0;
  const x = i % W;
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  if (i >= W) out.push(i - W);
  if (i + W < N) out.push(i + W);
  return out;
}

// Invasion percolation, the ground truth. `state`: 0 water, 1 grain, 2 fluid.
// `time[i]` is the step at which cell i filled.
export function simulator(rock: Rock) {
  const { W, H, solid, rad } = rock, N = W * H;
  const state = new Uint8Array(N), time = new Int32Array(N).fill(-1), queued = new Uint8Array(N);
  const heap = new Heap(), nb: number[] = [];
  for (let i = 0; i < N; i++) if (solid[i]) state[i] = 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < INLET; x++) { const i = y * W + x; if (!solid[i]) { state[i] = 2; time[i] = 0; queued[i] = 1; } }
  for (let y = 0; y < H; y++) for (const j of neighbours(y * W + INLET - 1, W, N, nb)) if (!state[j] && !queued[j]) { queued[j] = 1; heap.push(rad[j], j); }
  let pressure = 0, frame = 0, breakthrough = false, tail = 0;
  const invade = (i: number) => {
    state[i] = 2; time[i] = frame;
    if (i % W === W - 1) breakthrough = true;
    for (const j of neighbours(i, W, N, nb)) if (!state[j] && !queued[j]) { queued[j] = 1; heap.push(rad[j], j); }
  };
  function step(): boolean {
    frame++;
    if (breakthrough) {
      if (tail++ >= 24) return false;
      let n = 0; while (heap.size && 1 / heap.peek() <= pressure && n++ < 40) invade(heap.pop());
      return true;
    }
    if (!heap.size) return false;
    let n = 0;
    while (heap.size && 1 / heap.peek() <= pressure && n < 190) { invade(heap.pop()); n++; }
    if (n === 0) pressure += Math.max(0.0025, (1 / heap.peek() - pressure) * 0.1);
    return true;
  }
  return { state, time, step, get frame() { return frame; } };
}

export function saturation(rock: Rock, state: Uint8Array) {
  let n = 0;
  for (let i = 0; i < state.length; i++) if (state[i] === 2 && i % rock.W >= INLET) n++;
  return n / rock.pores;
}

// ---- Patches -------------------------------------------------------------------------------

type Patches = { bw: number; bh: number; size: Float32Array; pore: Uint8Array; map: Int32Array };
function patchesOf(rock: Rock): Patches {
  const bw = Math.ceil(rock.W / B), bh = Math.ceil(rock.H / B);
  const size = new Float32Array(bw * bh), pore = new Uint8Array(bw * bh), map = new Int32Array(rock.W * rock.H);
  for (let y = 0; y < rock.H; y++) for (let x = 0; x < rock.W; x++) {
    const i = y * rock.W + x, b = ((y / B) | 0) * bw + ((x / B) | 0);
    map[i] = b;
    if (!rock.solid[i]) { pore[b] = 1; size[b] = Math.max(size[b], rock.rad[i]); }
  }
  return { bw, bh, size, pore, map };
}

export const FEATURES = ['Pore size', 'Relative size', 'Wet sides', 'Wet nearby', 'Just filled'];
export const NF = FEATURES.length;

function features(p: Patches, wet: (b: number) => boolean, fresh: (b: number) => boolean, b: number, frontMax: number, out: Float32Array, o: number) {
  const { bw, bh, size } = p, x = b % bw, y = (b / bw) | 0;
  let n4 = 0, n8 = 0, f8 = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
    const j = yy * bw + xx;
    if (wet(j)) { n8++; if (!dx || !dy) n4++; if (fresh(j)) f8++; }
  }
  const r = Math.min(size[b], 18);
  out[o] = r / 18; out[o + 1] = r / Math.max(frontMax, 1); out[o + 2] = n4 / 4; out[o + 3] = n8 / 8; out[o + 4] = Math.min(f8, 3) / 3;
}

function frontOf(p: Patches, wet: (b: number) => boolean) {
  const { bw, bh, pore, size } = p, front: number[] = [];
  let frontMax = 0;
  for (let b = 0; b < bw * bh; b++) {
    if (!pore[b] || wet(b)) continue;
    const x = b % bw, y = (b / bw) | 0;
    if ((x > 0 && wet(b - 1)) || (x < bw - 1 && wet(b + 1)) || (y > 0 && wet(b - bw)) || (y < bh - 1 && wet(b + bw))) {
      front.push(b); frontMax = Math.max(frontMax, size[b]);
    }
  }
  return { front, frontMax };
}

// ---- Training data -------------------------------------------------------------------------

export type Dataset = { X: Float32Array; Y: Uint8Array; rate: number };

// Simulate drainage in a training rock and turn snapshots into (features, fills next) pairs.
// A generator, so the caller can spread the work over frames; it yields progress in [0, 1].
export function* datasetSteps(rock: Rock, seed: number): Generator<number, Dataset> {
  const sim = simulator(rock);
  while (sim.step()) if (sim.frame % 60 === 0) yield Math.min(0.45, sim.frame / 1200);
  yield 0.45;
  const p = patchesOf(rock), bt = new Float64Array(p.bw * p.bh);
  const lists: number[][] = Array.from({ length: bt.length }, () => []);
  for (let i = 0; i < rock.W * rock.H; i++) if (!rock.solid[i]) lists[p.map[i]].push(sim.time[i] < 0 ? Infinity : sim.time[i]);
  lists.forEach((l, b) => { bt[b] = l.length ? l.sort((a, c) => a - c)[Math.ceil(l.length / 2) - 1] : Infinity; });

  const rand = rng(seed + 7);
  const pos: Float32Array[] = [], neg: Float32Array[] = [];
  for (let t = 0; t < sim.frame - 1; t += 2) {
    if (t % 24 === 0) yield 0.5 + (0.5 * t) / sim.frame;
    const wet = (b: number) => bt[b] <= t, fresh = (b: number) => bt[b] === t;
    const { front, frontMax } = frontOf(p, wet);
    for (const b of front) {
      const f = new Float32Array(NF);
      features(p, wet, fresh, b, frontMax, f, 0);
      (bt[b] <= t + 1 ? pos : neg).push(f);
    }
  }
  const shuffle = <T>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const P = shuffle(pos).slice(0, 2500), Nn = shuffle(neg).slice(0, P.length * 2);
  const rows = shuffle([...P.map((f) => [f, 1] as const), ...Nn.map((f) => [f, 0] as const)]);
  const X = new Float32Array(rows.length * NF), Y = new Uint8Array(rows.length);
  rows.forEach(([f, y], s) => { X.set(f, s * NF); Y[s] = y; });
  let filled = 0;
  for (let b = 0; b < bt.length; b++) if (bt[b] > 0 && bt[b] < Infinity) filled++;
  return { X, Y, rate: filled / sim.frame };
}

export function dataset(rock: Rock, seed: number): Dataset {
  const it = datasetSteps(rock, seed);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// ---- The network ---------------------------------------------------------------------------

export const HIDDEN = 10;

// A two-layer perceptron, NF → HIDDEN (tanh) → 1 (sigmoid), trained by Adam on mini-batches.
export function network(seed: number) {
  const rand = rng(seed);
  const n = NF * HIDDEN + HIDDEN + HIDDEN + 1;
  const W1 = 0, B1 = NF * HIDDEN, W2 = B1 + HIDDEN, B2 = W2 + HIDDEN;
  const w = new Float32Array(n).map(() => (rand() - 0.5) * 1.2);
  w[B2] = 0;
  const m = new Float32Array(n), v = new Float32Array(n), g = new Float32Array(n), h = new Float32Array(HIDDEN);
  let t = 0;

  function forward(x: Float32Array, o: number) {
    let z = w[B2];
    for (let k = 0; k < HIDDEN; k++) {
      let a = w[B1 + k];
      for (let f = 0; f < NF; f++) a += w[W1 + k * NF + f] * x[o + f];
      h[k] = Math.tanh(a); z += w[W2 + k] * h[k];
    }
    return 1 / (1 + Math.exp(-z));
  }

  // One pass over the data in mini-batches. Returns the mean loss over the pass.
  function epoch(X: Float32Array, Y: Uint8Array, batch = 256, lr = 0.004) {
    const count = Y.length;
    let total = 0;
    for (let s0 = 0; s0 < count; s0 += batch) {
      const s1 = Math.min(count, s0 + batch), bs = s1 - s0;
      g.fill(0);
      for (let s = s0; s < s1; s++) {
        const p = forward(X, s * NF), y = Y[s];
        total -= y ? Math.log(p + 1e-7) : Math.log(1 - p + 1e-7);
        const dz = (p - y) / bs;
        g[B2] += dz;
        for (let k = 0; k < HIDDEN; k++) {
          g[W2 + k] += dz * h[k];
          const da = dz * w[W2 + k] * (1 - h[k] * h[k]);
          g[B1 + k] += da;
          for (let f = 0; f < NF; f++) g[W1 + k * NF + f] += da * X[s * NF + f];
        }
      }
      t++;
      const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      for (let q = 0; q < n; q++) {
        m[q] = 0.9 * m[q] + 0.1 * g[q]; v[q] = 0.999 * v[q] + 0.001 * g[q] * g[q];
        w[q] -= (lr * (m[q] / c1)) / (Math.sqrt(v[q] / c2) + 1e-8);
      }
    }
    return total / count;
  }

  // Mean loss without updating weights, for held-out data.
  function loss(X: Float32Array, Y: Uint8Array) {
    let total = 0;
    for (let s = 0; s < Y.length; s++) { const p = forward(X, s * NF); total -= Y[s] ? Math.log(p + 1e-7) : Math.log(1 - p + 1e-7); }
    return total / Y.length;
  }

  // Weight accessors for drawing the network.
  const inWeight = (f: number, k: number) => w[W1 + k * NF + f];
  const outWeight = (k: number) => w[W2 + k];
  return { forward, epoch, loss, inWeight, outWeight };
}
export type Network = ReturnType<typeof network>;

// ---- Prediction ----------------------------------------------------------------------------

// Roll the flow forward with the network alone: each step it scores every patch on the front,
// and the highest-scoring patches fill, at the rate learned from the training rock.
export function rollout(rock: Rock, net: Network, rate: number) {
  const { W, H, solid } = rock, p = patchesOf(rock), N = W * H;
  const wetP = new Uint8Array(p.bw * p.bh), age = new Int32Array(p.bw * p.bh).fill(-1);
  for (let b = 0; b < wetP.length; b++) if ((b % p.bw) * B < INLET && p.pore[b]) { wetP[b] = 1; age[b] = 0; }
  const state = new Uint8Array(N);
  for (let i = 0; i < N; i++) state[i] = solid[i] ? 1 : wetP[p.map[i]] || i % W < INLET ? 2 : 0;
  const wet = (b: number) => wetP[b] === 1;
  let t = 0, budget = 0;
  const fresh = (b: number) => age[b] === t, x = new Float32Array(NF);
  // Cells of each patch, so a filled patch repaints only its own cells.
  const cells: number[][] = Array.from({ length: wetP.length }, () => []);
  for (let i = 0; i < N; i++) if (!solid[i]) cells[p.map[i]].push(i);
  function step() {
    const { front, frontMax } = frontOf(p, wet);
    budget += rate;
    const k = Math.min(Math.floor(budget), front.length);
    budget -= k;
    if (k === 0) { t++; return; }
    const score = new Float32Array(front.length);
    front.forEach((b, j) => { features(p, wet, fresh, b, frontMax, x, 0); score[j] = net.forward(x, 0); });
    const order = Array.from(front.keys()).sort((a, c) => score[c] - score[a]);
    t++;
    for (let j = 0; j < k; j++) {
      const b = front[order[j]];
      wetP[b] = 1; age[b] = t;
      for (const i of cells[b]) state[i] = 2;
    }
  }
  return { state, step };
}
