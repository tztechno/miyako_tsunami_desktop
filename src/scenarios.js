export const TSUNAMI_SCENARIOS = {
  great_east_japan: {
    id: 'great_east_japan',
    name: '東日本大震災 (2011年実測再現)',
    name_en: '2011 Tohoku Earthquake Tsunami (Recorded)',
    // Offshore boundary amplitude (sea depth ~25 m), tuned to the 59 TTJT survey points in Taro
    // (tools/calibrate-2011.mjs): 8.0 m gives 25 points within ±2 m, RMSE 5.3 m.
    waveHeight: 8.0, // m offshore
    periodSec: 720,  // 12 min
    directionDeg: 110, // from East-Southeast
    durationMin: 30,
    hasPreDrawdown: true,
    description: '2011年3月11日の津波の再現。沖合（水深約25m）の波高8.0mは、田老の痕跡実測59地点に最も合うよう調整した値（海岸に近づくと浅水化で高くなる）。旧田老防潮堤（10m）を越流。※位置が特定できない海側の旧防潮堤（震災で破壊）は未収録。',
    description_en: 'Reproduction of the 2011 tsunami. The 8.0m offshore height (sea depth ~25m) is tuned to best match the 59 surveyed points in Taro (it grows higher towards the coast by shoaling). Overtops the 10m historic dyke. Note: the seaward historic wall (destroyed in 2011) is not modeled because its exact position is unknown.',
    recommendedSeawall: 'historic_10',
  },
  l2_maximum: {
    id: 'l2_maximum',
    name: '想定最大規模 L2津波 (岩手県公表)',
    name_en: 'Level 2 Maximum Probable Tsunami',
    waveHeight: 19.5, // m
    periodSec: 900,  // 15 min
    directionDeg: 90,
    durationMin: 35,
    hasPreDrawdown: true,
    description: '岩手県公表の想定最大クラス津波（波高19.5m）。住民の高台避難が必須。※新田老防潮堤（TP+14.7m）は正確な位置が特定できないため未収録。',
    description_en: 'Maximum probable tsunami (19.5m) designated by Iwate Prefecture, highlighting the necessity of high-ground evacuation. Note: the new TP+14.7m seawall is not modeled because its exact position is unknown.',
    recommendedSeawall: 'historic_10',
  },
  l1_design: {
    id: 'l1_design',
    name: '施設計画規模 L1津波 (設計波)',
    name_en: 'Level 1 Design Tsunami (New Seawall Baseline)',
    waveHeight: 14.0, // m
    periodSec: 600,  // 10 min
    directionDeg: 90,
    durationMin: 25,
    hasPreDrawdown: false,
    description: '新田老防潮堤（TP+14.7m）の設計根拠となった頻度高の津波。旧防潮堤（10m）では越流する。※新防潮堤は正確な位置が特定できないため未収録。',
    description_en: 'Design tsunami (14.0m) for frequent occurrences; the basis of the new TP+14.7m seawall. The historic 10m wall overflows. Note: the new seawall is not modeled because its exact position is unknown.',
    recommendedSeawall: 'historic_10',
  },
  chile_1960: {
    id: 'chile_1960',
    name: 'チリ地震津波 (1960年再現)',
    name_en: '1960 Chile Earthquake Tsunami',
    waveHeight: 5.5, // m
    periodSec: 1200, // 20 min long swell
    directionDeg: 90,
    durationMin: 40,
    hasPreDrawdown: true,
    description: '1960年チリ沖から太平洋を渡来した津波（波高5.5m）。旧田老防潮堤（10m）が完璧に防ぎ切り、田老が無被害で世界に名を馳せた歴史的津波。',
    description_en: '1960 trans-Pacific tsunami (5.5m). The historic 10m dyke completely repelled the waves with zero casualties, earning Taro global fame.',
    recommendedSeawall: 'historic_10',
  },
  custom: {
    id: 'custom',
    name: 'カスタム津波パラメータ',
    name_en: 'Custom Wave Parameters',
    waveHeight: 12.0,
    periodSec: 600,
    directionDeg: 90,
    durationMin: 30,
    hasPreDrawdown: false,
    description: 'スライダーで波高（3m〜25m）、周期、波の方向を自由に変更してシミュレーションできます。',
    description_en: 'Freely adjust offshore wave height (3m-25m), period, and angle using sliders.',
    recommendedSeawall: 'historic_10',
  }
};
