import React, { useEffect, useRef, useState } from 'react';
import { Form, Typography, Spin, Button } from 'antd';
import dayjs from 'dayjs';
import { FormQuestion } from '../services/apiService';
import { useSectionedFormTemplate } from '../hooks/useSectionedFormTemplate';
import { useSubmitConfirmation } from '../hooks/useSubmitConfirmation';
import {
  renderField,
  renderQuestionLabel,
  indentedFieldStyle,
  buildQuestionDisplayNumbers,
  isTextQuestion,
  AssessmentTextArea,
} from '../utils/formFieldRendering';
import { ManagerEvaluationAnswers } from './ManagerEvaluationAnswers';
import EvaluationSummary from './EvaluationSummary';
import PerformanceHikeReference from './PerformanceHikeReference';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../utils/teamStatusHelpers';
import { computeRatingSummary } from '../utils/ratingSummary';
import '../styles/evaluationForm.css';
import '../styles/hrEmployeeDetails.css';
import '../styles/evaluationSummary.css';

const { Title, Text } = Typography;

const HR_EVALUATION_TEMPLATE_ID = 1003;

// "Review Period" already has a known answer (see getInitialValue below) and
// shouldn't be shown as a field to fill in — only in the submitted, read-only
// view (ManagerEvaluationAnswers, which reads the hook's full `sections`, not
// the filtered `fillableSections` this excludes it from). Same approach
// main.py uses server-side and ManagerEvaluation.tsx/selfassesment.tsx use
// for their own equivalent fields — HR Evaluation has no "Employee Name"
// question of its own, so Review Period is the only one here.
const isAutoFilledQuestion = (question: FormQuestion) => question.question === 'Review Period';

// Matches renderQuestionLabel's font — same convention ManagerEvaluation.tsx
// uses for its comment fields.
const COMMENT_LABEL_STYLE: React.CSSProperties = { fontSize: 16, fontWeight: 600, color: '#F4F1F8' };

const commentFieldName = (question: FormQuestion) => `${question.question_number}_comment`;

export interface HREvaluationTabProps {
  // Optional so this tab can also be reused by an employee viewing their own
  // reviews (MyReviewDetails) — omitted there, which resolves to "self" the
  // same way every other employee_id-less call in this app already does
  // (see _resolve_target_employee in main.py).
  employeeId?: string;
  // Workflow gate: Self Assessment AND Manager Evaluation both submitted for
  // the review period currently shown on this page — computed by the parent
  // (HREmployeeDetails) from the exact same period-aware booleans it already
  // uses for the workflow status row, so this can never disagree with what
  // that row displays. Re-checked server-side too (see submit_form in
  // main.py) so this isn't the only thing enforcing it.
  available: boolean;
  // Called right after a submit actually completes (create OR edit) — the
  // parent's own "HR Review" tab label/workflow-strip badge read from data
  // fetched once on page load, which this tab's own local submittedAnswers
  // state doesn't touch, so without this callback they'd keep showing
  // "Ready" even after the submission just succeeded.
  onSubmitted?: () => void;
  // HR-only: show a previous period's submission (read-only, no Edit).
  // Omitted for the current period.
  reviewPeriodId?: string;
  // Employee's own My Reviews page only: hides the score summary panel
  // (rating chart and points) so the answers use the full width. HR, CDO and
  // manager views leave this off and keep their scores.
  hideScores?: boolean;
  // Shown as "Submitted by" next to "Submitted on". No HR person is recorded
  // on the submission, so the caller passes a role label (the employee's My
  // Reviews page passes "HR"); omitted elsewhere.
  submittedByLabel?: string;
}

