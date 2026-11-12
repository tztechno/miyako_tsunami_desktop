// The "詳細タイル" panel (from N74 osaka_tsunami): build / pick / delete 2 m tiles, run the nested GPU computation
// alongside the 5 m run, and show its results in step with it (water, flooded buildings, figures).
// Tiles are built from today's data (DEM5A, PLATEAU), so they are used with the 現在 era only.
import { buildTile, placeTile } from './tilebuilder.js';
import { saveTile, getTile, deleteTile, listTiles } from './store.js';
import { loadTile, tileSurface, buildingFloodDepth, tileStats } from './tile.js';
import { TileSim } from './tileSim.js';
import { TileView } from './tileView.js';

const SNAP_BUDGET_BYTES = 400e6; // stored depth snapshots (Uint16 mm per cell) stay under this
const STEP_BUDGET_MS = 14;       // GPU stepping per animation frame

export class TileController {
  /**
   * ctx: { scene, meta, ground, waterMask, seawallMgr, timeline: () => Timeline, lang: () => 'ja' | 'en',
   *        pin: () => pin, startCompute: () => void (start the 5 m run if needed), onUpdate: () => void (redraw),
   *        era: () => 'present' | 'era2011', tide: () => tide level (m) }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.tile = null;
    this.view = null;
    this.surface = null;
    this.run = null;
    this.building = false;
    this.$ = (id) => document.getElementById(id);
    this.$('btn-tile-build').addEventListener('click', () => this.build());
    this.$('select-tile').addEventListener('change', (e) => this.select(e.target.value));
    this.$('btn-tile-delete').addEventListener('click', () => this.remove());
    this.$('btn-tile-run').addEventListener('click', () => this.toggleRun());
    this.refreshList();
    this.updateTexts();
  }

  L(ja, en) { return this.ctx.lang() === 'en' ? en : ja; }

  status(text) { this.$('tile-status').textContent = text; }

  updateTexts() {
    this.$('txt-sec-tile').textContent = this.L('詳細タイル（2m・全建物）', 'Detail Tile (2 m, all buildings)');
    this.$('btn-tile-build').textContent = this.L('ピン位置で作成', 'Build at pin');
    this.$('btn-tile-delete').textContent = this.L('削除', 'Delete');
    this.$('txt-tile-hint').textContent = this.L(
      'ピン（地図のクリックか住所検索）の場所に、1〜3km四方の2mタイルを作ります（スマホでは1kmのみ）。地形・PLATEAU建物・航空写真をネットから取得します。「詳細計算」で、全域（5m）の水位をタイルの外周に与えて2mで計算します。全域の計算がまだなら自動で始め、両方を同時に進めます。地形・防潮堤が「現在」のときだけ使えます。',
      'Builds a 1-3 km square 2 m tile at the pin (map click or address search; 1 km only on phones), with terrain, PLATEAU buildings and aerial photos fetched online. "Detail run" computes the tile at 2 m with the region-wide (5 m) run\'s water level on its edges; the region-wide run is started if needed and both go on together. Only with the "Present" terrain and seawalls.');
    this.updateRunButton();
    const sel = this.$('select-tile');
    if (sel.options[0]) sel.options[0].textContent = this.L('（タイルを表示しない）', '(no tile)');
    this.showFigures();
  }

  updateRunButton() {
    const btn = this.$('btn-tile-run');
    const running = this.run?.status === 'running';
    btn.textContent = running ? this.L('⏸ 詳細計算を中止', '⏸ Stop detail run') : this.L('▶ 詳細計算 (GPU)', '▶ Detail run (GPU)');
    btn.disabled = !this.tile;
  }

  async refreshList(selected = this.tile?.meta.name) {
    const list = await listTiles();
    const sel = this.$('select-tile');
    sel.innerHTML = '';
    sel.append(new Option(this.L('（タイルを表示しない）', '(no tile)'), ''));
    // tiles the user built (all stored tiles) carry a ★, as in nagoya_flood's region list
    for (const m of list.filter((t) => t.region === this.ctx.meta.name)) sel.append(new Option(`★ ${m.label} (${(m.size / 1000).toFixed(0)}km, ${m.buildings.toLocaleString()}${this.L('棟', ' bldgs')})`, m.name));
    sel.value = selected || '';
    this.$('btn-tile-delete').disabled = !sel.options.length || sel.options.length < 2;
  }

  /** Build a tile centred on the pin / area and show it. */
  async build() {
    if (this.building) return;
    if (this.ctx.era() !== 'present') { this.status(this.L('詳細タイルは現在の地形・建物で作るため、地形・防潮堤を「現在」にしてください。', 'Tiles are built from today\'s terrain and buildings: set the terrain and seawalls to "Present".')); return; }
    const pin = this.ctx.pin();
    if (!pin) { this.status(this.L('先に地図をクリックするか住所を検索して、ピンか範囲を置いてください。', 'Place a pin or an area first (click the map or search an address).')); return; }
    const size = +this.$('select-tile-size').value;
    const { meta } = this.ctx;
    if (!placeTile(meta, pin.x, pin.z, size)) { this.status(this.L('この大きさのタイルは計算範囲に収まりません。', 'A tile of this size does not fit in the simulation area.')); return; }
    this.building = true;
    this.$('btn-tile-build').disabled = true;
    try {
      const name = `tile_${Date.now()}`;
      const label = `${pin.title}`.replace(/^岩手県/, '').replace(/^宮古市/, '').slice(0, 28);
      const { meta: tm, files } = await buildTile({
        name, label, worldX: pin.x, worldZ: pin.z, size, res: 2,
        region: { meta, ground: this.ctx.ground, waterMask: this.ctx.waterMask },
      }, (f, ja, en) => this.status(`${this.L(ja, en)} (${Math.round(f * 100)}%)`));
      await saveTile(name, tm, files);
      await this.refreshList(name);
      await this.select(name);
    } catch (e) {
      console.error(e);
      this.status(this.L(`タイルの作成に失敗しました: ${e.message}`, `Tile build failed: ${e.message}`));
    } finally {
      this.building = false;
      this.$('btn-tile-build').disabled = false;
    }
  }

