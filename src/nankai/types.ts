export interface BathymetryMeta {
  width: number;
  height: number;
  factor: number;
  bounds: {
    lonMin: number;
    lonMax: number;
    latMin: number;
    latMax: number;
  };
  dxDeg: number;
  dyDeg: number;
  dxMeters: number;
  dyMeters: number;
}

export interface FaultParams {
  name: string;
  epicenterLon: number;
  epicenterLat: number;
  depthKm: number;          // 断層上端の深さ (km)
  lengthKm: number;         // 断層長 (km)
  widthKm: number;          // 断層幅 (km)
  strikeDeg: number;        // 走向 (度, 北から時計回り)
  dipDeg: number;           // 傾斜角 (度)
  rakeDeg: number;          // すべり角 (度, 90度は逆断層)
  slipM: number;            // すべり量 (m)
  magnitude?: number;       // モーメントマグニチュード Mw
  subfault?: boolean;       // すべり分布を構成する小断層 (地図では個別ラベルを付けず、すべり量で色分け表示)
}

// 実際の地震の震源 (破壊開始点)。波源計算には使わず、地図表示のみ
export interface Hypocenter {
  lon: number;
  lat: number;
  depthKm?: number;        // 歴史地震で深さ不明の場合は省略
  referenceEvent?: string; // 想定地震に参考表示する歴史地震の ID (i18n の REFERENCE_EVENT_NAMES)
  ruptureStart?: boolean;  // 想定モデルの破壊開始点 (破壊伝播の計算に使用)
}

// 破壊伝播 (破壊開始点から順次すべりが生じる)。未設定のシナリオは全域同時破壊
export interface RuptureParams {
  lon: number;
  lat: number;
  velocityKmS: number;
  riseTimeSec: number;
}

export interface ObservationPoint {
  id: string;
  name: string;
  lon: number;
  lat: number;
  color: string;
  depth?: number;
  // 解析結果
  firstArrivalSec?: number;
  maxArrivalSec?: number;
  maxWaveHeight?: number;
  minWaveHeight?: number;
  dominantDirectionDeg?: number;
  timeHistory?: {
    timeSec: number;
    elevation: number;
    u: number;
    v: number;
    speed: number;
    directionDeg: number;
  }[];
}

export interface SimulationState {
  timeSec: number;
  step: number;
  maxTimeSec: number;
  dt: number;
  isRunning: boolean;
  isPaused: boolean;
  speedMultiplier: number;
}
