import { CALIBRATION } from '@ss/content';

const C = CALIBRATION.calendar;

export const SEASON_NAMES = ['春', '夏', '秋', '冬'] as const;

export interface CalendarDate {
  /** 第幾年，從 1 起算。 */
  year: number;
  /** 0=春 1=夏 2=秋 3=冬 */
  season: number;
  /** 季內第幾日，1..90 */
  dayOfSeason: number;
  /** 年內第幾日，1..360 */
  dayOfYear: number;
  /** 年內第幾月，1..12 */
  month: number;
  /** 月內第幾日，1..30 */
  dayOfMonth: number;
  /** 年內第幾週，1..60 */
  week: number;
  /** 週內第幾日，1..6 */
  dayOfWeek: number;
  isRestDay: boolean;
}

/** tick = 自第 1 年春季第 1 日起經過的日數（0 起算）。曆法已鎖定（GDD 3）。 */
export function toDate(tick: number): CalendarDate {
  const doy0 = tick % C.daysPerYear;
  const dayOfWeek = (doy0 % C.daysPerWeek) + 1;
  return {
    year: Math.floor(tick / C.daysPerYear) + 1,
    season: Math.floor(doy0 / C.daysPerSeason),
    dayOfSeason: (doy0 % C.daysPerSeason) + 1,
    dayOfYear: doy0 + 1,
    month: Math.floor(doy0 / C.daysPerMonth) + 1,
    dayOfMonth: (doy0 % C.daysPerMonth) + 1,
    week: Math.floor(doy0 / C.daysPerWeek) + 1,
    dayOfWeek,
    isRestDay: dayOfWeek === C.restDayOfWeek,
  };
}

export function toTick(year: number, season: number, dayOfSeason: number): number {
  return (year - 1) * C.daysPerYear + season * C.daysPerSeason + (dayOfSeason - 1);
}

export function formatDate(tick: number): string {
  const d = toDate(tick);
  return `第${d.year}年 ${SEASON_NAMES[d.season]}季 第${d.dayOfSeason}日`;
}

export const isWeekEnd = (tick: number): boolean => toDate(tick).dayOfWeek === C.daysPerWeek;
export const isMonthEnd = (tick: number): boolean => toDate(tick).dayOfMonth === C.daysPerMonth;
export const isSeasonEnd = (tick: number): boolean => toDate(tick).dayOfSeason === C.daysPerSeason;
export const isYearEnd = (tick: number): boolean => toDate(tick).dayOfYear === C.daysPerYear;
