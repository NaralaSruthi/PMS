import React, { useEffect, useRef, useState } from 'react';
import { Typography, Spin, Button, Form, message } from 'antd';
import ApiService, { FormQuestion, ReviewScore } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../utils/teamStatusHelpers';
import { renderField, formatAnswer, isTextQuestion, trimTextAnswers, AssessmentTextArea } from '../utils/formFieldRendering';
import { useSubmitConfirmation } from '../hooks/useSubmitConfirmation';
import { formatPoints } from './EvaluationSummary';
import '../styles/hrEmployeeDetails.css';

const { Text } = Typography;

// A real dbo.self_evaluation_form row exists for this template — fetched
// below like any other template, rather than assumed empty. Every question
// on it is rendered (HR can add more from the Forms tab), except "Review
// Period", which every template carries but nobody answers here. "Additional
// Comments" is the CDO's optional remark, so it stays optional and keeps its
// own placeholder.
const OVERALL_REVIEW_TEMPLATE_ID = 1004;
const COMMENTS_QUESTION_TEXT = 'Additional Comments';
const isHiddenQuestion = (question: FormQuestion) => question.question === 'Review Period';


export interface OverallReviewTabProps {
  // Omitted entirely (rather than the caller's own employee_id) when the
  // employee is viewing their own Overall Review — same self-resolves
  // convention every other employee_id-less call in this app already uses
  // (see _resolve_target_employee in main.py). Only HR's usage (
  // HREmployeeDetails) ever passes a real value here.
  employeeId?: string;
  // Workflow gate: HR Evaluation must already be submitted — computed by the
  // parent (HREmployeeDetails) from the same data it already has.
  available: boolean;
  // Form still renders but Approve is disabled — set while the Manager
  // Review is rejected (Requirements §5.8 "Disabled" state).
  submitDisabled?: boolean;
  // HR-only: show a previous period's Overall Review (read-only, no
  // Approve). Omitted for the current period.
  reviewPeriodId?: string;
  // Called right after Approve succeeds — the parent's own tab label/
  // workflow-strip badge read from a roster fetched once on page load, which
  // this tab's own local `approved` state doesn't touch (same reasoning as
  // HREvaluationTab's onSubmitted).
  onApproved?: () => void;
  // Called when Approve is refused because the Manager Review turned out to
  // be rejected (e.g. from another browser) — the parent refetches, which
  // disables Approve.
  onStatusOutdated?: () => void;
  // Points earned / possible on the Manager and HR Reviews, as stored on
  // each submission (see _score_fields in main.py) — the Overall Score is
  // simply their sum (e.g. 61.25/85 + 12/15 = 73.25/100). Undefined when that
  // review isn't submitted or its form has no scored questions yet.
  managerScore?: ReviewScore;
  hrScore?: ReviewScore;
}

