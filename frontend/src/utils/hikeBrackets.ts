// Performance score → hike mapping, shared by the Evaluation Summary sidebar's
// reference table (PerformanceHikeReference.tsx) and the HR Dashboard's Hike
// Distribution card so both always agree. Display only — nothing here feeds
// scoring, approvals, or the API.
// Brackets are upper-inclusive (61–70% covers anything above 60 up to 70), so
// exactly 60% falls in "Below 60%" and exactly 90% in "81–90%".
export interface HikeBracket {
  label: string;
  hike: string;
  // Exclusive lower bound; undefined for the lowest bracket.
  above?: number;
}

export const HIKE_BRACKETS: HikeBracket[] = [
  { label: 'Below 60%', hike: '0%' },
  { label: '61–70%', hike: '5%', above: 60 },
  { label: '71–80%', hike: '10%', above: 70 },
  { label: '81–90%', hike: '15%', above: 80 },
  { label: 'Above 90%', hike: '20%', above: 90 },
];

// Index into HIKE_BRACKETS for a score percentage (0–100).
export const hikeBracketIndex = (scorePercentage: number): number => {
  for (let i = HIKE_BRACKETS.length - 1; i > 0; i -= 1) {
    if (scorePercentage > (HIKE_BRACKETS[i].above as number)) return i;
  }
  return 0;
};
