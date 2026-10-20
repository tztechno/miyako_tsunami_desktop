/**
 * 2D Shallow Water / Local Inertial Tsunami Inundation Simulator
 * Physics: Bates et al. (2010) semi-implicit local inertial formulation
 * + Seawall overtopping barrier mechanics + Plateau 3D buildings obstacle mask.
 */

/**
 * Offshore boundary water level (m) at time t (s): for hasPreDrawdown a drawdown, the main
 * crest, then follow-on waves at 55 % height repeating every period; otherwise one solitary wave.
 */
export function offshoreWaveEta(t, { waveHeight, wavePeriod, hasPreDrawdown }) {
  if (t < 0) return 0.0;
  const omega = (2 * Math.PI) / wavePeriod;
  if (hasPreDrawdown) {
    const phase = omega * t;
    if (phase < Math.PI * 0.5) return -Math.sin(phase * 2) * (waveHeight * 0.15); // initial drawdown
    if (phase < Math.PI * 2.5) {
      const eta = Math.sin(phase - Math.PI * 0.5) * waveHeight; // main crest
      return eta < 0 ? eta * 0.4 : eta;
    }
    return Math.sin(phase - Math.PI * 2.5) * (waveHeight * 0.55); // follow-on waves
  }
  const u = (t - wavePeriod * 0.4) / (wavePeriod * 0.2);
  const sech = 1 / Math.cosh(Math.max(-10, Math.min(10, u)));
  return waveHeight * sech * sech;
}

export class TsunamiSimulator {
  constructor({ meta, ground, seawallManager, buildings = [] }) {
    this.meta = meta;
    this.nx = meta.nx;
    this.ny = meta.ny;
    this.res = meta.res;
    this.ground = ground; // Float32Array (elevation z_b)
    this.seawalls = seawallManager;
    this.buildings = buildings;

    const N = this.nx * this.ny;
    this.N = N;

    // Simulation fields
    this.eta = new Float32Array(N); // Water surface elevation (m)
    this.depth = new Float32Array(N); // Water depth h (m)
    this.maxDepth = new Float32Array(N); // Cumulative peak depth (m)
    this.arrival = new Float32Array(N); // First time (s) a land cell reaches 0.3 m depth; -1 = never
    this.qx = new Float32Array(N); // Unit discharge x (m2/s)
    this.qy = new Float32Array(N); // Unit discharge y (m2/s)
    this.outScale = new Float32Array(N); // Positivity limiter scratch
    this.qxPrev = new Float32Array(N); // Previous-step fluxes for θ-weighting
    this.qyPrev = new Float32Array(N);

    // Mask for building obstacles
    this.bldgMask = new Uint8Array(N);
    this.initBuildingMask();

    // Initial state: sea cells have eta = 0.0 (sea level), land cells depth = 0
    this.initWater();

    // Time & Controls
    this.simTimeSec = 0;
    this.isRunning = false;
    this.speedMultiplier = 1.0;
    this.manningN = 0.025; // coastal/urban friction

    // Wave parameters (default: 2011 Tohoku recorded)
    this.waveHeight = 8.0;
    this.wavePeriod = 720;
    this.waveDirectionDeg = 90; // 90 = from East
    this.hasPreDrawdown = true;

    // Stats
    this.stats = {
      simTimeMin: 0,
      offshoreWaveHeight: 0,
      maxRunup: 0,
      inundatedAreaHa: 0,
      inundatedBuildings: 0,
      isOvertopping: false,
      overtoppingCount: 0,
    };

    // Time series logs for CSV export
    this.history = [];
    this.lastLogSec = -100;
  }

