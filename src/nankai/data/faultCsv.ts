import { FaultParams, Hypocenter, RuptureParams } from '../types';

/**
 * 断層パラメータ CSV の読み書き
 *
 * 1行が1枚の矩形断層 (小断層) で、複数行で複数の断層 (すべり分布) を表す。
 * 各断層の Okada (1985) 変位は線形に重ね合わせる。
 *
 *   name,lon,lat,top_depth_km,length_km,width_km,strike_deg,dip_deg,rake_deg,slip_m
 *
 * - lon, lat: 断層面の地表投影の中心 (度)
 * - 深さは top_depth_km (断層上端) か center_depth_km (断層面中心) のどちらか
 *   (中心深さは 上端 = 中心 − (幅/2)·sin(傾斜) で上端に換算)
 * - すべり量は slip_m か slip_cm のどちらか
 * - name は省略可 (F1, F2, ...)
 *
 * '#' で始まる行はコメント。コメント中の key=value で震源と破壊伝播を指定できる (省略時は全域同時破壊):
 *   # hypocenter_lon=142.86, hypocenter_lat=38.10, hypocenter_depth_km=24
 *   # rupture_velocity_km_s=2.5, rise_time_s=60
 */

const RIGIDITY = 4.0e10;

type Lang = 'ja' | 'en';
const MSG = {
  ja: {
    line: (n: number) => `${n}行目`,
    headerLine: (n: number) => `${n}行目 (見出し行)`,
    missingCols: (c: string) => `必要な列がありません: ${c}`,
    or: 'または',
    ambiguousDepth: '列 "depth" は上端か中心かが曖昧です。top_depth_km または center_depth_km を使ってください。',
    notNumber: (c: string) => `${c} が数値ではありません`,
    noSlip: 'slip_m (または slip_cm) がありません',
    noDepth: 'top_depth_km (または center_depth_km) がありません',
    lonLatRange: '経度・緯度が範囲外です',
    outsideDomain: (lon: number, lat: number, d: Domain) => `断層の中心 (${lon}, ${lat}) が計算範囲 (${d.lonMin.toFixed(2)}〜${d.lonMax.toFixed(2)}°E, ${d.latMin.toFixed(2)}〜${d.latMax.toFixed(2)}°N) の外です`,
    length: 'length_km は 0 より大きく 2000 以下にしてください',
    width: 'width_km は 0 より大きく 500 以下にしてください',
    dip: 'dip_deg は 0 より大きく 90 以下にしてください',
    rake: 'rake_deg は −360〜360 にしてください',
    slip: 'すべり量は 0〜200 m にしてください (向きは rake_deg で指定)',
    topNeg: 'top_depth_km が負です',
    centerNeg: (t: string) => `center_depth_km から求めた上端深さが負になります (${t} km)。中心深さ・幅・傾斜を確認してください`,
    tooMany: (n: number) => `断層は最大 ${n} 行までです`,
    noHeader: '見出し行とデータ行がありません',
    noRows: '断層のデータ行がありません',
    ruptureNeedsHypo: 'rupture_velocity_km_s を使うには hypocenter_lon と hypocenter_lat も指定してください'
  },
  en: {
    line: (n: number) => `Line ${n}`,
    headerLine: (n: number) => `Line ${n} (header)`,
    missingCols: (c: string) => `required columns are missing: ${c}`,
    or: 'or',
    ambiguousDepth: 'column "depth" is ambiguous (top or center?). Use top_depth_km or center_depth_km.',
    notNumber: (c: string) => `${c} is not a number`,
    noSlip: 'slip_m (or slip_cm) is missing',
    noDepth: 'top_depth_km (or center_depth_km) is missing',
    lonLatRange: 'longitude/latitude out of range',
    outsideDomain: (lon: number, lat: number, d: Domain) => `fault center (${lon}, ${lat}) is outside the computational domain (${d.lonMin.toFixed(2)}–${d.lonMax.toFixed(2)}°E, ${d.latMin.toFixed(2)}–${d.latMax.toFixed(2)}°N)`,
    length: 'length_km must be > 0 and ≤ 2000',
    width: 'width_km must be > 0 and ≤ 500',
    dip: 'dip_deg must be > 0 and ≤ 90',
    rake: 'rake_deg must be between −360 and 360',
    slip: 'slip must be 0–200 m (give the direction with rake_deg)',
    topNeg: 'top_depth_km is negative',
    centerNeg: (t: string) => `the top depth derived from center_depth_km is negative (${t} km). Check center depth, width and dip`,
    tooMany: (n: number) => `at most ${n} fault rows are allowed`,
    noHeader: 'no header line or data rows',
    noRows: 'no fault data rows',
    ruptureNeedsHypo: 'rupture_velocity_km_s requires hypocenter_lon and hypocenter_lat'
  }
};
type Domain = { lonMin: number; lonMax: number; latMin: number; latMax: number };
export const MAX_FAULT_ROWS = 5000;

