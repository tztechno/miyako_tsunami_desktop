import { BathymetryMeta, ObservationPoint, RuptureParams } from '../types';

/**
 * 格子規模の数値振動 (2Δx モード) を抑える平滑化フィルター
 *  - shapiro4: 4次 Shapiro フィルター  η ← η − (ε/16)(δx⁴η + δy⁴η)
 *              2Δx 波を ε の割合で減衰させつつ、長い波への影響は sin⁴(kΔ/2) に比例して小さい
 *  - laplacian: ラプラシアン平滑化     η ← η + κ·(近傍平均 − η)  (旧来の方式。長い波も sin²(kΔ/2) で減衰)
 *  - none: フィルターなし
 */
export type FilterMode = 'shapiro4' | 'laplacian' | 'none';

export const FILTER_PRESETS: Record<string, { mode: FilterMode; strength: number }> = {
  shapiro4: { mode: 'shapiro4', strength: 0.1 },
  laplacianWeak: { mode: 'laplacian', strength: 0.005 },
  laplacianLegacy: { mode: 'laplacian', strength: 0.03 },
  none: { mode: 'none', strength: 0 }
};

// 外洋境界の吸収層 (スポンジ層) の幅 (セル) と最大減衰率 (1ステップあたり)
const SPONGE_CELLS = 40;
const SPONGE_MAX_DAMPING = 0.05;

/**
 * 2次元浅水流方程式（Shallow Water Equations）ソルバー
 * スタガード格子（Arakawa C-grid）およびリープフロッグ時間積分
 */
export class ShallowWaterSolver {
  public width: number;
  public height: number;
  public dx: number;
  public dy: number;
  // 緯度依存の東西格子間隔 (行ごと, m) と球面補正係数 cos(緯度)
  private dxRow: Float64Array;
  private cosCenter: Float64Array; // セル中心の cosφ
  private cosFace: Float64Array;   // 行 r と r+1 の境界 (N フラックス位置) の cosφ
  private sampleEverySteps: number;
  // 入れ子格子 (高解像度の部分領域) として使う場合: 外周1列の水位は外側の粗い格子から与え、吸収層・放射条件は使わない
  public readonly nested: boolean;
  // 波が存在しうる計算領域 (行・列の範囲)。CFL条件により1ステップで広がるのは高々数セル
  private activeR0 = 0;
  private activeR1 = 0;
  private activeC0 = 0;
  private activeC1 = 0;
  // 破壊伝播による時間発展する波源 (対象セル, 最終変位, 破壊到達時刻)
  private srcIdx: Int32Array | null = null;
  private srcAmp: Float32Array | null = null;
  private srcOnset: Float32Array | null = null;
  private srcRise = 60;
  private srcEndSec = 0;

  // 平滑化フィルター
  public filterMode: FilterMode = 'shapiro4';
  public filterStrength = 0.1;
  // 吸収層の減衰係数 (1 = 減衰なし)。外周 SPONGE_CELLS セルで外側ほど強く減衰させ、境界での反射を防ぐ
  private sponge: Float32Array;
  public g: number = 9.80665;
  public dt: number;

  // 水深データ (h > 0: 海, h <= 0: 陸)
  public depth: Float32Array;
  // 静水面からの水位変動 (m)
  public eta: Float32Array;
  // 平滑化・安定化用テンポラリバッファ
  private etaTemp: Float32Array;
  // 前ステップの水位
  private etaPrev: Float32Array;
  // 水平流量フラックス M = u * (h + eta) (m^2/s)
  public M: Float32Array;
  // 鉛直（南北）流量フラックス N = v * (h + eta) (m^2/s)
  public N: Float32Array;

  // 最大波高記録 (m)
  public maxEta: Float32Array;
  // 第1波到達時刻記録 (sec, 水位 > 0.1m)
  public arrivalTime: Float32Array;

