/**
 * Preset boundary waves from nankai_trough results (.cache/nankai_<scenario>.json, written by
 * tools/nankai/run-nankai.ts), for each region:
 *   <scenario>_<region>_edges.json  waveforms at the stations along the region's inflow edges (src/edgePath.js),
 *                                   each relative to its own first value (the coseismic change: the terrain is
 *                                   surveyed after 2011, so the land's subsidence is already in it)
 *                                   { p: metres along the edges, dtSec, count, eta: count values per station }
 *   <scenario>_<region>_edge.csv    the station in the middle of the edges, in nankai_trough's full-timeline CSV
 *                                   format, for the app's CSV badge, preview and multiplier
 *
 *   node tools/build-wave-sources.mjs <run.json>[:<scenario>[:<key>[:<fromSec>:<toSec>]]] ...
 *   e.g. .cache/nankai_tohoku_2011_m90.json  .cache/nankai_nankai_full_m9.json:nankai_full_m9:nankai_full_m9_2h:5400:12600
 *   With a window, time 0 of the files is fromSec after the earthquake (the CSV says so in its Time Offset line).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appRoot, 'public', 'data', 'wave_sources');
const REGIONS = ['taro', 'miyako_port'];
const EDGE_DT_SEC = 6;

const row = (r) => `${r.elevation.toFixed(3)},${r.u.toFixed(3)},${r.v.toFixed(3)},${r.speed.toFixed(3)},${r.directionDeg.toFixed(1)}`;

function csv(pt, from, to) {
  const lines = [
    '# Tsunami Wave Boundary Condition for Phase 2 Simulation (Full Timeline)',
    `# Location: ${pt.name} (Lon: ${pt.lon}, Lat: ${pt.lat})`,
    `# Max Wave Height: ${pt.maxWaveHeight ?? 0} m, First Arrival: ${pt.firstArrivalSec ?? 'N/A'} s`,
    ...(from > 0 ? [`# Time Offset: ${from} s (Absolute_Time_sec = Time_sec + ${from})`] : []),
    'Time_sec,Elevation_m,U_velocity_m_s,V_velocity_m_s,Speed_m_s,Direction_deg',
  ];
  for (const r of pt.timeHistory) if (r.timeSec >= from && r.timeSec <= to) lines.push(`${(r.timeSec - from).toFixed(1)},${row(r)}`);
  return '﻿' + lines.join('\r\n');
}

fs.mkdirSync(outDir, { recursive: true });
for (const arg of process.argv.slice(2)) {
  const [file, only, keyArg, fromArg, toArg] = arg.split(':');
  const from = +(fromArg || 0), to = toArg ? +toArg : Infinity;
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [scenario, { name, points }] of Object.entries(all)) {
    if (only && scenario !== only) continue;
    for (const region of REGIONS) {
      const st = points.filter((p) => p.region === region).sort((a, b) => a.p - b.p);
      if (!st.length) continue;
      const hist = st[0].timeHistory, dt0 = hist[1].timeSec - hist[0].timeSec, every = Math.max(1, Math.round(EDGE_DT_SEC / dt0));
      const k0 = Math.round(from / dt0), kEnd = Math.min(hist.length, Number.isFinite(to) ? Math.round(to / dt0) + 1 : hist.length);
      const n = Math.floor((kEnd - k0) / every);
      const eta = [];
      for (const s of st) {
        const base = s.timeHistory[0].elevation;
        for (let k = 0; k < n; k++) eta.push(+(s.timeHistory[k0 + k * every].elevation - base).toFixed(3));
      }
      const key = `${keyArg || scenario}_${region}`;
      fs.writeFileSync(path.join(outDir, `${key}_edges.json`), JSON.stringify({ scenario: name, dtSec: every * dt0, count: n, p: st.map((s) => s.p), lon: st.map((s) => s.lon), lat: st.map((s) => s.lat), eta }));
      const mid = st[Math.floor(st.length / 2)];
      fs.writeFileSync(path.join(outDir, `${key}_edge.csv`), csv({ ...mid, name: `${name} 計算域の縁 (${region})` }, from, to));
      const maxes = st.map((s) => s.maxWaveHeight);
      console.log(`${key}: ${st.length} stations, ${n} samples every ${every * dt0} s, edge max ${Math.min(...maxes).toFixed(2)}..${Math.max(...maxes).toFixed(2)} m, first ${st.map((s) => s.timeHistory[0].elevation.toFixed(2)).slice(0, 3).join(',')}..`);
    }
  }
}