  initWater() {
    this.maxSeaDepth = 0;
    this.hMax = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.ground[i] < 0) this.maxSeaDepth = Math.max(this.maxSeaDepth, -this.ground[i]);
      const zb = this.ground[i];
      if (zb < 0) {
        // Sea: flat at 0m sea level
        this.eta[i] = 0.0;
        this.depth[i] = Math.max(0, -zb);
      } else {
        // Dry land
        this.eta[i] = zb;
        this.depth[i] = 0;
      }
      this.maxDepth[i] = this.depth[i];
      this.arrival[i] = -1;
      this.qx[i] = 0;
      this.qy[i] = 0;
    }
  }

  initBuildingMask() {
    const { res } = this.meta;
    for (const b of this.buildings) {
      const gx0 = Math.max(0, Math.floor((b.x - b.w / 2) / res));
      const gx1 = Math.min(this.nx - 1, Math.ceil((b.x + b.w / 2) / res));
      const gz0 = Math.max(0, Math.floor((b.z - b.d / 2) / res));
      const gz1 = Math.min(this.ny - 1, Math.ceil((b.z + b.d / 2) / res));
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          this.bldgMask[gz * this.nx + gx] = 1;
        }
      }
    }
  }

  setScenario(scenario) {
    this.waveHeight = scenario.waveHeight;
    this.wavePeriod = scenario.periodSec;
    this.waveDirectionDeg = scenario.directionDeg;
    this.hasPreDrawdown = !!scenario.hasPreDrawdown;
    this.setupBoundary();
    this.reset();
  }

  setCustomWave({ height, period, direction }) {
    if (height !== undefined) this.waveHeight = height;
    if (period !== undefined) this.wavePeriod = period;
    if (direction !== undefined) {
      this.waveDirectionDeg = direction;
      this.setupBoundary();
    }
  }

  /**
   * Open-sea boundary cells (east columns, north/south rows) and their arrival delays.
   * waveDirectionDeg is the bearing the wave comes FROM (90 = east, 110 = east-southeast).
   */
  setupBoundary() {
    const { nx, ny, res, ground } = this;
    const cells = [];
    for (let y = 0; y < ny; y++) {
      if (ground[y * nx + nx - 1] < 0) cells.push(y * nx + nx - 1);
      if (ground[y * nx + nx - 2] < -5) cells.push(y * nx + nx - 2);
    }
    for (let x = 0; x < nx - 2; x++) {
      if (ground[x] < -5) cells.push(x);
      if (ground[(ny - 1) * nx + x] < -5) cells.push((ny - 1) * nx + x);
    }
    const th = (this.waveDirectionDeg * Math.PI) / 180;
    const kE = -Math.sin(th); // propagation direction (east, north components)
    const kN = -Math.cos(th);
    const s = cells.map((i) => (i % nx) * res * kE - Math.floor(i / nx) * res * kN);
    const sMin = Math.min(...s);
    const c = Math.sqrt(9.80665 * Math.max(5, this.maxSeaDepth || 20));
    this.bcCells = Int32Array.from(cells);
    this.bcDelay = Float32Array.from(s, (v) => (v - sMin) / c);
  }

  reset() {
    this.simTimeSec = 0;
    this.history = [];
    this.lastLogSec = -100;
    this.initWater();
    this.updateStats();
  }

  /** Current offshore tsunami boundary wave elevation (m) */
  getOffshoreWaveEta(t) {
    return offshoreWaveEta(t, this);
  }

  /** Stable timestep from the CFL condition of the local inertial scheme (Bates et al. 2010). */
  stableDt() {
    const hMax = Math.max(1, this.hMax || 0, this.maxSeaDepth + Math.abs(this.waveHeight));
    return Math.min(1.0, (0.6 * this.res) / Math.sqrt(9.80665 * hMax));
  }

  /** Advance the simulation by `simSeconds`, sub-stepping at the stable timestep. */
  advance(simSeconds) {
    let remaining = simSeconds;
    while (remaining > 1e-6) {
      const dt = Math.min(remaining, this.stableDt());
      this.step(dt);
      remaining -= dt;
    }
  }

  /** Run physics step (dt seconds). dt must satisfy stableDt(). */
  step(dt) {
    const { nx, ny, res } = this;
    const g = 9.80665;
    const n2 = this.manningN * this.manningN;
    const etaOffshore = this.getOffshoreWaveEta(this.simTimeSec);
    this.stats.offshoreWaveHeight = etaOffshore;

    const barrierGrid = this.seawalls.barrierGrid;
    const barrierActive = this.seawalls.barrierActive;

    let overtoppingCount = 0;

    // 1. Boundary Condition: plane wave entering through the open-sea edges.
    // Each boundary cell sees the offshore signal delayed by the travel time of an
    // obliquely incident wave front, so the wave direction is honoured.
    if (!this.bcCells) this.setupBoundary();
    const { bcCells, bcDelay } = this;
    for (let k = 0; k < bcCells.length; k++) {
      const idx = bcCells[k];
      const e = this.getOffshoreWaveEta(this.simTimeSec - bcDelay[k]);
      this.eta[idx] = Math.max(this.ground[idx], e);
      this.depth[idx] = Math.max(0, this.eta[idx] - this.ground[idx]);
    }

    const THETA = 0.7;
    const qxPrev = this.qxPrev;
    const qyPrev = this.qyPrev;
    qxPrev.set(this.qx);
    qyPrev.set(this.qy);

    // 2. Flux Updates: qx (East-West)
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i0 = y * nx + x;
        const i1 = y * nx + (x + 1);

        // Building wall obstacle
        if (this.bldgMask[i0] && this.bldgMask[i1]) {
          this.qx[i0] = 0;
          continue;
        }

        const eta0 = this.eta[i0];
        const eta1 = this.eta[i1];
        const zb0 = this.ground[i0];
        const zb1 = this.ground[i1];

        // Effective sill elevation
        let zSill = Math.max(zb0, zb1);

        // Seawall check
        const hasBarrier = barrierActive[i0] || barrierActive[i1];
        if (hasBarrier) {
          const bH = Math.max(barrierGrid[i0], barrierGrid[i1]);
          if (bH > zSill) {
            zSill = bH;
            // Check if overtopping
            if (Math.max(eta0, eta1) > bH) {
              overtoppingCount++;
            } else {
              // Completely blocked
              this.qx[i0] = 0;
              continue;
            }
          }
        }

        const hFlow = Math.max(0, Math.max(eta0, eta1) - zSill);
        if (hFlow < 0.005) {
          this.qx[i0] = 0;
          continue;
        }

        // Water surface gradient
        const dh_dx = (eta1 - eta0) / res;
        const qOld = qxPrev[i0];
        // θ-weighted flux (de Almeida et al. 2012) damps the checkerboard instability in deep water
        const qL = x > 0 ? qxPrev[i0 - 1] : qOld;
        const qR = x < nx - 2 ? qxPrev[i0 + 1] : qOld;
        const qTheta = THETA * qOld + (1 - THETA) * 0.5 * (qL + qR);

        // Semi-implicit local inertial update
        const denom = 1 + (g * dt * n2 * Math.abs(qOld)) / (hFlow * hFlow * Math.cbrt(hFlow));
        let qNew = (qTheta - g * hFlow * dt * dh_dx) / denom;

        // Froude limit / CFL limiter
        const maxQ = hFlow * Math.sqrt(g * hFlow) * 1.5;
        qNew = Math.max(-maxQ, Math.min(maxQ, qNew));

        this.qx[i0] = qNew;
      }
    }

    // 3. Flux Updates: qy (North-South)
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx; x++) {
        const i0 = y * nx + x;
        const i1 = (y + 1) * nx + x;

        if (this.bldgMask[i0] && this.bldgMask[i1]) {
          this.qy[i0] = 0;
          continue;
        }

        const eta0 = this.eta[i0];
        const eta1 = this.eta[i1];
        const zb0 = this.ground[i0];
        const zb1 = this.ground[i1];

        let zSill = Math.max(zb0, zb1);

        const hasBarrier = barrierActive[i0] || barrierActive[i1];
        if (hasBarrier) {
          const bH = Math.max(barrierGrid[i0], barrierGrid[i1]);
          if (bH > zSill) {
            zSill = bH;
            if (Math.max(eta0, eta1) > bH) {
              overtoppingCount++;
            } else {
              this.qy[i0] = 0;
              continue;
            }
          }
        }

        const hFlow = Math.max(0, Math.max(eta0, eta1) - zSill);
        if (hFlow < 0.005) {
          this.qy[i0] = 0;
          continue;
        }

        const dh_dy = (eta1 - eta0) / res;
        const qOld = qyPrev[i0];
        const qU = y > 0 ? qyPrev[i0 - nx] : qOld;
        const qD = y < ny - 2 ? qyPrev[i0 + nx] : qOld;
        const qTheta = THETA * qOld + (1 - THETA) * 0.5 * (qU + qD);
        const denom = 1 + (g * dt * n2 * Math.abs(qOld)) / (hFlow * hFlow * Math.cbrt(hFlow));
        let qNew = (qTheta - g * hFlow * dt * dh_dy) / denom;

        const maxQ = hFlow * Math.sqrt(g * hFlow) * 1.5;
        qNew = Math.max(-maxQ, Math.min(maxQ, qNew));

        this.qy[i0] = qNew;
      }
    }

    // 3b. Positivity limiter: a cell may not discharge more water than it holds in one step.
    // Without this, over-draining produces negative depths that get clamped to 0 (mass creation)
    // and grows into unphysical spikes of tens of metres.
    const scale = this.outScale;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const fixed = x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || (x >= nx - 2 && this.ground[i] < -5);
        if (fixed) { scale[i] = 1; continue; }
        let out = 0;
        if (x < nx - 1 && this.qx[i] > 0) out += this.qx[i];
        if (x > 0 && this.qx[i - 1] < 0) out -= this.qx[i - 1];
        if (y < ny - 1 && this.qy[i] > 0) out += this.qy[i];
        if (y > 0 && this.qy[i - nx] < 0) out -= this.qy[i - nx];
        const outVol = (out * dt) / res;
        scale[i] = outVol > this.depth[i] ? this.depth[i] / outVol : 1;
      }
    }
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const i = y * nx + x;
        const q = this.qx[i];
        if (q !== 0) this.qx[i] = q * (q > 0 ? scale[i] : scale[i + 1]);
      }
    }
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const q = this.qy[i];
        if (q !== 0) this.qy[i] = q * (q > 0 ? scale[i] : scale[i + nx]);
      }
    }

    // 4. Continuity Equation (Depth update)
    let maxRunupElev = 0;
    let inunAreaCount = 0;
    let hMax = 0;

    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x;

        // Skip fixed eastern ocean boundary cells
        if (x >= nx - 2 && this.ground[i] < -5) continue;

        const qx_in = this.qx[y * nx + (x - 1)];
        const qx_out = this.qx[i];
        const qy_in = this.qy[(y - 1) * nx + x];
        const qy_out = this.qy[i];

        const netFlux = (qx_in - qx_out + qy_in - qy_out) / res;
        let newDepth = this.depth[i] + netFlux * dt;
        if (newDepth < 0.001) newDepth = 0;

        this.depth[i] = newDepth;
        this.eta[i] = this.ground[i] + newDepth;

        if (newDepth > hMax) hMax = newDepth;
        if (newDepth >= 0.3 && this.arrival[i] < 0 && this.ground[i] >= 0) this.arrival[i] = this.simTimeSec + dt;
        if (newDepth > this.maxDepth[i]) {
          this.maxDepth[i] = newDepth;
        }

        // Metrics on land
        if (this.ground[i] >= 0 && newDepth > 0.2) {
          inunAreaCount++;
          if (this.eta[i] > maxRunupElev) {
            maxRunupElev = this.eta[i];
          }
        }
      }
    }

    this.hMax = hMax;
    this.simTimeSec += dt;
    this.stats.overtoppingCount = overtoppingCount;
    this.stats.isOvertopping = overtoppingCount > 0;
    this.stats.inundatedAreaHa = (inunAreaCount * res * res) / 10000;
    this.stats.maxRunup = Math.max(this.stats.maxRunup, maxRunupElev);

    // Periodically log for CSV
    if (this.simTimeSec - this.lastLogSec >= 10.0) {
      this.lastLogSec = this.simTimeSec;
      this.logSnapshot();
    }
  }

  updateStats() {
    this.stats.simTimeMin = (this.simTimeSec / 60).toFixed(1);
    // Count inundated buildings (> 0.5m water)
    const { res } = this.meta;
    let bldCount = 0;
    for (const b of this.buildings) {
      const gx = Math.floor(b.x / res);
      const gz = Math.floor(b.z / res);
      if (gx >= 0 && gx < this.nx && gz >= 0 && gz < this.ny) {
        if (this.depth[gz * this.nx + gx] >= 0.5) {
          bldCount++;
        }
      }
    }
    this.stats.inundatedBuildings = bldCount;
  }

  logSnapshot() {
    this.updateStats();
    this.history.push({
      timeSec: Math.round(this.simTimeSec),
      timeMin: (this.simTimeSec / 60).toFixed(1),
      offshoreWaveM: this.stats.offshoreWaveHeight.toFixed(2),
      maxRunupM: this.stats.maxRunup.toFixed(2),
      inundatedAreaHa: this.stats.inundatedAreaHa.toFixed(1),
      inundatedBuildings: this.stats.inundatedBuildings,
      isOvertopping: this.stats.isOvertopping ? 'YES' : 'NO',
      overtoppingCount: this.stats.overtoppingCount,
    });
  }

  getPointDepth(worldX, worldZ) {
    const { res } = this.meta;
    const gx = Math.floor(worldX / res);
    const gz = Math.floor(worldZ / res);
    if (gx < 0 || gx >= this.nx || gz < 0 || gz >= this.ny) return null;
    const idx = gz * this.nx + gx;
    return {
      gx,
      gz,
      elevation: this.ground[idx],
      waterDepth: this.depth[idx],
      maxDepth: this.maxDepth[idx],
      waterEta: this.eta[idx],
    };
  }

  generateCSV() {
    const headers = [
      'Time (sec)',
      'Time (min)',
      'Offshore Tsunami Wave (m)',
      'Max Run-up Elevation (TP+m)',
      'Inundated Area (ha)',
      'Inundated Buildings (count)',
      'Seawall Overtopping',
      'Overtopping Cell Count',
    ];
    const rows = this.history.map(h => [
      h.timeSec,
      h.timeMin,
      h.offshoreWaveM,
      h.maxRunupM,
      h.inundatedAreaHa,
      h.inundatedBuildings,
      h.isOvertopping,
      h.overtoppingCount,
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    return csvContent;
  }
}
