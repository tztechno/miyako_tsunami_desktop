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
import { offshoreWaveEta } from './tsunamiSim.js';

const RENDER_STEP = 2; // water mesh = every 2nd sim cell (10 m)
const $ = (id) => document.getElementById(id);

const COMPASS_JA = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南'];
const COMPASS_EN = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S'];
const compass = (deg) => {
  const k = Math.max(0, Math.min(8, Math.round(deg / 22.5)));
  return (getLang() === 'en' ? COMPASS_EN : COMPASS_JA)[k];
};

class App {
  constructor() {
    this.canvas = $('gl-canvas');
    this.scene = new TsunamiScene(this.canvas);
    this.depthChart = new DepthChart($('depth-chart-canvas'));

    this.currentRegion = 'taro';
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
      [L('来襲方向', 'Wave coming from'), $('val-wave-dir').textContent],
      [L('防潮堤', 'Seawall'), `${sw.selectedOptions[0]?.textContent || sw.value} / ${L('天端', 'crest')} ${$('input-seawall-height').value}m`],
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

  async loadRegion(regionName) {
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
    const ground = new Float32Array(await (await fetch(`data/regions/${regionName}/ground.f32`)).arrayBuffer());
    let buildings = [];
    try {
      const bRes = await fetch(`data/regions/${regionName}/buildings.json`);
      if (bRes.ok) buildings = await bRes.json();
    } catch {}
    if (token !== this.loadToken) return; // a newer region switch superseded this one

    this.regionMeta = meta;
    this.groundF32 = ground;
    this.buildings = buildings;

    this.scene.clearAerialCache();
    await this.scene.buildTerrain(meta, ground, `data/regions/${regionName}/aerial.jpg`);
    this.scene.aerialCache.now = this.scene.groundMesh.material.map;
    this.aerialUrls = { now: `data/regions/${regionName}/aerial.jpg`, y2011: `data/regions/${regionName}/aerial_2011.jpg` };
    if ($('sel-aerial').value !== 'now') await this.scene.setAerial($('sel-aerial').value, this.aerialUrls);
    await this.scene.buildOverlay('hazard', `data/regions/${regionName}/hazard_tsunami.png`);
    this.scene.setOverlayVisible('hazard', $('chk-hazardmap').checked);
    await this.scene.buildOverlay('inund2011', `data/regions/${regionName}/inund2011.png`);
    this.scene.setOverlayVisible('inund2011', $('chk-inund2011').checked);
    await this.scene.buildOverlay('inund5', `data/regions/${regionName}/inund2011_5m.png`, { nearest: true });
    this.scene.setOverlayVisible('inund5', $('chk-inund5').checked);
    this.scene.buildWaterMesh(meta, RENDER_STEP);
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
    const swPreset = $('select-seawall').value;
    this.seawallMgr.setPreset(swPreset === 'custom' ? 'custom' : swPreset, parseFloat($('input-seawall-height').value));

    this.sim = new SimClient({
      meta,
      ground,
      buildings,
      seawallMgr: this.seawallMgr,
      renderStep: RENDER_STEP,
      onFrame: () => (this.frameDirty = true),
    });
    await this.loadSurvey(regionName, meta, ground);
    await this.loadInund2011(regionName);
    await this.loadInund5(regionName);

    this.depthChart.setPoint(null);
    this.labelMgr = new LabelManager($('label-container'), meta);
    await this.labelMgr.loadLabels();
    this.labelMgr.setVisible($('chk-labels').checked);

    this.scene.setCameraView('viewCoast');

    const sc = TSUNAMI_SCENARIOS[$('select-scenario').value] || TSUNAMI_SCENARIOS.great_east_japan;
    this.applyScenario(sc);
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
    box.innerHTML = en
      ? `Water reached <b>${sum.reached}/${sum.n}</b> points · within ±2m <b>${sum.within}</b><br>Mean (sim − measured) <b>${f(sum.meanDiff)}</b> · RMSE <b>${Number.isFinite(sum.rmse) ? sum.rmse.toFixed(1) + 'm' : '--'}</b>`
      : `水が届いた地点 <b>${sum.reached}/${sum.n}</b>・差±2m以内 <b>${sum.within}</b><br>平均の差（計算−実測） <b>${f(sum.meanDiff)}</b>・RMSE <b>${Number.isFinite(sum.rmse) ? sum.rmse.toFixed(1) + 'm' : '--'}</b>`;
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

  applyScenario(sc) {
    this.setSimulating(false);
    this.sim.setScenario(sc);
    this.updateScenarioDesc(sc);
    $('input-wave-height').value = sc.waveHeight;
    $('val-wave-height').textContent = `${sc.waveHeight.toFixed(1)}m`;
    $('input-wave-dir').value = sc.directionDeg;
    this.updateDirLabel(sc.directionDeg);
    this.depthChart.history = [];
    this.waveParams = { waveHeight: sc.waveHeight, wavePeriod: sc.periodSec, hasPreDrawdown: !!sc.hasPreDrawdown };
    $('batch-minutes').value = sc.durationMin || 30;
    this.drawWavePreview();
  }

  /** Offshore boundary waveform over the batch duration, with each crest marked. */
  drawWavePreview() {
    const cv = $('wave-preview');
    if (!this.waveParams || !cv.clientWidth) return;
    const w = (cv.width = cv.clientWidth);
    const h = (cv.height = cv.clientHeight);
    const ctx = cv.getContext('2d');
    const dur = Math.max(60, (Number($('batch-minutes').value) || 30) * 60);
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
    const en = getLang() === 'en';
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
          [L('周期 (秒)', 'Period (s)'), this.waveParams.wavePeriod],
          [L('来襲方向', 'Wave coming from'), $('val-wave-dir').textContent],
          [L('防潮堤', 'Seawall'), `${sw.selectedOptions[0]?.textContent || sw.value} / ${L('天端', 'crest')} ${$('input-seawall-height').value}m`],
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
    $('val-wave-dir').textContent = `${deg}° ${compass(deg)}`;
  }

  setSimulating(on) {
    if (on && this.batching) return; // the batch run owns the simulation until it finishes
    this.isSimulating = on;
    if (this.sim) on ? this.sim.play() : this.sim.pause();
    $('btn-play').textContent = on ? t('pause') : t('play');
  }

  syncSeawall() {
    this.sim?.setBarriers(this.seawallMgr);
    this.updateHUD();
  }

  bindUI() {
    $('btn-lang').addEventListener('click', () => {
      setLang(getLang() === 'ja' ? 'en' : 'ja');
      this.updateLanguageTexts();
      this.labelMgr?.updateLanguage();
    });

    $('select-region').addEventListener('change', (e) => {
      this.currentRegion = e.target.value;
      this.loadRegion(this.currentRegion);
    });

    const selScenario = $('select-scenario');
    selScenario.addEventListener('change', (e) => {
      const sc = TSUNAMI_SCENARIOS[e.target.value];
      if (!sc) return;
      this.applyScenario(sc);
      if (sc.recommendedSeawall && this.currentRegion === 'taro') {
        $('select-seawall').value = sc.recommendedSeawall;
        this.seawallMgr.setPreset(sc.recommendedSeawall);
        $('input-seawall-height').value = this.seawallMgr.customHeight;
        $('val-seawall-height').textContent = `${this.seawallMgr.customHeight.toFixed(1)}m`;
        this.syncSeawall();
      }
    });

    $('select-seawall').addEventListener('change', (e) => {
      const preset = e.target.value;
      const h = preset === 'none' ? 0.0 : 10.0;
      this.seawallMgr.setPreset(preset, h);
      $('input-seawall-height').value = h;
      $('val-seawall-height').textContent = `${h.toFixed(1)}m`;
      this.syncSeawall();
    });

    $('input-seawall-height').addEventListener('input', (e) => {
      const h = parseFloat(e.target.value);
      $('val-seawall-height').textContent = `${h.toFixed(1)}m`;
      this.seawallMgr.setCustomHeight(h);
      $('select-seawall').value = 'custom';
      this.syncSeawall();
    });

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
      $('val-wave-height').textContent = `${h.toFixed(1)}m`;
      this.sim.setCustomWave({ height: h });
      if (this.waveParams) {
        this.waveParams.waveHeight = h;
        this.drawWavePreview();
      }
      selScenario.value = 'custom';
    });

    $('input-wave-dir').addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value);
      this.updateDirLabel(deg);
      this.sim.setCustomWave({ direction: deg });
      selScenario.value = 'custom';
    });

    $('btn-play').addEventListener('click', () => this.setSimulating(!this.isSimulating));

    $('btn-reset').addEventListener('click', () => {
      if (this.batching) return;
      this.setSimulating(false);
      this.sim.reset();
      this.depthChart.history = [];
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
    $('stat-time').textContent = `${stats.simTimeMin} ${t('unitMin')}`;
    $('stat-wave-h').textContent = `${stats.offshoreWaveHeight.toFixed(1)} m`;
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
