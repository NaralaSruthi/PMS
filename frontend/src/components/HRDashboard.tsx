import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Table, Typography, Avatar, Button, Select, Row, Col, Tooltip } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { IdcardOutlined, TeamOutlined, ProfileOutlined, StarOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import ApiService, { HRDashboardResponse, HREmployee, HRManager, ReviewPeriodOption } from '../services/apiService';
import FormLoadingState from './FormLoadingState';
import { getInitials, StatusBadge } from '../utils/teamStatusHelpers';
import { formatReviewPeriod } from '../utils/reviewPeriodFormat';
import { SummaryStatCard, ReviewStatusCard } from './ManagerDashboard';
import {
  HikeBand,
  HIKE_BAND_ORDER,
  HIKE_BAND_DISPLAY,
  getHikeBand,
  employeeHikeBand,
  groupByHikeBand,
  overallScorePercentage,
} from '../utils/hikeBrackets';
import { useAuth } from '../contexts/AuthContext';
import '../styles/pageLayout.css';
import '../styles/teamTable.css';
import '../styles/managerDashboard.css';
import '../styles/hrDashboard.css';

const { Title, Text } = Typography;

// Value of the Reporting Manager filter's "All Managers" option — never a
// real employee_id.
const ALL_OPTION = '__all__';

interface EmptyHRStateProps {
  title?: string;
  description?: string;
  // Optional button under the message (e.g. "Show all" for an empty band).
  action?: React.ReactNode;
}

const EmptyHRState: React.FC<EmptyHRStateProps> = ({
  title = 'No employees found',
  description = 'There are no other employees in the system yet.',
  action,
}) => (
  <div className="team-empty-state">
    <div className="team-empty-icon">
      <IdcardOutlined />
    </div>
    <div className="team-empty-title">{title}</div>
    <div className="team-empty-description">{description}</div>
    {action && <div style={{ marginTop: 16 }}>{action}</div>}
  </div>
);

const employeesLabel = (count: number) => `${count} ${count === 1 ? 'employee' : 'employees'}`;

interface HikeDistributionBarProps {
  // Employees per band for the current Period + Manager view.
  counts: Record<HikeBand, number>;
  total: number;
  selectedBand: HikeBand | null;
  onSelect: (band: HikeBand | null) => void;
}

// Clickable hike distribution: one bar split into a segment per band (width
// ∝ employee count, empty bands hidden), a legend below, and the active
// filter on the right. Clicking a segment filters the table to that band;
// clicking it again (or Clear) shows everyone.
const HikeDistributionBar: React.FC<HikeDistributionBarProps> = ({ counts, total, selectedBand, onSelect }) => (
  <div className="hike-distribution">
    <div className="hike-distribution__header">
      <Text strong className="hike-distribution__title">
        Hike distribution · {employeesLabel(total)}
      </Text>
      {selectedBand && (
        <span className="hike-distribution__active">
          Showing {HIKE_BAND_DISPLAY[selectedBand].name} ·{' '}
          <Button type="link" size="small" className="hike-distribution__clear" onClick={() => onSelect(null)}>
            Clear
          </Button>
        </span>
      )}
    </div>

    <div className="hike-distribution__bar" role="group" aria-label="Filter employees by hike band">
      {HIKE_BAND_ORDER.filter((band) => counts[band] > 0).map((band) => {
        const display = HIKE_BAND_DISPLAY[band];
        const count = counts[band];
        const selected = selectedBand === band;
        const faded = selectedBand !== null && !selected;
        const description = `${display.name}: ${employeesLabel(count)}, ${display.range}`;
        return (
          <Tooltip key={band} title={description}>
            <button
              type="button"
              className={`hike-distribution__segment${selected ? ' hike-distribution__segment--selected' : ''}${
                faded ? ' hike-distribution__segment--faded' : ''
              }`}
              style={{ flexGrow: count, backgroundColor: display.color, color: display.textColor }}
              aria-pressed={selected}
              aria-label={`${description}. ${selected ? 'Click to show all employees' : 'Click to filter the table'}`}
              onClick={() => onSelect(selected ? null : band)}
            >
              {count}
            </button>
          </Tooltip>
        );
      })}
    </div>

    {/* Band name under each segment — same flex sizing as the bar so every
        label sits directly below its colour. Decorative: each segment's
        aria-label already names its band. */}
    <div className="hike-distribution__labels" aria-hidden="true">
      {HIKE_BAND_ORDER.filter((band) => counts[band] > 0).map((band) => (
        <span
          key={band}
          className={`hike-distribution__label${
            selectedBand !== null && selectedBand !== band ? ' hike-distribution__label--faded' : ''
          }`}
          style={{ flexGrow: counts[band] }}
          title={HIKE_BAND_DISPLAY[band].name}
        >
          {/* Just the hike %: "20%", "10%" … or "Not scored". */}
          {band === 'not_scored' ? HIKE_BAND_DISPLAY[band].name : `${band}%`}
        </span>
      ))}
    </div>
  </div>
);

const HRDashboard: React.FC = () => {
  const navigate = useNavigate();
  // Same page for HR and the CDO; the title follows the sidebar label
  // (Sidebar.tsx): "Overall Review" for the CDO, "HR Review" otherwise.
  const { authState } = useAuth();
  const pageTitle = authState.user?.isCDO ? 'Overall Review' : 'HR Review';
  const [employees, setEmployees] = useState<HREmployee[]>([]);
  const [managers, setManagers] = useState<HRManager[]>([]);
  // Kept alongside the individual fields above so "View Details" below can
  // hand this exact response to HREmployeeDetails via router state — that
  // page would otherwise call this same GET /api/hr/employees a second time,
  // fetching the entire org-wide roster again just to find the one employee
  // that was already right here on this table's row.
  const [dashboardResponse, setDashboardResponse] = useState<HRDashboardResponse | null>(null);
  const [selectedManagerId, setSelectedManagerId] = useState<string | undefined>(undefined);
  // Period being viewed, in the stored form the API takes ("Jan 2026 - Jun
  // 2026"); absent means the current period. Kept in the URL so the details
  // page's Back button returns to the same period. Only HR is offered
  // previous periods (see review_period_options in get_hr_employees).
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReviewPeriodId = searchParams.get('review_period_id') || undefined;
  const [reviewPeriodOptions, setReviewPeriodOptions] = useState<ReviewPeriodOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against React StrictMode's dev-only double-invoke of effects —
  // keyed by period so switching periods still fetches.
  const hasFetchedRef = useRef<string | null>(null);

  const fetchEmployees = useCallback(async (reviewPeriodId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await ApiService.getHRDashboard(reviewPeriodId);
      setDashboardResponse(response);
      setEmployees(response.employees || []);
      setManagers(response.managers || []);
      setReviewPeriodOptions(response.review_period_options || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load HR dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const fetchKey = requestedReviewPeriodId ?? '';
    if (hasFetchedRef.current === fetchKey) return;
    hasFetchedRef.current = fetchKey;
    fetchEmployees(requestedReviewPeriodId);
  }, [fetchEmployees, requestedReviewPeriodId]);

  // Switching period reloads the roster for that period (via the URL change
  // above) rather than filtering the current one client-side.
  const handleReviewPeriodChange = (value: string) => {
    // A different period means different scores, so drop any band filter.
    applyBand(null);
    setSearchParams(value === dashboardResponse?.current_review_period_id ? {} : { review_period_id: value });
  };

  // Only employees who actually report to the selected manager — "reports
  // to" is checked by employee_id (manager_ids), never by display name, so
  // two managers who happen to share a name can't be confused.
  const filteredEmployees = useMemo(
    () =>
      selectedManagerId
        ? employees.filter((employee) => employee.manager_ids?.includes(selectedManagerId))
        : employees,
    [employees, selectedManagerId]
  );

  // Hike band picked on the distribution bar; null = show everyone. Filtered
  // client-side over the full roster for the period (GET /api/hr/employees
  // returns every employee; the table pages in the browser), on top of the
  // Manager filter. Narrows only the table: the summary cards and the bar's
  // counts keep counting the whole manager-filtered roster so they don't
  // shift as the band changes.
  const [selectedBand, setSelectedBand] = useState<HikeBand | null>(null);
  // Controlled so any filter change can send the table back to page 1.
  const [currentPage, setCurrentPage] = useState(1);
  const applyBand = (band: HikeBand | null) => {
    setSelectedBand(band);
    setCurrentPage(1);
  };
  const bandCounts = useMemo(() => {
    const groups = groupByHikeBand(filteredEmployees);
    return Object.fromEntries(HIKE_BAND_ORDER.map((band) => [band, groups[band].length])) as Record<HikeBand, number>;
  }, [filteredEmployees]);
  const tableEmployees = useMemo(
    () =>
      selectedBand === null
        ? filteredEmployees
        : filteredEmployees.filter((employee) => employeeHikeBand(employee) === selectedBand),
    [filteredEmployees, selectedBand]
  );

  // The roster is fetched for exactly the selected period (see
  // get_hr_employees in main.py), so "submitted" already means "submitted
  // for this period".
  const isSelfAssessmentSubmittedForPeriod = (employee: HREmployee) => employee.self_assessment.submitted;

  const isManagerEvaluationSubmittedForPeriod = (employee: HREmployee) => employee.manager_evaluation.submitted;

  const isHREvaluationSubmittedForPeriod = (employee: HREmployee) => employee.hr_evaluation.submitted;

  if (loading) {
    return <FormLoadingState />;
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  const totalCount = filteredEmployees.length;
  const selfAssessmentSubmittedCount = filteredEmployees.filter(isSelfAssessmentSubmittedForPeriod).length;
  const selfAssessmentPendingCount = totalCount - selfAssessmentSubmittedCount;
  const managerEvalSubmittedCount = filteredEmployees.filter(isManagerEvaluationSubmittedForPeriod).length;
  const managerEvalPendingCount = totalCount - managerEvalSubmittedCount;
  const hrEvalSubmittedCount = filteredEmployees.filter(isHREvaluationSubmittedForPeriod).length;
  const hrEvalPendingCount = totalCount - hrEvalSubmittedCount;

  const columns = [
    {
      title: 'Employee',
      key: 'employee',
      render: (_: unknown, record: HREmployee) => (
        <div className="employee-cell">
          <Avatar className="employee-avatar">{getInitials(record.name)}</Avatar>
          <div className="employee-info">
            {/* Name only — the email still shows on hover. */}
            <div className="employee-name" title={record.email}>{record.name}</div>
          </div>
        </div>
      ),
    },
    {
      title: 'Manager',
      key: 'manager_name',
      render: (_: unknown, record: HREmployee) => record.manager_name || '—',
    },
    {
      title: 'Self Review',
      key: 'self_assessment_status',
      render: (_: unknown, record: HREmployee) => (
        <StatusBadge status={isSelfAssessmentSubmittedForPeriod(record) ? 'submitted' : 'not_started'} />
      ),
    },
    {
      title: 'Manager Review',
      key: 'manager_evaluation_status',
      render: (_: unknown, record: HREmployee) =>
        // "N/A" only when there's truly nothing to show — no manager
        // currently assigned AND no submission for the selected period. A
        // submission that already exists is real regardless of whether the
        // employee's manager assignment has since changed, so it still gets
        // shown (and stays viewable) rather than being masked as N/A.
        !record.manager_evaluation.has_manager && !isManagerEvaluationSubmittedForPeriod(record) ? (
          <Text type="secondary">N/A</Text>
        ) : (
          <StatusBadge
            status={
              isManagerEvaluationSubmittedForPeriod(record)
                ? record.manager_evaluation.approval_status === 'rejected'
                  ? 'rejected'
                  : 'submitted'
                : 'not_started'
            }
          />
        ),
    },
    {
      title: 'HR Review',
      key: 'hr_evaluation_status',
      render: (_: unknown, record: HREmployee) => (
        <StatusBadge status={isHREvaluationSubmittedForPeriod(record) ? 'submitted' : 'not_started'} />
      ),
    },
    {
      // Overall Score % in a pill coloured by its hike band (getHikeBand) —
      // the same colour as that band's segment on the distribution bar; the
      // hike itself is in the tooltip. A grey "Not scored" pill until both
      // Manager and HR reviews are scored.
      title: 'Rating',
      key: 'hike_rating',
      // Fixed width: the table is table-layout: fixed (scroll.y), so without
      // one this short column would get an equal share of the width. Room
      // for "Not scored" and the header's sort icon.
      width: 130,
      // By score; Not scored always at the bottom in either direction (antd
      // reverses the result for descending, so flip it back for those rows).
      sorter: (a: HREmployee, b: HREmployee, sortOrder?: SortOrder) => {
        const scoreA = overallScorePercentage(a);
        const scoreB = overallScorePercentage(b);
        if (scoreA === undefined || scoreB === undefined) {
          if (scoreA === scoreB) return 0;
          const unscoredLast = scoreA === undefined ? 1 : -1;
          return sortOrder === 'descend' ? -unscoredLast : unscoredLast;
        }
        return scoreA - scoreB;
      },
      render: (_: unknown, record: HREmployee) => {
        const score = overallScorePercentage(record);
        const band = getHikeBand(score);
        const display = HIKE_BAND_DISPLAY[band];
        const pill = (text: string) => (
          <span className="hike-rating-chip" style={{ backgroundColor: display.color, color: display.textColor }}>
            {text}
          </span>
        );
        if (score === undefined) return pill('Not scored');
        // Whole number, or one decimal when there is one (71.1%).
        return <Tooltip title={`${display.name} (${display.range})`}>{pill(`${Math.round(score * 10) / 10}%`)}</Tooltip>;
      },
    },
    {
      title: 'Action',
      key: 'action',
      width: 140,
      render: (_: unknown, record: HREmployee) => {
        if (!record.employee_id) {
          return '—';
        }
        // Stable identifiers only — employee_id in the path, and the
        // review period (stored id form) as a query param when HR is
        // looking at a previous period; omitted for the current one.
        const query =
          dashboardResponse && dashboardResponse.review_period_id !== dashboardResponse.current_review_period_id
            ? `?review_period_id=${encodeURIComponent(dashboardResponse.review_period_id)}`
            : '';
        return (
          <Button
            type="link"
            onClick={() =>
              // dashboardResponse is handed along in router state so
              // HREmployeeDetails can reuse this exact org-wide roster
              // instead of fetching GET /api/hr/employees again.
              navigate(`/hr-dashboard/${record.employee_id}${query}`, {
                state: { dashboard: dashboardResponse },
              })
            }
          >
            View Details →
          </Button>
        );
      },
    },
  ];

  return (
    // hr-dashboard scopes the compact spacing in hrDashboard.css to this page
    // only (the card/table classes are shared with the Manager Dashboard).
    <div className="app-page-container hr-dashboard">
      {/* Title and filters share one line (wrapping on narrow screens) so the
          employee table below gets the vertical space. */}
      <div className="app-page-header hr-dashboard__toolbar">
        <Title level={3} className="app-page-title">{pageTitle}</Title>

        <div className="hr-dashboard__filters">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text strong>Review Period:</Text>
            <Select
              style={{ minWidth: 240 }}
              value={dashboardResponse?.review_period_id}
              onChange={handleReviewPeriodChange}
              options={reviewPeriodOptions.map((option) => ({
                value: option.review_period_id,
                label: option.is_current
                  ? `${formatReviewPeriod(option.label)} (current)`
                  : formatReviewPeriod(option.label),
              }))}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text strong>Reporting Manager:</Text>
            {/* "All Managers" is a real option (ALL_OPTION), shown when no
                manager is selected — the filter itself still uses undefined. */}
            <Select
              allowClear={selectedManagerId !== undefined}
              style={{ minWidth: 240 }}
              value={selectedManagerId ?? ALL_OPTION}
              onChange={(value) => {
                setSelectedManagerId(value === ALL_OPTION ? undefined : value);
                setCurrentPage(1);
              }}
              options={[
                { value: ALL_OPTION, label: 'All Managers' },
                ...managers.map((manager) => ({ value: manager.employee_id, label: manager.name })),
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
        <Col xs={24} sm={12} lg={6}>
          <SummaryStatCard
            icon={<TeamOutlined />}
            value={totalCount}
            title="Total Employees"
            iconColor="#FFFFFF"
            iconBackground="#3B82F6"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <ReviewStatusCard
            icon={<ProfileOutlined />}
            title="Self Reviews"
            subtitle="Track self-review submissions"
            iconColor="#FFFFFF"
            iconBackground="#22C55E"
            submittedCount={selfAssessmentSubmittedCount}
            pendingCount={selfAssessmentPendingCount}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <ReviewStatusCard
            icon={<StarOutlined />}
            title="Manager Reviews"
            subtitle="Track manager review progress"
            iconColor="#FFFFFF"
            iconBackground="var(--color-primary, #6666D1)"
            submittedCount={managerEvalSubmittedCount}
            submittedLabel="Completed"
            pendingCount={managerEvalPendingCount}
            pendingLabel="Not Completed"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <ReviewStatusCard
            icon={<SafetyCertificateOutlined />}
            title="HR Reviews"
            subtitle="Track HR review progress"
            iconColor="#FFFFFF"
            iconBackground="var(--color-accent, #5DD3E8)"
            submittedCount={hrEvalSubmittedCount}
            submittedLabel="Completed"
            pendingCount={hrEvalPendingCount}
            pendingLabel="Not Completed"
          />
        </Col>
      </Row>

      <div className="app-content-card">
        {filteredEmployees.length === 0 ? (
          selectedManagerId ? (
            <EmptyHRState
              title="No reports for this manager"
              description="This manager doesn't have any employees assigned to them."
            />
          ) : (
            <EmptyHRState />
          )
        ) : (
          <>
          <HikeDistributionBar
            counts={bandCounts}
            total={filteredEmployees.length}
            selectedBand={selectedBand}
            onSelect={applyBand}
          />
          <Table
            className="team-table scrollable-team-table"
            columns={columns}
            dataSource={tableEmployees}
            rowKey="email"
            // Fixed header, scrolling rows — same setup as the Manager Review
            // table (see scrollable-team-table in teamTable.css, which makes
            // the body fill the card; the 240 is only antd's trigger).
            scroll={{ y: 240 }}
            pagination={{
              pageSize: 10,
              current: currentPage,
              onChange: setCurrentPage,
              showTotal: (total, range) => `Showing ${range[0]}–${range[1]} of ${total} employees`,
            }}
            locale={{
              // Only reachable when a selected band has no one left after a
              // Manager change (empty bands have no segment to click).
              emptyText: (
                <EmptyHRState
                  title="No employees in the selected hike band"
                  description="No employee in this view has an Overall Score in this band."
                  action={
                    <Button type="primary" onClick={() => applyBand(null)}>
                      Show all
                    </Button>
                  }
                />
              ),
            }}
          />
          </>
        )}
      </div>
    </div>
  );
};

export default HRDashboard;