  /** Show a stored tile ('' = none). */
  async select(name) {
    this.armedDelete = null; // a pending delete applies to the tile it was armed for
    this.$('btn-tile-delete').textContent = this.L('削除', 'Delete');
    this.clearRun();
    if (this.view) { this.view.dispose(); this.view = null; }
    this.tile = null;
    this.ctx.scene.setDetailRect(null);
    if (name) {
      const rec = await getTile(name);
      if (rec) {
        const { meta, scene } = this.ctx;
        this.tile = loadTile(rec, meta);
        this.surface = tileSurface(this.tile, this.ctx.seawallMgr, meta);
        this.view = new TileView(scene, this.tile, this.surface);
        const t = this.tile;
        scene.setDetailRect({ x0: t.offX, z0: t.offZ, x1: t.offX + t.widthM, z1: t.offZ + t.heightM });
        const stale = rec.meta.regionBuilt && rec.meta.regionBuilt !== meta.built;
        this.status(this.L(
          `${t.meta.label}: ${(t.widthM / 1000).toFixed(0)}km四方・建物 ${t.buildings.count.toLocaleString()} 棟${stale ? '\n（全域データの更新前に作ったタイルです。作り直しをおすすめします）' : ''}`,
          `${t.meta.label}: ${(t.widthM / 1000).toFixed(0)} km square, ${t.buildings.count.toLocaleString()} buildings${stale ? '\n(built before the city data was updated; rebuilding is recommended)' : ''}`));
      }
    } else this.status('');
    this.$('select-tile').value = this.tile ? name : '';
    this.updateRunButton();
    this.ctx.onUpdate();
  }

