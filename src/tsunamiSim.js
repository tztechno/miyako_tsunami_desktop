/**
 * 2D Shallow Water / Local Inertial Tsunami Inundation Simulator
 * Physics: Bates et al. (2010) semi-implicit local inertial formulation
 * + Seawall overtopping barrier mechanics + Plateau 3D buildings obstacle mask.
 */

import { WaveProfile } from './waveProfile.js';
export { WaveProfile };

/**
 * Offshore boundary water level (m) at time t (s): for hasPreDrawdown a drawdown, the main
 * crest, then follow-on waves at 55 % height repeating every period; otherwise one solitary wave.
 */
export function offshoreWaveEta(t, { waveHeight, wavePeriod, hasPreDrawdown }) {
  if (t < 0) return 0.0;
  const omega = (2 * Math.PI) / (wavePeriod || 720);
  if (hasPreDrawdown) {
    const phase = omega * t;
    if (phase < Math.PI * 0.5) return -Math.sin(phase * 2) * (waveHeight * 0.15); // initial drawdown
    if (phase < Math.PI * 2.5) {
      const eta = Math.sin(phase - Math.PI * 0.5) * waveHeight; // main crest
      return eta < 0 ? eta * 0.4 : eta;
    }
    return Math.sin(phase - Math.PI * 2.5) * (waveHeight * 0.55); // follow-on waves
  }
  const u = (t - (wavePeriod || 720) * 0.4) / ((wavePeriod || 720) * 0.2);
  const sech = 1 / Math.cosh(Math.max(-10, Math.min(10, u)));
  return waveHeight * sech * sech;
}

/**
 * Wave source of a region: where a wave from offshore enters it. Scene coordinates are m from the region
 * centre (x east, z south).
 *   center:      centre of the source zone
 *   edges:       inflow edges
 *   walls:       closed edges (no flux). Other sea edges are held at still water, so water flows out freely.
 *   directionDeg: bearing the wave comes from at those edges for CSV scenarios (null = the CSV's own direction)
 *   via:         where a wave from east of the region passes on its way in (null = straight to the nearest edge)
 *
 * Taro faces the open Pacific on the east, north and south.
 * Miyako Port: Miyako Bay opens only to the north. The sea along the east edge is the outer coast of the Omoe
 * Peninsula and the south edge cuts through the inner bay, so a wave from offshore reaches the port only
 * around the north tip of the peninsula (at the region's NE corner) and through the bay mouth. The east edge
 * is a wall; the inner bay stays open (2011 CSV vs the 89 surveyed heights: RMSE 5.4 m open, 10.5 m as a wall).
 */
export function regionSource(meta) {
  const halfW = (meta.nx * meta.res) / 2;
  const halfH = (meta.ny * meta.res) / 2;
  if (meta.name === 'miyako_port') {
    return { center: { x: 1450, z: -1750 }, edges: ['north'], walls: ['east'], directionDeg: 50, via: { x: halfW + 1000, z: -halfH - 750 } };
  }
  return { center: { x: halfW - 250, z: 0 }, edges: ['east', 'north', 'south'], walls: [], directionDeg: null, via: null };
}

/** Centre of the wave source zone (see regionSource). */
export function sourceZoneCenter(meta) {
  return regionSource(meta).center;
}

/** Edges where the offshore wave enters the region (see regionSource). */
export function inflowEdges(meta) {
  return regionSource(meta).edges;
}

/**
 * Route (scene x/z points) from an offshore point such as a CSV location to where its wave enters the region,
 * and its length (m): through regionSource().via to the edge next to the source zone, or straight to the
 * nearest edge.
 */
export function entryPath(meta, x, z) {
  const halfW = (meta.nx * meta.res) / 2;
  const halfH = (meta.ny * meta.res) / 2;
  const src = regionSource(meta);
  const pts = [{ x, z }];
  if (src.via) {
    if (x > halfW) pts.push(src.via);
    pts.push({ x: src.center.x, z: -halfH });
  } else {
    pts.push({ x: Math.max(-halfW, Math.min(halfW, x)), z: Math.max(-halfH, Math.min(halfH, z)) });
  }
  let length = 0;
  for (let k = 1; k < pts.length; k++) length += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  return { pts, length };
}

