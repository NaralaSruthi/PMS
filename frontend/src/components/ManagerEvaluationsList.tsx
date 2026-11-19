import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Typography, Avatar, Button, Progress, Tooltip, Select, Row, Col } from 'antd';
import { SolutionOutlined, TeamOutlined, ProfileOutlined, StarOutlined } from '@ant-design/icons';
import ApiService, { TeamMemberSubmission } from '../services/apiService';
import FormLoadingState from './FormLoadingState';
import { getInitials, StatusBadge, StatusKind } from '../utils/teamStatusHelpers';
import { formatReviewPeriod } from '../utils/reviewPeriodFormat';
import { SummaryStatCard, ReviewStatusCard } from './ManagerDashboard';
import { formatPoints } from './EvaluationSummary';
import '../styles/managerDashboard.css';
import '../styles/pageLayout.css';
import '../styles/teamTable.css';
// Same compact dashboard look as the HR Review page (see .hr-dashboard there).
import '../styles/hrDashboard.css';

const { Title, Text } = Typography;

// Value of the Review Period filter's "All Periods" option — never a real
// period.
const ALL_OPTION = '__all__';

interface ManagerEvaluationRow extends TeamMemberSubmission {
  managerEvalStatus: StatusKind;
  selfEvalSubmitted: boolean;
}

const EmptyManagerEvaluationsState: React.FC = () => (
  <div className="team-empty-state">
    <div className="team-empty-icon">
      <SolutionOutlined />
    </div>
    <div className="team-empty-title">No employees to evaluate</div>
    <div className="team-empty-description">
      You don't have any employees assigned to you yet. Once employees are
      assigned to you, they'll show up here for evaluation.
    </div>
  </div>
);