  /**
   * Delete the tile chosen in the list. Confirmed inside the panel (the first press arms the button until it is
   * pressed again or the choice changes) because the desktop app's WebView does not show window.confirm dialogs.
   */
  async remove() {
    const btn = this.$('btn-tile-delete');
    const name = this.$('select-tile').value;
    if (!name) { this.status(this.L('削除するタイルを一覧から選んでください。', 'Choose the tile to delete in the list.')); return; }
    if (this.armedDelete !== name) {
      this.armedDelete = name;
      btn.textContent = this.L('本当に削除', 'Really delete');
      this.status(this.L('もう一度押すと削除します。', 'Press again to delete.'));
      return;
    }
    this.armedDelete = null;
    btn.textContent = this.L('削除', 'Delete');
    const label = this.tile?.meta.label || name;
    await this.select('');
    await deleteTile(name);
    await this.refreshList('');
    this.status(this.L(`タイル「${label}」を削除しました。`, `Deleted the tile "${label}".`));
  }

  /** The seawall preset changed: rebuild the tile's walls (any detail result is already dropped). */
  refreshSurface() {
    if (!this.tile) return;
    this.surface = tileSurface(this.tile, this.ctx.seawallMgr, this.ctx.meta);
    this.view.setWalls(this.surface);
  }

  /** Drop the detail results (the 5 m run they were nested in changed). */
  clearRun() {
    if (this.run?.sim) this.run.sim.dispose();
    this.run = null;
    if (this.view) this.view.setDepth(new Float32Array(this.tile.N), new Float32Array(this.tile.buildings.count));
    this.updateRunButton();
    this.showFigures();
  }

  /**
   * Start / stop the detail run. As in nagoya_flood, the city-wide (5 m) run and the tile run go on together:
   * the 5 m run is started if needed and the tile follows it, never stepping past the keyframes computed so far.
   */
  toggleRun() {
    if (this.run?.status === 'running') { this.clearRun(); return; }
    if (this.ctx.era() !== 'present') { this.status(this.L('詳細計算は地形・防潮堤が「現在」のときだけ使えます。', 'The detail run needs the "Present" terrain and seawalls.')); return; }
    const gl = this.ctx.scene.renderer;
    if (!gl.capabilities.isWebGL2 || !gl.extensions.has('EXT_color_buffer_float')) {
      this.status(this.L('この環境のGPUは浮動小数点の描画に対応していないため、詳細計算はできません。', 'This GPU cannot render to float textures; the detail run is not available.'));
      return;
    }
    this.clearRun();
    this.ctx.startCompute(); // no-op when the 5 m run is computed or computing
    this.run = { sim: null, status: 'running', snaps: [], every: 30, next: 0, end: 0, wall0: performance.now(), bFlood: new Float32Array(this.tile.buildings.count) };
    this.updateRunButton();
  }

  snapshot() {
    const { sim } = this.run;
    const st = sim.readState();
    const N = this.tile.N, d = new Uint16Array(N);
    for (let k = 0; k < N; k++) d[k] = Math.min(65535, Math.round(st[k * 4] * 1000));
    this.run.snaps.push({ t: sim.time, d });
    this.run.last = st;
    this.run.next = sim.time + this.run.every;
  }

