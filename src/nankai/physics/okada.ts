import { FaultParams } from '../types';

/**
 * Okada (1985) の弾性食い違い理論に基づく半無限均質媒質表面の鉛直変位計算
 * Okada, Y. (1985), Surface deformation due to shear and tensile faults in a half-space,
 * Bull. Seismol. Soc. Am., 75, 1135-1154.
 */

// ポアソン比 ν = 0.25 (ポアソン固体, λ = μ)
const POISSON = 0.25;
const MU_LAMBDA = 1 - 2 * POISSON; // μ / (λ + μ) = 0.5

function chinnery(f: (xi: number, eta: number) => number, x: number, p: number, L: number, W: number): number {
  return f(x, p) - f(x, p - W) - f(x - L, p) + f(x - L, p - W);
}

/**
 * Okada (1985) 式 (25)(26) の鉛直変位 uz の被積分項 (係数 -U/2π を除く)
 * 戻り値: [ストライクスリップ成分, ディップスリップ成分]
 */
function verticalTerms(xi: number, eta: number, q: number, sinD: number, cosD: number): [number, number] {
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  if (R < 1e-6) return [0, 0];

  const dTilde = eta * sinD - q * cosD;
  const X = Math.sqrt(xi * xi + q * q);
  const rEta = Math.max(R + eta, 1e-9);
  const rXi = Math.max(R + xi, 1e-9);
  const rD = Math.max(R + dTilde, 1e-9);

  let I4: number;
  let I5: number;
  if (Math.abs(cosD) > 1e-6) {
    I5 = Math.abs(xi) < 1e-9
      ? 0
      : MU_LAMBDA * (2 / cosD) * Math.atan((eta * (X + q * cosD) + X * (R + X) * sinD) / (xi * (R + X) * cosD));
    I4 = MU_LAMBDA * (1 / cosD) * (Math.log(rD) - sinD * Math.log(rEta));
  } else {
    // 鉛直断層 (cosδ = 0)
    I5 = -MU_LAMBDA * (xi * sinD) / rD;
    I4 = -MU_LAMBDA * q / rD;
  }

  const atanTerm = Math.abs(q) < 1e-9 ? 0 : Math.atan((xi * eta) / (q * R));

  const strike = (dTilde * q) / (R * rEta) + (q * sinD) / rEta + I4 * sinD;
  const dip = (dTilde * q) / (R * rXi) + sinD * atanTerm - I5 * sinD * cosD;
  return [strike, dip];
}

/**
 * 単一矩形断層による任意観測点 (x, y) での鉛直変位 (m)
 * x: 走向方向の距離 (m)
 * y: 走向直交方向の距離 (m)
 * depthMeters: 断層下端の深さ (m) (Okada 1985 の d)
 */
export function calculateOkadaVerticalDisplacement(
  xMeters: number,
  yMeters: number,
  depthMeters: number,
  lengthMeters: number,
  widthMeters: number,
  dipDeg: number,
  rakeDeg: number,
  slipMeters: number
): number {
  const dipRad = (dipDeg * Math.PI) / 180;
  const rakeRad = (rakeDeg * Math.PI) / 180;

  const U1 = slipMeters * Math.cos(rakeRad); // ストライクスリップ量
  const U2 = slipMeters * Math.sin(rakeRad); // ディップスリップ量

  const sinD = Math.sin(dipRad);
  const cosD = Math.cos(dipRad);

  // Okada の座標系: 原点は断層下端 (深さ d)、x は走向方向、断層は y 正方向へ浅くなる (傾斜は -y 側)
  const d = depthMeters;
  const p = yMeters * cosD + d * sinD;
  const q = yMeters * sinD - d * cosD;

  // 4隅の寄与を合成 (Chinnery's notation)
  const fnStrike = (xi: number, eta: number) => verticalTerms(xi, eta, q, sinD, cosD)[0];
  const fnDip = (xi: number, eta: number) => verticalTerms(xi, eta, q, sinD, cosD)[1];

  let uz = 0;
  if (Math.abs(U1) > 1e-4) {
    uz += U1 * chinnery(fnStrike, xMeters, p, lengthMeters, widthMeters);
  }
  if (Math.abs(U2) > 1e-4) {
    uz += U2 * chinnery(fnDip, xMeters, p, lengthMeters, widthMeters);
  }
  uz *= -1 / (2 * Math.PI);

  // 物理的リミッター（数値特異点保護）
  if (isNaN(uz) || !isFinite(uz)) return 0;
  const maxDisplacement = slipMeters * 1.5;
  return Math.max(-maxDisplacement, Math.min(maxDisplacement, uz));
}

