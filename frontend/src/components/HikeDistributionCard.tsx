import React from 'react';
import { Divider, Tooltip, Typography } from 'antd';
import { RiseOutlined } from '@ant-design/icons';
import type { HREmployee } from '../services/apiService';
import { ManagerOverviewCard } from './ManagerDashboard';
import { HIKE_BRACKETS, hikeBracketIndex } from '../utils/hikeBrackets';
import '../styles/managerDashboard.css';
import '../styles/hikeDistribution.css';

const { Text } = Typography;

// Names listed in a row's hover tooltip before collapsing to "+N more".
const MAX_TOOLTIP_NAMES = 10;

// An employee's Overall Score as a % — Manager + HR points over Manager + HR
// possible points, the same totals OverallReviewTab shows as "Overall Score".
// Undefined (→ pending) until both reviews are submitted with scored forms,
// or while the Manager Review is rejected and awaiting resubmission, since
// the score isn't final yet in either case.
export const overallScorePercentage = (employee: HREmployee): number | undefined => {
  const manager = employee.manager_evaluation;
  const hr = employee.hr_evaluation;
  if (!manager.submitted || !hr.submitted || manager.approval_status === 'rejected') return undefined;
  const max = (manager.max_score ?? 0) + (hr.max_score ?? 0);
  if (max <= 0) return undefined;
  return (((manager.score ?? 0) + (hr.score ?? 0)) / max) * 100;
};

const namesTooltip = (names: string[]) =>
  names.length === 0 ? null : (
    <div>
      {names.slice(0, MAX_TOOLTIP_NAMES).map((name) => (
        <div key={name}>{name}</div>
      ))}
      {names.length > MAX_TOOLTIP_NAMES && <div>+{names.length - MAX_TOOLTIP_NAMES} more</div>}
    </div>
  );

// Bracket an employee falls into (index into HIKE_BRACKETS), or undefined
// while their score is pending — the HR Dashboard filters its table by this.
export const employeeHikeBracketIndex = (employee: HREmployee): number | undefined => {
  const score = overallScorePercentage(employee);
  return score === undefined ? undefined : hikeBracketIndex(score);
};

export interface HikeDistributionCardProps {
  // Already filtered by the dashboard's Review Period / Reporting Manager.
  employees: HREmployee[];
  // Bracket currently filtering the dashboard's table (index into
  // HIKE_BRACKETS); clicking a row selects it, clicking it again clears it.
  selectedIndex?: number;
  onSelect?: (index: number | undefined) => void;
}

// HR Dashboard card in the same layout as ReviewStatusCard (header, divider,
// label + count rows): how many employees fall into each hike bracket. Hover
// a row (or the pending note) for the names.
const HikeDistributionCard: React.FC<HikeDistributionCardProps> = ({ employees, selectedIndex, onSelect }) => {
  const bracketNames: string[][] = HIKE_BRACKETS.map(() => []);
  const pendingNames: string[] = [];
  for (const employee of employees) {
    const index = employeeHikeBracketIndex(employee);
    if (index === undefined) pendingNames.push(employee.name);
    else bracketNames[index].push(employee.name);
  }

  const toggle = (index: number) => onSelect?.(selectedIndex === index ? undefined : index);

  return (
    <ManagerOverviewCard>
      <div className="review-status-header">
        <div
          className="summary-stat-card-icon"
          style={{ color: '#FFFFFF', backgroundColor: 'var(--color-warning, #F0C97A)' }}
        >
          <RiseOutlined />
        </div>
        <div>
          <div className="review-status-card-title">Performance &amp; Hike</div>
          <Tooltip title={namesTooltip(pendingNames)}>
            <Text className="review-status-card-subtitle">
              Track hike by Overall Score · {pendingNames.length} pending
            </Text>
          </Tooltip>
        </div>
      </div>
      <Divider className="review-status-divider" />
      <div className="review-status-rows hike-distribution-rows">
        {/* Highest hike first, matching how the other cards lead with the
            positive outcome. */}
        {HIKE_BRACKETS.map((bracket, index) => ({ bracket, index, names: bracketNames[index] }))
          .reverse()
          .map(({ bracket, index, names }) => (
            <Tooltip key={bracket.label} title={namesTooltip(names)} placement="left">
              <div
                className={`review-status-row hike-distribution-row${
                  selectedIndex === index ? ' hike-distribution-row--active' : ''
                }`}
                role="button"
                tabIndex={0}
                aria-pressed={selectedIndex === index}
                onClick={() => toggle(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle(index);
                  }
                }}
              >
                <span className="review-status-row-label">
                  {bracket.hike} hike <span className="hike-distribution-range">{bracket.label}</span>
                </span>
                <span
                  className="review-status-row-count"
                  style={{ color: names.length ? 'var(--color-success, #4ADE80)' : 'var(--color-text-secondary, #8B86A2)' }}
                >
                  {names.length}
                </span>
              </div>
            </Tooltip>
          ))}
      </div>
    </ManagerOverviewCard>
  );
};

export default HikeDistributionCard;