const ManagerEvaluationsList: React.FC = () => {
  const navigate = useNavigate();
  const [managerEvalTeam, setManagerEvalTeam] = useState<TeamMemberSubmission[]>([]);
  const [selfEvalTeam, setSelfEvalTeam] = useState<TeamMemberSubmission[]>([]);
  const [currentReviewPeriod, setCurrentReviewPeriod] = useState<string | undefined>(undefined);
  const [reviewPeriods, setReviewPeriods] = useState<string[]>([]);
  const [selectedReviewPeriod, setSelectedReviewPeriod] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against React StrictMode's dev-only double-invoke of effects —
  // without this, all API calls below fire twice on every mount.
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // One call covers both rosters this table needs — see get_manager_team
        // in main.py for why this replaced two separate getTeamSubmissions
        // calls (one per template), each paying its own connection overhead.
        const { self_team: selfEvalResponse, manager_team: managerEvalResponse } = await ApiService.getManagerTeam();
        setManagerEvalTeam(managerEvalResponse.team);
        setSelfEvalTeam(selfEvalResponse.team);
        setCurrentReviewPeriod(managerEvalResponse.review_period);
        // Union of both templates' periods — a period could be referenced by
        // only a self-evaluation or only a manager-evaluation submission.
        setReviewPeriods(
          Array.from(new Set([...managerEvalResponse.review_periods, ...selfEvalResponse.review_periods]))
        );
        // Defaults to the current period, same as the HR Dashboard's own
        // selector — switching it is what lets a manager look at an earlier
        // period instead.
        setSelectedReviewPeriod(managerEvalResponse.review_period);
      } catch (err: any) {
        setError(err?.message || 'Failed to load manager review');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return <FormLoadingState />;
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  const selfEvalByEmployeeId = new Map(selfEvalTeam.map((member) => [member.employee_id, member]));

  // A submission only counts as "for the selected period" if its own Review
  // Period answer resolves to the same value — never just "submitted at
  // all", since the one submission that exists could be for a different
  // period entirely (same rule the HR Dashboard already applies). No period
  // selected ("All Periods") falls back to plain submitted/not-submitted.
  const isSelfEvalSubmittedForPeriod = (member: TeamMemberSubmission | undefined) =>
    !!member?.submitted && (!selectedReviewPeriod || member.review_period === selectedReviewPeriod);

  const isManagerEvalSubmittedForPeriod = (member: TeamMemberSubmission) =>
    member.submitted && (!selectedReviewPeriod || member.review_period === selectedReviewPeriod);

  // Manager Evaluation Status has a third state ("Draft") the API can't
  // always see — has_draft (see get_manager_team in main.py) reflects a
  // server-persisted autosave from the evaluation form itself (see
  // useSectionedFormTemplate), so this is visible regardless of which
  // device/browser the manager started the draft on.
  // A submitted evaluation HR/the CDO sent back shows "Rejected" — the
  // manager needs to revise and resubmit it.
  const rows: ManagerEvaluationRow[] = managerEvalTeam.map((member) => {
    const hasDraft = !member.submitted && !!member.has_draft;
    const submittedForPeriod = isManagerEvalSubmittedForPeriod(member);

    return {
      ...member,
      managerEvalStatus: submittedForPeriod
        ? member.approval_status === 'rejected'
          ? 'rejected'
          : 'submitted'
        : hasDraft
        ? 'draft'
        : 'not_started',
      selfEvalSubmitted: isSelfEvalSubmittedForPeriod(selfEvalByEmployeeId.get(member.employee_id)),
    };
  });

  const totalCount = rows.length;
  // A rejected evaluation counts as pending: it's waiting on the manager.
  const submittedCount = rows.filter((row) => row.managerEvalStatus === 'submitted').length;
  const notSubmittedCount = totalCount - submittedCount;
  const selfReviewSubmittedCount = rows.filter((row) => row.selfEvalSubmitted).length;
  const selfReviewPendingCount = totalCount - selfReviewSubmittedCount;

  const columns = [
    {
      title: 'Employee',
      key: 'employee',
      render: (_: unknown, record: ManagerEvaluationRow) => (
        <div className="employee-cell">
          <Avatar className="employee-avatar">{getInitials(record.name)}</Avatar>
          <div className="employee-info">
            {/* Name only — the email still shows on hover, same as the HR Review table. */}
            <div className="employee-name" title={record.email}>{record.name}</div>
          </div>
        </div>
      ),
    },
    {
      title: 'Self Review Status',
      key: 'self_eval_status',
      render: (_: unknown, record: ManagerEvaluationRow) => (
        <StatusBadge status={record.selfEvalSubmitted ? 'submitted' : 'not_started'} />
      ),
    },
    {
      title: 'Manager Review Status',
      key: 'manager_eval_status',
      render: (_: unknown, record: ManagerEvaluationRow) => <StatusBadge status={record.managerEvalStatus} />,
    },
    {
      title: 'Score',
      key: 'score',
      render: (_: unknown, record: ManagerEvaluationRow) => {
        const hasSubmission = record.managerEvalStatus === 'submitted' || record.managerEvalStatus === 'rejected';
        // No points yet (max 0) means HR hasn't scored this form's questions.
        if (!hasSubmission || record.score === undefined || record.max_score === undefined || record.max_score <= 0) {
          return '—';
        }
        // Points earned / possible as stored on the submission (e.g. 61.25 /
        // 85) — the same figures EvaluationSummary's donut and the Overall
        // Review show. The bar fills to the same share.
        const percentage = Math.round((record.score / record.max_score) * 100);
        return (
          <div className="score-cell">
            <div className="score-fraction">
              {formatPoints(record.score)} / {formatPoints(record.max_score)}
            </div>
            <Progress
              percent={percentage}
              showInfo={false}
              size="small"
              strokeColor="var(--color-accent, #5DD3E8)"
            />
          </div>
        );
      },
    },
    {
      title: 'Action',
      key: 'action',
      render: (_: unknown, record: ManagerEvaluationRow) => {
        if (!record.employee_id) {
          return '—';
        }
        const label =
          record.managerEvalStatus === 'submitted'
            ? 'View'
            : record.managerEvalStatus === 'rejected'
            ? 'Revise'
            : record.managerEvalStatus === 'draft'
            ? 'Continue'
            : 'Evaluate';
        const button = (
          <Button
            type={record.managerEvalStatus === 'submitted' ? 'default' : 'primary'}
            disabled={!record.selfEvalSubmitted}
            onClick={() =>
              // Both team rosters are already in hand here (this page just
              // fetched them) — handed to ManagerEmployeeReview via router
              // state so it doesn't call the same two GET .../team endpoints
              // again a moment later.
              navigate(`/manager-evaluation/${record.employee_id}`, {
                state: { managerEvalTeam, selfEvalTeam },
              })
            }
          >
            {label}
          </Button>
        );
        // Can't meaningfully evaluate someone before they've completed their
        // own self-evaluation — grey the action out and explain why, rather
        // than a plain disabled button with no context.
        return record.selfEvalSubmitted ? button : (
          <Tooltip title="Waiting for employee to submit their self review">
            <span>{button}</span>
          </Tooltip>
        );
      },
    },
  ];

  return (
    // hr-dashboard: same compact spacing, card and table sizes as the HR
    // Review page (hrDashboard.css).
    <div className="app-page-container hr-dashboard">
      <div className="app-page-header hr-dashboard__toolbar">
        <Title level={3} className="app-page-title">Manager Review</Title>
        <div className="hr-dashboard__filters">
          <div>
            <Text strong>Review Period:</Text>
            {/* "All Periods" is a real option (ALL_OPTION), shown when no
                period is selected — the filter itself still uses undefined. */}
            <Select
              allowClear={selectedReviewPeriod !== undefined}
              style={{ minWidth: 240 }}
              value={selectedReviewPeriod ?? ALL_OPTION}
              onChange={(value) => setSelectedReviewPeriod(value === ALL_OPTION ? undefined : value)}
              options={[
                { value: ALL_OPTION, label: 'All Periods' },
                ...reviewPeriods.map((period) => ({
                  value: period,
                  label: period === currentReviewPeriod
                    ? `${formatReviewPeriod(period)} (current)`
                    : formatReviewPeriod(period),
                })),
              ]}
            />
          </div>
        </div>
      </div>

      <Row
        className="hr-dashboard__cards"
        gutter={[{ xs: 12, sm: 16 }, { xs: 12, sm: 16 }]}
        align="stretch"
        style={{ marginBottom: 16 }}
      >
        <Col xs={24} sm={12} lg={8}>
          <SummaryStatCard
            icon={<TeamOutlined />}
            value={totalCount}
            title="Total Reportees"
            iconColor="#FFFFFF"
            iconBackground="#3B82F6"
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <ReviewStatusCard
            icon={<ProfileOutlined />}
            title="Self Reviews"
            subtitle="Track self-review submissions"
            iconColor="#FFFFFF"
            iconBackground="#22C55E"
            submittedCount={selfReviewSubmittedCount}
            pendingCount={selfReviewPendingCount}
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <ReviewStatusCard
            icon={<StarOutlined />}
            title="Manager Reviews"
            subtitle="Track manager review progress"
            iconColor="#FFFFFF"
            iconBackground="var(--color-primary, #6666D1)"
            submittedCount={submittedCount}
            submittedLabel="Completed"
            pendingCount={notSubmittedCount}
            pendingLabel="Not Completed"
          />
        </Col>
      </Row>

      <div className="app-content-card">
        {rows.length === 0 ? (
          <EmptyManagerEvaluationsState />
        ) : (
          <Table
            className="team-table scrollable-team-table"
            columns={columns}
            dataSource={rows}
            rowKey={(record) => record.employee_id || record.email}
            // A truthy scroll.y is what makes antd split the header into its
            // own fixed row with the body scrolling separately underneath —
            // the actual number is irrelevant since scrollableTeamTable's own
            // CSS (teamTable.css) overrides it to fill .app-content-card's
            // real height instead of this fixed placeholder.
            scroll={{ y: 240 }}
            pagination={{
              pageSize: 10,
              showTotal: (total, range) => `Showing ${range[0]}–${range[1]} of ${total} employees`,
            }}
          />
        )}
      </div>
    </div>
  );
};

export default ManagerEvaluationsList;