/**
 * Open-sea boundary cells (inflowEdges: east columns, north/south rows), their arrival delays and forcing weights, and the
 * representative depth of the forced edge. directionDeg is the bearing the wave comes FROM (90 = east).
 * sourceWidthM limits the forcing to boundary cells within ±width/2 of the source zone centre, measured along
 * the wave crest. The source zone is where a wave from a distant earthquake enters the region, not the
 * epicentre, so the wave has the same height across the whole width. Cells outside stay at still water.
 * null = no limit (the whole boundary).
 * depth is the inflow-weighted mean depth Σh²/Σh of the forced cells (deep cells carry most of the inflow).
 */
export function openBoundary(meta, ground, directionDeg, sourceWidthM, maxSeaDepth) {
  const { nx, ny, res } = meta;
  const edges = inflowEdges(meta);
  const cells = [];
  if (edges.includes('east')) {
    for (let y = 0; y < ny; y++) {
      if (ground[y * nx + nx - 1] < 0) cells.push(y * nx + nx - 1);
      if (ground[y * nx + nx - 2] < -5) cells.push(y * nx + nx - 2);
    }
  }
  // without the east edge, the north/south rows run to the corner
  const xEnd = edges.includes('east') ? nx - 2 : nx;
  for (let x = 0; x < xEnd; x++) {
    if (edges.includes('north') && ground[x] < -5) cells.push(x);
    if (edges.includes('south') && ground[(ny - 1) * nx + x] < -5) cells.push((ny - 1) * nx + x);
  }
  const th = (directionDeg * Math.PI) / 180;
  const kE = -Math.sin(th); // propagation direction (east, north components)
  const kN = -Math.cos(th);
  const s = cells.map((i) => (i % nx) * res * kE - Math.floor(i / nx) * res * kN);
  const sMin = Math.min(...s);
  const c = Math.sqrt(9.80665 * Math.max(5, maxSeaDepth || 20));
  const delay = Float32Array.from(s, (v) => (v - sMin) / c);

  let weight;
  if (!(sourceWidthM > 0)) {
    weight = new Float32Array(cells.length).fill(1);
  } else {
    const ctr = sourceZoneCenter(meta);
    const cE = (nx * res) / 2 + ctr.x;
    const cN = -((ny * res) / 2 + ctr.z);
    const half = sourceWidthM / 2;
    weight = Float32Array.from(cells, (i) => {
      // distance from the centre line along the crest (perpendicular to the propagation direction)
      const dE = ((i % nx) + 0.5) * res - cE;
      const dN = -(Math.floor(i / nx) + 0.5) * res - cN;
      return Math.abs(dE * Math.cos(th) - dN * Math.sin(th)) <= half ? 1 : 0;
    });
  }

  let h1 = 0, h2 = 0;
  cells.forEach((i, k) => {
    const h = -ground[i];
    if (weight[k] > 0 && h > 0) {
      h1 += h;
      h2 += h * h;
    }
  });
  return { cells: Int32Array.from(cells), delay, weight, depth: h1 > 0 ? h2 / h1 : 0 };
}

/**
 * Green's law amplitude factor for a wave recorded at sourceDepth (the CSV point) and fed in at edgeDepth:
 * (h_source / h_edge)^(1/4). 1 when either depth is unknown.
 */
export function shoalingFactor(sourceDepth, edgeDepth) {
  return sourceDepth > 0 && edgeDepth > 0 ? (sourceDepth / edgeDepth) ** 0.25 : 1;
}

/**
 * Simulated max water level (m) to compare with a surveyed 2011 height at grid cell `cell`. When that cell
 * stayed dry, the highest level among wet cells within `radius` cells (default 3 = 15 m) is used: survey marks
 * are often on building walls (buildings are solid in the model, so their cells never get wet) or at the very
 * edge of the water. NaN when no water came within the radius.
 */
