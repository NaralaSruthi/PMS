import type { HREmployee } from '../services/apiService';

// Performance score → hike bands. getHikeBand() is the single source of truth
// for which band a score falls into, used everywhere a band is shown or
// filtered on: the Evaluation Summary sidebar's reference table
// (PerformanceHikeReference), and the HR Dashboard's hike distribution bar and
// Rating column. Display only — nothing here
// feeds scoring, approvals, or the API.
//
// Bands (score = Overall Score %, upper-inclusive):
//   > 90 → 20%   81–90 → 15%   71–80 → 10%   61–70 → 5%   ≤ 60 → 0%
//   no score → Not scored

export type ScoredHikeBand = '20' | '15' | '10' | '5' | '0';
export type HikeBand = ScoredHikeBand | 'not_scored';

export interface HikeBracket {
  band: ScoredHikeBand;
  label: string;
  hike: string;
  // Exclusive lower bound; undefined for the lowest band.
  above?: number;
}

// Lowest to highest. Display order (highest first) is up to each caller.
export const HIKE_BRACKETS: HikeBracket[] = [
  { band: '0', label: 'Below 60%', hike: '0%' },
  { band: '5', label: '61–70%', hike: '5%', above: 60 },
  { band: '10', label: '71–80%', hike: '10%', above: 70 },
  { band: '15', label: '81–90%', hike: '15%', above: 80 },
  { band: '20', label: 'Above 90%', hike: '20%', above: 90 },
];

export const getHikeBand = (scorePercentage: number | undefined | null): HikeBand => {
  if (scorePercentage === undefined || scorePercentage === null || Number.isNaN(scorePercentage)) {
    return 'not_scored';
  }
  for (let i = HIKE_BRACKETS.length - 1; i > 0; i -= 1) {
    if (scorePercentage > (HIKE_BRACKETS[i].above as number)) return HIKE_BRACKETS[i].band;
  }
  return HIKE_BRACKETS[0].band;
};

// Bracket details (label / hike text) for a scored band.
export const hikeBracketFor = (band: ScoredHikeBand): HikeBracket =>
  HIKE_BRACKETS.find((bracket) => bracket.band === band) as HikeBracket;

// ---- Display: order, names and colours per band ----

// Highest hike first, Not scored last — the order of the HR Dashboard's
// distribution bar and its legend.
export const HIKE_BAND_ORDER: HikeBand[] = ['20', '15', '10', '5', '0', 'not_scored'];

export interface HikeBandDisplay {
  // Short name: "10% hike" / "Not scored".
  name: string;
  // Score range in words, for tooltips: "score 71–80%".
  range: string;
  // Segment / chip fill and the text drawn on it.
  color: string;
  textColor: string;
}

// One colour per band, dark green (20%) through to amber (0%), grey for Not
// scored — shared by the distribution bar, its legend and the Rating column
// chips so a band always looks the same.
export const HIKE_BAND_DISPLAY: Record<HikeBand, HikeBandDisplay> = {
  '20': { name: '20% hike', range: 'score above 90%', color: '#15803D', textColor: '#FFFFFF' },
  '15': { name: '15% hike', range: 'score 81–90%', color: '#22C55E', textColor: '#052E16' },
  '10': { name: '10% hike', range: 'score 71–80%', color: '#A3E635', textColor: '#1A2E05' },
  '5': { name: '5% hike', range: 'score 61–70%', color: '#FACC15', textColor: '#422006' },
  '0': { name: '0% hike', range: 'score 60% or below', color: '#F59E0B', textColor: '#451A03' },
  not_scored: { name: 'Not scored', range: 'no overall score yet', color: '#4B5563', textColor: '#F3F4F6' },
};

// ---- HR Dashboard roster helpers ----

// An employee's Overall Score as a % — Manager + HR points over Manager + HR
// possible points, the same totals OverallReviewTab shows as "Overall Score".
// Undefined (→ "Not scored") until both reviews are submitted with scored
// forms, or while the Manager Review is rejected and awaiting resubmission,
// since the score isn't final yet in either case.
export const overallScorePercentage = (employee: HREmployee): number | undefined => {
  const manager = employee.manager_evaluation;
  const hr = employee.hr_evaluation;
  if (!manager.submitted || !hr.submitted || manager.approval_status === 'rejected') return undefined;
  const max = (manager.max_score ?? 0) + (hr.max_score ?? 0);
  if (max <= 0) return undefined;
  return (((manager.score ?? 0) + (hr.score ?? 0)) / max) * 100;
};

// The employee's hike band — used by the HR Dashboard's distribution bar and
// Rating column so they can never disagree.
export const employeeHikeBand = (employee: HREmployee): HikeBand => getHikeBand(overallScorePercentage(employee));

// Employee names per band (every band present, possibly empty).
export const groupByHikeBand = (employees: HREmployee[]): Record<HikeBand, string[]> => {
  const groups: Record<HikeBand, string[]> = { '20': [], '15': [], '10': [], '5': [], '0': [], not_scored: [] };
  for (const employee of employees) groups[employeeHikeBand(employee)].push(employee.name);
  return groups;
};
