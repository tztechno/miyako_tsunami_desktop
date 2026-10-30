import { TsunamiScene, DEPTH_LEGEND } from './scene.js';
import { SeawallManager } from './seawall.js';
import { SimClient } from './simClient.js';
import { DepthChart } from './chart.js';
import { LabelManager } from './labels.js';
import { TSUNAMI_SCENARIOS } from './scenarios.js';
import { recordVideo, makeCameraPath } from './recorder.js';
import { t, setLang, getLang } from './i18n.js';
import { toLonLat } from './proj.js';
import { buildBatchZip, waveCrests } from './batchExport.js';
import { offshoreWaveEta, openBoundary, shoalingFactor, surveyFitsTerrain, regionSource } from './tsunamiSim.js';
import { WaveProfile } from './waveProfile.js';
import { seaDepthAt } from './bathyLookup.js';

const RENDER_STEP = 2; // water mesh = every 2nd sim cell (10 m)
const $ = (id) => document.getElementById(id);

const COMPASS_JA = [
  '北', '北北東', '北東', '東北東',
  '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西',
  '西', '西北西', '北西', '北北西',
];
const COMPASS_EN = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
];
const compass = (deg) => {
  const norm = ((Math.round(deg / 22.5) % 16) + 16) % 16;
  return (getLang() === 'en' ? COMPASS_EN : COMPASS_JA)[norm];
};

class App {
  constructor() {
    this.canvas = $('gl-canvas');
    this.scene = new TsunamiScene(this.canvas);
    this.depthChart = new DepthChart($('depth-chart-canvas'));

    const urlParams = new URLSearchParams(window.location.search);
    const regionParam = urlParams.get('region');
    this.currentRegion = (regionParam === 'miyako_port' || regionParam === 'taro') ? regionParam : 'taro';
    if ($('select-region')) $('select-region').value = this.currentRegion;
    this.regionMeta = null;
    this.groundF32 = null;
    this.buildings = [];
    this.seawallMgr = null;
    this.sim = null; // SimClient (worker)
    this.labelMgr = null;

    this.isSimulating = false;
    this.selectedPoint = null;
    this.pointLog = [];
    this.batchPoints = [];
    this.batching = null; // { durationSec } while a batch run is in progress
    this.frameDirty = false;
    this.recording = null;
    this.keyframes = [];
    this.loadToken = 0;

    // Wave profile from CSV (nankai_trough or user import)
    this.activeWaveProfile = null;
    // Multiplier on the CSV waveform (kept across CSV scenarios and regions; shown in the CSV badge)
    this.csvScale = 1;
    // Width of the wave source along the crest (m). The source is where a wave from a distant earthquake
    // enters the region, not the epicentre; the wave height is uniform across it. Kept across scenarios and regions.
    this.sourceWidthM = 100000;
    // Still-water level (T.P. m) under every scenario, e.g. high tide: the whole sea starts this high and the
    // boundary wave rides on it. Kept across scenarios and regions.
    this.tideLevel = 0;
    this.isPulseMode = false;

    this.init();
  }

  async init() {
    this.bindUI();
    this.setupResize();
    this.setupPicking();
    await this.loadRegion(this.currentRegion);
    this.updateLanguageTexts(); // apply the language saved from the last visit

    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.recording) return; // the recorder drives rendering

