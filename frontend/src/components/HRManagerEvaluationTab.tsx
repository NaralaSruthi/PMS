import React, { useState } from 'react';
import { Form, Typography, Spin, Button, Modal, Input, message } from 'antd';
import ApiService from '../services/apiService';
import { useSectionedFormTemplate } from '../hooks/useSectionedFormTemplate';
import { ManagerEvaluationAnswers } from './ManagerEvaluationAnswers';
import { isAutoFilledQuestion } from './ManagerEvaluation';
import EvaluationSummary from './EvaluationSummary';
import PerformanceHikeReference from './PerformanceHikeReference';
import ReviewHistory from './ReviewHistory';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../utils/teamStatusHelpers';
import { computeRatingSummary } from '../utils/ratingSummary';
import '../styles/hrEmployeeDetails.css';
import '../styles/evaluationSummary.css';

const { Text } = Typography;
const { TextArea } = Input;

const MANAGER_EVALUATION_TEMPLATE_ID = 1002;

export interface HRManagerEvaluationTabProps {
  // Optional so this tab can also be reused by an employee viewing their own
  // review (MyReviewDetails) — omitted there, which resolves to "self" the
  // same way every other employee_id-less call in this app already does
  // (see _resolve_target_employee in main.py).
  employeeId?: string;
  // Whether a Manager Evaluation submission exists for this employee for the
  // review period currently selected on the HR Dashboard — computed once by
  // the parent (HREmployeeDetails, from data it already has), so this tab
  // doesn't re-derive it from a second fetch.
  submittedForPeriod: boolean;
  // The reporting manager's name, resolved by the parent from the org-wide
  // roster (employee.manager_name) — not read off the submission response,
  // since /submission's employee_name field always names the employee being
  // evaluated, not the manager who submitted the evaluation about them.
  submittedByName?: string;
  // Set when the employee has no manager assigned at all, so there's nothing
  // that could ever be submitted here — distinct from "not submitted yet".
  naReason?: string;
  // HR-only: show a previous period's submission (read-only, no
  // Approve/Reject). Omitted for the current period.
  reviewPeriodId?: string;
  // Fires after an Approve/Reject has actually been recorded (never on a
  // failed call), so the parent can refetch — e.g. HREmployeeDetails, whose
  // Overall Review readiness depends on this approval status and otherwise
  // kept showing "Ready" after a rejection until a refresh. Passes the
  // decision so the parent can apply it before its refetch returns.
  onDecision?: (status: 'approved' | 'rejected') => void;
  // Employee's own My Reviews page only: hides the score summary panel
  // (rating chart and points) so the answers use the full width. HR, CDO and
  // manager views leave this off and keep their scores.
  hideScores?: boolean;
  // Employee's own My Reviews page only (shown after the Overall Review is
  // approved): hides the Review History (submit / reject / resubmit trail)
  // and the approval details (Approved/Rejected badge and "Approved by" row),
  // leaving just Submitted by / Submitted on. HR, CDO and manager views
  // leave this off.
  hideHistory?: boolean;
}

