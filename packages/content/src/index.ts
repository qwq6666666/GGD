import calibration from './calibration.json' with { type: 'json' };
import economy from './economy.json' with { type: 'json' };
import names from './names.json' with { type: 'json' };
import events from './events.json' with { type: 'json' };
import goals from './goals.json' with { type: 'json' };

export type Calibration = typeof calibration;
export type Economy = typeof economy;

/** 待校準數值的唯一來源（GDD 16.4）。 */
export const CALIBRATION: Calibration = calibration;
export const ECON: Economy = economy;
export const NAMES: typeof names = names;
export const EVENTS: typeof events = events;
/** 村級階段、目標與解鎖（GDD 外的玩法擴充，見 ADR-0007）。 */
export const GOALS: typeof goals = goals;
