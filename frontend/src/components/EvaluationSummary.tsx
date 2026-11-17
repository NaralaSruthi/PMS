import React from 'react';
import { Typography } from 'antd';
import type { RatingSummary } from './ManagerEvaluation';
import RatingDistributionChart, { RatingDistributionSlice } from './RatingDistributionChart';
import '../styles/evaluationSummary.css';

const { Text } = Typography;

// Status tokens (good/warning/critical), not arbitrary chart colors — these
// three answers literally mean good/bad, so they wear the app's fixed status
// palette (same green/gold/red used by StatusBadge in teamStatusHelpers.tsx)
// rather than a generic categorical one, tuned for contrast against the
// card's dark surface.
const RATING_COLORS: Record<string, string> = {
  Outstanding: '#4ADE80',
  Meets: '#F0C97A',
  'Does not meet': '#F47272',
};

export interface EvaluationSummaryProps {
  // null until ManagerEvaluation reports its first tally (template still
  // loading) — rendered as a quiet placeholder rather than a spinner, since
  // this sidebar never fetches anything of its own.
  summary: RatingSummary | null;
}

// Points as stored (up to 2 decimals), without trailing zeros: 61.25, 7.5, 85.
export const formatPoints = (points: number) => String(Math.round(points * 100) / 100);

// Manager Evaluation tab's sidebar (see ManagerEmployeeReview.tsx): a compact
// donut of the live rating-question answers, with the rating quality score
// (points earned / points possible so far) centered in it, and a legend
// (count + share of answered) below.
const EvaluationSummary: React.FC<EvaluationSummaryProps> = ({ summary }) => {
  const slices: RatingDistributionSlice[] =
    summary?.rows.map((row) => ({ label: row.label, value: row.count, color: RATING_COLORS[row.label] })) || [];

  // Points earned / possible from each question's own points (e.g. "61.25/85"
  // on the Manager Review) — "—" until HR has given the form's questions points.
  const centerLabel =
    summary && summary.possiblePoints > 0
      ? `${formatPoints(summary.earnedPoints)}/${formatPoints(summary.possiblePoints)}`
      : '—';

  return (
    <div className="evaluation-summary-card">
      <Text strong style={{ display: 'block', fontSize: 14, color: '#F4F1F8', marginBottom: 16 }}>
        Evaluation Summary
      </Text>

      {!summary || summary.totalEligible === 0 ? (
        <Text type="secondary" style={{ fontSize: 13 }}>
          {summary ? 'No rating questions in this form.' : 'Loading…'}
        </Text>
      ) : summary.answered === 0 ? (
        // Distinct from the donut view below — a donut with nothing answered
        // yet would render as an all-gray ring with every legend row at 0%,
        // which reads as "everyone got a 0", not "nothing selected yet". Text
        // only until the first rating is actually selected.
        <div>
          <Text strong style={{ display: 'block', fontSize: 15, color: '#F4F1F8', marginBottom: 6 }}>
            No ratings yet
          </Text>
          <Text style={{ display: 'block', fontSize: 13, marginBottom: 20, color: '#FFFFFF' }}>
            The summary will update as you complete the evaluation.
          </Text>
          <Text style={{ display: 'block', fontSize: 12, color: '#8B86A2', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            Questions Rated
          </Text>
          <Text strong style={{ fontSize: 20, color: '#F4F1F8' }}>
            0 / {summary.totalEligible}
          </Text>
        </div>
      ) : (
        <>
          <RatingDistributionChart slices={slices} centerLabel={centerLabel} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
            {summary.rows.map((row) => (
              <div
                key={row.label}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: RATING_COLORS[row.label],
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, color: '#F4F1F8', flex: 1 }}>{row.label}</span>
                <span style={{ fontSize: 13, color: '#F4F1F8', fontWeight: 600 }}>{row.count}</span>
                <span style={{ fontSize: 13, color: '#C5C0D6', minWidth: 32, textAlign: 'right' }}>
                  {row.percentage}%
                </span>
              </div>
            ))}
          </div>

          {/* The score above counts unanswered questions as 0, so say
              plainly whether it's final yet. */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--color-border, rgba(255,255,255,0.12))',
            }}
          >
            <span style={{ fontSize: 13, color: '#C5C0D6' }}>
              Questions Rated {summary.answered} / {summary.totalEligible}
            </span>
            {!summary.complete && (
              <span style={{ fontSize: 13, fontWeight: 600, color: '#F0C97A' }}>Incomplete</span>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default EvaluationSummary;