export interface FaultCsvResult {
  faults: FaultParams[];
  hypocenter?: Hypocenter;
  rupture?: RuptureParams;
  momentMagnitude: number;
  errors: string[];
}

type Field = 'name' | 'lon' | 'lat' | 'top' | 'center' | 'length' | 'width' | 'strike' | 'dip' | 'rake' | 'slipM' | 'slipCm';

// 列名 (小文字、空白・括弧内の単位を除いたもの) → 項目
const ALIASES: Record<string, Field> = {
  name: 'name', fault: 'name', id: 'name', '名前': 'name', '断層名': 'name',
  lon: 'lon', longitude: 'lon', center_lon: 'lon', '経度': 'lon',
  lat: 'lat', latitude: 'lat', center_lat: 'lat', '緯度': 'lat',
  top_depth_km: 'top', top_depth: 'top', depth_top_km: 'top', '上端深さ': 'top',
  center_depth_km: 'center', center_depth: 'center', depth_center_km: 'center', '中心深さ': 'center',
  length_km: 'length', length: 'length', '長さ': 'length',
  width_km: 'width', width: 'width', '幅': 'width',
  strike_deg: 'strike', strike: 'strike', '走向': 'strike',
  dip_deg: 'dip', dip: 'dip', '傾斜': 'dip', '傾斜角': 'dip',
  rake_deg: 'rake', rake: 'rake', 'すべり角': 'rake',
  slip_m: 'slipM', slip: 'slipM', 'すべり量': 'slipM',
  slip_cm: 'slipCm'
};

function normalizeHeader(h: string): string {
  return h
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[（(][^)）]*[)）]/g, '') // 「長さ(km)」などの単位を除く
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function detectDelimiter(line: string): string {
  if (line.includes('\t')) return '\t';
  if (!line.includes(',') && line.includes(';')) return ';';
  return ',';
}

function splitLine(line: string, delim: string): string[] {
  return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, '').trim());
}

/**
 * Mo = μ Σ D L W から Mw (log10 Mo = 1.5 Mw + 9.1)
 */
export function momentMagnitude(faults: FaultParams[]): number {
  let m0 = 0;
  for (const f of faults) m0 += RIGIDITY * Math.abs(f.slipM) * f.lengthKm * 1000 * f.widthKm * 1000;
  return m0 > 0 ? (Math.log10(m0) - 9.1) / 1.5 : 0;
}