// Employee Review Details page's final "Overall Review" tab — CDO-only
// approval, one step after the HR Evaluation. Read-only for everyone else
// (regular HR sees the same status but no Approve button), enforced again
// server-side (see submit_form's OVERALL_REVIEW_TEMPLATE_ID gate in main.py)
// so this isn't the only thing stopping a non-CDO from approving.
const OverallReviewTab: React.FC<OverallReviewTabProps> = ({
  employeeId,
  available,
  submitDisabled = false,
  reviewPeriodId,
  onApproved,
  onStatusOutdated,
  managerScore,
  hrScore,
}) => {
  const { authState } = useAuth();
  const isCDO = authState.user?.isCDO || false;

  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [approvedAt, setApprovedAt] = useState<string | undefined>(undefined);
  const [approving, setApproving] = useState(false);
  // A previous period is always locked (see _is_period_locked in main.py) —
  // no Approve, and every question stays read-only.
  const [locked, setLocked] = useState(false);
  // The template's visible questions, in order, and the submitted answers
  // (empty until approved).
  const [questions, setQuestions] = useState<FormQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [form] = Form.useForm();
  const { confirmSubmit, contextHolder: submitConfirmHolder } = useSubmitConfirmation();
  // Guards against React StrictMode's dev-only double-invoke of effects.
  const hasFetchedRef = useRef<string | undefined | null>(null);

  const fetchApproval = () => {
    if (!available) return;
    setLoading(true);
    setError(null);
    ApiService.getFormWithSubmission(OVERALL_REVIEW_TEMPLATE_ID, employeeId, reviewPeriodId)
      .then(({ template: overallTemplate, submission: overall }) => {
        setApproved(overall.submitted);
        setLocked(!!overall.locked);
        setApprovedAt(overall.submitted_at);
        setQuestions(
          overallTemplate.questions.filter((q) => !isHiddenQuestion(q)).sort((a, b) => a.order - b.order)
        );
        setAnswers(overall.answers || {});
      })
      .catch((err: any) => setError(err?.message || 'Failed to load the overall review status'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!available) return;
    const fetchKey = `${employeeId ?? ''}:${reviewPeriodId ?? ''}`;
    if (hasFetchedRef.current === fetchKey) return;
    hasFetchedRef.current = fetchKey;
    fetchApproval();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, available, reviewPeriodId]);

  const managerPoints = managerScore?.score ?? 0;
  const hrPoints = hrScore?.score ?? 0;
  const overallScore = managerPoints + hrPoints;
  const overallMax = (managerScore?.max_score ?? 0) + (hrScore?.max_score ?? 0);
  const pointsLabel = (review?: ReviewScore) =>
    review?.max_score ? `${formatPoints(review.score ?? 0)} / ${formatPoints(review.max_score)}` : '—';

  // Required questions first, then an "are you sure" — approval closes the
  // whole review cycle, so it shouldn't happen on a stray click.
  const handleApprove = async () => {
    let values: Record<string, any>;
    try {
      values = await form.validateFields();
    } catch {
      return; // antd already shows each field's error
    }
    confirmSubmit('Approve Overall Review?', () => approve(values), {
      content:
        'Are you sure you want to approve this review?',
      okText: 'Approve',
    });
  };

  const approve = async (values: Record<string, any>) => {
    setApproving(true);
    try {
      // Date answers come out of the form as dayjs objects — sent as plain
      // YYYY-MM-DD, the same way they're shown read-only below. Typed text
      // is trimmed first (see trimTextAnswers).
      const submitted = Object.fromEntries(
        Object.entries(trimTextAnswers(questions, values)).map(([key, value]) => [
          key,
          value && typeof value.format === 'function' ? value.format('YYYY-MM-DD') : value,
        ])
      );
      await ApiService.submitFormTemplate(OVERALL_REVIEW_TEMPLATE_ID, submitted, employeeId);
      // Same wording as the other review forms (FORM_NAMES in
      // useSectionedFormTemplate).
      message.success('Overall Review Form submitted successfully');
      setAnswers(submitted);
      setApproved(true);
      setApprovedAt(new Date().toISOString());
      onApproved?.();
    } catch (err: any) {
      // The backend's Overall Review gate (submit_form in main.py) — this
      // page's status was out of date, so refresh it instead of just failing.
      if (typeof err?.message === 'string' && err.message.includes('Manager Evaluation is rejected')) {
        message.warning('This Manager Review has been rejected. Refreshing the review status…');
        onStatusOutdated?.();
        return;
      }
      message.error(err?.message || 'Failed to approve the overall review');
    } finally {
      setApproving(false);
    }
  };

  if (!available) {
    return (
      <div style={{ padding: '32px 4px', textAlign: 'center' }}>
        <Text strong style={{ display: 'block', fontSize: 16, color: '#F4F1F8', marginBottom: 8 }}>
          Overall Review
        </Text>
        <StatusBadge status="not_available" />
        <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          The Overall Review will be available for approval once the HR Evaluation has been submitted and the
          Manager Evaluation has been approved.
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

  return (
    <div style={{ padding: '8px 4px' }}>
      {submitConfirmHolder}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Text strong style={{ fontSize: 20, color: '#F4F1F8', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
          Overall Review
        </Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* "Not Available" while Approve is disabled (Manager Review
              rejected) — matches the tab badge and workflow strip. */}
          <StatusBadge status={approved ? 'submitted' : submitDisabled ? 'not_available' : 'ready'} />
          {isCDO && !approved && !locked && (
            <Button type="primary" size="middle" onClick={handleApprove} loading={approving} disabled={submitDisabled}>
              Approve
            </Button>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 32,
          flexWrap: 'wrap',
          marginTop: 20,
          marginBottom: 20,
          paddingBottom: 20,
          borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.12))',
        }}
      >
        <div>
          <div className="hr-employee-info-label">Overall Score</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#F4F1F8' }}>{overallMax > 0 ? `${formatPoints(overallScore)} / ${formatPoints(overallMax)}` : '—'}</div>
        </div>
        <div>
          <div className="hr-employee-info-label">Manager Review</div>
          <div className="hr-employee-info-value">{pointsLabel(managerScore)}</div>
        </div>
        <div>
          <div className="hr-employee-info-label">HR Review</div>
          <div className="hr-employee-info-value">{pointsLabel(hrScore)}</div>
        </div>
        {approved && approvedAt && (
          <div>
            <div className="hr-employee-info-label">Approved on</div>
            <div className="hr-employee-info-value">{new Date(approvedAt).toLocaleDateString()}</div>
          </div>
        )}
      </div>

      {isCDO && !approved && !locked ? (
        <Form form={form} layout="vertical" requiredMark={false}>
          {questions.map((question) => {
            const isComments = question.question === COMMENTS_QUESTION_TEXT;
            return (
              <Form.Item
                key={question.question_number}
                name={String(question.question_number)}
                // A slider (RatingQuestion) renders its own title.
                label={
                  question.type === 'slider' ? undefined : (
                    <span className="hr-employee-info-label">{question.question}</span>
                  )
                }
                rules={
                  !isComments && question.required !== false
                    ? [
                        {
                          required: true,
                          ...(isTextQuestion(question) ? { whitespace: true } : {}),
                          message: question.type === 'slider' ? 'Please provide a rating.' : 'This field is required',
                        },
                      ]
                    : []
                }
                style={{ marginBottom: 20 }}
              >
                {isComments ? (
                  <AssessmentTextArea
                    placeholder="Optional remarks for this final approval"
                    // Narrower than the shared .styled-form-input's default
                    // 100% width — this box only ever holds a short remark,
                    // not the multi-paragraph answers that class normally
                    // styles.
                    style={{ maxWidth: 800 }}
                  />
                ) : (
                  // No indent: renderField's default left margin lines a
                  // field up under a numbered label, and these labels
                  // aren't numbered — this keeps every box aligned with
                  // the comments box above.
                  renderField(question, { fontSize: 15, maxWidth: 800, marginLeft: 0, width: '100%' })
                )}
              </Form.Item>
            );
          })}
        </Form>
      ) : (
        questions.map((question) => {
          const answer = answers[String(question.question_number)];
          const hasAnswer = !(answer === undefined || answer === null || answer === '');
          return (
            <div key={question.question_number} style={{ marginBottom: 20 }}>
              <div className="hr-employee-info-label" style={{ marginBottom: 8 }}>{question.question}</div>
              <Text style={{ display: 'block', whiteSpace: 'pre-line', overflowWrap: 'anywhere', color: hasAnswer ? '#F4F1F8' : '#8B86A2' }}>
                {hasAnswer
                  ? formatAnswer(answer, question)
                  : question.question === COMMENTS_QUESTION_TEXT
                  ? 'No comments added.'
                  : 'Not answered.'}
              </Text>
            </div>
          );
        })
      )}

      {/* Workflow guidance for HR/the CDO only — not shown to an employee
          viewing their own review (no employeeId, see the prop above). */}
      {employeeId !== undefined && (
        <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          {approved
            ? 'This review has been given final approval. The employee can now see their full review.'
            : isCDO
            ? 'The HR Evaluation has been submitted. Approve the Manager Review to release the full review to the employee.'
            : 'Awaiting final approval from the CDO.'}
        </Text>
      )}
    </div>
  );
};

export default OverallReviewTab;