/**
 * 緯度経度グリッド全体に対して断層モデルから初期海面変位配列 (Float32Array) を生成
 */
export function computeInitialDisplacementGrid(
  faults: FaultParams[],
  gridWidth: number,
  gridHeight: number,
  lonMin: number,
  lonMax: number,
  latMin: number,
  latMax: number
): Float32Array {
  const eta0 = new Float32Array(gridWidth * gridHeight);
  const dLon = (lonMax - lonMin) / gridWidth;
  const dLat = (latMax - latMin) / gridHeight;

  // 緯度1度あたりの距離 (約111km)
  const latMetersPerDeg = 111132;

  for (const fault of faults) {
    const strikeRad = (fault.strikeDeg * Math.PI) / 180;
    const cosStrike = Math.cos(strikeRad);
    const sinStrike = Math.sin(strikeRad);

    const L = fault.lengthKm * 1000;
    const W = fault.widthKm * 1000;
    // depthKm は断層上端の深さ。Okada の式で用いる下端深さに換算する (断層面が常に地下に収まる)
    const depth = fault.depthKm * 1000 + W * Math.sin((fault.dipDeg * Math.PI) / 180);
    const slip = fault.slipM;

    const epicLat = fault.epicenterLat;
    const epicLon = fault.epicenterLon;
    const lonMetersPerDeg = latMetersPerDeg * Math.cos((epicLat * Math.PI) / 180);

    // 断層の影響範囲を大まかに絞り込む（高速化）
    // 打ち切り境界で変位が段差にならないよう、外側30%はコサインテーパーで0に近づける
    const searchRadiusKm = (fault.lengthKm + fault.widthKm) * 1.2;
    const taperStartKm = searchRadiusKm * 0.7;
    const minGridLon = epicLon - searchRadiusKm / (lonMetersPerDeg / 1000);
    const maxGridLon = epicLon + searchRadiusKm / (lonMetersPerDeg / 1000);
    const minGridLat = epicLat - searchRadiusKm / 111;
    const maxGridLat = epicLat + searchRadiusKm / 111;

    const colStart = Math.max(0, Math.floor((minGridLon - lonMin) / dLon));
    const colEnd = Math.min(gridWidth, Math.ceil((maxGridLon - lonMin) / dLon));
    const rowStart = Math.max(0, Math.floor((latMax - maxGridLat) / dLat));
    const rowEnd = Math.min(gridHeight, Math.ceil((latMax - minGridLat) / dLat));

    for (let r = rowStart; r < rowEnd; r++) {
      const lat = latMax - r * dLat;
      const dY = (lat - epicLat) * latMetersPerDeg;

      for (let c = colStart; c < colEnd; c++) {
        const lon = lonMin + c * dLon;
        const dX = (lon - epicLon) * lonMetersPerDeg;

        // 断層座標系 (走向方向 x, 走向直交方向 y) への回転変換
        // 北=Y, 東=X
        const faultX = dX * sinStrike + dY * cosStrike;
        const faultY = -dX * cosStrike + dY * sinStrike;

        // 断層原点を中心とするオフセット調整（矩形中央を震源座標とする場合）
        const shiftedX = faultX + L * 0.5;
        const shiftedY = faultY + W * 0.5 * Math.cos((fault.dipDeg * Math.PI) / 180);

        const distKm = Math.hypot(dX, dY) / 1000;
        if (distKm >= searchRadiusKm) continue;
        const taper = distKm <= taperStartKm
          ? 1
          : 0.5 * (1 + Math.cos((Math.PI * (distKm - taperStartKm)) / (searchRadiusKm - taperStartKm)));

        const dz = calculateOkadaVerticalDisplacement(
          shiftedX,
          shiftedY,
          depth,
          L,
          W,
          fault.dipDeg,
          fault.rakeDeg,
          slip
        );

        eta0[r * gridWidth + c] += dz * taper;
      }
    }
  }

  return eta0;
}