export function parseFaultCsv(text: string, domain?: Domain, lang: Lang = 'ja'): FaultCsvResult {
  const t = MSG[lang];
  const errors: string[] = [];
  const meta: Record<string, number> = {};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);

  let header: (Field | null)[] | null = null;
  let delim = ',';
  const faults: FaultParams[] = [];

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li].trim();
    const lineNo = li + 1;
    if (!raw) continue;
    if (raw.startsWith('#')) {
      // コメント中の key=value
      for (const m of raw.matchAll(/([a-z_]+)\s*[=:]\s*(-?[\d.]+(?:e-?\d+)?)/gi)) {
        meta[m[1].toLowerCase()] = parseFloat(m[2]);
      }
      continue;
    }

    if (!header) {
      delim = detectDelimiter(raw);
      const cols = splitLine(raw, delim).map(normalizeHeader);
      header = cols.map((c) => ALIASES[c] ?? null);
      const has = (f: Field) => header!.includes(f);
      const missing: string[] = [];
      if (!has('lon')) missing.push('lon');
      if (!has('lat')) missing.push('lat');
      if (!has('top') && !has('center')) missing.push(`top_depth_km (${t.or} center_depth_km)`);
      if (!has('length')) missing.push('length_km');
      if (!has('width')) missing.push('width_km');
      if (!has('strike')) missing.push('strike_deg');
      if (!has('dip')) missing.push('dip_deg');
      if (!has('rake')) missing.push('rake_deg');
      if (!has('slipM') && !has('slipCm')) missing.push(`slip_m (${t.or} slip_cm)`);
      if (cols.includes('depth') || cols.includes('depth_km')) {
        errors.push(`${t.line(lineNo)}: ${t.ambiguousDepth}`);
      }
      if (missing.length > 0) {
        errors.push(`${t.headerLine(lineNo)}: ${t.missingCols(missing.join(', '))}`);
        return { faults: [], momentMagnitude: 0, errors };
      }
      continue;
    }

    const cells = splitLine(raw, delim);
    const rec: Partial<Record<Field, string>> = {};
    header.forEach((f, i) => {
      if (f && cells[i] !== undefined && cells[i] !== '') rec[f] = cells[i];
    });
    const num = (f: Field): number => (rec[f] === undefined ? NaN : Number(rec[f]));
    const rowErr: string[] = [];
    const need = (f: Field, label: string): number => {
      const v = num(f);
      if (!Number.isFinite(v)) rowErr.push(t.notNumber(label));
      return v;
    };

    const lon = need('lon', 'lon');
    const lat = need('lat', 'lat');
    const length = need('length', 'length_km');
    const width = need('width', 'width_km');
    const strike = need('strike', 'strike_deg');
    const dip = need('dip', 'dip_deg');
    const rake = need('rake', 'rake_deg');
    let slip = NaN;
    if (rec.slipM !== undefined) slip = need('slipM', 'slip_m');
    else if (rec.slipCm !== undefined) slip = need('slipCm', 'slip_cm') / 100;
    else rowErr.push(t.noSlip);

    let top = NaN;
    if (rec.top !== undefined) {
      top = need('top', 'top_depth_km');
    } else if (rec.center !== undefined) {
      const center = need('center', 'center_depth_km');
      top = center - (width / 2) * Math.sin((dip * Math.PI) / 180);
    } else {
      rowErr.push(t.noDepth);
    }

    // 数値として読めた項目は範囲も確認し、1行の誤りをまとめて報告する
    const ok = Number.isFinite;
    if (ok(lon) && ok(lat)) {
      if (lon < -180 || lon > 360 || lat < -90 || lat > 90) rowErr.push(t.lonLatRange);
      else if (domain && (lon < domain.lonMin || lon > domain.lonMax || lat < domain.latMin || lat > domain.latMax)) {
        rowErr.push(t.outsideDomain(lon, lat, domain));
      }
    }
    if (ok(length) && (!(length > 0) || length > 2000)) rowErr.push(t.length);
    if (ok(width) && (!(width > 0) || width > 500)) rowErr.push(t.width);
    if (ok(dip) && (!(dip > 0) || dip > 90)) rowErr.push(t.dip);
    if (ok(rake) && (rake < -360 || rake > 360)) rowErr.push(t.rake);
    if (ok(slip) && (slip < 0 || slip > 200)) rowErr.push(t.slip);
    if (ok(top) && top < 0) rowErr.push(rec.top !== undefined ? t.topNeg : t.centerNeg(top.toFixed(2)));

    if (rowErr.length > 0) {
      errors.push(`${t.line(lineNo)}: ${rowErr.join(' / ')}`);
      continue;
    }
    if (faults.length >= MAX_FAULT_ROWS) {
      errors.push(t.tooMany(MAX_FAULT_ROWS));
      break;
    }

    faults.push({
      name: rec.name ?? `F${faults.length + 1}`,
      epicenterLon: lon,
      epicenterLat: lat,
      depthKm: Math.max(0.1, top), // 上端が地表ちょうどだと地表で特異になるため 0.1 km を下限にする
      lengthKm: length,
      widthKm: width,
      strikeDeg: ((strike % 360) + 360) % 360,
      dipDeg: dip,
      rakeDeg: rake,
      slipM: slip
    });
  }

  if (!header) errors.push(t.noHeader);
  else if (faults.length === 0 && errors.length === 0) errors.push(t.noRows);

  // 震源と破壊伝播 (任意)
  let hypocenter: Hypocenter | undefined;
  let rupture: RuptureParams | undefined;
  const hLon = meta['hypocenter_lon'];
  const hLat = meta['hypocenter_lat'];
  if (Number.isFinite(hLon) && Number.isFinite(hLat)) {
    const v = meta['rupture_velocity_km_s'];
    const hasRupture = Number.isFinite(v) && v > 0;
    hypocenter = {
      lon: hLon,
      lat: hLat,
      depthKm: Number.isFinite(meta['hypocenter_depth_km']) ? meta['hypocenter_depth_km'] : undefined
    };
    if (hasRupture) {
      const rise = meta['rise_time_s'];
      rupture = { lon: hLon, lat: hLat, velocityKmS: v, riseTimeSec: Number.isFinite(rise) && rise > 0 ? rise : 60 };
    }
  } else if (Number.isFinite(meta['rupture_velocity_km_s'])) {
    errors.push(t.ruptureNeedsHypo);
  }

  return { faults, hypocenter, rupture, momentMagnitude: momentMagnitude(faults), errors };
}

