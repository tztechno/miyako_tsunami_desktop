/**
 * Keyframes of the running simulation for the 2 m detail tile (src/tile/), as in osaka_tsunami: the worker posts
 * the water level in cm on the render grid every 30 simulated seconds while the run goes on. Here the run is
 * live (computed while it plays), so `end` is the length the user asked for and `done` turns true when the run
 * reaches it.
 */
export class Timeline {
  constructor({ meta, ground, renderStep }) {
    const step = renderStep;
    this.wnx = Math.floor(meta.nx / step);
    this.wny = Math.floor(meta.ny / step);
    // ground under each render vertex (same sampling as the worker's keyframes)
    this.ground = new Float32Array(this.wnx * this.wny);
    for (let j = 0; j < this.wny; j++) {
      const sy = Math.min(meta.ny - 1, j * step);
      for (let i = 0; i < this.wnx; i++) this.ground[j * this.wnx + i] = ground[sy * meta.nx + Math.min(meta.nx - 1, i * step)];
    }
    this.step = step;
    this.end = 0;
    this.clear();
  }

  clear() {
    this.frames = [];
    this.done = false;
  }

  get start() {
    return this.frames.length ? this.frames[0].t : 0;
  }

  /** Last simulated time with a keyframe. */
  get computedTo() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  get progress() {
    if (this.done) return 1;
    if (!this.frames.length || this.end <= this.start) return 0;
    return Math.min(1, (this.computedTo - this.start) / (this.end - this.start));
  }

  /** Index of the last keyframe at or before t. */
  indexAt(t) {
    const f = this.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** A keyframe { t, eta } from the worker; one earlier than the last means the run was reset. */
  add(k) {
    if (this.frames.length && k.t < this.computedTo - 1e-6) this.clear();
    this.frames.push(k);
    if (this.end > 0 && k.t >= this.end - 1e-6) this.done = true;
  }
}