// Employee Review Details page's "Manager Evaluation" tab. Read-only for
// everyone, including HR — a submitted Manager Evaluation can no longer be
// reopened for editing from here (the backend's submit_form also rejects
// this template's edit carve-out unconditionally now, not just client-side).
const HRManagerEvaluationTab: React.FC<HRManagerEvaluationTabProps> = ({
  employeeId,
  submittedForPeriod,
  submittedByName,
  naReason,
  reviewPeriodId,
  onDecision,
  hideScores,
  hideHistory,
}) => {
  // The hook's internal Form.useWatch/setFieldsValue calls need a real
  // FormInstance to exist even though this read-only tab never renders a
  // <Form> of its own.
  const [form] = Form.useForm();

  // templateId is only handed to the hook once we know a submission actually
  // exists — otherwise this would fetch (and the loading state below would
  // spin forever) for an employee who was never going to have anything to
  // show anyway.
  const {
    template,
    loading,
    error,
    sections,
    submittedAnswers,
    submittedAt,
    approvalStatus,
    setApprovalStatus,
    approvalBy,
    setApprovalBy,
    approvalAt,
    setApprovalAt,
    history,
    setHistory,
    locked,
    setLocked,
  } = useSectionedFormTemplate(
    form,
    submittedForPeriod ? MANAGER_EVALUATION_TEMPLATE_ID : undefined,
    employeeId,
    undefined,
    undefined,
    reviewPeriodId
  );

  const ratingSummary = computeRatingSummary(template?.questions ?? [], submittedAnswers || {});

  // Approve/Reject is HR/CDO-only (is_hr already covers the CDO designation
  // — see HR_DESIGNATIONS in main.py) and only makes sense when viewing a
  // SPECIFIC employee's evaluation — never on MyReviewDetails, where this
  // same tab is reused for an employee viewing their OWN manager's
  // evaluation of them (employeeId is undefined there, resolving to "self"
  // server-side, which this action was never meant to target).
  const { authState } = useAuth();
  // No decisions once the Overall Review has locked the period.
  const canDecide = (authState.user?.isHR || false) && !!employeeId && !locked;
  // Tracks which specific decision is in flight (not just whether one is),
  // so only the clicked button shows its own loading spinner instead of both.
  const [decisionSubmitting, setDecisionSubmitting] = useState<'approved' | 'rejected' | null>(null);
  // Reject asks for a reason first (Approve doesn't) — this only tracks
  // whether that prompt is open, not the decision itself.
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const handleDecision = async (status: 'approved' | 'rejected', reason?: string) => {
    if (!employeeId) return;
    setDecisionSubmitting(status);
    try {
      const now = new Date().toISOString();
      await ApiService.setFormApproval(MANAGER_EVALUATION_TEMPLATE_ID, employeeId, status, reason);
      setApprovalStatus(status);
      setApprovalBy(authState.user?.name);
      setApprovalAt(now);
      // Mirrors set_submission_approval appending to history server-side —
      // without this, Review History only shows the new decision after a
      // full page reload/refetch, same reasoning as the resubmit handler in
      // useSectionedFormTemplate already appending its own "submitted" entry.
      setHistory((prev) => [
        ...prev,
        { event: status, at: now, by: authState.user?.name, ...(reason ? { reason } : {}) },
      ]);
      message.success(status === 'approved' ? 'Manager Evaluation approved' : 'Manager Evaluation rejected');
      onDecision?.(status);
    } catch (err: any) {
      // The period was locked after this tab loaded — hide the buttons.
      if (err?.status === 409 && typeof err?.message === 'string' && err.message.includes('locked')) setLocked(true);
      message.error(err?.message || 'Failed to record decision');
    } finally {
      setDecisionSubmitting(null);
    }
  };

  const openRejectModal = () => {
    setRejectReason('');
    setRejectModalOpen(true);
  };

  const confirmReject = async () => {
    const trimmedReason = rejectReason.trim();
    if (!trimmedReason) {
      message.error('A reason is required to reject this evaluation.');
      return;
    }
    setRejectModalOpen(false);
    await handleDecision('rejected', trimmedReason);
  };

  // "Employee Name"/"Review Period" are auto-filled (never something the
  // manager actually answers), so they're skipped in this read-only view
  // too — same predicate imported from ManagerEvaluation.tsx (same template,
  // so the same set applies) rather than a second, separately maintained
  // copy of it here.
  const readOnlySections = sections
    .map((section) => ({ ...section, questions: section.questions.filter((q) => !isAutoFilledQuestion(q)) }))
    .filter((section) => section.questions.length > 0);

  if (!submittedForPeriod) {
    return (
      <div style={{ padding: '32px 4px', textAlign: 'center' }}>
        <Text strong style={{ display: 'block', fontSize: 16, color: '#F4F1F8', marginBottom: 8 }}>
          Manager Review
        </Text>
        <StatusBadge status="not_started" />
        <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          {naReason || 'The manager review has not been submitted for this review period.'}
        </Text>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: '32px 4px', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  if (!template) {
    return null;
  }

  return (
    <div className="manager-eval-tab-layout" style={hideScores ? { gridTemplateColumns: '1fr' } : undefined}>
      <div className="manager-eval-tab-layout__form">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <Text strong style={{ fontSize: 20, color: '#F4F1F8', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Manager Review
          </Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* "Rejected" replaces "Submitted" until the manager resubmits;
                an approval shows alongside it. */}
            <StatusBadge status={approvalStatus === 'rejected' && !hideHistory ? 'rejected' : 'submitted'} />
            {approvalStatus === 'approved' && !hideHistory && <StatusBadge status="approved" />}
            {canDecide && (
              <>
                <Button
                  className="approve-decision-btn"
                  size="small"
                  onClick={() => handleDecision('approved')}
                  loading={decisionSubmitting === 'approved'}
                  // Also disabled while rejected — only the manager's
                  // resubmission reopens it for a decision (Requirements §5.6).
                  disabled={approvalStatus === 'approved' || approvalStatus === 'rejected'}
                >
                  Approve
                </Button>
                <Button
                  className="reject-decision-btn"
                  size="small"
                  onClick={openRejectModal}
                  loading={decisionSubmitting === 'rejected'}
                  disabled={approvalStatus === 'rejected'}
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        </div>
        {template.header_title && (
          <Text style={{ display: 'block', fontSize: 16, color: '#C5C0D6', lineHeight: 1.6, marginTop: 8 }}>
            {template.header_title}
          </Text>
        )}
        <div
          style={{
            display: 'flex',
            gap: 32,
            marginTop: 16,
            marginBottom: 28,
            paddingBottom: 24,
            flexWrap: 'wrap',
            borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.12))',
          }}
        >
          {submittedByName && (
            <div>
              <div className="hr-employee-info-label">Submitted by</div>
              <div className="hr-employee-info-value">{submittedByName}</div>
            </div>
          )}
          {submittedAt && (
            <div>
              <div className="hr-employee-info-label">Submitted on</div>
              <div className="hr-employee-info-value">{new Date(submittedAt).toLocaleDateString()}</div>
            </div>
          )}
          {!hideHistory && approvalStatus && approvalBy && approvalAt && (
            <div>
              <div className="hr-employee-info-label">{approvalStatus === 'approved' ? 'Approved' : 'Rejected'} by</div>
              <div className="hr-employee-info-value">
                {approvalBy} on {new Date(approvalAt).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
        {!hideHistory && <ReviewHistory events={history || []} reviewLabel="Manager Review" />}
        <ManagerEvaluationAnswers sections={readOnlySections} answers={submittedAnswers || {}} />
      </div>
      {!hideScores && (
        <div className="manager-eval-tab-layout__summary">
          <PerformanceHikeReference scorePercentage={ratingSummary.scorePercentage} />
          <EvaluationSummary summary={ratingSummary} />
        </div>
      )}
      <Modal
        title="Reject Manager Evaluation"
        open={rejectModalOpen}
        onOk={confirmReject}
        onCancel={() => setRejectModalOpen(false)}
        okText="Reject"
        okButtonProps={{ danger: true, disabled: !rejectReason.trim() }}
        // Stays in the middle at any zoom level or window height.
        centered
      >
        <Text style={{ display: 'block', marginBottom: 8 }}>Reason (required)</Text>
        <TextArea
          rows={4}
          placeholder="Explain why this evaluation is being rejected"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
        />
      </Modal>
    </div>
  );
};

export default HRManagerEvaluationTab;