  // 観測点リスト
  public observationPoints: ObservationPoint[] = [];

  // 物理定数
  private manningN: number = 0.025; // 海底粗度係数 (Manning's n)
  public currentTimeSec: number = 0;
  public currentStep: number = 0;
  private metaBounds: BathymetryMeta['bounds'];

  constructor(meta: BathymetryMeta, rawBathymetry: Int16Array, dtSec: number = 2.0, options: { nested?: boolean } = {}) {
    this.nested = options.nested === true;
    this.width = meta.width;
    this.height = meta.height;
    this.dx = meta.dxMeters;
    this.dy = meta.dyMeters;
    this.dt = dtSec;
    this.metaBounds = meta.bounds;

    // 全国版では南北に約26度の範囲を持つため、東西格子間隔を緯度ごとに求める
    const dLat = (meta.bounds.latMax - meta.bounds.latMin) / this.height;
    const dLon = (meta.bounds.lonMax - meta.bounds.lonMin) / this.width;
    this.dxRow = new Float64Array(this.height);
    this.cosCenter = new Float64Array(this.height);
    this.cosFace = new Float64Array(this.height);
    let minDx = Infinity;
    for (let r = 0; r < this.height; r++) {
      const latC = meta.bounds.latMax - (r + 0.5) * dLat;
      const latF = meta.bounds.latMax - (r + 1) * dLat;
      this.cosCenter[r] = Math.cos((latC * Math.PI) / 180);
      this.cosFace[r] = Math.cos((latF * Math.PI) / 180);
      this.dxRow[r] = dLon * 111320 * this.cosCenter[r];
      if (this.dxRow[r] < minDx) minDx = this.dxRow[r];
    }

    const size = this.width * this.height;
    this.depth = new Float32Array(size);
    this.eta = new Float32Array(size);
    this.etaTemp = new Float32Array(size);
    this.etaPrev = new Float32Array(size);
    this.M = new Float32Array(size);
    this.N = new Float32Array(size);
    this.maxEta = new Float32Array(size);
    this.arrivalTime = new Float32Array(size).fill(-1);

    // GEBCO rawBathymetry: 標高値 (海は負, 陸は正)
    // 水深 h: 海は正 (h = -z), 陸は 0
    let maxDepth = 10;
    for (let i = 0; i < size; i++) {
      const z = rawBathymetry[i];
      if (z < 0) {
        this.depth[i] = -z;
        if (-z > maxDepth) maxDepth = -z;
      } else {
        this.depth[i] = 0; // 陸地
      }
    }

    // CFL安定条件チェック
    const cMax = Math.sqrt(this.g * maxDepth);
    const dtCfl = Math.min(minDx, this.dy) / (Math.SQRT2 * cMax);
    if (this.dt > dtCfl * 0.9) {
      this.dt = Number((dtCfl * 0.8).toFixed(2));
      console.log(`Adjusted dt to CFL condition: ${this.dt}s (max depth: ${maxDepth}m, cMax: ${cMax.toFixed(1)}m/s)`);
    }

    // 観測点のサンプリング間隔を約4秒に揃える (入れ子格子は外側の格子と同じ時刻に記録するので、外から呼ぶ)
    this.sampleEverySteps = this.nested ? Infinity : Math.max(1, Math.round(4 / this.dt));

    // 吸収層: 外周からの距離 d (セル) に対し、毎ステップ (1 − α_max ((S−d)/S)²) 倍に減衰させる
    this.sponge = new Float32Array(size).fill(1);
    for (let r = 0; r < this.height && !this.nested; r++) {
      for (let c = 0; c < this.width; c++) {
        const d = Math.min(r, c, this.height - 1 - r, this.width - 1 - c);
        if (d < SPONGE_CELLS) {
          const t = (SPONGE_CELLS - d) / SPONGE_CELLS;
          this.sponge[r * this.width + c] = 1 - SPONGE_MAX_DAMPING * t * t;
        }
      }
    }
  }