/**
 * 現在の断層モデルを CSV にする (読み込みと同じ形式。テンプレートとしても使える)
 */
export function faultsToCsv(faults: FaultParams[], title: string, hypocenter?: Hypocenter, rupture?: RuptureParams): string {
  const r = (v: number, d: number) => Number(v.toFixed(d)).toString();
  const lines: string[] = [];
  lines.push(`# Fault model: ${title}`);
  lines.push(`# Mw (rigidity 40 GPa) = ${momentMagnitude(faults).toFixed(2)}, faults = ${faults.length}`);
  lines.push('# lon/lat = center of the surface projection of each fault plane; top_depth_km = depth of the upper edge');
  if (hypocenter) {
    const depth = hypocenter.depthKm !== undefined ? `, hypocenter_depth_km=${hypocenter.depthKm}` : '';
    lines.push(`# hypocenter_lon=${hypocenter.lon}, hypocenter_lat=${hypocenter.lat}${depth}`);
  }
  if (rupture) {
    lines.push(`# rupture_velocity_km_s=${rupture.velocityKmS}, rise_time_s=${rupture.riseTimeSec}`);
  }
  lines.push('name,lon,lat,top_depth_km,length_km,width_km,strike_deg,dip_deg,rake_deg,slip_m');
  for (const f of faults) {
    // 区切り文字と衝突しないよう、名前の , ; タブ " は空白に置き換える
    const name = f.name.replace(/[",;\t]/g, ' ').trim() || 'F';
    lines.push([
      name, r(f.epicenterLon, 4), r(f.epicenterLat, 4), r(f.depthKm, 2), r(f.lengthKm, 2), r(f.widthKm, 2),
      r(f.strikeDeg, 1), r(f.dipDeg, 1), r(f.rakeDeg, 1), r(f.slipM, 2)
    ].join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