  /** Called every animation frame: advance a running detail computation. */
  /** Called every animation frame: advance a running detail computation. */
  tick() {
    const run = this.run;
    if (!run || run.status !== 'running') return;
    const tl = this.ctx.timeline();
    const cityPct = () => Math.round(tl.progress * 100);
    if (!run.sim) {
      // the tile needs two 5 m keyframes to interpolate its edge water level
      if (tl.frames.length < 2) {
        this.status(this.L(`全域（5m）の計算を開始しました… ${cityPct()}%`, `Region-wide (5 m) run started… ${cityPct()}%`));
        return;
      }
      run.sim = new TileSim(this.ctx.scene.renderer, this.tile, this.surface, { timeline: tl, regionMeta: this.ctx.meta, tideLevel: this.ctx.tide() });
      const span = tl.end - tl.start;
      run.every = Math.max(30, Math.ceil(((span * this.tile.N * 2) / SNAP_BUDGET_BYTES) / 30) * 30);
      run.next = tl.start;
      this.snapshot();
    }
    const sim = run.sim;
    run.end = tl.done ? tl.computedTo : tl.end;
    const limit = tl.computedTo; // never beyond the 5 m keyframes computed so far
    const t0 = performance.now();
    let waiting = false;
    while (performance.now() - t0 < STEP_BUDGET_MS) {
      if (limit - sim.time <= 1e-6) { waiting = !tl.done; break; }
      for (let s = 0; s < 40; s++) { // the max-depth read-back below stalls the GPU, so not every step
        const dt = Math.min(sim.stableDt(), run.next - sim.time, limit - sim.time);
        if (dt <= 1e-6) break;
        sim.step(dt);
        if (sim.time >= run.next - 1e-6 || sim.time >= limit - 1e-6) break;
      }
      sim.measure();
      if (sim.time >= run.next - 1e-6 || (tl.done && sim.time >= run.end - 1e-6)) {
        this.snapshot();
        this.showSnapshot(run.snaps.length - 1);
        if (tl.done && sim.time >= run.end - 1e-6) { this.finish(); return; }
        break;
      }
    }
    const pct = Math.round(((sim.time - tl.start) / Math.max(1, run.end - tl.start)) * 100);
    const wait = waiting ? this.L('（全域の計算待ち）', ' (waiting for the city-wide run)') : '';
    this.status(this.L(`詳細計算中 ${pct}%${wait} / 全域 ${cityPct()}%（${sim.steps.toLocaleString()} ステップ, Δt ${sim.stableDt().toFixed(3)} 秒）`,
      `Detail run ${pct}%${wait} / city-wide ${cityPct()}% (${sim.steps.toLocaleString()} steps, Δt ${sim.stableDt().toFixed(3)} s)`));
  }

  finish() {
    const run = this.run;
    run.status = 'done';
    run.wall = (performance.now() - run.wall0) / 1000;
    const N = this.tile.N;
    run.maxDepth = new Float32Array(N);
    for (let k = 0; k < N; k++) run.maxDepth[k] = run.last[k * 4 + 1];
    run.bMax = buildingFloodDepth(this.tile, run.maxDepth, new Float32Array(this.tile.buildings.count));
    run.max = tileStats(this.tile, run.maxDepth, run.bMax);
    run.sim.dispose();
    run.sim = null;
    this.updateRunButton();
    this.ctx.onUpdate();
  }

  /** Depth on the tile at simulated time t (interpolated between snapshots), or null without results. */
  depthAt(t, out) {
    const S = this.run?.snaps;
    if (!S?.length) return null;
    t = Math.max(S[0].t, Math.min(S[S.length - 1].t, t));
    let i = 0;
    while (i < S.length - 2 && S[i + 1].t < t) i++;
    const a = S[i], b = S[Math.min(i + 1, S.length - 1)];
    const w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    for (let k = 0; k < out.length; k++) out[k] = (a.d[k] + (b.d[k] - a.d[k]) * w) * 0.001;
    return out;
  }

  showSnapshot(i) {
    const s = this.run.snaps[i];
    const depth = new Float32Array(this.tile.N);
    for (let k = 0; k < depth.length; k++) depth[k] = s.d[k] * 0.001;
    buildingFloodDepth(this.tile, depth, this.run.bFlood);
    this.view.setDepth(depth, this.run.bFlood);
    this.run.shownT = s.t;
    this.run.now = tileStats(this.tile, depth, this.run.bFlood);
  }

