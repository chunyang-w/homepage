// Drainage in a 2D porous medium: polydisperse grains on a grid, with a non-wetting fluid
// invading from the left by invasion percolation. The fluid always enters the widest open pore
// next, so it pauses at narrow throats and bursts through pore bodies. The neural network that
// learns to predict it lives in learn.ts.

export const SCALE = 2; // grid cells per CSS pixel
export const INLET = 7 * SCALE; // open reservoir on the left face
export const B = 4; // the network works on B×B-cell patches (see learn.ts)

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
  const it = makeRockSteps(W, H, seed);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// The same, as a generator that yields progress in [0, 1], so callers can spread it over frames.
export function* makeRockSteps(W: number, H: number, seed: number): Generator<number, Rock> {
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
    if (i % 15000 === 14999) yield (0.3 * i) / 60000;
  }
  const rad = new Float32Array(W * H).fill(40); // pores farther than this from a grain are rare
  const REACH = 40;
  for (let n = 0; n < grains.length; n++) {
    const g = grains[n];
    if (n % 40 === 39) yield 0.3 + (0.6 * n) / grains.length;
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
