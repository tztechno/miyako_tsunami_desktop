// Turn a batch run into downloadable files (CSV, ESRI ASCII grids, conditions) and zip them.
import { makeZip } from './zip.js';
import { offshoreWaveEta } from './tsunamiSim.js';

// JGD2011 / Japan Plane Rectangular CS X (EPSG:6678), ESRI WKT for the .prj files
const PRJ_6678 =
  'PROJCS["JGD_2011_Japan_Zone_10",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",140.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",40.0],UNIT["Meter",1.0]]';

const BOM = '﻿';
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;

/** Crest times/heights of the offshore waveform within [0, durationSec] (local maxima ≥ 0.3 m). */
export function waveCrests(params, durationSec) {
  const crests = [];
  let prev = offshoreWaveEta(0, params);
  let cur = offshoreWaveEta(1, params);
  for (let t = 1; t < durationSec; t++) {
    const next = offshoreWaveEta(t + 1, params);
    if (cur >= prev && cur > next && cur >= 0.3) crests.push({ t, h: cur });
    prev = cur;
    cur = next;
  }
  return crests;
}

/** ESRI ASCII grid; row 0 is the northern edge. value(i) returns a number or null (NODATA). */
function asciiGrid(meta, value, decimals) {
  const { nx, ny, res, originE, originN } = meta;
  const lines = [
    `ncols ${nx}`,
    `nrows ${ny}`,
    `xllcorner ${originE}`,
    `yllcorner ${originN - ny * res}`,
    `cellsize ${res}`,
    'NODATA_value -9999',
  ];
  for (let j = 0; j < ny; j++) {
    const row = new Array(nx);
    for (let i = 0; i < nx; i++) {
      const v = value(j * nx + i);
      row[i] = v == null ? '-9999' : v.toFixed(decimals);
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n') + '\n';
}

/**
 * result: worker batchDone message. points: [{ name, lat, lon, e, n, elevation, cell, measured? }].
 * cond: human-readable conditions (label/value pairs). en: English headers.
 */
export function buildBatchZip({ result, points, meta, ground, cond, en, durationSec, waveParams }) {
  const L = (ja, eng) => (en ? eng : ja);
  const files = [];

  // 1. Whole-area timeline (every 10 s, from the simulator)
  files.push({ name: 'summary_timeline.csv', data: result.summaryCsv });

  // 2. Point time series (wide format)
  const head = [L('経過時間 (秒)', 'Elapsed (s)'), L('経過時間 (分)', 'Elapsed (min)'), L('沖合の水位 (m)', 'Offshore level (m)')];
  for (const p of points) head.push(`${p.name} ${L('水深', 'depth')} (m)`, `${p.name} ${L('水位', 'level')} (T.P. m)`);
  const pointMeta = points.map((p) => [p.name, p.lat.toFixed(6), p.lon.toFixed(6), p.elevation.toFixed(2)].map(q).join(','));
  const ts = [
    [L('地点', 'Point'), L('緯度', 'Latitude'), L('経度', 'Longitude'), L('地盤標高 (T.P. m)', 'Elevation (T.P. m)')].map(q).join(','),
    ...pointMeta,
    '',
    head.map(q).join(','),
    ...result.times.map((t, r) => {
      const row = result.rows[r];
      const cols = [Math.round(t), (t / 60).toFixed(2), row[0].toFixed(3)];
      for (let k = 0; k < points.length; k++) cols.push(row[1 + k * 2].toFixed(3), row[2 + k * 2].toFixed(3));
      return cols.join(',');
    }),
  ];
  if (points.length) files.push({ name: 'points_timeseries.csv', data: BOM + ts.join('\r\n') });

  // 3. Point summary
  if (points.length) {
    const sumHead = [
      L('地点', 'Point'), L('緯度', 'Latitude'), L('経度', 'Longitude'), L('地盤標高 (T.P. m)', 'Elevation (T.P. m)'),
      L('最大浸水深 (m)', 'Max depth (m)'), L('最大水位 (T.P. m)', 'Max level (T.P. m)'),
      L('最大水位の時刻 (分)', 'Time of max level (min)'), L('到達時刻 水深0.3m (分)', 'Arrival, depth 0.3m (min)'),
      L('2011年実測 (T.P. m)', '2011 measured (T.P. m)'), L('計算−実測 (m)', 'Sim − measured (m)'),
    ];
    const lines = [sumHead.map(q).join(',')];
    points.forEach((p, k) => {
      let maxLevel = -Infinity;
      let tMax = 0;
      result.rows.forEach((row, r) => {
        if (row[1 + k * 2] > 0.05 && row[2 + k * 2] > maxLevel) {
          maxLevel = row[2 + k * 2];
          tMax = result.times[r];
        }
      });
      const md = result.maxDepth[p.cell];
      const wet = ground[p.cell] < 0 || md >= 0.05;
      const arr = result.arrival[p.cell];
      const simLevel = wet ? ground[p.cell] + md : null;
      lines.push(
        [
          q(p.name), p.lat.toFixed(6), p.lon.toFixed(6), p.elevation.toFixed(2),
          wet ? md.toFixed(2) : '0', simLevel != null ? simLevel.toFixed(2) : '',
          Number.isFinite(maxLevel) ? (tMax / 60).toFixed(2) : '', arr >= 0 ? (arr / 60).toFixed(2) : '',
          p.measured != null ? p.measured.toFixed(2) : '',
          p.measured != null && simLevel != null ? (simLevel - p.measured).toFixed(2) : '',
        ].join(',')
      );
    });
    files.push({ name: 'points_summary.csv', data: BOM + lines.join('\r\n') });
  }

  // 4. Grids (land cells only; sea = NODATA)
  files.push({
    name: 'max_depth_m.asc',
    data: asciiGrid(meta, (i) => (ground[i] < 0 ? null : result.maxDepth[i] >= 0.01 ? result.maxDepth[i] : 0), 2),
  });
  files.push({ name: 'max_depth_m.prj', data: PRJ_6678 });
  files.push({
    name: 'arrival_time_min.asc',
    data: asciiGrid(meta, (i) => (ground[i] < 0 || result.arrival[i] < 0 ? null : result.arrival[i] / 60), 2),
  });
  files.push({ name: 'arrival_time_min.prj', data: PRJ_6678 });

  // 5. Conditions + offshore waveform crests
  const crests = waveCrests(waveParams, durationSec);
  const condText = [
    L('宮古・田老津波シミュレーター 一括計算結果', 'Miyako Tsunami Simulator — batch run'),
    `${L('作成日時', 'Created')}: ${new Date().toLocaleString()}`,
    '',
    ...cond.map(([k, v]) => `${k}: ${v}`),
    '',
    L('沖合の波の山（境界条件）:', 'Offshore wave crests (boundary condition):'),
    ...crests.map((c, k) => `  ${L(`第${k + 1}波`, `Wave ${k + 1}`)}: ${(c.t / 60).toFixed(1)} ${L('分', 'min')}, ${c.h.toFixed(2)} m`),
    '',
    L('ファイル:', 'Files:'),
    L('  summary_timeline.csv   10秒ごとの全体指標（沖合の水位・最大遡上高・浸水面積・浸水建物数・越流）', '  summary_timeline.csv   whole-area indicators every 10 s'),
    L('  points_timeseries.csv  観察地点の水深・水位（5秒ごと）', '  points_timeseries.csv  depth / level at the points every 5 s'),
    L('  points_summary.csv     地点ごとの最大浸水深・到達時刻・2011年実測との差', '  points_summary.csv     per-point max depth, arrival time, difference to 2011 measurements'),
    L('  max_depth_m.asc        最大浸水深の格子（5m, 平面直角座標系第X系 JGD2011, EPSG:6678）', '  max_depth_m.asc        max inundation depth grid (5 m, JGD2011 / Japan zone X, EPSG:6678)'),
    L('  arrival_time_min.asc   水深0.3mに達した時刻（分）の格子', '  arrival_time_min.asc   time (min) each cell first reached 0.3 m depth'),
    L('  ※ .asc は QGIS 等の GIS でそのまま開けます（.prj に座標系）。', '  * The .asc grids open directly in QGIS etc. (.prj holds the CRS).'),
  ].join('\r\n');
  files.push({ name: 'conditions.txt', data: BOM + condText });

  return makeZip(files);
}
