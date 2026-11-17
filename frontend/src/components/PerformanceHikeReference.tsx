import React from 'react';
import { Typography } from 'antd';
import { HIKE_BRACKETS, hikeBracketIndex } from '../utils/hikeBrackets';
import '../styles/evaluationSummary.css';

const { Text } = Typography;

// Static score → hike reference shown above the Evaluation Summary sidebar.
// Display only: it reads the existing score percentage (computeRatingSummary's
// scorePercentage — earned / possible points, the same figure the donut
// centers on) and never feeds back into scoring or approvals.
// Bracket thresholds live in utils/hikeBrackets.ts (shared with the HR
// Dashboard's Hike Distribution card).

export interface PerformanceHikeReferenceProps {
  // undefined until at least one scored question is answered (see
  // RatingSummary.scorePercentage) — the table still renders, unhighlighted.
  scorePercentage: number | undefined;
}

const PerformanceHikeReference: React.FC<PerformanceHikeReferenceProps> = ({ scorePercentage }) => {
  const hasScore = typeof scorePercentage === 'number' && !Number.isNaN(scorePercentage);
  const activeIndex = hasScore ? hikeBracketIndex(scorePercentage as number) : -1;

  return (
    <div className="evaluation-summary-card hike-reference-card">
      <div className="hike-reference-card__header">
        <Text strong style={{ fontSize: 14, color: '#F4F1F8' }}>
          Performance Score &amp; Hike
        </Text>
        <span className="hike-reference-card__current">
          {hasScore ? `Current ${Math.round((scorePercentage as number) * 100) / 100}%` : 'No score yet'}
        </span>
      </div>

      <table className="hike-reference-table">
        <thead>
          <tr>
            <th scope="col">Score</th>
            <th scope="col">Hike</th>
          </tr>
        </thead>
        <tbody>
          {HIKE_BRACKETS.map((bracket, index) => {
            const active = index === activeIndex;
            return (
              <tr
                key={bracket.label}
                className={active ? 'hike-reference-table__row--active' : undefined}
                aria-current={active ? 'true' : undefined}
              >
                <td>{bracket.label}</td>
                <td>{bracket.hike}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default PerformanceHikeReference;
