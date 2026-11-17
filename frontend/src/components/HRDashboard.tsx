import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Table, Typography, Avatar, Button, Select, Row, Col, Tag } from 'antd';
import { IdcardOutlined, TeamOutlined, ProfileOutlined, StarOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import ApiService, { HRDashboardResponse, HREmployee, HRManager, ReviewPeriodOption } from '../services/apiService';
import FormLoadingState from './FormLoadingState';
import { getInitials, StatusBadge } from '../utils/teamStatusHelpers';
import { formatReviewPeriod } from '../utils/reviewPeriodFormat';
import { SummaryStatCard, ReviewStatusCard } from './ManagerDashboard';
import HikeDistributionCard, { employeeHikeBracketIndex } from './HikeDistributionCard';
import { HIKE_BRACKETS } from '../utils/hikeBrackets';
import '../styles/pageLayout.css';
import '../styles/teamTable.css';
import '../styles/managerDashboard.css';

const { Title, Text } = Typography;

// Value of the Reporting Manager filter's "All Managers" option — never a
// real employee_id.
const ALL_OPTION = '__all__';

interface EmptyHRStateProps {
  title?: string;
  description?: string;
}

const EmptyHRState: React.FC<EmptyHRStateProps> = ({
  title = 'No employees found',
  description = 'There are no other employees in the system yet.',
}) => (
  <div className="team-empty-state">
    <div className="team-empty-icon">
      <IdcardOutlined />
    </div>
    <div className="team-empty-title">{title}</div>
    <div className="team-empty-description">{description}</div>
  </div>
);

const HRDashboard: React.FC = () => {
  const navigate = useNavigate();
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
    // A different period means different scores, so drop any hike filter.
    setSelectedHikeIndex(undefined);
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

  // Hike bracket picked on the Performance & Hike card (index into
  // HIKE_BRACKETS) — narrows only the table below; the summary cards keep
  // counting the whole manager-filtered roster so their numbers don't shift
  // as HR clicks between brackets.
  const [selectedHikeIndex, setSelectedHikeIndex] = useState<number | undefined>(undefined);
  const tableEmployees = useMemo(
    () =>
      selectedHikeIndex === undefined
        ? filteredEmployees
        : filteredEmployees.filter((employee) => employeeHikeBracketIndex(employee) === selectedHikeIndex),
    [filteredEmployees, selectedHikeIndex]
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
            <div className="employee-name" title={record.name}>{record.name}</div>
            <div className="employee-email" title={record.email}>{record.email}</div>
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
      title: 'Action',
      key: 'action',
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
    <div className="app-page-container">
      {/* Tighter than the shared 24px header margin — 8px here plus the
          title's own 8px leaves 16px above the filter row. */}
      <div className="app-page-header" style={{ marginBottom: 8 }}>
        <Title level={3} className="app-page-title">HR Review</Title>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
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
            onChange={(value) => setSelectedManagerId(value === ALL_OPTION ? undefined : value)}
            options={[
              { value: ALL_OPTION, label: 'All Managers' },
              ...managers.map((manager) => ({ value: manager.employee_id, label: manager.name })),
            ]}
          />
        </div>
      </div>

      <Row gutter={[{ xs: 16, sm: 20, lg: 24 }, { xs: 16, sm: 20, lg: 24 }]} align="stretch" style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={8} xl={{ flex: '20%' }}>
          <SummaryStatCard
            icon={<TeamOutlined />}
            value={totalCount}
            title="Total Employees"
            iconColor="#FFFFFF"
            iconBackground="#3B82F6"
          />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={{ flex: '20%' }}>
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
        <Col xs={24} sm={12} lg={8} xl={{ flex: '20%' }}>
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
        <Col xs={24} sm={12} lg={8} xl={{ flex: '20%' }}>
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
        <Col xs={24} sm={12} lg={8} xl={{ flex: '20%' }}>
          <HikeDistributionCard
            employees={filteredEmployees}
            selectedIndex={selectedHikeIndex}
            onSelect={setSelectedHikeIndex}
          />
        </Col>
      </Row>

      {selectedHikeIndex !== undefined && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <Text strong>Hike:</Text>
          <Tag closable color="purple" onClose={() => setSelectedHikeIndex(undefined)} style={{ marginInlineEnd: 0 }}>
            {HIKE_BRACKETS[selectedHikeIndex].hike} hike ({HIKE_BRACKETS[selectedHikeIndex].label})
          </Tag>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {tableEmployees.length} of {filteredEmployees.length} employees
          </Text>
        </div>
      )}

      <div className="app-content-card">
        {filteredEmployees.length > 0 && tableEmployees.length === 0 ? (
          <EmptyHRState
            title="No employees in this hike bracket"
            description="No employee's Overall Score falls in this range. Clear the hike filter to see everyone."
          />
        ) : filteredEmployees.length === 0 ? (
          selectedManagerId ? (
            <EmptyHRState
              title="No reports for this manager"
              description="This manager doesn't have any employees assigned to them."
            />
          ) : (
            <EmptyHRState />
          )
        ) : (
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
              showTotal: (total, range) => `Showing ${range[0]}–${range[1]} of ${total} employees`,
            }}
          />
        )}
      </div>
    </div>
  );
};

export default HRDashboard;