  /** Follow the city timeline (after the detail run has finished). */
  showAt(t) {
    const run = this.run;
    if (!run || run.status !== 'done' || !this.view) return;
    if (run.shownT !== undefined && Math.abs(run.shownT - t) < 1) return;
    const depth = this.depthAt(t, this.view.depth);
    if (!depth) return;
    // flooded buildings: refreshed whenever the time moves by 5 s or more (the percentile pass is the costly part)
    if (run.floodT === undefined || Math.abs(run.floodT - t) >= 5) {
      buildingFloodDepth(this.tile, depth, run.bFlood);
      run.floodT = t;
    }
    this.view.setDepth(depth, run.bFlood);
    run.shownT = t;
    run.now = tileStats(this.tile, depth, run.bFlood);
    this.showFigures();
  }

  showFigures() {
    const run = this.run;
    if (!run || run.status !== 'done' || !this.tile) return;
    const n = run.now || { areaHa: 0, hmax: 0, b05: 0 };
    const total = this.tile.buildings.count.toLocaleString();
    this.status(this.L(
      `詳細計算 完了（${run.wall.toFixed(0)} 秒・保存間隔 ${run.every} 秒）\n` +
      `この時刻: 浸水 ${n.areaHa.toFixed(1)} ha / 浸水建物(周囲0.5m以上) ${n.b05.toLocaleString()} / ${total} 棟 / 最大 ${n.hmax.toFixed(2)} m\n` +
      `全期間の最大: 浸水 ${run.max.areaHa.toFixed(1)} ha / 浸水建物 ${run.max.b05.toLocaleString()} 棟 / 最大 ${run.max.hmax.toFixed(2)} m`,
      `Detail run done (${run.wall.toFixed(0)} s, snapshots every ${run.every} s)\n` +
      `Now: flooded ${n.areaHa.toFixed(1)} ha / buildings (>=0.5 m around) ${n.b05.toLocaleString()} of ${total} / max ${n.hmax.toFixed(2)} m\n` +
      `Whole run: flooded ${run.max.areaHa.toFixed(1)} ha / buildings ${run.max.b05.toLocaleString()} / max ${run.max.hmax.toFixed(2)} m`));
  }

  /**
   * Hydrograph from the detail run when the pin / area lies on the tile: [{ timeSec, depth }] up to time t,
   * or null (then the 5 m run's hydrograph is used).
   */
  seriesFor(pin, t) {
    const run = this.run, tile = this.tile;
    if (!pin || !tile || run?.status !== 'done') return null;
    if (run.seriesPin !== pin) {
      run.seriesPin = pin;
      run.seriesCells = this.cellsFor(pin);
    }
    const cells = run.seriesCells;
    if (!cells?.length) return null;
    const out = [];
    for (const s of run.snaps) {
      if (s.t > t) break;
      let d = 0;
      for (const k of cells) if (s.d[k] > d) d = s.d[k];
      out.push({ timeSec: s.t, depth: d * 0.001 });
    }
    return out;
  }

  /** Tile cells of a pin (its cell) or a town area (land outside buildings inside the rings). */
  cellsFor(pin) {
    const { nx, ny, res, offX, offZ, water, bldgGrid } = this.tile;
    if (!pin.rings) {
      const i = Math.floor((pin.x - offX) / res), j = Math.floor((pin.z - offZ) / res);
      return i >= 0 && j >= 0 && i < nx && j < ny ? [j * nx + i] : null;
    }
    const cells = [];
    for (let j = 0; j < ny; j++) {
      const zc = offZ + (j + 0.5) * res;
      const xs = [];
      for (const r of pin.rings) {
        const n = r.length / 2;
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const z1 = r[k * 2 + 1], z2 = r[i * 2 + 1];
          if ((z1 <= zc && z2 > zc) || (z2 <= zc && z1 > zc)) xs.push(r[k * 2] + ((zc - z1) / (z2 - z1)) * (r[i * 2] - r[k * 2]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - offX) / res - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[q + 1] - offX) / res - 0.5));
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          if (!water[k] && bldgGrid[k] < 0) cells.push(k);
        }
      }
    }
    return cells;
  }
}