      if (this.frameDirty && this.sim?.frame) {
        this.frameDirty = false;
        this.applyFrame();
      }
      this.scene.render(dt);
      this.depthChart.draw();
      this.labelMgr?.update(this.scene.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    };
    requestAnimationFrame(loop);
  }

  /** Push the latest worker frame into the 3D scene, HUD and hydrograph. */
  applyFrame() {
    const f = this.sim.frame;
    this.scene.updateWater(f, this.groundF32);
    this.scene.updateBuildingDamage(f.bldgWet);
    this.updateHUD();
    this.updateSurveyPanel();
    this.updateInundPanel();
    if (this.batching) {
      const pct = Math.min(100, Math.round((this.sim.simTimeSec / this.batching.durationSec) * 100));
      $('record-progress-fill').style.width = `${pct}%`;
      $('record-status-text').textContent = `${t('batchRunning')} ${(this.sim.simTimeSec / 60).toFixed(1)} / ${(this.batching.durationSec / 60).toFixed(0)} ${t('unitMin')} (${pct}%)`;
    }
    if (this.selectedPoint && this.sim.point) {
      this.depthChart.pointInfo = this.sim.point;
      if (this.isSimulating) this.depthChart.addSample(this.sim.simTimeSec, this.sim.point.waterDepth);
      this.updatePointInspectionUI(this.sim.point);
    }
    this.logPoint();
  }

  /** Keep the full time series at the observation point (the chart only shows the last 200 samples). */
  logPoint() {
    const pt = this.sim?.point;
    if (!this.selectedPoint || !pt) return;
    const t = this.sim.simTimeSec;
    const last = this.pointLog[this.pointLog.length - 1];
    if (last && t < last.t) this.pointLog = []; // simulation was reset
    if (last && t - last.t < 1) return; // at most one sample per simulated second
    this.pointLog.push({ t, depth: pt.waterDepth, eta: pt.waterEta, maxDepth: pt.maxDepth });
  }

  exportPointCsv() {
    if (!this.selectedPoint || !this.pointLog.length) {
      alert(getLang() === 'en' ? 'Click a point on the map and run the simulation first.' : '地図をクリックして地点を選び、計算を進めてから保存してください。');
      return;
    }
    const m = this.regionMeta;
    const e = m.originE + this.selectedPoint.worldX;
    const n = m.originN - this.selectedPoint.worldZ;
    const [lon, lat] = toLonLat(e, n);
    const sc = $('select-scenario');
    const sw = $('select-seawall');
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const en = getLang() === 'en';
    const L = (ja, eng) => (en ? eng : ja);
    const meta = [
      [L('地点の緯度', 'Latitude'), lat.toFixed(6)],
      [L('地点の経度', 'Longitude'), lon.toFixed(6)],
      [L('平面直角座標 第X系 X(東)(m)', 'JPRCS zone X easting (m)'), e.toFixed(1)],
      [L('平面直角座標 第X系 Y(北)(m)', 'JPRCS zone X northing (m)'), n.toFixed(1)],
      [L('地盤標高 (T.P. m)', 'Ground elevation (T.P. m)'), this.pointElevation.toFixed(2)],
      [L('地域', 'Region'), $('select-region').selectedOptions[0].textContent],
      [L('津波シナリオ', 'Scenario'), sc.selectedOptions[0].textContent],
      [L('沖合の波高 (m)', 'Offshore wave height (m)'), $('input-wave-height').value],
      [L('潮位 (T.P. m)', 'Tide level (T.P. m)'), this.tideLevel],
      [L('来襲方向', 'Wave coming from'), $('val-wave-dir').textContent],
      [L('地形・防潮堤', 'Terrain & seawalls'), sw.selectedOptions[0]?.textContent || sw.value],
    ];
    const rows = [
      ...meta.map(([k, v]) => `${q(k)},${q(v)}`),
      '',
      (en
        ? ['Elapsed (s)', 'Elapsed (min)', 'Water depth (m)', 'Water level (T.P. m)', 'Max depth so far (m)']
        : ['経過時間 (秒)', '経過時間 (分)', '水深 (m)', '水位 (T.P. m)', 'その時点までの最大浸水深 (m)']
      ).map(q).join(','),
      ...this.pointLog.map((r) => [Math.round(r.t), (r.t / 60).toFixed(2), r.depth.toFixed(3), r.eta.toFixed(3), r.maxDepth.toFixed(3)].join(',')),
    ];
    const csv = '\uFEFF' + rows.join('\r\n');
    this.download(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `miyako_tsunami_point_${lat.toFixed(5)}_${lon.toFixed(5)}_${Date.now()}.csv`
    );
  }

  async loadRegion(regionName, { keepView = false } = {}) {
    const token = ++this.loadToken;
    if (this.batching) {
      // switching region abandons a running batch (its worker is terminated below)
      this.batching = null;
      $('record-modal').style.display = 'none';
    }
    this.setSimulating(false);
    this.sim?.dispose();
    this.sim = null;

    const meta = await (await fetch(`data/regions/${regionName}/meta.json`)).json();
    // The era brings its terrain: 当時 is the land before the new seawall's embankments. Only Taro has it.
    const selEra = $('select-seawall');
    selEra.disabled = !meta.ground2011;
    if (!meta.ground2011) selEra.value = 'present';
    const era = selEra.value;
    const groundFile = era === 'era2011' ? meta.ground2011.file : 'ground.f32';
    const ground = new Float32Array(await (await fetch(`data/regions/${regionName}/${groundFile}`)).arrayBuffer());
    let buildings = [];
    try {
      const bRes = await fetch(`data/regions/${regionName}/buildings.json`);
      if (bRes.ok) buildings = await bRes.json();
    } catch {}
    // PLATEAU buildings are today's; no building data from before 2011 exists, so 当時 has none
    // (2011 scenario vs the 5 m inundation mesh: CSI 0.90 without them, 0.74 with today's buildings)
    if (era === 'era2011') buildings = [];
    if (token !== this.loadToken) return; // a newer region switch superseded this one

    this.regionMeta = meta;
    this.groundF32 = ground;
    this.buildings = buildings;

    this.scene.clearAerialCache();
    await this.scene.buildTerrain(meta, ground, `data/regions/${regionName}/aerial.jpg`);
    this.scene.aerialCache.now = this.scene.groundMesh.material.map;
    this.aerialUrls = { now: `data/regions/${regionName}/aerial.jpg`, y2011: `data/regions/${regionName}/aerial_2011.jpg`, y1975: `data/regions/${regionName}/aerial_1975.jpg` };
    if ($('sel-aerial').value !== 'now') await this.scene.setAerial($('sel-aerial').value, this.aerialUrls);
    await this.scene.buildOverlay('hazard', `data/regions/${regionName}/hazard_tsunami.png`);
    this.scene.setOverlayVisible('hazard', $('chk-hazardmap').checked);
    await this.scene.buildOverlay('inund2011', `data/regions/${regionName}/inund2011.png`);
    this.scene.setOverlayVisible('inund2011', $('chk-inund2011').checked);
    await this.scene.buildOverlay('inund5', `data/regions/${regionName}/inund2011_5m.png`, { nearest: true });
    this.scene.setOverlayVisible('inund5', $('chk-inund5').checked);
    this.scene.buildWaterMesh(meta, RENDER_STEP);
    const scInit = TSUNAMI_SCENARIOS[$('select-scenario').value] || TSUNAMI_SCENARIOS.great_east_japan;
    const initWaveDir = (scInit.directionDegByRegion && scInit.directionDegByRegion[regionName]) || (regionName === 'miyako_port' ? 50 : 110);
    this.scene.buildSourceZone(meta, initWaveDir);
    this.scene.setSourceZoneVisible($('chk-sourcezone').checked);
    this.scene.buildBuildings(buildings, meta, ground);
    this.scene.setBuildingFocus({ x: 0, z: 0 });
    if (this.scene.pinMesh) this.scene.pinMesh.visible = false;
    this.scene.focusMarker.visible = false;
    this.selectedPoint = null;

    try {
      const outerMetaRes = await fetch('data/regions/outer/meta.json');
      if (outerMetaRes.ok) {
        const outerMeta = await outerMetaRes.json();
        const outerG = new Float32Array(await (await fetch('data/regions/outer/ground.f32')).arrayBuffer());
        await this.scene.buildOuterBackdrop(outerMeta, outerG, 'data/regions/outer/aerial.jpg', meta);
        this.scene.outerMesh.visible = $('chk-backdrop').checked;
      }
    } catch (e) {
      console.warn('Outer backdrop load failed:', e);
    }

    if (this.seawallMgr) {
      this.scene.scene.remove(this.seawallMgr.meshGroup);
      this.seawallMgr.dispose();
    }
    this.seawallMgr = new SeawallManager(meta);
    await this.seawallMgr.loadSeawalls(regionName);
    this.scene.scene.add(this.seawallMgr.meshGroup);
    this.seawallMgr.setEra(era);

    this.sim = new SimClient({
      meta,
      ground,
      buildings,
      seawallMgr: this.seawallMgr,
      renderStep: RENDER_STEP,
      onFrame: () => (this.frameDirty = true),
    });
    if (this.tideLevel > 0) this.sim.setTide(this.tideLevel);
    await this.loadSurvey(regionName, meta, ground);
    await this.loadInund2011(regionName);
    await this.loadInund5(regionName);

    this.depthChart.setPoint(null);
    this.labelMgr = new LabelManager($('label-container'), meta);
    await this.labelMgr.loadLabels();
    this.labelMgr.setVisible($('chk-labels').checked);

    this.currentRegion = regionName;
    if (!keepView) this.scene.setCameraView('viewCoast');

    const dirInput = $('input-wave-dir');
    if (dirInput) {
      dirInput.min = 0;
      dirInput.max = 360;
    }

    const sc = TSUNAMI_SCENARIOS[$('select-scenario').value] || TSUNAMI_SCENARIOS.nankai_trough || TSUNAMI_SCENARIOS.great_east_japan;
    await this.applyScenario(sc);
    this.updateLanguageTexts();
  }

  /** 2011 tsunami survey points (measured water levels) for comparison with the simulation. */
  async loadSurvey(regionName, meta, ground) {
    this.survey = [];
    try {
      const res = await fetch(`data/regions/${regionName}/survey2011.json`);
      if (res.ok) this.survey = (await res.json()).points || [];
    } catch {}
    this.scene.buildSurveyMarkers(this.survey, meta, ground);
    this.scene.setSurveyVisible($('chk-survey').checked);
    const { nx, ny, res } = meta;
    const cells = Int32Array.from(this.survey, (p) => {
      const gx = Math.min(nx - 1, Math.max(0, Math.floor(p.x / res)));
      const gz = Math.min(ny - 1, Math.max(0, Math.floor(p.z / res)));
      return gz * nx + gx;
    });
    this.survey.forEach((p, k) => (p.fitsTerrain = surveyFitsTerrain(p, ground[cells[k]])));
    this.sim.setSurveyCells(cells);
    this.updateSurveyPanel();
  }

  updateSurveyPanel() {
    const panel = $('survey-panel');
    const show = $('chk-survey').checked && this.survey?.length > 0;
    panel.hidden = !show;
    if (!show || !this.sim) return;
    const started = (this.sim.simTimeSec || 0) > 1;
    const sum = this.scene.updateSurveyComparison(this.survey, started ? this.sim.surveyMax : null);
    const en = getLang() === 'en';
    const box = $('survey-summary');
    if (!started || !sum) {
      box.innerHTML = en
        ? `<b>${this.survey.length}</b> measured points. Play the <b>2011</b> scenario to compare.`
        : `実測 <b>${this.survey.length}</b> 地点。<b>東日本大震災</b>シナリオを再生すると比較できます。`;
      return;
    }
    const f = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}m` : '--');
    const r = (v) => (Number.isFinite(v) ? v.toFixed(1) + 'm' : '--');
    const c = sum.fits;
    box.innerHTML = en
      ? `<b>Points matching today's terrain</b> (${c.n}): water reached <b>${c.reached}</b> · within ±2m <b>${c.within}</b> · mean <b>${f(c.meanDiff)}</b> · RMSE <b>${r(c.rmse)}</b><br>`
        + `All ${sum.n} points: reached ${sum.reached} · within ±2m ${sum.within} · mean ${f(sum.meanDiff)} · RMSE ${r(sum.rmse)}`
      : `<b>地形が今と矛盾しない地点</b>（${c.n}）: 水が届いた <b>${c.reached}</b>・差±2m以内 <b>${c.within}</b>・平均の差 <b>${f(c.meanDiff)}</b>・RMSE <b>${r(c.rmse)}</b><br>`
        + `全 ${sum.n} 地点: 届いた ${sum.reached}・±2m以内 ${sum.within}・平均の差 ${f(sum.meanDiff)}・RMSE ${r(sum.rmse)}`;
  }

  /** 2011 actual inundation, 100 m mesh (復興支援調査アーカイブ). */
  async loadInund2011(regionName) {
    this.inund = [];
    try {
      const res = await fetch(`data/regions/${regionName}/inund2011.json`);
      if (res.ok) this.inund = (await res.json()).meshes || [];
    } catch {}
    // sample points of the water grid (10 m) inside each mesh square, used to average the simulated max depth
    const { nx, res } = this.regionMeta;
    const step = RENDER_STEP;
    const wnx = Math.floor(nx / step);
    const wny = Math.floor(this.regionMeta.ny / step);
    const cell = res * step;
    for (const m of this.inund) {
      const xs = m.ring.map((q) => q[0]);
      const zs = m.ring.map((q) => q[1]);
      const idx = [];
      for (let j = Math.max(0, Math.ceil(Math.min(...zs) / cell)); j <= Math.min(wny - 1, Math.floor(Math.max(...zs) / cell)); j++) {
        for (let i = Math.max(0, Math.ceil(Math.min(...xs) / cell)); i <= Math.min(wnx - 1, Math.floor(Math.max(...xs) / cell)); i++) {
          if (this.groundF32[j * step * nx + i * step] >= 0) idx.push(j * wnx + i);
        }
      }
      m.samples = idx;
    }
    this.updateInundPanel();
  }

  /** 2011 actual inundation, 5 m mesh: one value per simulation cell (cm, 65535 = no data). */
  async loadInund5(regionName) {
    this.actual5 = null;
    this.scene.actual5 = null;
    try {
      const res = await fetch(`data/regions/${regionName}/inund2011_5m.bin`);
      if (res.ok) this.actual5 = new Uint16Array(await res.arrayBuffer());
    } catch {}
    if (!this.actual5) return;
    // resample to the water grid (every RENDER_STEP-th cell) for the match map and statistics
    const { nx, ny } = this.regionMeta;
    const wnx = Math.floor(nx / RENDER_STEP);
    const wny = Math.floor(ny / RENDER_STEP);
    const r = new Uint16Array(wnx * wny);
    for (let j = 0; j < wny; j++) for (let i = 0; i < wnx; i++) r[j * wnx + i] = this.actual5[j * RENDER_STEP * nx + i * RENDER_STEP];
    this.scene.actual5 = r;
    this.updateInundPanel();
  }

  /** Cell-by-cell agreement between simulated max depth and the 2011 5 m mesh (land, surveyed cells). */
  inund5Stats() {
    const a = this.scene.actual5;
    const md = this.sim?.frame?.maxDepth;
    if (!a || !md) return null;
    const { nx } = this.regionMeta;
    const wnx = Math.floor(nx / RENDER_STEP);
    let hit = 0, miss = 0, fa = 0, n = 0, sum = 0, sq = 0;
    for (let v = 0; v < a.length; v++) {
      const av = a[v];
      if (av === 65535) continue;
      const j = Math.floor(v / wnx), i = v % wnx;
      if (this.groundF32[j * RENDER_STEP * nx + i * RENDER_STEP] < 0) continue;
      const unknown = av === 65534; // flooded, depth unknown in the source
      const act = unknown ? Infinity : av / 100;
      const sim = md[v] >= 0.1 ? md[v] : 0;
      if (act > 0 && sim > 0) {
        hit++;
        if (!unknown) {
          const d = sim - act;
          n++;
          sum += d;
          sq += d * d;
        }
      } else if (act > 0) miss++;
      else if (sim > 0) fa++;
    }
    return { hit, miss, fa, csi: hit / Math.max(1, hit + miss + fa), hitRate: hit / Math.max(1, hit + miss), mean: n ? sum / n : NaN, rmse: n ? Math.sqrt(sq / n) : NaN, cellHa: (RENDER_STEP * this.regionMeta.res) ** 2 / 1e4 };
  }

  updateInundPanel() {
    const panel = $('inund-panel');
    const use5 = ($('chk-inund5').checked || $('chk-match').checked) && !!this.scene.actual5;
    const use100 = $('chk-inund2011').checked && this.inund?.length > 0;
    panel.hidden = !(use5 || use100);
    if (panel.hidden || !this.sim?.frame) return;
    const en = getLang() === 'en';
    const box = $('inund-summary');
    const fm = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}m`;
    if ((this.sim.simTimeSec || 0) <= 1) {
      box.innerHTML = en
        ? `Play the <b>2011</b> scenario to compare with the 2011 inundation.`
        : `<b>東日本大震災</b>シナリオを再生すると、2011年の浸水と比較できます。`;
      return;
    }
    let html = '';
    if (use5) {
      const s = this.inund5Stats();
      if (s) {
        const ha = (c) => (c * s.cellHa).toFixed(1);
        html += en
          ? `<b>5m mesh</b>: 2011 flooded area reproduced <b>${(s.hitRate * 100).toFixed(0)}%</b> · CSI <b>${s.csi.toFixed(2)}</b><br>Both <b>${ha(s.hit)}ha</b> · missed <b>${ha(s.miss)}ha</b> · sim only <b>${ha(s.fa)}ha</b><br>Depth (sim − 2011) mean <b>${fm(s.mean)}</b> · RMSE <b>${s.rmse.toFixed(1)}m</b>`
          : `<b>5mメッシュ</b>: 2011年の浸水範囲の再現率 <b>${(s.hitRate * 100).toFixed(0)}%</b>・CSI <b>${s.csi.toFixed(2)}</b><br>両方浸水 <b>${ha(s.hit)}ha</b>・見逃し <b>${ha(s.miss)}ha</b>・計算のみ <b>${ha(s.fa)}ha</b><br>浸水深の差（計算−実績） 平均 <b>${fm(s.mean)}</b>・RMSE <b>${s.rmse.toFixed(1)}m</b>`;
      }
    }
    if (use100) {
      if (html) html += '<br>';
      const md = this.sim.frame.maxDepth;
      let flooded = 0, n = 0, sum = 0, sq = 0;
      for (const m of this.inund) {
        if (!m.samples.length) continue;
        let s = 0;
        for (const k of m.samples) s += md[k] >= 0.05 ? md[k] : 0;
        const sim = s / m.samples.length; // mean simulated max depth over the land part of the mesh
        n++;
        if (sim >= 0.3) flooded++;
        const d = sim - m.depth;
        sum += d;
        sq += d * d;
      }
      const mean = n ? sum / n : NaN;
      const rmse = n ? Math.sqrt(sq / n) : NaN;
      html += en
        ? `<b>100m mesh</b>: also flooded in the simulation <b>${flooded}/${n}</b> · depth mean <b>${fm(mean)}</b> · RMSE <b>${rmse.toFixed(1)}m</b>`
        : `<b>100mメッシュ</b>: 計算でも浸水 <b>${flooded}/${n}</b>・浸水深の差 平均 <b>${fm(mean)}</b>・RMSE <b>${rmse.toFixed(1)}m</b>`;
    }
    box.innerHTML = html;
  }

  buildDepthLegend() {
    $('depth-legend').innerHTML = DEPTH_LEGEND.slice()
      .reverse()
      .map((c) => `<div><span style="background:${c.color}"></span>${c.label}</div>`)
      .join('');
  }

  showCsvMetadataBadge(profile) {
    const badge = $('csv-meta-badge');
    if (!badge) return;
    $('csv-meta-name').textContent = profile.location || profile.name || profile.filename || '波源データ';
    $('csv-meta-peak').textContent = `${profile.peakHeight.toFixed(2)}m`;
    const min = Math.floor(profile.peakTimeSec / 60);
    const sec = Math.round(profile.peakTimeSec % 60);
    $('csv-meta-time').textContent = `${min}分${sec < 10 ? '0' : ''}${sec}秒`;
    $('csv-meta-dur').textContent = `${(profile.durationSec / 60).toFixed(1)}分`;
    const dir = profile.dominantDirectionDeg || 93;
    $('csv-meta-dir').textContent = `${dir}° (${compass(dir)})`;
    // Levels are used relative to the first CSV value (see WaveProfile.baseLevel)
    $('csv-meta-base').textContent = `${profile.baseLevel >= 0 ? '+' : ''}${profile.baseLevel.toFixed(2)}m → 0`;
    badge.style.display = 'block';
  }

  hideCsvMetadataBadge() {
    const badge = $('csv-meta-badge');
    if (badge) badge.style.display = 'none';
  }

  async applyScenario(sc) {
    this.setSimulating(false);
    // CSV scenarios: the region's own source direction (Miyako Port: into the bay mouth) unless the scenario sets one
    const deg = sc.directionDegByRegion?.[this.currentRegion]
      || (sc.isCsvWave && regionSource(this.regionMeta).directionDeg)
      || sc.directionDeg;

    // Load CSV wave profile if this scenario is driven by a CSV file
    if (sc.isCsvWave) {
      if (!sc.waveProfile && sc.csvUrl) {
        try {
          const res = await fetch(sc.csvUrl);
          if (res.ok) {
            const csvText = await res.text();
            sc.waveProfile = WaveProfile.parse(csvText, sc.csvUrl.split('/').pop());
          }
        } catch (err) {
          console.error('Failed to load wave CSV:', err);
        }
      }
      if (sc.waveProfile) {
        const prof = sc.waveProfile;
        // Depth at the CSV point (japan.tif) for the shoaling correction to the edge of the region
        if (prof.sourceDepth == null && prof.lon != null) prof.sourceDepth = await seaDepthAt(prof.lon, prof.lat);
        this.activeWaveProfile = prof;
        this.showCsvMetadataBadge(sc.waveProfile);
        sc.waveHeight = sc.waveProfile.peakHeight;
        sc.durationMin = Math.ceil(sc.waveProfile.durationSec / 60);
      }
    } else {
      this.activeWaveProfile = null;
      this.hideCsvMetadataBadge();
    }

    this.currentScenarioId = sc.id;
    this.sim.setScenario({ ...sc, directionDeg: deg, waveProfile: this.activeWaveProfile });
    this.updateScenarioDesc(sc);
    $('input-wave-height').value = sc.waveHeight;
    $('val-wave-height').textContent = `${sc.waveHeight.toFixed(1)}m`;
    $('input-wave-dir').value = deg;
    this.updateDirLabel(deg);
    this.scene.updateSourceZoneDirection(deg);
    this.scene.setCsvSource(this.regionMeta, this.activeWaveProfile);
    this.labelMgr?.setSourceLabel(this.activeWaveProfile);
    this.depthChart.history = [];
    this.waveParams = {
      waveHeight: sc.waveHeight,
      wavePeriod: sc.periodSec,
      hasPreDrawdown: !!sc.hasPreDrawdown,
      waveProfile: this.activeWaveProfile,
    };
    $('batch-minutes').value = sc.durationMin || 30;
    this.setSourceWidth(this.sourceWidthM);
    if (this.activeWaveProfile) this.setCsvScale(this.csvScale);
    this.drawWavePreview();
    this.updateHUD();
  }

  /** Reload the region with the terrain, seawalls and photo of the selected era; restarts the run. */
  changeEra() {
    $('sel-aerial').value = $('select-seawall').value === 'era2011' ? 'y1975' : 'now';
    return this.loadRegion(this.currentRegion, { keepView: true });
  }

  /** Raise the still sea level by `level` m for every scenario (high tide); restarts the run. */
  setTide(level) {
    this.tideLevel = level;
    $('val-tide').textContent = `+${level.toFixed(1)}m`;
    this.scene.seaLevel = level;
    this.sim.setTide(level);
    this.depthChart.history = [];
    this.updateHUD();
  }

  /** Limit the wave source to widthM along the crest; redraws the source frame. */
  setSourceWidth(widthM) {
    this.sourceWidthM = widthM;
    this.sim.setCustomWave({ sourceWidthM: widthM });
    this.scene.buildSourceZone(this.regionMeta, parseFloat($('input-wave-dir').value) || 90, widthM);
    this.scene.setSourceZoneVisible($('chk-sourcezone').checked);
    $('input-source-width').value = widthM / 1000;
    $('val-source-width').textContent = `${(widthM / 1000).toFixed(1)} km`;
    if (this.activeWaveProfile) this.setCsvScale(this.csvScale); // the forced edge, so its depth, changed
  }

  /**
   * Green's law factor from the CSV point to the forced edge of the region for the current direction and
   * source width (the simulator computes the same in setupBoundary). Shown in the CSV badge.
   */
  updateCsvShoal() {
    const prof = this.activeWaveProfile;
    const deg = parseFloat($('input-wave-dir').value) || 90;
    const b = openBoundary(this.regionMeta, this.groundF32, deg, this.sourceWidthM, 20);
    const factor = shoalingFactor(prof.sourceDepth, b.depth);
    $('csv-meta-shoal').textContent = prof.sourceDepth > 0
      ? `×${factor.toFixed(2)} (${prof.sourceDepth.toFixed(0)}m→${b.depth.toFixed(0)}m)`
      : t('csvShoalUnknown');
    this.csvShoal = factor;
    return factor;
  }

  /**
   * Multiply the CSV waveform by the user's factor k on top of the automatic shoaling correction:
   * boundary level = CSV × shoaling × k. The boundary, the height slider/label and the preview follow.
   */
  setCsvScale(k) {
    const prof = this.activeWaveProfile;
    if (!prof || !Number.isFinite(k)) return;
    k = Math.min(10, Math.max(0.1, k));
    this.csvScale = k;
    const total = this.updateCsvShoal() * k;
    const h = prof.peakHeight * total;
    this.sim.setCustomWave({ profileScale: k });
    if (this.waveParams) {
      this.waveParams.waveHeight = h;
      this.waveParams.profileScale = total; // what multiplies the CSV at the boundary (preview, batch crests)
    }
    $('input-csv-scale').value = k.toFixed(2);
    $('input-wave-height').value = Math.min(25, h);
    $('val-wave-height').textContent = `${h.toFixed(1)}m`;
    this.drawWavePreview();
  }

  /** Offshore boundary waveform over the batch duration, with each crest marked. */
  drawWavePreview() {
    const cv = $('wave-preview');
    if (!cv || !cv.clientWidth) return;
    const w = (cv.width = cv.clientWidth);
    const h = (cv.height = cv.clientHeight);
    const ctx = cv.getContext('2d');
    const dur = Math.max(60, (Number($('batch-minutes').value) || 30) * 60);
    const en = getLang() === 'en';

    // 1. If activeWaveProfile is loaded (nankai_trough or imported CSV), draw real wave curve
    if (this.activeWaveProfile) {
      const prof = this.activeWaveProfile;
      const scale = this.waveParams?.profileScale ?? 1;
      const maxAbs = Math.max(1, prof.peakHeight * scale, Math.abs(prof.troughHeight * scale)) * 1.25;
      const X = (t) => 8 + (t / dur) * (w - 16);
      const Y = (e) => h / 2 - (e / maxAbs) * (h / 2 - 10);

      ctx.clearRect(0, 0, w, h);

      // 0m reference line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Y(0));
      ctx.lineTo(w, Y(0));
      ctx.stroke();

      // Plot actual wave elevation
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      const numSteps = Math.min(w, 400);
      for (let i = 0; i <= numSteps; i++) {
        const tt = (i / numSteps) * dur;
        const val = prof.getEta(tt) * scale;
        const px = X(tt);
        const py = Y(val);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Mark peak surge
      if (prof.peakTimeSec <= dur) {
        const px = X(prof.peakTimeSec);
        const py = Y(prof.peakHeight * scale);
        ctx.fillStyle = '#ff1744';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9.5px Inter, sans-serif';
        ctx.fillText(`▲ ${(prof.peakHeight * scale).toFixed(2)}m`, px - 14, Math.max(12, py - 6));
      }

      // Mark maximum drawdown (trough)
      if (prof.troughTimeSec <= dur && prof.troughHeight * scale < -0.1) {
        const tx = X(prof.troughTimeSec);
        const ty = Y(prof.troughHeight * scale);
        ctx.fillStyle = '#00b0ff';
        ctx.beginPath();
        ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#80d8ff';
        ctx.font = '9px Inter, sans-serif';
        ctx.fillText(`▼ ${(prof.troughHeight * scale).toFixed(2)}m`, tx - 14, Math.min(h - 4, ty + 12));
      }

      const pMin = (prof.peakTimeSec / 60).toFixed(1);
      const tMin = (prof.troughTimeSec / 60).toFixed(1);
      $('wave-crests').textContent = en
        ? `Drawdown ${(prof.troughHeight * scale).toFixed(2)}m (${tMin} min) → Peak surge +${(prof.peakHeight * scale).toFixed(2)}m (${pMin} min)`
        : `最大引き波 ${(prof.troughHeight * scale).toFixed(2)}m (${tMin}分) → 最大押し波 +${(prof.peakHeight * scale).toFixed(2)}m (${pMin}分)`;
      return;
    }

    // 2. Default equation-based wave preview (historic Tohoku, L1, L2, Chile, Custom)
    if (!this.waveParams) return;
    const p = this.waveParams;
    const amp = Math.max(1, p.waveHeight) * 1.15;
    const X = (t) => 4 + (t / dur) * (w - 8);
    const Y = (e) => h / 2 - (e / amp) * (h / 2 - 8);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(0, Y(0));
    ctx.lineTo(w, Y(0));
    ctx.stroke();
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= w; i++) {
      const tt = (i / w) * dur;
      const y = Y(offshoreWaveEta(tt, p));
      if (i === 0) ctx.moveTo(X(tt), y);
      else ctx.lineTo(X(tt), y);
    }
    ctx.stroke();
    const crests = waveCrests(p, dur);
    ctx.fillStyle = '#ffb74d';
    ctx.font = '10px Inter, sans-serif';
    crests.forEach((c, k) => {
      ctx.beginPath();
      ctx.arc(X(c.t), Y(c.h), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${k + 1}`, X(c.t) + 4, Y(c.h) + 3);
    });
    $('wave-crests').textContent = crests.length
      ? crests.map((c, k) => (en ? `Wave ${k + 1}: ${(c.t / 60).toFixed(1)} min ${c.h.toFixed(1)}m` : `第${k + 1}波 ${(c.t / 60).toFixed(1)}分 ${c.h.toFixed(1)}m`)).join(' / ')
      : en ? 'No crest within this duration' : 'この長さの中に波の山はありません';
  }

  updateBatchCount() {
    const n = this.batchPoints.length;
    $('batch-count').textContent = getLang() === 'en' ? `${n} points` : `${n} 地点`;
  }

  /** Point record for the batch run from simulation coordinates (metres from the NW corner). */
  makeBatchPoint(name, worldX, worldZ, measured) {
    const m = this.regionMeta;
    const gx = Math.min(m.nx - 1, Math.max(0, Math.floor(worldX / m.res)));
    const gz = Math.min(m.ny - 1, Math.max(0, Math.floor(worldZ / m.res)));
    const e = m.originE + worldX;
    const n = m.originN - worldZ;
    const [lon, lat] = toLonLat(e, n);
    return { name, lat, lon, e, n, cell: gz * m.nx + gx, elevation: this.groundF32[gz * m.nx + gx], measured };
  }

  async runBatch() {
    if (this.batching || this.recording || !this.sim) return;
    const durationSec = Math.max(60, (Number($('batch-minutes').value) || 30) * 60);
    const points = [...this.batchPoints];
    if (!points.length && this.selectedPoint) points.push(this.makeBatchPoint('P1', this.selectedPoint.worldX, this.selectedPoint.worldZ));
    if ($('chk-batch-survey').checked) {
      for (const s of this.survey || []) points.push(this.makeBatchPoint(`TTJT ${s.id}`, s.x, s.z, s.h));
    }

    this.setSimulating(false);
    this.batching = { durationSec };
    const modal = $('record-modal');
    modal.style.display = 'flex';
    $('record-progress-fill').style.width = '0%';
    $('record-status-text').textContent = t('batchRunning');
    const en = getLang() === 'en';
    try {
      const result = await this.sim.batch(durationSec, Int32Array.from(points, (p) => p.cell), 5);
      if (result.cancelled) {
        $('record-status-text').textContent = t('batchCancelled');
      } else {
        const sw = $('select-seawall');
        const L = (ja, eng) => (en ? eng : ja);
        const cond = [
          [L('地域', 'Region'), $('select-region').selectedOptions[0].textContent],
          [L('津波シナリオ', 'Scenario'), $('select-scenario').selectedOptions[0].textContent],
          [L('沖合の波高 (m)', 'Offshore wave height (m)'), this.waveParams.waveHeight],
          ...(this.activeWaveProfile
            ? [
                [L('浅水補正 (グリーンの法則)', "Shoaling correction (Green's law)"), $('csv-meta-shoal').textContent],
                [L('CSV波形の倍率', 'CSV wave multiplier'), this.csvScale],
              ]
            : []),
          [L('波源の幅 (km)', 'Source width (km)'), this.sourceWidthM / 1000],
          [L('潮位 (T.P. m, 津波はこの上に重なる)', 'Tide level (T.P. m, the tsunami rides on it)'), this.tideLevel],
          [L('周期 (秒)', 'Period (s)'), this.waveParams.wavePeriod],
          [L('来襲方向', 'Wave coming from'), $('val-wave-dir').textContent],
          [L('地形・防潮堤', 'Terrain & seawalls'), sw.selectedOptions[0]?.textContent || sw.value],
          [L('計算した長さ (分)', 'Duration (min)'), durationSec / 60],
          [L('格子', 'Grid'), `${this.regionMeta.nx} × ${this.regionMeta.ny}, ${this.regionMeta.res} m`],
        ];
        const blob = buildBatchZip({ result, points, meta: this.regionMeta, ground: this.groundF32, cond, en, durationSec, waveParams: this.waveParams });
        const sc = $('select-scenario').value;
        this.download(blob, `miyako_tsunami_batch_${this.currentRegion}_${sc}_${Math.round(durationSec / 60)}min.zip`);
        $('record-progress-fill').style.width = '100%';
        $('record-status-text').textContent = t('batchDone');
      }
    } catch (e) {
      console.error('Batch error:', e);
      $('record-status-text').textContent = `Error: ${e.message}`;
    }
    this.batching = null;
    this.frameDirty = true;
    setTimeout(() => (modal.style.display = 'none'), 1500);
  }

  updateDirLabel(deg) {
    const isMiyako = this.currentRegion === 'miyako_port';
    const note = isMiyako && deg >= 40 && deg <= 65 ? (getLang() === 'en' ? ' (Bay Mouth)' : '（宮古湾口）') : '';
    const normDeg = Math.round(((deg % 360) + 360) % 360);
    const degStr = deg < 0 ? `${normDeg}° (${deg}°)` : `${deg}°`;
    $('val-wave-dir').textContent = `${degStr} ${compass(deg)}${note}`;
  }

  setSimulating(on) {
    if (on && this.batching) return; // the batch run owns the simulation until it finishes
    this.isSimulating = on;
    if (this.sim) on ? this.sim.play() : this.sim.pause();
    $('btn-play').textContent = on ? t('pause') : t('play');
  }

  bindUI() {
    $('btn-lang').addEventListener('click', () => {
      setLang(getLang() === 'ja' ? 'en' : 'ja');
      this.updateLanguageTexts();
      this.labelMgr?.updateLanguage();
    });

    $('select-region').addEventListener('change', (e) => {
      this.currentRegion = e.target.value;
      const u = new URL(window.location.href);
      u.searchParams.set('region', this.currentRegion);
      window.history.replaceState({}, '', u.toString());
      this.loadRegion(this.currentRegion);
    });

    const selScenario = $('select-scenario');
    selScenario.addEventListener('change', (e) => {
      const sc = TSUNAMI_SCENARIOS[e.target.value];
      if (!sc) return;
      // A scenario tied to an era brings its terrain and seawalls (loadRegion applies the scenario)
      const era = this.currentRegion === 'taro' ? sc.recommendedSeawall : null;
      if (era && era !== $('select-seawall').value) {
        $('select-seawall').value = era;
        this.changeEra();
      } else {
        this.applyScenario(sc);
      }
    });

    $('select-seawall').addEventListener('change', () => this.changeEra());

    $('batch-minutes').addEventListener('input', () => this.drawWavePreview());
    $('btn-batch-add').addEventListener('click', () => {
      if (!this.selectedPoint) {
        alert(getLang() === 'en' ? 'Click a point on the map first.' : '先に地図をクリックして地点を選んでください。');
        return;
      }
      this.batchPoints.push(this.makeBatchPoint(`P${this.batchPoints.length + 1}`, this.selectedPoint.worldX, this.selectedPoint.worldZ));
      this.updateBatchCount();
    });
    $('btn-batch-clear').addEventListener('click', () => {
      this.batchPoints = [];
      this.updateBatchCount();
    });
    $('btn-batch-run').addEventListener('click', () => this.runBatch());

    $('input-wave-height').addEventListener('input', (e) => {
      const h = parseFloat(e.target.value);
      if (this.activeWaveProfile) {
        // With a CSV the height slider is another way to set the multiplier (target peak / corrected CSV peak)
        const peak = this.activeWaveProfile.peakHeight * (this.csvShoal ?? 1);
        if (peak > 0) this.setCsvScale(h / peak);
        return;
      }
      $('val-wave-height').textContent = `${h.toFixed(1)}m`;
      this.sim.setCustomWave({ height: h });
      if (this.waveParams) {
        this.waveParams.waveHeight = h;
        this.drawWavePreview();
      }
      // A CSV scenario stays selected: the slider only scales its waveform
      if (!this.activeWaveProfile) selScenario.value = 'custom';
    });

    $('input-tide').addEventListener('input', (e) => {
      if (this.batching) {
        e.target.value = this.tideLevel; // the batch run owns the simulation until it finishes
        return;
      }
      this.setTide(parseFloat(e.target.value));
    });

    $('input-source-width').addEventListener('input', (e) => {
      this.setSourceWidth(parseFloat(e.target.value) * 1000);
    });

    $('input-wave-dir').addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value);
      this.updateDirLabel(deg);
      this.scene.updateSourceZoneDirection(deg);
      this.sim.setCustomWave({ direction: deg });
      if (this.activeWaveProfile) this.setCsvScale(this.csvScale); // the forced edge, so its depth, changed
      else selScenario.value = 'custom';
    });

    // Wave Source CSV Import UI & Drag-and-Drop
    this.initWaveCsvUI();

    // Artificial Wave (Pulse Injection) Mode Toggle
    const btnPulse = $('btn-pulse-mode');
    const pulseControls = $('pulse-controls');
    if (btnPulse) {
      btnPulse.addEventListener('click', () => {
        this.isPulseMode = !this.isPulseMode;
        btnPulse.classList.toggle('active', this.isPulseMode);
        btnPulse.textContent = this.isPulseMode
          ? (getLang() === 'en' ? '🎯 Click water to inject wave (Active)' : '🎯 水面クリックで人工波注入中 (ON)')
          : t('injectPulseWave');
        if (pulseControls) {
          pulseControls.style.display = this.isPulseMode ? 'block' : 'none';
        }
      });
    }

    const inputPulseH = $('input-pulse-height');
    if (inputPulseH) {
      inputPulseH.addEventListener('input', (e) => {
        $('val-pulse-height').textContent = `${parseFloat(e.target.value).toFixed(1)}m`;
      });
    }

    $('btn-play').addEventListener('click', () => this.setSimulating(!this.isSimulating));

    $('btn-reset').addEventListener('click', () => {
      if (this.batching) return;
      this.setSimulating(false);
      this.sim.reset();
      this.depthChart.history = [];
      this.updateHUD();
    });

    $('btn-point-csv').addEventListener('click', () => this.exportPointCsv());

    $('btn-csv').addEventListener('click', async () => {
      if (!this.sim) return;
      const csv = await this.sim.csv();
      this.download(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `miyako_tsunami_${this.currentRegion}_${Date.now()}.csv`);
    });

    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => this.scene.setCameraView(btn.dataset.view));
    });

    $('btn-lock-view').addEventListener('click', () => this.toggleLock());
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'l' || e.key === 'L') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) this.toggleLock();
    });

    // Hazard map / 2011 record
    this.buildDepthLegend();
    const legendUI = () =>
      ($('depth-legend').hidden = !['chk-hazardmap', 'chk-inund5', 'chk-inund2011', 'chk-maxdepth', 'chk-hazard'].some((id) => $(id).checked));
    $('chk-hazardmap').addEventListener('change', (e) => {
      this.scene.setOverlayVisible('hazard', e.target.checked);
      legendUI();
    });
    $('chk-inund5').addEventListener('change', (e) => {
      this.scene.setOverlayVisible('inund5', e.target.checked);
      legendUI();
      this.updateInundPanel();
    });
    $('chk-match').addEventListener('change', (e) => {
      this.scene.showMatch = e.target.checked;
      $('match-legend').hidden = !e.target.checked;
      this.frameDirty = true;
      this.updateInundPanel();
    });
    $('chk-inund2011').addEventListener('change', (e) => {
      this.scene.setOverlayVisible('inund2011', e.target.checked);
      legendUI();
      this.updateInundPanel();
    });
    $('chk-maxdepth').addEventListener('change', (e) => {
      this.scene.showMaxDepth = e.target.checked;
      this.frameDirty = true;
      legendUI();
    });
    $('chk-survey').addEventListener('change', (e) => {
      this.scene.setSurveyVisible(e.target.checked);
      this.updateSurveyPanel();
    });
    $('sel-aerial').addEventListener('change', (e) => this.scene.setAerial(e.target.value, this.aerialUrls));

    // Display options
    $('chk-hazard').addEventListener('change', (e) => {
      legendUI();
      this.scene.showHazardColors = e.target.checked;
      this.frameDirty = true;
    });
    $('chk-buildings').addEventListener('change', (e) => {
      if (this.scene.buildingsMesh) this.scene.buildingsMesh.visible = e.target.checked;
    });
    $('chk-bldg-focus').addEventListener('change', (e) => this.scene.setBuildingFocus({ enabled: e.target.checked }));
    $('sel-bldg-radius').addEventListener('change', (e) => this.scene.setBuildingFocus({ radius: Number(e.target.value) }));
    $('chk-labels').addEventListener('change', (e) => this.labelMgr?.setVisible(e.target.checked));
    $('chk-sourcezone').addEventListener('change', (e) => this.scene.setSourceZoneVisible(e.target.checked));
    $('chk-backdrop').addEventListener('change', (e) => {
      if (this.scene.outerMesh) this.scene.outerMesh.visible = e.target.checked;
    });

    // Video
    const camUI = () => {
      $('rec-orbit-row').hidden = $('rec-cam-mode').value !== 'orbit';
      $('rec-kf-row').hidden = $('rec-cam-mode').value !== 'keyframes';
      const moving = $('rec-cam-mode').value !== 'fixed';
      $('btn-kf-preview').hidden = !moving;
      $('rec-preview-hint').hidden = !moving;
    };
    $('rec-cam-mode').addEventListener('change', camUI);
    camUI();
    $('btn-kf-add').addEventListener('click', () => {
      this.keyframes.push(this.scene.getCameraPose());
      this.updateKfCount();
    });
    $('btn-kf-clear').addEventListener('click', () => {
      this.keyframes = [];
      this.updateKfCount();
    });
    $('btn-kf-preview').addEventListener('click', () => this.previewCameraPath());
    $('btn-record').addEventListener('click', () => this.startRecording());
    $('btn-rec-cancel').addEventListener('click', () => {
      this.recording?.abort();
      if (this.batching) this.sim.cancelBatch();
    });

    // Collapsible panels (state remembered per browser)
    this.bindCollapse('btn-toggle-sidebar', 'control-sidebar', 'miyako_tsunami_sidebar', ['◀', '▶']);
    this.bindCollapse('btn-toggle-chart', 'bottom-hud', 'miyako_tsunami_chart', ['▾', '▸']);
  }

  bindCollapse(btnId, panelId, storageKey, [openIcon, closedIcon]) {
    const btn = $(btnId);
    const panel = $(panelId);
    const apply = (collapsed) => {
      panel.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? closedIcon : openIcon;
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = t(collapsed ? 'expand' : 'collapse');
      if (!collapsed && this.onResize) this.onResize(); // chart canvas was 0×0 while hidden
    };
    let saved = false;
    try {
      saved = localStorage.getItem(storageKey) === '1';
    } catch {}
    apply(saved);
    btn.addEventListener('click', () => {
      const collapsed = !panel.classList.contains('collapsed');
      apply(collapsed);
      try {
        localStorage.setItem(storageKey, collapsed ? '1' : '0');
      } catch {}
    });
  }

  updateKfCount() {
    const n = this.keyframes.length;
    $('kf-count').textContent = getLang() === 'en' ? `${n} views` : `${n} 点`;
  }

  toggleLock() {
    if (this.recording) return;
    this.scene.setViewLocked(!this.scene.viewLocked);
    const btn = $('btn-lock-view');
    btn.textContent = t(this.scene.viewLocked ? 'unlockView' : 'lockView');
    btn.classList.toggle('active', this.scene.viewLocked);
  }

  /** Single click (no drag) = inspect point; double click = make that spot the centre of rotation. */
  setupPicking() {
    let down = null;
    let clickTimer = null;
    const ndc = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
    };

    this.canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    this.canvas.addEventListener('pointerup', (e) => {
      const isClick = down && e.button === 0 && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4;
      down = null;
      if (!isClick || this.recording) return;
      const [x, y] = ndc(e);
      clearTimeout(clickTimer);
      // wait briefly so a double-click does not also move the observation point
      clickTimer = setTimeout(() => this.pickPoint(x, y), 230);
    });
    this.canvas.addEventListener('dblclick', (e) => {
      clearTimeout(clickTimer);
      if (this.scene.viewLocked || this.recording) return;
      const p = this.scene.pickSurface(...ndc(e));
      if (p) this.scene.flyTo(p);
    });
  }

  initWaveCsvUI() {
    const fileInput = $('input-wave-csv');
    const dropZone = $('csv-drop-zone');
    const btnClear = $('btn-csv-clear');

    $('input-csv-scale').addEventListener('change', (e) => this.setCsvScale(parseFloat(e.target.value)));

    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (file) {
          await this.loadWaveCsvFile(file);
          fileInput.value = '';
        }
      });
    }

    if (dropZone) {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
      });
      dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file && (file.name.endsWith('.csv') || file.type.includes('csv') || file.type === 'text/plain')) {
          await this.loadWaveCsvFile(file);
        }
      });
    }

    // Global drag & drop on window for easy file drop
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file && file.name.endsWith('.csv')) {
        e.preventDefault();
        await this.loadWaveCsvFile(file);
      }
    });

    if (btnClear) {
      btnClear.addEventListener('click', () => {
        this.activeWaveProfile = null;
        this.hideCsvMetadataBadge();
        const sel = $('select-scenario');
        if (sel.value === 'csv_custom') {
          sel.value = 'nankai_trough';
          const sc = TSUNAMI_SCENARIOS.nankai_trough;
          if (sc) this.applyScenario(sc);
        } else {
          this.drawWavePreview();
        }
      });
    }
  }

  async loadWaveCsvFile(file) {
    try {
      const text = await file.text();
      const profile = WaveProfile.parse(text, file.name);
      this.activeWaveProfile = profile;

      TSUNAMI_SCENARIOS.csv_custom = {
        id: 'csv_custom',
        name: `波源CSV: ${profile.filename || profile.name}`,
        name_en: `Wave CSV: ${profile.filename || profile.name}`,
        waveHeight: profile.peakHeight,
        periodSec: profile.peakTimeSec || 600,
        directionDeg: profile.dominantDirectionDeg || 93,
        durationMin: Math.max(30, Math.ceil(profile.durationSec / 60)),
        hasPreDrawdown: profile.troughHeight < -0.1,
        isCsvWave: true,
        waveProfile: profile,
        description: `読み込み済み波源データ（${profile.location || file.name}）。最大波高 ${profile.peakHeight.toFixed(2)}m（到達: ${(profile.peakTimeSec / 60).toFixed(1)}分）、総時間 ${(profile.durationSec / 60).toFixed(1)}分、${profile.count}点。`,
        description_en: `Imported wave boundary data (${profile.location || file.name}). Peak surge ${profile.peakHeight.toFixed(2)}m (at ${(profile.peakTimeSec / 60).toFixed(1)} min), duration ${(profile.durationSec / 60).toFixed(1)} min, ${profile.count} samples.`,
      };

      const selScenario = $('select-scenario');
      selScenario.value = 'csv_custom';
      await this.applyScenario(TSUNAMI_SCENARIOS.csv_custom);
    } catch (err) {
      console.error('Failed to parse wave CSV:', err);
      alert(getLang() === 'en'
        ? `Error parsing wave CSV file: ${err.message}`
        : `波源CSVの読み込みに失敗しました: ${err.message}`);
    }
  }

  pickPoint(x, y) {
    const p = this.scene.pickSurface(x, y);
    if (!p || !this.sim) return;
    const { nx, ny, res } = this.regionMeta;
    const worldX = p.x + (nx * res) / 2;
    const worldZ = p.z + (ny * res) / 2;
    if (worldX < 0 || worldZ < 0 || worldX >= nx * res || worldZ >= ny * res) return;

    const gx = Math.floor(worldX / res);
    const gz = Math.floor(worldZ / res);
    const elevation = this.groundF32[gz * nx + gx];

    // Artificial wave pulse injection mode
    if (this.isPulseMode) {
      if (elevation < 0) {
        const h = parseFloat($('input-pulse-height')?.value) || 5.0;
        const deg = parseFloat($('input-wave-dir')?.value) || 90;
        this.sim.injectWave({
          worldX,
          worldZ,
          height: h,
          radius: 180,
          directionDeg: deg,
        });
        this.scene.setPin(p.x, p.z, elevation);
        this.frameDirty = true;
      }
      return;
    }

    this.selectedPoint = { worldX, worldZ };
    this.pointElevation = elevation;
    this.pointLog = [];
    this.sim.setPoint(this.selectedPoint);
    this.scene.setPin(p.x, p.z, elevation);
    this.scene.setBuildingFocus({ x: p.x, z: p.z });
    this.depthChart.setPoint({ elevation, waterDepth: 0, maxDepth: 0 });
    this.updatePointInspectionUI({ elevation, waterDepth: 0, maxDepth: 0 });
  }

  updatePointInspectionUI(info) {
    $('val-point-elev').textContent = `${info.elevation.toFixed(1)}m`;
    $('val-point-depth').textContent = `${info.waterDepth.toFixed(2)}m`;
    $('val-point-max-depth').textContent = `${info.maxDepth.toFixed(2)}m`;
  }

  updateScenarioDesc(sc) {
    $('scenario-desc').textContent = getLang() === 'en' ? sc.description_en : sc.description;
  }

  updateHUD() {
    const stats = this.sim?.stats;
    if (!stats) return;

    // 1. High precision Dual LAP & Earthquake timer
    const sec = this.sim.simTimeSec || 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    const timeEl = $('stat-time');
    if (timeEl) {
      timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
    }

    // Time since earthquake origin (seconds)
    // Offset comes from activeWaveProfile or scenario definition
    let offsetSec = 0;
    if (this.activeWaveProfile && this.activeWaveProfile.timeOffset != null) {
      offsetSec = this.activeWaveProfile.timeOffset;
    } else {
      const curSc = TSUNAMI_SCENARIOS[this.currentScenarioId];
      if (curSc && curSc.eqTimeOffsetSec != null) {
        offsetSec = curSc.eqTimeOffsetSec;
      }
    }

    const eqSec = Math.max(0, sec + offsetSec);
    const eqH = Math.floor(eqSec / 3600);
    const eqM = Math.floor((eqSec % 3600) / 60);
    const eqS = Math.floor(eqSec % 60);
    const eqTimeEl = $('stat-eq-time');
    if (eqTimeEl) {
      eqTimeEl.textContent = `${String(eqH).padStart(2, '0')}:${String(eqM).padStart(2, '0')}:${String(eqS).padStart(2, '0')}`;
    }

    const eqOffsetTag = $('stat-eq-offset-tag');
    if (eqOffsetTag) {
      if (offsetSec > 0) {
        const offMin = Math.round(offsetSec / 60);
        eqOffsetTag.textContent = `+${offMin}m`;
        eqOffsetTag.title = `地震発生から波源境界までのオフセット: ${offsetSec}秒 (${offMin}分)`;
      } else {
        eqOffsetTag.textContent = '⏱️ EQ';
        eqOffsetTag.title = '地震発生時を0秒として計算';
      }
    }

    // 2. Distance from wave front to coastline
    const distEl = $('stat-wave-dist');
    if (distEl) {
      if (stats.waveStatus === 'landfall' || (stats.waveFrontDistM !== undefined && stats.waveFrontDistM <= 0)) {
        distEl.textContent = getLang() === 'en' ? '⚠️ Shore Inundation!' : '⚠️ 沿岸到達・遡上中！';
        distEl.style.color = '#ff5252';
        distEl.classList.add('pulse-alert');
      } else {
        const dM = Math.round(stats.waveFrontDistM || 0);
        distEl.textContent = `${dM.toLocaleString()} m`;
        distEl.style.color = dM < 1500 ? '#ffd54f' : '#00e5ff';
        distEl.classList.remove('pulse-alert');
      }
    }

    // 3. Water heights: Offshore source (5.9km) vs Coastal Bay
    const offEta = stats.offshoreWaveHeight || 0;
    $('stat-wave-h').textContent = `${offEta >= 0 ? '+' : ''}${offEta.toFixed(1)} m`;

    const coastEl = $('stat-coastal-h');
    if (coastEl) {
      const cEta = stats.coastalWaveHeight || 0;
      coastEl.textContent = `${cEta >= 0 ? '+' : ''}${cEta.toFixed(1)} m`;
      coastEl.style.color = Math.abs(cEta) >= 1.0 ? '#ff80ab' : '#69f0ae';
    }

    $('stat-runup').textContent = `${stats.maxRunup.toFixed(1)} m`;
    $('stat-area').textContent = `${stats.inundatedAreaHa.toFixed(1)} ha`;
    $('stat-buildings').textContent = `${stats.inundatedBuildings} ${t('unitBldg')}`;

    const banner = $('overflow-banner');
    if (stats.isOvertopping) {
      banner.className = 'overflow-banner alert';
      banner.textContent = `${t('overflowOccurring')} (${stats.overtoppingCount} ${t('unitSpots')})`;
    } else {
      banner.className = 'overflow-banner';
      banner.textContent = t('overflowNone');
    }
  }

  updateLanguageTexts() {
    document.documentElement.lang = getLang();
    $('btn-lang').textContent = getLang() === 'ja' ? 'EN / 日本語' : '日本語 / EN';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    const isMiyako = this.currentRegion === 'miyako_port';
    const en = getLang() === 'en';
    const offEl = document.querySelector('[data-i18n="offshoreHeight"]');
    if (offEl) {
      offEl.textContent = isMiyako
        ? (en ? 'Wave Source (Bay Mouth)' : '波源 (宮古湾口・田老沖)')
        : (en ? 'Wave Source (5.9km Offshore)' : '波源 (田老沖5.9km)');
    }
    const coastEl = document.querySelector('[data-i18n="coastalHeight"]');
    if (coastEl) {
      coastEl.textContent = isMiyako
        ? (en ? 'Miyako Port (Seawall Front)' : '宮古港 (沿岸防潮堤前)')
        : (en ? 'Taro Bay (Seawall Front)' : '田老湾 (沿岸防潮堤前)');
    }
    const townEl = document.querySelector('[data-i18n="viewTown"]');
    if (townEl) {
      townEl.textContent = isMiyako
        ? (en ? 'Miyako City / Port' : '宮古市街地・港')
        : (en ? 'Taro Downtown' : '田老市街地');
    }
    $('btn-lock-view').textContent = t(this.scene.viewLocked ? 'unlockView' : 'lockView');
    for (const [btn, panel] of [['btn-toggle-sidebar', 'control-sidebar'], ['btn-toggle-chart', 'bottom-hud']]) {
      $(btn).title = t($(panel).classList.contains('collapsed') ? 'expand' : 'collapse');
    }
    $('btn-play').textContent = t(this.isSimulating ? 'pause' : 'play');
    const sc = TSUNAMI_SCENARIOS[$('select-scenario').value];
    if (sc) this.updateScenarioDesc(sc);
    this.updateDirLabel(parseFloat($('input-wave-dir').value));
    this.updateKfCount();
    this.updateBatchCount();
    this.drawWavePreview();
    this.updateHUD();
    this.updateSurveyPanel();
    this.updateInundPanel();
  }

  cameraPath() {
    const mode = $('rec-cam-mode').value;
    return makeCameraPath(mode, {
      current: this.scene.getCameraPose(),
      orbitDeg: Number($('rec-orbit-deg').value) || 90,
      keyframes: this.keyframes,
    });
  }

  /** Fly the camera along the recording path once (no recording). */
  previewCameraPath(seconds = 6) {
    if (this.recording) return;
    const start = this.scene.getCameraPose();
    const path = this.cameraPath();
    const wasLocked = this.scene.viewLocked;
    this.scene.setViewLocked(true);
    const t0 = performance.now();
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      const pose = path(u);
      this.scene.setCameraPose(pose.pos, pose.target);
      if (u < 1) requestAnimationFrame(step);
      else {
        this.scene.setCameraPose(start.pos, start.target);
        this.scene.setViewLocked(wasLocked);
      }
    };
    step();
  }

  async startRecording() {
    if (this.recording || !this.sim) return;
    const mode = $('rec-cam-mode').value;
    if (mode === 'keyframes' && this.keyframes.length < 2) {
      alert(getLang() === 'en' ? 'Add at least 2 views first.' : '先に視点を2つ以上追加してください。');
      return;
    }

    const [width, height] = $('rec-resolution').value.split('x').map(Number);
    const fps = Number($('rec-fps').value);
    const frames = Math.max(2, Math.round((Number($('rec-duration').value) || 20) * fps));
    const simPerFrame = ((Number($('rec-sim-minutes').value) || 15) * 60) / frames;
    const path = this.cameraPath();
    const startPose = this.scene.getCameraPose();

    const modal = $('record-modal');
    const fill = $('record-progress-fill');
    const statusText = $('record-status-text');
    modal.style.display = 'flex';
    statusText.textContent = t('recording');
    fill.style.width = '0%';

    const abort = new AbortController();
    this.recording = abort;
    const wasSimulating = this.isSimulating;
    this.setSimulating(false);

    // Render at the exact video size so the frame is not stretched
    const renderer = this.scene.renderer;
    const prevRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    this.scene.camera.aspect = width / height;
    this.scene.camera.updateProjectionMatrix();

    try {
      const res = await recordVideo({
        glCanvas: this.canvas,
        width,
        height,
        fps,
        frames,
        signal: abort.signal,
        renderFrame: async (i, u) => {
          if (i > 0) await this.sim.advance(simPerFrame);
          const f = this.sim.frame;
          this.scene.updateWater(f, this.groundF32);
          this.scene.updateBuildingDamage(f.bldgWet);
          this.logPoint();
          const pose = path(u);
          this.scene.setCameraPose(pose.pos, pose.target);
          this.scene.renderFrame();
        },
        drawOverlay: (ctx) => {
          const s = this.sim.stats;
          ctx.fillStyle = 'rgba(10, 25, 40, 0.8)';
          ctx.fillRect(20, 20, 330, 92);
          ctx.fillStyle = '#00e5ff';
          ctx.font = 'bold 15px sans-serif';
          ctx.fillText('Miyako Tsunami 3D Simulator', 35, 45);
          ctx.fillStyle = '#ffffff';
          ctx.font = '13px sans-serif';
          ctx.fillText(t('videoLine1').replace('{t}', (this.sim.simTimeSec / 60).toFixed(1)).replace('{h}', s.offshoreWaveHeight.toFixed(1)), 35, 70);
          ctx.fillText(t('videoLine2').replace('{a}', s.inundatedAreaHa.toFixed(1)).replace('{b}', s.inundatedBuildings), 35, 92);
        },
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          fill.style.width = `${pct}%`;
          statusText.textContent = `${t('recording')} (${pct}%)`;
        },
      });
      if (!abort.signal.aborted) {
        this.download(res.blob, `miyako_tsunami_${this.currentRegion}_${Date.now()}.${res.ext}`);
        statusText.textContent = t('recordDone');
      }
    } catch (e) {
      console.error('Recording error:', e);
      statusText.textContent = `Error: ${e.message}`;
    }

    renderer.setPixelRatio(prevRatio);
    this.onResize();
    this.scene.setCameraPose(startPose.pos, startPose.target);
    this.recording = null;
    this.frameDirty = true;
    setTimeout(() => (modal.style.display = 'none'), 1200);
    if (wasSimulating) this.setSimulating(true);
  }

  download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  setupResize() {
    this.onResize = () => {
      const w = this.canvas.parentElement.clientWidth;
      const h = this.canvas.parentElement.clientHeight;
      this.scene.resize(w, h);
      const dc = $('depth-chart-canvas');
      dc.width = dc.parentElement.clientWidth;
      dc.height = dc.parentElement.clientHeight;
    };
    window.addEventListener('resize', () => {
      if (!this.recording) this.onResize();
    });
    this.onResize();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new App();
});