// Employee Review Details page's "HR Evaluation" tab. Unlike
// HRManagerEvaluationTab (which only ever edits an ALREADY-submitted Manager
// Evaluation — the manager creates it elsewhere), HR Evaluation has no
// separate "fill it out" surface anywhere else in the app: HR both creates
// and edits it right here, since HR is the only one who ever submits this
// template. Backend enforces that (is_hr + a specific employee_id, plus the
// same availability gate) in submit_form — this component doesn't just trust
// a client-side check.
const HREvaluationTab: React.FC<HREvaluationTabProps> = ({
  employeeId,
  available,
  onSubmitted,
  reviewPeriodId,
  hideScores,
  submittedByLabel,
}) => {
  const { authState } = useAuth();
  const isHR = authState.user?.isHR || false;
  // CDO shares HR's is_hr flag (see HR_DESIGNATIONS in main.py) so they can
  // still view this tab, but they get read-only access here — only a real
  // HR designation can create or edit an HR Evaluation. Backend enforces the
  // same restriction in submit_form, so this isn't just a client-side check.
  const isCDO = authState.user?.isCDO || false;
  const canEditHR = isHR && !isCDO;
  const [form] = Form.useForm();
  // Called unconditionally (before any of the early returns below) — hooks
  // can't be called conditionally. Falls back to {} while there's nothing to
  // watch yet.
  const liveValues = (Form.useWatch([], form) || {}) as Record<string, any>;

  // templateId is only handed to the hook once the workflow gate is open —
  // otherwise this would fetch (and loading below would spin forever) for a
  // template HR isn't allowed to touch yet anyway.
  const {
    template,
    loading,
    error,
    sections,
    fillableSections,
    currentSectionIndex,
    isFirstSection,
    isLastSection,
    isCurrentSectionComplete,
    submitting,
    submittedAnswers,
    submittedAt,
    locked,
    handleNext,
    handlePrevious,
    handleSubmit,
    handleValuesChange,
  } = useSectionedFormTemplate(
    form,
    available ? HR_EVALUATION_TEMPLATE_ID : undefined,
    employeeId,
    isAutoFilledQuestion,
    undefined,
    reviewPeriodId
  );
  const { confirmSubmit, contextHolder: submitConfirmHolder } = useSubmitConfirmation();

  // "Review Period" pre-fills with the current period, same as
  // ManagerEvaluation.tsx/selfassesment.tsx — never something HR picks.
  const getInitialValue = (question: FormQuestion) => {
    if (question.question === 'Review Period' && template?.review_period) return template.review_period;
    return question.answer || undefined;
  };

  const [isEditing, setIsEditing] = useState(false);

  // Prefill the form with the actual submitted answers when entering edit
  // mode — same rehydration approach useSectionedFormTemplate already uses
  // to restore a server-persisted draft (dayjs conversion for date fields),
  // just seeded from the real submission instead of a draft.
  useEffect(() => {
    if (!isEditing || !submittedAnswers || !template) return;
    const dateFieldNames = new Set(
      template.questions.filter((q) => q.type === 'date').map((q) => String(q.question_number))
    );
    const restored: Record<string, any> = {};
    for (const [key, value] of Object.entries(submittedAnswers)) {
      restored[key] = dateFieldNames.has(key) && value ? dayjs(value as string) : value;
    }
    form.setFieldsValue(restored);
  }, [isEditing, submittedAnswers, template, form]);

  // Flips back to the read-only view once a submit attempt made while
  // editing has actually finished — see the identical pattern (and its
  // caveats) in selfassesment.tsx. Also tells the parent a submit (create OR
  // edit) just completed, regardless of isEditing — this transition
  // (submitting -> not submitting) only happens right after a real submit
  // attempt, never on initial mount (wasSubmittingRef starts false), so this
  // can't misfire for an already-existing submission encountered on load.
  const wasSubmittingRef = useRef(false);
  // submittedAt only changes when the submit actually succeeded (the hook
  // sets it on success only), so the parent is told about real submissions,
  // never a failed attempt — it marks the HR Review submitted straight away.
  const submittedAtBeforeRef = useRef(submittedAt);
  useEffect(() => {
    if (!wasSubmittingRef.current && submitting) {
      submittedAtBeforeRef.current = submittedAt;
    }
    if (wasSubmittingRef.current && !submitting) {
      if (submittedAt !== submittedAtBeforeRef.current) {
        onSubmitted?.();
      }
      if (isEditing) {
        setIsEditing(false);
      }
    }
    wasSubmittingRef.current = submitting;
  }, [submitting, isEditing, onSubmitted, submittedAt]);

  // Unlike HRManagerEvaluationTab.tsx (which only ever edits an ALREADY
  // submitted evaluation, so its Form is only ever mounted while isEditing is
  // true), HR can create a brand new HR Evaluation from scratch right here —
  // so the interactive Form is also mounted whenever there's no submission
  // yet at all (isEditing still false in that case). The live watch is the
  // right source whenever that Form is actually on screen, i.e. whenever this
  // ISN'T the pure read-only view (submittedAnswers set AND not editing).
  const isFormActive = !submittedAnswers || isEditing;
  const ratingAnswerSource: Record<string, any> = isFormActive ? liveValues : submittedAnswers || {};
  const ratingSummary = computeRatingSummary(template?.questions ?? [], ratingAnswerSource);

  // "Review Period" is auto-filled (never something HR actually answers), so
  // it's skipped in the read-only submitted view too, not just the editable
  // form — dropping the question from each section rather than the section
  // itself, since the other real questions in that section still need to show.
  const readOnlySections = sections
    .map((section) => ({ ...section, questions: section.questions.filter((q) => !isAutoFilledQuestion(q)) }))
    .filter((section) => section.questions.length > 0);

  // Gapless 1, 2, 3... over only the fillable (visible) questions — same
  // reasoning as ManagerEvaluation.tsx's identical call: fillableSections
  // already excludes "Review Period" (auto-filled, hidden), so its own
  // question_number (always 1, the first question in this template) would
  // otherwise leave the first VISIBLE question mislabeled "2.".
  const questionDisplayNumbers = buildQuestionDisplayNumbers(fillableSections);

  if (!available) {
    return (
      <div style={{ padding: '32px 4px', textAlign: 'center' }}>
        <Text strong style={{ display: 'block', fontSize: 16, color: '#F4F1F8', marginBottom: 8 }}>
          HR Review
        </Text>
        <StatusBadge status="not_available" />
        <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          HR Review will be available after the Self Review and Manager Review are submitted.
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

  // The interactive create/edit Form below is real-HR-only — HR either fills
  // out a brand new HR Evaluation (no submission yet) or reopens an already
  // submitted one (isEditing). Anyone else who can view this tab but can't
  // submit it (the employee themselves on MyReviewDetails, or a CDO — see
  // canEditHR above) must never see a fillable form for a review they don't
  // submit, so they get the same read-only "not submitted yet" messaging
  // every other not-yet-submitted tab uses instead. Same for a locked period
  // (a previous period, or the Overall Review already submitted) — nothing
  // new can be filled out there, even by HR.
  if ((!canEditHR || locked) && !submittedAnswers) {
    return (
      <div style={{ padding: '32px 4px', textAlign: 'center' }}>
        <Text strong style={{ display: 'block', fontSize: 16, color: '#F4F1F8', marginBottom: 8 }}>
          HR Review
        </Text>
        <StatusBadge status="not_started" />
        <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          HR has not submitted this review yet.
        </Text>
      </div>
    );
  }

  if (submittedAnswers && !isEditing) {
    return (
      <div className="manager-eval-tab-layout" style={hideScores ? { gridTemplateColumns: '1fr' } : undefined}>
        <div className="manager-eval-tab-layout__form">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <Text strong style={{ fontSize: 18, color: '#F4F1F8', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              HR Review
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <StatusBadge status="submitted" />
              {/* No Edit once the Overall Review has locked the period. */}
              {canEditHR && !locked && (
                <Button type="primary" size="middle" onClick={() => setIsEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
          </div>
          {template.header_title && (
            <Text style={{ display: 'block', fontSize: 16, color: '#C5C0D6', lineHeight: 1.6, marginTop: 8 }}>
              {template.header_title}
            </Text>
          )}
          {/* No "Submitted by" here, unlike Self Assessment/Manager Evaluation
              — there's no assigned-HR relationship to any one employee (HR's
              authority is org-wide), and self_evaluation_submissions has no
              submitted-by column, so naming a specific HR person would be a
              guess, not a fact. */}
          {submittedAt && (
            <div
              style={{
                display: 'flex',
                gap: 32,
                flexWrap: 'wrap',
                marginTop: 16,
                marginBottom: 28,
                paddingBottom: 24,
                borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.12))',
              }}
            >
              {submittedByLabel && (
                <div>
                  <div className="hr-employee-info-label">Submitted by</div>
                  <div className="hr-employee-info-value">{submittedByLabel}</div>
                </div>
              )}
              <div>
                <div className="hr-employee-info-label">Submitted on</div>
                <div className="hr-employee-info-value">{new Date(submittedAt).toLocaleDateString()}</div>
              </div>
            </div>
          )}
          <ManagerEvaluationAnswers sections={readOnlySections} answers={submittedAnswers} />
        </div>
        {!hideScores && (
          <div className="manager-eval-tab-layout__summary">
            <PerformanceHikeReference scorePercentage={ratingSummary.scorePercentage} />
            <EvaluationSummary summary={ratingSummary} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="manager-eval-tab-layout">
      <div className="manager-eval-tab-layout__form">
        {/* Same title/header_title treatment as the read-only view above —
            previously shown only once submitted, so filling out a brand new
            HR Evaluation (or reopening one via Edit) had no heading or
            description at all above the form. */}
        <Text strong style={{ display: 'block', fontSize: 18, color: '#F4F1F8', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
          HR Review
        </Text>
        {template.header_title && (
          <Text style={{ display: 'block', fontSize: 16, color: '#C5C0D6', lineHeight: 1.6, marginTop: 8 }}>
            {template.header_title}
          </Text>
        )}
        {submitConfirmHolder}
        <Form
          form={form}
          layout="vertical"
          // Validation has passed by the time onFinish runs — confirm first.
          onFinish={(values) => confirmSubmit('Submit HR Review?', () => handleSubmit(values))}
          onValuesChange={handleValuesChange}
          onKeyDown={(e) => {
            const target = e.target as HTMLElement;
            if (e.key === 'Enter' && target.tagName !== 'TEXTAREA' && target.getAttribute('type') !== 'submit') {
              e.preventDefault();
            }
          }}
          requiredMark={(label, { required }) => (
            <span style={{ position: 'relative', display: 'block', width: '100%', paddingRight: required ? 14 : 0 }}>
              {label}
              {required && (
                <span style={{ position: 'absolute', top: 0, right: 0, color: '#F47272' }}>*</span>
              )}
            </span>
          )}
        >
          {/* Always mounted (regardless of which page is showing) so its
              known value is part of the form's submitted values without ever
              being visible to HR — see isAutoFilledQuestion. */}
          {template.questions.filter(isAutoFilledQuestion).map((question) => (
            <Form.Item key={question.question_number} name={String(question.question_number)} hidden initialValue={getInitialValue(question)}>
              {renderField(question, { fontSize: 15 })}
            </Form.Item>
          ))}

          {fillableSections.map((section, index) => (
            <div
              key={index}
              style={{
                display: index === currentSectionIndex ? undefined : 'none',
                // Without a section.name, there's no Title element to supply
                // the gap below the header title (antd's default heading
                // margin) — this keeps that same breathing room when a
                // section has no name of its own.
                marginTop: section.name ? undefined : 32,
              }}
            >
              {section.name && <Title level={4} style={{ marginBottom: 32 }}>{section.name}</Title>}
              {section.questions.map((question) => (
                <React.Fragment key={question.question_number}>
                  <Form.Item
                    name={String(question.question_number)}
                    label={
                      question.type === 'slider'
                        ? undefined
                        : renderQuestionLabel(question, 16, { fontWeight: 600, color: '#F4F1F8' }, questionDisplayNumbers.get(question.question_number))
                    }
                    initialValue={
                      // Plain `question.answer || undefined` would wrongly
                      // reset a slider answer of 0 (a valid min value) since
                      // 0 is falsy — check for absence instead.
                      question.answer === undefined || question.answer === null || question.answer === ('' as any)
                        ? undefined
                        : question.answer
                    }
                    rules={[
                      {
                        required: true,
                        // Spaces alone don't count as an answer (text types
                        // only — see isTextQuestion).
                        ...(isTextQuestion(question) ? { whitespace: true } : {}),
                        message: question.type === 'slider' ? 'Please provide a rating.' : 'This field is required',
                      },
                    ]}
                    style={{ marginBottom: 24 }}
                  >
                    {renderField(question, { fontSize: 15 }, questionDisplayNumbers.get(question.question_number))}
                  </Form.Item>
                  {question.has_comment && (
                    question.type === 'radio' ? (
                      <Form.Item
                        noStyle
                        shouldUpdate={(prev, cur) =>
                          prev[String(question.question_number)] !== cur[String(question.question_number)]
                        }
                      >
                        {() =>
                          form.getFieldValue(String(question.question_number)) ? (
                            <Form.Item
                              name={commentFieldName(question)}
                              label={<span style={COMMENT_LABEL_STYLE}>{question.comment_label}</span>}
                              initialValue={question.comment_answer || undefined}
                              style={{ marginBottom: 24 }}
                            >
                              <AssessmentTextArea style={{ ...indentedFieldStyle, fontSize: 15 }} />
                            </Form.Item>
                          ) : null
                        }
                      </Form.Item>
                    ) : (
                      <Form.Item
                        name={commentFieldName(question)}
                        label={<span style={COMMENT_LABEL_STYLE}>{question.comment_label}</span>}
                        initialValue={question.comment_answer || undefined}
                        style={{ marginBottom: 24 }}
                      >
                        <AssessmentTextArea style={{ ...indentedFieldStyle, fontSize: 15 }} />
                      </Form.Item>
                    )
                  )}
                </React.Fragment>
              ))}
            </div>
          ))}

          <Form.Item className="evaluation-form-actions">
            {isEditing && (
              <Button onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            )}
            {!isFirstSection && (
              <Button className="evaluation-secondary-btn" onClick={handlePrevious}>
                Previous
              </Button>
            )}
            {isLastSection ? (
              <Button type="primary" onClick={() => form.submit()} loading={submitting}>
                Submit
              </Button>
            ) : (
              <Button type="primary" onClick={handleNext} disabled={!isCurrentSectionComplete}>
                Next
              </Button>
            )}
          </Form.Item>
        </Form>
      </div>
      <div className="manager-eval-tab-layout__summary">
        <PerformanceHikeReference scorePercentage={ratingSummary.scorePercentage} />
        <EvaluationSummary summary={ratingSummary} />
      </div>
    </div>
  );
};

export default HREvaluationTab;
