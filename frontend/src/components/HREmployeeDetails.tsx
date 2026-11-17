import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Typography, Button, Tabs } from 'antd';
import { ArrowLeftOutlined, CheckCircleFilled, ClockCircleOutlined } from '@ant-design/icons';
import ApiService, { HRDashboardResponse, HREmployee } from '../services/apiService';
import { formatReviewPeriod } from '../utils/reviewPeriodFormat';
import FormLoadingState from './FormLoadingState';
import HRSelfAssessmentTab from './HRSelfAssessmentTab';
import HRManagerEvaluationTab from './HRManagerEvaluationTab';
import HREvaluationTab from './HREvaluationTab';
import OverallReviewTab from './OverallReviewTab';
import { StatusBadge } from '../utils/teamStatusHelpers';
import '../styles/pageLayout.css';
import '../styles/hrEmployeeDetails.css';

const { Title, Text } = Typography;

type TabKey = 'self' | 'manager' | 'hr' | 'overall';

interface InfoField {
  label: string;
  value?: string;
}

interface StatusPatch {
  managerApproval?: 'approved' | 'rejected';
  hrSubmitted?: boolean;
  overallApproved?: boolean;
  at: number;
}

// Reached from the HR Dashboard's "View Details" action. Reuses the same
// org-wide GET /api/hr/employees endpoint the dashboard itself already
// calls (no new backend route) and finds this one employee client-side by
// employee_id — never by name. The review_period_id query param (stored
// form, e.g. "Jan 2026 - Jun 2026") carries the period selected on the
// dashboard; the roster is fetched for exactly that period, so every status
// below is already scoped to it server-side.
const HREmployeeDetails: React.FC = () => {
  const { employeeId } = useParams<{ employeeId: string }>();
  const [searchParams] = useSearchParams();
  const selectedReviewPeriodId = searchParams.get('review_period_id') || undefined;
  const navigate = useNavigate();
  const location = useLocation();
  // Back returns to the dashboard on the same period HR was looking at.
  const backToDashboardPath = selectedReviewPeriodId
    ? `/hr-dashboard?review_period_id=${encodeURIComponent(selectedReviewPeriodId)}`
    : '/hr-dashboard';
  // HRDashboard's own "View Details" click already has this exact org-wide
  // roster in hand — handed over via router state so the page can render
  // instantly. It's only a first paint: the browser keeps router state across
  // F5 and back/forward, so it can be arbitrarily old, and a fresh roster is
  // always fetched in the background below. Ignored if it's for a different
  // period than the URL asks for.
  const routerDashboard = (location.state as { dashboard?: HRDashboardResponse } | null)?.dashboard;
  const preloadedDashboard =
    routerDashboard && (!selectedReviewPeriodId || routerDashboard.review_period_id === selectedReviewPeriodId)
      ? routerDashboard
      : undefined;

  const [dashboard, setDashboard] = useState<HRDashboardResponse | null>(preloadedDashboard ?? null);
  const [loading, setLoading] = useState(!preloadedDashboard);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('self');
  // Actions just taken on this page (Manager Review decision, HR Review
  // submitted, Overall Review approved), applied to every status straight
  // away rather than waiting for the roster refetch, which scans every
  // employee and can take seconds — otherwise the badges, workflow strip and
  // Approve button lagged behind until a refresh. `at` is when the latest
  // action was recorded; a roster fetched after it already includes it, so
  // the patch is dropped then (see fetchDashboard).
  const [statusPatch, setStatusPatch] = useState<StatusPatch | null>(null);
  // It belongs to one employee's review for one period — never carried over.
  useEffect(() => {
    setStatusPatch(null);
  }, [employeeId, selectedReviewPeriodId]);
  // Guards against React StrictMode's dev-only double-invoke of effects.
  const hasFetchedRef = useRef(false);
  // Only the most recently started fetch may apply its result, so a slow
  // older response can't overwrite a newer one.
  const latestFetchRef = useRef(0);

  // Re-run after every action on this page and on every tab switch, so the
  // statuses also pick up changes made elsewhere (e.g. the manager
  // resubmitting). A failed background refresh keeps the current data on
  // screen; only a failed first load (nothing to show yet) is an error.
  const fetchDashboard = useCallback(
    async ({ background = true }: { background?: boolean } = {}) => {
      const fetchId = ++latestFetchRef.current;
      const startedAt = Date.now();
      try {
        const response = await ApiService.getHRDashboard(selectedReviewPeriodId);
        if (fetchId !== latestFetchRef.current) return;
        setDashboard(response);
        setStatusPatch((prev) => (prev && prev.at <= startedAt ? null : prev));
      } catch (err: any) {
        if (!background) setError(err?.message || 'Failed to load employee review details');
      }
    },
    [selectedReviewPeriodId]
  );

  const recordAction = (patch: Omit<StatusPatch, 'at'>) => {
    setStatusPatch((prev) => ({ ...prev, ...patch, at: Date.now() }));
    fetchDashboard();
  };

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    // With a preloaded roster the page is already on screen, so this
    // refresh runs quietly behind it.
    if (preloadedDashboard) {
      fetchDashboard();
      return;
    }

    setLoading(true);
    fetchDashboard({ background: false }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchDashboard]);

  if (loading) {
    return <FormLoadingState />;
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  const employee: HREmployee | undefined = dashboard?.employees.find((e) => e.employee_id === employeeId);

  if (!employee) {
    return (
      <div className="app-page-container hr-employee-review-page">
        <div className="app-page-header">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(backToDashboardPath)} style={{ marginBottom: 16 }}>
            Back
          </Button>
        </div>
        <Text type="danger">No employee found with that ID.</Text>
      </div>
    );
  }

  // The roster was fetched for exactly this period (see get_hr_employees in
  // main.py), so "submitted" already means "submitted for this period".
  const selfSubmittedForPeriod = employee.self_assessment.submitted;

  const managerEvalSubmittedForPeriod = employee.manager_evaluation.submitted;

  const managerNotApplicable = !employee.manager_evaluation.has_manager && !managerEvalSubmittedForPeriod;

  // Workflow rule: HR Evaluation can only be started once BOTH Self
  // Assessment and Manager Evaluation are submitted for this same review
  // period — reusing the exact two period-aware booleans above rather than
  // re-deriving submission state, so this can never drift from what the
  // workflow status row and the other two tabs already show.
  const hrEvaluationAvailable = selfSubmittedForPeriod && managerEvalSubmittedForPeriod;

  const hrEvalSubmittedForPeriod = !!statusPatch?.hrSubmitted || employee.hr_evaluation.submitted;

  // Overall Review (CDO's final approval) can't happen until the HR
  // Evaluation itself has a real submission, AND the Manager Evaluation is
  // Pending (submitted, no decision yet) or Approved — mirrors
  // OVERALL_REVIEW_TEMPLATE_ID's gate in submit_form (main.py), re-derived
  // here so the Approve button never renders enabled just to 400 on click.
  const managerApprovalStatus = statusPatch?.managerApproval ?? employee.manager_evaluation.approval_status;
  const managerRejected = managerEvalSubmittedForPeriod && managerApprovalStatus === 'rejected';
  const overallReviewAvailable =
    hrEvalSubmittedForPeriod && managerEvalSubmittedForPeriod && managerApprovalStatus !== 'rejected';
  // Requirements §5.8 "Disabled": HR Review submitted but the Manager Review
  // was rejected — the form still renders, with Submit disabled until the
  // manager resubmits.
  const overallSubmitDisabled = hrEvalSubmittedForPeriod && managerApprovalStatus === 'rejected';
  // Period-agnostic (see the type comment on overall_review) — approval is a
  // one-time act, not tied to any one review period the way the other three
  // statuses are.
  const overallApproved = !!statusPatch?.overallApproved || employee.overall_review.submitted;

  // A previous period (HR-only) is read-only history: each tab is told which
  // period to load, and the backend reports it as locked so no Edit/Approve/
  // Reject is offered. Undefined for the current period, so every tab keeps
  // its normal behavior there.
  const isPastPeriod = !!dashboard && dashboard.review_period_id !== dashboard.current_review_period_id;
  const tabReviewPeriodId = isPastPeriod ? dashboard?.review_period_id : undefined;

  // Each tab loads its own content once, so it's keyed on the roster's
  // version of that review: when a refresh shows a newer submission or
  // decision (e.g. the manager resubmitted from elsewhere), the tab remounts
  // and reloads. Unchanged keys never remount, so in-progress edits survive.
  const tabVersion = (status: { submitted_at?: string; approval_status?: string | null }) =>
    `${employee.employee_id}:${tabReviewPeriodId ?? ''}:${status.submitted_at ?? ''}:${status.approval_status ?? ''}`;

  // Only real, existing fields — nothing here is invented. designation and
  // department come straight from dataflix_users (via GET /api/hr/employees);
  // a field is simply omitted if the underlying value doesn't exist.
  const infoFields: InfoField[] = [
    { label: 'Employee', value: employee.name },
    { label: 'Designation', value: employee.designation },
    { label: 'Department', value: employee.department },
    { label: 'Reporting Manager', value: employee.manager_name },
    {
      label: 'Review Period',
      value: dashboard?.review_period ? formatReviewPeriod(dashboard.review_period) : undefined,
    },
  ].filter((field) => !!field.value);

  // Status indicator only, per the "workflow" requirement — no percentage
  // or progress bar.
  const workflowSteps: { key: TabKey; label: string; done: boolean; statusText: string }[] = [
    {
      key: 'self',
      label: 'Self Review',
      done: selfSubmittedForPeriod,
      statusText: selfSubmittedForPeriod ? 'Submitted' : 'Not Started',
    },
    {
      key: 'manager',
      label: 'Manager Review',
      // Sent back to the manager, so not done until they resubmit.
      done: managerEvalSubmittedForPeriod && !managerRejected,
      statusText: managerNotApplicable
        ? 'N/A'
        : managerRejected
        ? 'Rejected'
        : managerEvalSubmittedForPeriod
        ? 'Submitted'
        : 'Not Started',
    },
    {
      key: 'hr',
      label: 'HR Review',
      done: hrEvalSubmittedForPeriod,
      statusText: hrEvalSubmittedForPeriod ? 'Submitted' : hrEvaluationAvailable ? 'Ready' : 'Not Available',
    },
    {
      key: 'overall',
      label: 'Overall Review',
      done: overallApproved,
      statusText: overallApproved ? 'Approved' : overallReviewAvailable ? 'Ready' : 'Not Available',
    },
  ];

  return (
    <div className="app-page-container hr-employee-review-page">
      <div className="app-page-header">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(backToDashboardPath)} style={{ marginBottom: 16 }}>
          Back
        </Button>
        <Title level={3} className="app-page-title">Employee Review</Title>
      </div>

      <div className="app-content-card app-content-card--plain">
        <div className="hr-employee-info-grid">
          {infoFields.map((field) => (
            <div key={field.label}>
              <div className="hr-employee-info-label">{field.label}</div>
              <div className="hr-employee-info-value">{field.value}</div>
            </div>
          ))}
        </div>

        <div className="hr-workflow-status">
          {workflowSteps.map((step, index) => (
            <React.Fragment key={step.key}>
              <div className="hr-workflow-step">
                {step.done ? (
                  <CheckCircleFilled style={{ fontSize: 22, color: '#4ADE80' }} />
                ) : (
                  <ClockCircleOutlined style={{ fontSize: 22, color: '#8B86A2' }} />
                )}
                <span className="hr-workflow-step-label">{step.label}</span>
                <span className="hr-workflow-step-status">{step.statusText}</span>
              </div>
              {index < workflowSteps.length - 1 && <div className="hr-workflow-connector" />}
            </React.Fragment>
          ))}
        </div>

        <Tabs
          className="hr-employee-tabs"
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key as TabKey);
            fetchDashboard();
          }}
          items={[
            {
              key: 'self',
              label: (
                <span className="hr-tab-label">
                  <span>Self Review</span>
                  <StatusBadge status={selfSubmittedForPeriod ? 'submitted' : 'not_started'} />
                </span>
              ),
              children: (
                <HRSelfAssessmentTab
                  key={tabVersion(employee.self_assessment)}
                  employeeId={employee.employee_id!}
                  submittedForPeriod={selfSubmittedForPeriod}
                  reviewPeriodId={tabReviewPeriodId}
                />
              ),
            },
            {
              key: 'manager',
              label: (
                <span className="hr-tab-label">
                  <span>Manager Review</span>
                  {managerNotApplicable ? (
                    <span className="hr-tab-label-na">N/A</span>
                  ) : (
                    <StatusBadge
                      status={managerRejected ? 'rejected' : managerEvalSubmittedForPeriod ? 'submitted' : 'not_started'}
                    />
                  )}
                </span>
              ),
              children: (
                <HRManagerEvaluationTab
                  key={tabVersion(employee.manager_evaluation)}
                  employeeId={employee.employee_id!}
                  submittedForPeriod={managerEvalSubmittedForPeriod}
                  submittedByName={employee.manager_name}
                  naReason={managerNotApplicable ? 'This employee has no manager currently assigned.' : undefined}
                  reviewPeriodId={tabReviewPeriodId}
                  onDecision={(status) => recordAction({ managerApproval: status })}
                />
              ),
            },
            {
              key: 'hr',
              label: (
                <span className="hr-tab-label">
                  <span>HR Review</span>
                  <StatusBadge
                    status={hrEvalSubmittedForPeriod ? 'submitted' : hrEvaluationAvailable ? 'ready' : 'not_available'}
                  />
                </span>
              ),
              children: (
                <HREvaluationTab
                  key={tabVersion(employee.hr_evaluation)}
                  employeeId={employee.employee_id!}
                  available={hrEvaluationAvailable}
                  onSubmitted={() => recordAction({ hrSubmitted: true })}
                  reviewPeriodId={tabReviewPeriodId}
                />
              ),
            },
            {
              key: 'overall',
              label: (
                <span className="hr-tab-label">
                  <span>Overall Review</span>
                  <StatusBadge
                    status={overallApproved ? 'submitted' : overallReviewAvailable ? 'ready' : 'not_available'}
                  />
                </span>
              ),
              children: (
                <OverallReviewTab
                  key={tabVersion(employee.overall_review)}
                  employeeId={employee.employee_id!}
                  available={overallReviewAvailable || overallSubmitDisabled}
                  submitDisabled={overallSubmitDisabled}
                  reviewPeriodId={tabReviewPeriodId}
                  onApproved={() => recordAction({ overallApproved: true })}
                  onStatusOutdated={() => fetchDashboard()}
                  managerScore={employee.manager_evaluation}
                  hrScore={employee.hr_evaluation}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
};

export default HREmployeeDetails;