export function surveyWaterLevel(ground, maxDepth, nx, ny, cell, radius = 3) {
  const wet = (i) => ground[i] < 0 || maxDepth[i] >= 0.05;
  if (wet(cell)) return ground[cell] + maxDepth[cell];
  const cx = cell % nx, cy = (cell - cx) / nx;
  let best = NaN;
  for (let y = Math.max(0, cy - radius); y <= Math.min(ny - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(nx - 1, cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const i = y * nx + x;
      if (wet(i) && !(ground[i] + maxDepth[i] <= best)) best = ground[i] + maxDepth[i];
    }
  }
  return best;
}

/**
 * Does a 2011 survey point agree with today's terrain (DEM5A)? Comparing at points where the ground has
 * changed since (cut / fill, reconstruction) or where the mark's position is off is meaningless.
 *   I (inundation height): the ground must be below the measured water level.
 *   R (run-up height = ground level where the water stopped): the ground must be within ±3 m of it.
 * groundZ is the DEM elevation at the point's cell.
 */
export function surveyFitsTerrain(point, groundZ) {
  return point.type === 'R' ? Math.abs(groundZ - point.h) <= 3 : groundZ < point.h;
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
    // Closed edges (regionSource); an inflow east edge is two columns wide
    this.eastOpen = inflowEdges(meta).includes('east');
    this.walls = regionSource(meta).walls;

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

    // Still-water level (T.P. m) the tsunami rides on, e.g. high tide; the boundary wave is added on top
    this.tideLevel = 0;

    // Initial state: sea cells at the tide level, land cells depth = 0
    this.initWater();

    // Time & Controls
    this.simTimeSec = 0;
    this.isRunning = false;
    this.speedMultiplier = 1.0;
    this.manningN = 0.025; // coastal/urban friction

    // Wave parameters (default: 2011 Tohoku recorded)
    this.waveProfile = null; // CsvWaveProfile instance if driven by CSV wave source
    this.waveHeight = 8.0;
    this.wavePeriod = 720;
    this.waveDirectionDeg = 90; // 90 = from East
    this.hasPreDrawdown = true;

    // Stats
    this.stats = {
      simTimeSec: 0,
      simTimeMin: 0,
      offshoreWaveHeight: 0,
      coastalWaveHeight: 0,
      waveFrontDistM: 0,
      waveStatus: 'approaching',
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

  initCoastline() {
    const { nx, ny, ground } = this;
    let sumX = 0, count = 0;
    for (let y = 0; y < ny; y++) {
      for (let x = nx - 1; x >= 0; x--) {
        if (ground[y * nx + x] >= 0) {
          sumX += x;
          count++;
          break;
        }
      }
    }
    this.coastCellX = count > 0 ? Math.round(sumX / count) : Math.round(nx * 0.25);
    const coastalCells = [];
    for (let y = Math.floor(ny * 0.3); y <= Math.floor(ny * 0.7); y++) {
      const gx = Math.min(nx - 1, this.coastCellX + 15);
      if (ground[y * nx + gx] < 0) {
        coastalCells.push(y * nx + gx);
      }
    }
    this.coastalCells = coastalCells;
  }

  initWater() {
    const tide = this.tideLevel;
    this.maxSeaDepth = 0;
    this.hMax = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.ground[i] < 0) this.maxSeaDepth = Math.max(this.maxSeaDepth, -this.ground[i]);
      const zb = this.ground[i];
      if (zb < 0) {
        // Sea: flat at the tide level
        this.eta[i] = tide;
        this.depth[i] = Math.max(0, tide - zb);
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
    if (tide > 0) this.floodTide(tide);
  }

  /**
   * Land below the tide level that the sea reaches without crossing a seawall above the tide starts under water
   * (flat at the tide level, already inundated at 0 s), so the run does not open with the sea pouring onto it.
   */
  floodTide(tide) {
    const { nx, ny, ground, N } = this;
    const { barrierGrid, barrierActive } = this.seawalls;
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    for (let i = 0; i < N; i++) if (ground[i] < 0) queue[tail++] = i;
    const visit = (j) => {
      if (ground[j] < 0 || ground[j] >= tide || this.depth[j] > 0) return;
      if (barrierActive[j] && barrierGrid[j] >= tide) return;
      this.eta[j] = tide;
      this.depth[j] = this.maxDepth[j] = tide - ground[j];
      if (this.depth[j] >= 0.3) this.arrival[j] = 0;
      queue[tail++] = j;
    };
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (i >= nx) visit(i - nx);
      if (i < (ny - 1) * nx) visit(i + nx);
    }
  }

  /** Still-water level (T.P. m) under the tsunami, e.g. high tide. Restarts the run. */
  setTide(level) {
    this.tideLevel = Math.max(0, level || 0);
    this.reset();
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
    this.waveProfile = scenario.waveProfile || null;
    this.profileScale = 1;
    this.waveHeight = scenario.waveHeight;
    this.wavePeriod = scenario.periodSec;
    this.waveDirectionDeg = scenario.directionDeg;
    this.hasPreDrawdown = !!scenario.hasPreDrawdown;
    this.setupBoundary();
    this.reset();
  }

  setWaveProfile(profile) {
    this.waveProfile = profile;
    this.profileScale = 1;
    if (profile) {
      this.waveHeight = profile.peakHeight;
      this.waveDirectionDeg = profile.dominantDirectionDeg != null ? profile.dominantDirectionDeg : 90;
    }
    this.setupBoundary();
    this.reset();
  }

  clearWaveProfile() {
    this.waveProfile = null;
  }

  /**
   * Slider changes. With a CSV profile the waveform is kept: profileScale (or height / CSV peak) multiplies it,
   * direction only turns the incoming plane wave.
   */
  setCustomWave({ height, period, direction, profileScale, sourceWidthM }) {
    if (sourceWidthM !== undefined) {
      this.sourceWidthM = sourceWidthM;
      this.setupBoundary();
    }
    if (height !== undefined) {
      this.waveHeight = height;
      if (this.waveProfile && this.waveProfile.peakHeight > 0) this.profileScale = height / this.waveProfile.peakHeight;
    }
    if (profileScale !== undefined) this.profileScale = profileScale;
    if (period !== undefined) this.wavePeriod = period;
    if (direction !== undefined) {
      this.waveDirectionDeg = direction;
      this.setupBoundary();
    }
  }

  /**
   * Injects an artificial wave pulse at an arbitrary sea location (worldX, worldZ)
   * with optional directional momentum. Allows user to trigger artificial waves
   * anywhere in the bay or ocean.
   */
  injectPulseWave({ worldX, worldZ, height = 4.0, radius = 180, directionDeg = null }) {
    const { nx, ny, res, ground } = this;
    const cx = Math.floor(worldX / res);
    const cz = Math.floor(worldZ / res);
    const rCells = Math.ceil(radius / res);

    const x0 = Math.max(1, cx - rCells);
    const x1 = Math.min(nx - 2, cx + rCells);
    const z0 = Math.max(1, cz - rCells);
    const z1 = Math.min(ny - 2, cz + rCells);

    let kE = 0;
    let kN = 0;
    if (directionDeg != null) {
      const rad = (directionDeg * Math.PI) / 180;
      kE = -Math.sin(rad);
      kN = -Math.cos(rad);
    }

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const idx = z * nx + x;
        if (ground[idx] >= 0) continue; // Only on water
        const dist = Math.hypot((x - cx) * res, (z - cz) * res);
        if (dist > radius) continue;

        // Smooth cosine bell pulse
        const pulse = height * Math.cos((dist / radius) * (Math.PI * 0.5));
        if (pulse <= 0) continue;

        this.eta[idx] += pulse;
        this.depth[idx] = Math.max(0, this.eta[idx] - ground[idx]);
        if (this.depth[idx] > this.maxDepth[idx]) {
          this.maxDepth[idx] = this.depth[idx];
        }

        // Add momentum flux if directional
        if (directionDeg != null && this.depth[idx] > 0.1) {
          const c = Math.sqrt(9.80665 * this.depth[idx]);
          this.qx[idx] += pulse * c * kE;
          this.qy[idx] += pulse * c * kN;
        }
      }
    }
    this.updateStats();
  }

  /** Boundary cells for the current direction / source width, and the CSV shoaling factor for that edge. */
  setupBoundary() {
    const b = openBoundary(this.meta, this.ground, this.waveDirectionDeg, this.sourceWidthM, this.maxSeaDepth);
    this.bcCells = b.cells;
    this.bcDelay = b.delay;
    this.bcWeight = b.weight;
    this.bcDepth = b.depth;
    this.shoalFactor = this.waveProfile ? shoalingFactor(this.waveProfile.sourceDepth, b.depth) : 1;
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
    if (this.waveProfile) {
      // CSV level × Green's law correction from the CSV point to this edge × the user's multiplier
      return this.waveProfile.getEta(t) * (this.shoalFactor ?? 1) * (this.profileScale ?? 1);
    }
    return offshoreWaveEta(t, this);
  }

  /** Stable timestep from the CFL condition of the local inertial scheme (Bates et al. 2010). */
  stableDt() {
    const hMax = Math.max(1, this.hMax || 0, this.maxSeaDepth + this.tideLevel + Math.abs(this.waveHeight));
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
    const { bcCells, bcDelay, bcWeight } = this;
    for (let k = 0; k < bcCells.length; k++) {
      const idx = bcCells[k];
      const e = this.tideLevel + bcWeight[k] * this.getOffshoreWaveEta(this.simTimeSec - bcDelay[k]);
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

    // 3a. Closed edges (see regionSource)
    for (const wall of this.walls) {
      if (wall === 'east') for (let y = 0; y < ny; y++) this.qx[y * nx + nx - 2] = 0;
      else if (wall === 'north') for (let x = 0; x < nx; x++) this.qy[x] = 0;
      else for (let x = 0; x < nx; x++) this.qy[(ny - 2) * nx + x] = 0;
    }

    // 3b. Positivity limiter: a cell may not discharge more water than it holds in one step.
    // Without this, over-draining produces negative depths that get clamped to 0 (mass creation)
    // and grows into unphysical spikes of tens of metres.
    const scale = this.outScale;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const fixed = x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || (this.eastOpen && x >= nx - 2 && this.ground[i] < -5);
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
        if (this.eastOpen && x >= nx - 2 && this.ground[i] < -5) continue;

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
    this.stats.simTimeSec = this.simTimeSec;
    this.stats.simTimeMin = (this.simTimeSec / 60).toFixed(1);

    if (this.coastCellX === undefined) this.initCoastline();

    // 1. Coastal wave height (in the bay fronting the seawall)
    let coastalEta = 0;
    if (this.coastalCells && this.coastalCells.length > 0) {
      let sum = 0;
      for (let k = 0; k < this.coastalCells.length; k++) {
        sum += this.eta[this.coastalCells[k]];
      }
      coastalEta = sum / this.coastalCells.length - this.tideLevel;
    }
    this.stats.coastalWaveHeight = coastalEta;

    // 2. Wave front distance from coast
    const { nx, ny, res, eta, ground, coastCellX } = this;
    if (this.stats.inundatedAreaHa > 0.05) {
      this.stats.waveFrontDistM = 0;
      this.stats.waveStatus = 'landfall';
    } else {
      let minWaveX = nx - 1;
      // Scan sea cells (|eta| >= 0.25m or flow)
      const stepY = 3;
      for (let y = Math.floor(ny * 0.2); y < Math.floor(ny * 0.8); y += stepY) {
        for (let x = coastCellX; x < nx - 2; x++) {
          const idx = y * nx + x;
          if (ground[idx] < 0 && Math.abs(eta[idx] - this.tideLevel) >= 0.25) {
            if (x < minWaveX) minWaveX = x;
            break;
          }
        }
      }
      if (minWaveX <= coastCellX + 1) {
        this.stats.waveFrontDistM = 0;
        this.stats.waveStatus = 'landfall';
      } else if (minWaveX >= nx - 4) {
        this.stats.waveFrontDistM = Math.max(0, (nx - 1 - coastCellX) * res);
        this.stats.waveStatus = 'approaching';
      } else {
        this.stats.waveFrontDistM = Math.max(0, (minWaveX - coastCellX) * res);
        this.stats.waveStatus = 'approaching';
      }
    }

    // Count inundated buildings (> 0.5m water)
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