  /**
   * 観測点を記録するステップ間隔
   */
  public get samplingInterval(): number {
    return this.sampleEverySteps;
  }

  /**
   * 初期海面変位を設定してシミュレーションを初期化
   */
  public resetWithDisplacement(eta0: Float32Array, rupture?: RuptureParams): void {
    const size = this.width * this.height;
    this.currentTimeSec = 0;
    this.currentStep = 0;
    this.srcIdx = null;
    this.srcAmp = null;
    this.srcOnset = null;

    // 破壊伝播あり: 各セルの変位は「破壊開始点からの距離 / 破壊伝播速度」の時刻から、ライズタイムをかけて線形に生じる
    // (地表セルの距離で近似。破壊開始点の深さは考慮しない)
    if (rupture) {
      const idxList: number[] = [];
      for (let i = 0; i < size; i++) {
        if (this.depth[i] > 5 && Math.abs(eta0[i]) > 1e-4) idxList.push(i);
      }
      this.srcIdx = Int32Array.from(idxList);
      this.srcAmp = new Float32Array(idxList.length);
      this.srcOnset = new Float32Array(idxList.length);
      this.srcRise = Math.max(1, rupture.riseTimeSec);
      const { lonMin, lonMax, latMin, latMax } = this.metaBounds;
      const kmLat = 111.32;
      const kmLon = kmLat * Math.cos((rupture.lat * Math.PI) / 180);
      let maxOnset = 0;
      idxList.forEach((idx, k) => {
        const r = Math.floor(idx / this.width);
        const c = idx - r * this.width;
        const lon = lonMin + ((c + 0.5) / this.width) * (lonMax - lonMin);
        const lat = latMax - ((r + 0.5) / this.height) * (latMax - latMin);
        const distKm = Math.hypot((lon - rupture.lon) * kmLon, (lat - rupture.lat) * kmLat);
        this.srcAmp![k] = eta0[idx];
        this.srcOnset![k] = distKm / rupture.velocityKmS;
        if (this.srcOnset![k] > maxOnset) maxOnset = this.srcOnset![k];
      });
      this.srcEndSec = maxOnset + this.srcRise;
    }

    for (let i = 0; i < size; i++) {
      // 陸地でないセルにのみ海面変位を与える (破壊伝播ありの場合は時間とともに加える)
      if (this.depth[i] > 5) {
        const initial = rupture ? 0 : eta0[i];
        this.eta[i] = initial;
        this.etaPrev[i] = initial;
        this.maxEta[i] = Math.max(0, initial);
      } else {
        this.eta[i] = 0;
        this.etaPrev[i] = 0;
        this.maxEta[i] = 0;
      }
      this.M[i] = 0;
      this.N[i] = 0;
      this.etaTemp[i] = 0;
      this.arrivalTime[i] = -1;
    }

    // 初期変位 (破壊伝播ありは最終変位) のある範囲からアクティブ領域を初期化
    let r0 = this.height, r1 = -1, c0 = this.width, c1 = -1;
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const i = r * this.width + c;
        if (this.depth[i] > 5 && Math.abs(eta0[i]) > 1e-6) {
          if (r < r0) r0 = r;
          if (r > r1) r1 = r;
          if (c < c0) c0 = c;
          if (c > c1) c1 = c;
        }
      }
    }
    this.activeR0 = r0;
    this.activeR1 = r1;
    this.activeC0 = c0;
    this.activeC1 = c1;
    // 入れ子格子は外周から波が入ってくるので、常に全域を計算する
    if (this.nested) {
      this.activeR0 = 1;
      this.activeR1 = this.height - 2;
      this.activeC0 = 1;
      this.activeC1 = this.width - 2;
    }

    // 観測点履歴をクリア
    for (const pt of this.observationPoints) {
      pt.timeHistory = [];
      pt.maxWaveHeight = undefined;
      pt.minWaveHeight = undefined;
      pt.firstArrivalSec = undefined;
      pt.maxArrivalSec = undefined;
      pt.dominantDirectionDeg = undefined;
    }

    // t=0 の初期状態をサンプリング
    this.sampleObservationPoints();
  }

  /**
   * 1タイムステップ進行 (Arakawa C-grid Leapfrog scheme)
   */
  public step(): void {
    const W = this.width;
    const H = this.height;
    const dt = this.dt;
    const dy = this.dy;
    const g = this.g;
    const gn2 = g * this.manningN * this.manningN;

    // アクティブ領域を拡張 (初期変位なしの場合は計算不要)
    if (this.activeR1 < 0) {
      this.currentTimeSec += dt;
      this.currentStep++;
      if (this.currentStep % this.sampleEverySteps === 0) this.sampleObservationPoints();
      return;
    }
    const margin = 3;
    this.activeR0 = Math.max(1, this.activeR0 - margin);
    this.activeR1 = Math.min(H - 2, this.activeR1 + margin);
    this.activeC0 = Math.max(1, this.activeC0 - margin);
    this.activeC1 = Math.min(W - 2, this.activeC1 + margin);
    const rA = this.activeR0, rB = this.activeR1 + 1;
    const cA = this.activeC0, cB = this.activeC1 + 1;

    // 0. 破壊伝播による海面変位の追加 (時刻 t → t+dt の間に生じる分)
    if (this.srcIdx && this.srcAmp && this.srcOnset) {
      const t0 = this.currentTimeSec;
      const t1 = t0 + dt;
      const rise = this.srcRise;
      for (let k = 0; k < this.srcIdx.length; k++) {
        const onset = this.srcOnset[k];
        if (t1 <= onset || t0 >= onset + rise) continue;
        const f0 = Math.min(1, Math.max(0, (t0 - onset) / rise));
        const f1 = Math.min(1, Math.max(0, (t1 - onset) / rise));
        this.eta[this.srcIdx[k]] += this.srcAmp[k] * (f1 - f0);
      }
      if (t1 >= this.srcEndSec) {
        this.srcIdx = null;
        this.srcAmp = null;
        this.srcOnset = null;
      }
    }

    // 1. 運動方程式の計算 (流量フラックス M, N の更新: 半陰解法摩擦項)
    for (let r = rA; r < rB; r++) {
      const rowOffset = r * W;
      const dx = this.dxRow[r];
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;

        // --- 東西方向フラックス M (idx と idx+1 の間) ---
        const dCenter = this.depth[idx];
        const dEast = this.depth[idx + 1];

        if (dCenter > 1 && dEast > 1) {
          const dM = 0.5 * (dCenter + dEast);
          const etaM = 0.5 * (this.eta[idx] + this.eta[idx + 1]);
          const totalDepth = Math.max(0.1, dM + etaM);

          if (totalDepth > 0.2) {
            // 圧力勾配項: - g * totalDepth * dEta/dx
            const gradEtaX = (this.eta[idx + 1] - this.eta[idx]) / dx;
            const pressGrad = -g * totalDepth * gradEtaX;

            // 半陰解法による Manning 摩擦項 (分母に配置することで浅瀬でも絶対発散しない)
            const mVal = this.M[idx];
            const nVal = 0.25 * (this.N[idx] + this.N[idx + 1] + this.N[idx - W] + this.N[idx - W + 1]);
            const fluxMag = Math.sqrt(mVal * mVal + nVal * nVal);
            const dF = totalDepth > 1.0 ? totalDepth : 1.0;
            const frictionFactor = (gn2 * fluxMag) / (dF * dF * Math.cbrt(dF)); // dF^(7/3)

            // M^{n+1} = (M^n + press * dt) / (1 + friction * dt)
            const nextM = (mVal + pressGrad * dt) / (1.0 + frictionFactor * dt);
            this.M[idx] = Number.isFinite(nextM) ? nextM : 0;
          } else {
            this.M[idx] = 0;
          }
        } else {
          this.M[idx] = 0; // 陸境界反射
        }

        // --- 南北方向フラックス N (idx と idx+W の間) ---
        const dNorth = this.depth[idx + W];
        if (dCenter > 1 && dNorth > 1) {
          const dN = 0.5 * (dCenter + dNorth);
          const etaN = 0.5 * (this.eta[idx] + this.eta[idx + W]);
          const totalDepth = Math.max(0.1, dN + etaN);

          if (totalDepth > 0.2) {
            // 圧力勾配項: - g * totalDepth * dEta/dy (Y軸は南向きインデックス増加)
            const gradEtaY = (this.eta[idx + W] - this.eta[idx]) / dy;
            const pressGrad = -g * totalDepth * gradEtaY;

            const nVal = this.N[idx];
            const mVal = 0.25 * (this.M[idx] + this.M[idx - 1] + this.M[idx + W] + this.M[idx + W - 1]);
            const fluxMag = Math.sqrt(mVal * mVal + nVal * nVal);
            const dF = totalDepth > 1.0 ? totalDepth : 1.0;
            const frictionFactor = (gn2 * fluxMag) / (dF * dF * Math.cbrt(dF)); // dF^(7/3)

            const nextN = (nVal + pressGrad * dt) / (1.0 + frictionFactor * dt);
            this.N[idx] = Number.isFinite(nextN) ? nextN : 0;
          } else {
            this.N[idx] = 0;
          }
        } else {
          this.N[idx] = 0;
        }
      }
    }

    // 入れ子格子: 西端・北端の外周セルと内側の間の流量 (上の計算範囲に含まれない) も求めてから連続の式へ
    if (this.nested) this.updateNestedBoundaryFluxes(dt, gn2);

    // 2. 連続の式の計算 (水位 eta の更新)
    for (let r = rA; r < rB; r++) {
      const rowOffset = r * W;
      const dx = this.dxRow[r];
      // 球面座標の連続式: dN/dy 項は cosφ で重み付け (N は南向き正)
      const cS = this.cosFace[r] / this.cosCenter[r];
      const cN = this.cosFace[r - 1] / this.cosCenter[r];
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;
        if (this.depth[idx] <= 1) continue; // 陸地はスキップ

        // フラックス発散: dM/dx + dN/dy
        const divFlux = (this.M[idx] - this.M[idx - 1]) / dx + (this.N[idx] * cS - this.N[idx - W] * cN) / dy;
        let newEta = this.eta[idx] - divFlux * dt;

        // 物理的安定性のための水深リミッター（引き波で海底以下 -depth に潜らないよう制限）
        if (newEta < -this.depth[idx]) {
          newEta = -this.depth[idx] * 0.95;
        }
        if (!Number.isFinite(newEta)) {
          newEta = 0;
        }

        this.eta[idx] = newEta;

        // 第1波到達時刻記録 (0.15m以上の水位変動)
        if (Math.abs(newEta) >= 0.15 && this.arrivalTime[idx] < 0) {
          this.arrivalTime[idx] = this.currentTimeSec;
        }
      }
    }

    // 3. 格子規模の数値振動の抑制 (急な海底斜面で中央差分により励起される 2Δx モード)
    if (this.filterMode !== 'none' && this.filterStrength > 0) {
      if (this.filterMode === 'shapiro4') {
        this.applyShapiro4(rA, rB, cA, cB);
      } else {
        this.applyLaplacian(rA, rB, cA, cB);
      }
      for (let r = rA; r < rB; r++) {
        const rowOffset = r * W;
        for (let c = cA; c < cB; c++) {
          const idx = rowOffset + c;
          if (this.depth[idx] > 1) this.eta[idx] = this.etaTemp[idx];
        }
      }
    }

    // 4. 吸収層: 外周付近で水位・流量を減衰させ、計算範囲の外へ出ていく波を反射させない
    for (let r = rA; r < rB && !this.nested; r++) {
      const rowOffset = r * W;
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;
        const f = this.sponge[idx];
        if (f < 1) {
          this.eta[idx] *= f;
          this.M[idx] *= f;
          this.N[idx] *= f;
        }
      }
    }

    // 最大波高を更新
    for (let r = rA; r < rB; r++) {
      const rowOffset = r * W;
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;
        if (this.depth[idx] > 1 && this.eta[idx] > this.maxEta[idx]) {
          this.maxEta[idx] = this.eta[idx];
        }
      }
    }

    // 5. 外洋境界の放射条件 (Sommerfeld): ∂η/∂t + c ∂η/∂n = 0 を風上差分で離散化
    //    η_境界 ← η_境界 + Cr (η_内側 − η_境界)、Cr = c Δt / Δ
    const radiate = (b: number, inner: number, spacing: number) => {
      const cr = Math.min(1, (Math.sqrt(g * Math.max(1, this.depth[b])) * dt) / spacing);
      this.eta[b] += cr * (this.eta[inner] - this.eta[b]);
    };
    //    (入れ子格子では外周の水位を外側の格子から与えるので行わない)
    for (let r = 0; r < H && !this.nested; r++) {
      const dx = this.dxRow[r];
      radiate(r * W, r * W + 1, dx);                   // 西境界
      radiate(r * W + W - 1, r * W + W - 2, dx);       // 東境界
    }
    for (let c = 0; c < W && !this.nested; c++) {
      radiate(c, W + c, dy);                           // 北境界
      radiate((H - 1) * W + c, (H - 2) * W + c, dy);   // 南境界
    }

    this.currentTimeSec += dt;
    this.currentStep++;

    // 観測点サンプリング
    if (this.currentStep % this.sampleEverySteps === 0) {
      this.sampleObservationPoints();
    }
  }

  /**
   * 入れ子格子の西端 (列0と列1の間の M) と北端 (行0と行1の間の N) の流量。
   * 東端・南端の境界面は通常の計算範囲に含まれる。摩擦はその面自身の流量だけで評価する
   */
  private updateNestedBoundaryFluxes(dt: number, gn2: number): void {
    const W = this.width;
    const H = this.height;
    const g = this.g;
    const flux = (q: number, d0: number, d1: number, e0: number, e1: number, spacing: number) => {
      if (d0 <= 1 || d1 <= 1) return 0;
      const totalDepth = Math.max(0.1, 0.5 * (d0 + d1) + 0.5 * (e0 + e1));
      if (totalDepth <= 0.2) return 0;
      const pressGrad = -g * totalDepth * ((e1 - e0) / spacing);
      const dF = totalDepth > 1.0 ? totalDepth : 1.0;
      const friction = (gn2 * Math.abs(q)) / (dF * dF * Math.cbrt(dF));
      const next = (q + pressGrad * dt) / (1.0 + friction * dt);
      return Number.isFinite(next) ? next : 0;
    };
    for (let r = 1; r < H - 1; r++) {
      const idx = r * W;
      this.M[idx] = flux(this.M[idx], this.depth[idx], this.depth[idx + 1], this.eta[idx], this.eta[idx + 1], this.dxRow[r]);
    }
    for (let c = 1; c < W - 1; c++) {
      this.N[c] = flux(this.N[c], this.depth[c], this.depth[c + W], this.eta[c], this.eta[c + W], this.dy);
    }
  }

  /**
   * 4次 Shapiro フィルター (結果は etaTemp)。各方向について ±2 セルがすべて海なら 4次、
   * ±1 セルだけ海なら 2次 (η + ε/4·δ²η) で、どちらも 2Δx 波を ε の割合で減衰させる
   */
  private applyShapiro4(rA: number, rB: number, cA: number, cB: number): void {
    const W = this.width;
    const H = this.height;
    const eps = this.filterStrength;
    const depth = this.depth;
    const eta = this.eta;
    for (let r = rA; r < rB; r++) {
      const rowOffset = r * W;
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;
        const v = eta[idx];
        if (depth[idx] <= 1) {
          this.etaTemp[idx] = v;
          continue;
        }
        let delta = 0;
        // 東西方向
        if (depth[idx - 1] > 1 && depth[idx + 1] > 1) {
          if (c >= 2 && c < W - 2 && depth[idx - 2] > 1 && depth[idx + 2] > 1) {
            delta -= (eps / 16) * (eta[idx - 2] - 4 * eta[idx - 1] + 6 * v - 4 * eta[idx + 1] + eta[idx + 2]);
          } else {
            delta += (eps / 4) * (eta[idx - 1] - 2 * v + eta[idx + 1]);
          }
        }
        // 南北方向
        if (depth[idx - W] > 1 && depth[idx + W] > 1) {
          if (r >= 2 && r < H - 2 && depth[idx - 2 * W] > 1 && depth[idx + 2 * W] > 1) {
            delta -= (eps / 16) * (eta[idx - 2 * W] - 4 * eta[idx - W] + 6 * v - 4 * eta[idx + W] + eta[idx + 2 * W]);
          } else {
            delta += (eps / 4) * (eta[idx - W] - 2 * v + eta[idx + W]);
          }
        }
        this.etaTemp[idx] = v + delta;
      }
    }
  }

  /**
   * ラプラシアン平滑化 (結果は etaTemp)。水深1m超の隣接セルの平均に κ の割合で近づける
   */
  private applyLaplacian(rA: number, rB: number, cA: number, cB: number): void {
    const W = this.width;
    const kappa = this.filterStrength;
    for (let r = rA; r < rB; r++) {
      const rowOffset = r * W;
      for (let c = cA; c < cB; c++) {
        const idx = rowOffset + c;
        const val = this.eta[idx];
        if (this.depth[idx] <= 1) {
          this.etaTemp[idx] = val;
          continue;
        }
        let diffSum = 0;
        let validNeighbors = 0;
        const east = idx + 1;
        if (this.depth[east] > 1) { diffSum += this.eta[east] - val; validNeighbors++; }
        const west = idx - 1;
        if (this.depth[west] > 1) { diffSum += this.eta[west] - val; validNeighbors++; }
        const north = idx - W;
        if (this.depth[north] > 1) { diffSum += this.eta[north] - val; validNeighbors++; }
        const south = idx + W;
        if (this.depth[south] > 1) { diffSum += this.eta[south] - val; validNeighbors++; }
        this.etaTemp[idx] = validNeighbors > 0 ? val + kappa * (diffSum / validNeighbors) : val;
      }
    }
  }

  /**
   * 観測地点 1 点の時系列サンプリング（空間双線形補間＋局所高周波スパイク抑制）
   */
  public sampleSinglePoint(pt: ObservationPoint): void {
    const W = this.width;
    const H = this.height;
    const tSec = this.currentTimeSec;

    // 経度・緯度から浮動小数点グリッドインデックスを算出
    const cExact = ((pt.lon - this.metaBounds.lonMin) / (this.metaBounds.lonMax - this.metaBounds.lonMin)) * W;
    const rExact = ((this.metaBounds.latMax - pt.lat) / (this.metaBounds.latMax - this.metaBounds.latMin)) * H;

    const c0 = Math.floor(cExact);
    const r0 = Math.floor(rExact);
    const fx = Math.max(0, Math.min(1, cExact - c0));
    const fy = Math.max(0, Math.min(1, rExact - r0));

    let elev = 0;
    let u = 0;
    let v = 0;
    let totalWeight = 0;

    // 2x2近傍海洋セルの双線形補間（陸地セルは除外して海側のみで加重正規化）
    for (let dr = 0; dr <= 1; dr++) {
      for (let dc = 0; dc <= 1; dc++) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (c >= 0 && c < W && r >= 0 && r < H) {
          const idx = r * W + c;
          if (this.depth[idx] > 1) {
            const w = (dc === 0 ? (1 - fx) : fx) * (dr === 0 ? (1 - fy) : fy);
            const totalD = Math.max(0.1, this.depth[idx] + this.eta[idx]);
            const cellU = this.M[idx] / totalD;
            const cellV = -this.N[idx] / totalD;

            elev += w * this.eta[idx];
            u += w * cellU;
            v += w * cellV;
            totalWeight += w;
          }
        }
      }
    }

    if (totalWeight > 0.001) {
      elev /= totalWeight;
      u /= totalWeight;
      v /= totalWeight;
    } else {
      // 周囲4点に海がない場合は最寄りの最近傍セル
      const c = Math.max(0, Math.min(W - 1, Math.round(cExact)));
      const r = Math.max(0, Math.min(H - 1, Math.round(rExact)));
      const idx = r * W + c;
      elev = this.eta[idx] || 0;
      const totalD = Math.max(0.1, Math.max(1, this.depth[idx]) + elev);
      u = this.M[idx] / totalD;
      v = -this.N[idx] / totalD;
    }

    if (!Number.isFinite(elev)) elev = 0;
    if (!Number.isFinite(u)) u = 0;
    if (!Number.isFinite(v)) v = 0;

    const speed = Math.hypot(u, v);
    let dirDeg = 0;
    if (speed > 0.01) {
      dirDeg = (Math.atan2(u, v) * 180) / Math.PI;
      if (dirDeg < 0) dirDeg += 360;
    }

    if (!pt.timeHistory) pt.timeHistory = [];

    // 高周波ステップ跳ね（1ステップで急変する数値スパイク）の局所平滑化
    let finalElev = elev;
    const histLen = pt.timeHistory.length;
    if (histLen >= 2) {
      const prev1 = pt.timeHistory[histLen - 1].elevation;
      const prev2 = pt.timeHistory[histLen - 2].elevation;
      const stepDiff = Math.abs(elev - prev1);
      // 1サンプル（約4秒間隔）で0.3m以上の急激な数値跳ねがある場合、3点加重平均で平滑化
      if (stepDiff > 0.3) {
        finalElev = 0.45 * elev + 0.35 * prev1 + 0.2 * prev2;
      }
    }

    pt.timeHistory.push({
      timeSec: tSec,
      elevation: Number(finalElev.toFixed(3)),
      u: Number(u.toFixed(3)),
      v: Number(v.toFixed(3)),
      speed: Number(speed.toFixed(3)),
      directionDeg: Number(dirDeg.toFixed(1))
    });

    // 統計更新
    if (pt.maxWaveHeight === undefined || finalElev > pt.maxWaveHeight) {
      pt.maxWaveHeight = Number(finalElev.toFixed(2));
      pt.maxArrivalSec = tSec;
      pt.dominantDirectionDeg = Number(dirDeg.toFixed(1));
    }
    if (pt.minWaveHeight === undefined || finalElev < pt.minWaveHeight) {
      pt.minWaveHeight = Number(finalElev.toFixed(2));
    }
    // 到達判定は初期水位（地震直後の地殻変動による海面の沈降・隆起を含む）からの変化で行う
    const baseElev = pt.timeHistory[0].elevation;
    if (pt.firstArrivalSec === undefined && Math.abs(finalElev - baseElev) >= 0.15) {
      pt.firstArrivalSec = tSec;
    }
  }

  /**
   * 全観測地点の時系列サンプリング
   */
  public sampleObservationPoints(): void {
    for (const pt of this.observationPoints) {
      this.sampleSinglePoint(pt);
    }
  }
}
