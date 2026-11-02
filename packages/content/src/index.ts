import calibration from './calibration.json' with { type: 'json' };

export type Calibration = typeof calibration;

/** 待校準數值的唯一來源（GDD 16.4）。 */
export const CALIBRATION: Calibration = calibration;
