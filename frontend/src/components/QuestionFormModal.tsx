import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Select, Switch, AutoComplete, Alert, Row, Col, Grid, Typography, message } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import ApiService, {
  EditableForm,
  EditableFormQuestion,
  FormQuestionType,
  FormQuestionValues,
} from '../services/apiService';

const { TextArea } = Input;
const { Text } = Typography;

// The question types HR can pick. The renderer and the backend also accept
// 'text' (single line) so older questions keep working, but it's no longer
// offered: "Text" is always multi-line, and editing a 'text' question
// converts it.
export const QUESTION_TYPE_OPTIONS: { value: FormQuestionType; label: string }[] = [
  { value: 'textarea', label: 'Text' },
  { value: 'date', label: 'Date' },
  { value: 'radio', label: 'Single choice' },
  { value: 'slider', label: 'Slider' },
  { value: 'repeatable_text', label: 'Project list' },
];

// The 3-point rating scale every scored question uses (see
// RATING_OPTION_POINTS in main.py) — the default options for a new
// single-choice question, since that's what nearly every one of them is.
const DEFAULT_RATING_OPTIONS = ['Does not meet', 'Meets', 'Outstanding'];

const SLIDER_DEFAULTS = { min: 0, max: 10, step: 1 };

// Only the Manager and HR Reviews are scored (SCORED_TEMPLATE_IDS in main.py).
const SCORED_TEMPLATE_IDS = [1002, 1003];

// The KPI sheet's rule for filling a rating question's points from its
// weightage: share of the weightage each option earns. Only a starting point
// typed into the boxes — HR can change any of them, and other weightages are
// entered by hand.
const WEIGHTAGE_POINT_SHARES: Record<number, Record<string, number>> = {
  10: { 'Does not meet': 0.5, Meets: 0.75, Outstanding: 1 },
  5: { 'Does not meet': 0.35, Meets: 0.75, Outstanding: 1 },
};

const highestPoints = (points?: Record<string, number | null | undefined>, options?: string[]) => {
  const values = (options || Object.keys(points || {}))
    .map((option) => points?.[option])
    .filter((value): value is number => typeof value === 'number');
  return values.length ? Math.max(...values) : undefined;
};

// The dialog edits a 1-based Position among the form's editable (non-system)
// questions; it's converted to the stored `order` value on save. `scored`
// is the dialog's own "Counts toward score" switch, not a stored field.
type QuestionFormFields = FormQuestionValues & { position?: number; scored?: boolean; weightage?: number };

// What a question's score depends on, as a comparable string — used to warn
// HR before a save that re-scores submitted reviews.
const scoringKey = (q?: Pick<FormQuestionValues, 'option_points' | 'max_points' | 'min' | 'max'> | null) =>
  JSON.stringify(
    q && (q.option_points || q.max_points)
      ? { op: q.option_points ?? null, mp: q.max_points ?? null, min: q.min ?? null, max: q.max ?? null }
      : null
  );

const byOrder = (a: EditableFormQuestion, b: EditableFormQuestion) =>
  a.order - b.order || a.question_number - b.question_number;

export interface QuestionFormModalProps {
  open: boolean;
  templateId?: number;
  // null = Add (empty form); a question = Edit (populated with its data).
  question: EditableFormQuestion | null;
  // Sections already used on this form, offered as suggestions.
  sectionOptions: { value: string }[];
  // Every question on the form, system ones included — used to turn the
  // Position the user picks into a stored `order` value.
  formQuestions: EditableFormQuestion[];
  onClose: () => void;
  // Called with the whole updated form the API returns, so the caller can
  // refresh its table straight from the server's response.
  onSaved: (updated: EditableForm) => void;
  // Called after a failed save, so the caller can re-read the stored form
  // (e.g. someone else changed it in the meantime).
  onSaveFailed?: () => void;
}

// Shared Add/Edit Question dialog for the Forms page. Saves through the
// existing /api/hr/forms endpoints (addFormQuestion/updateFormQuestion),
// which re-validate everything server-side. System questions (is_system —
// the ones the app finds by their exact wording) can only be moved: their
// text, type, required flag, and type-specific settings are locked here and
// preserved as stored by the backend.
const QuestionFormModal: React.FC<QuestionFormModalProps> = ({
  open,
  templateId,
  question,
  sectionOptions,
  formQuestions,
  onClose,
  onSaved,
  onSaveFailed,
}) => {
  const [form] = Form.useForm<QuestionFormFields>();
  const [submitting, setSubmitting] = useState(false);
  const selectedType = Form.useWatch('type', form);
  const hasComment = Form.useWatch('has_comment', form);
  const selectedOptions = Form.useWatch('options', form);
  const scored = Form.useWatch('scored', form);
  const [modalApi, modalContext] = Modal.useModal();
  // md = 768px and up: paired fields sit side by side; below it they stack.
  const screens = Grid.useBreakpoint();
  // A control and its note on one line, vertically centred; the note wraps
  // below the control on narrow screens.
  const inlineNoteRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' };
  // Tighter than antd's default 24px between the Required / Include in review
  // score / Weightage rows.
  const compactItem: React.CSSProperties = { marginBottom: 16 };
  const isEdit = question !== null;
  const isSystem = !!question?.is_system;
  // Points apply to single-choice and slider questions on the scored forms.
  const canScore =
    !isSystem &&
    templateId !== undefined &&
    SCORED_TEMPLATE_IDS.includes(templateId) &&
    (selectedType === 'radio' || selectedType === 'slider');
  const pointOptions: string[] = Array.from(
    new Set(((selectedOptions as string[] | undefined) || []).map((option) => option.trim()).filter(Boolean))
  );
  const usesRatingOptions =
    pointOptions.length === DEFAULT_RATING_OPTIONS.length &&
    DEFAULT_RATING_OPTIONS.every((option) => pointOptions.includes(option));

  // Weightage and points stay in step (a single-choice question's weightage
  // IS its highest option's points): typing a weightage of 10 or 5 fills the
  // points boxes by the sheet's rule; editing a points box updates the
  // weightage. setFieldsValue doesn't re-fire this, so there's no loop.
  const handleValuesChange = (changed: Partial<QuestionFormFields>) => {
    if ('weightage' in changed) {
      const shares = changed.weightage !== undefined ? WEIGHTAGE_POINT_SHARES[changed.weightage as number] : undefined;
      if (shares && usesRatingOptions) {
        form.setFieldsValue({
          option_points: Object.fromEntries(
            DEFAULT_RATING_OPTIONS.map((option) => [option, Math.round((changed.weightage as number) * shares[option] * 100) / 100])
          ),
        });
      }
    } else if ('option_points' in changed) {
      const highest = highestPoints(form.getFieldValue('option_points'), pointOptions);
      if (highest !== undefined) form.setFieldsValue({ weightage: highest });
    }
  };
  // Once a question has answers its type is fixed (update_form_question in
  // main.py rejects a change), so the dialog asks when it opens and locks
  // the Type field instead of letting HR find out on Save. 'checking' locks
  // it too, so it can't be changed before the answer arrives.
  const [typeLock, setTypeLock] = useState<'checking' | 'locked' | 'unlocked'>('unlocked');
  // While locked, Save sends the stored type — not the field's value, which
  // shows a legacy single-line 'text' question as 'textarea'.
  const keepStoredType = isSystem || (isEdit && typeLock !== 'unlocked');

  useEffect(() => {
    if (!open || !question || question.is_system || templateId === undefined) {
      setTypeLock('unlocked');
      return;
    }
    let cancelled = false;
    setTypeLock('checking');
    ApiService.getFormQuestionHasAnswers(templateId, question.question_number)
      .then(({ has_answers }) => {
        if (!cancelled) setTypeLock(has_answers ? 'locked' : 'unlocked');
      })
      .catch(() => {
        // Don't block editing over a failed check — Save still enforces it.
        if (!cancelled) setTypeLock('unlocked');
      });
    return () => {
      cancelled = true;
    };
  }, [open, question, templateId]);

  // Positions count every question on the form, in display order, so they
  // match the Forms page's Order column.
  const visibleQuestions = [...formQuestions].sort(byOrder);
  const currentPosition = question
    ? visibleQuestions.findIndex((q) => q.question_number === question.question_number) + 1
    : undefined;
  const maxPosition = isEdit ? Math.max(visibleQuestions.length, 1) : visibleQuestions.length + 1;

  // Position -> stored order. Places the question immediately before the
  // question currently at that position (halfway between it and whatever
  // question, hidden or not, comes just before it), or after everything for
  // the last position. Only this question's order changes; nothing else is
  // renumbered.
  const orderForPosition = (position?: number | null): number | undefined => {
    if (position === undefined || position === null) return question?.order;
    if (question && position === currentPosition) return question.order;
    const otherQuestions = formQuestions.filter((q) => q.question_number !== question?.question_number);
    const others = visibleQuestions.filter((q) => q.question_number !== question?.question_number);
    const index = Math.min(Math.max(position - 1, 0), others.length);
    if (index >= others.length) {
      return otherQuestions.length ? Math.max(...otherQuestions.map((q) => q.order)) + 1 : undefined;
    }
    const next = others[index];
    const before = otherQuestions.map((q) => q.order).filter((order) => order < next.order);
    const previous = before.length ? Math.max(...before) : next.order - 1;
    return (previous + next.order) / 2;
  };

  // (Re)populate whenever the dialog opens: empty defaults for Add, the
  // question's stored values for Edit.
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (question) {
      form.setFieldsValue({
        question: question.question,
        type: (question.type === 'text' ? 'textarea' : question.type) as FormQuestionType,
        section: question.section || undefined,
        position: currentPosition || undefined,
        required: question.required !== false,
        options: question.options,
        has_comment: !!question.has_comment,
        comment_label: question.comment_label || undefined,
        min: question.min,
        max: question.max,
        step: question.step,
        scored: !!(question.option_points || question.max_points),
        option_points: question.option_points,
        weightage: highestPoints(question.option_points),
        max_points: question.max_points,
      });
    } else {
      form.setFieldsValue({ type: 'textarea', required: true, options: DEFAULT_RATING_OPTIONS, ...SLIDER_DEFAULTS, scored: false });
    }
    // Only on open / question change: re-running when currentPosition changes
    // (e.g. the page reloads the form after a failed save) would wipe what
    // the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, question, form]);

  const handleFinish = async (values: QuestionFormFields) => {
    if (templateId === undefined || submitting) return;
    // Send only what applies to the chosen type; for a system question, its
    // locked properties come from the stored question, not the form.
    const type = keepStoredType ? (question!.type as FormQuestionType) : values.type;
    const payload: FormQuestionValues = {
      question: isSystem ? question!.question : values.question.trim(),
      type,
      section: values.section?.trim() || '',
      order: orderForPosition(values.position),
      required: isSystem ? question!.required !== false : values.required,
    };
    if (!isSystem && type === 'radio') {
      payload.options = (values.options || []).map((option) => option.trim()).filter(Boolean);
      payload.has_comment = !!values.has_comment;
      if (values.has_comment) payload.comment_label = values.comment_label?.trim() || undefined;
    }
    if (!isSystem && type === 'slider') {
      payload.min = values.min;
      payload.max = values.max;
      payload.step = values.step;
    }
    // Omitted when not scored — the backend then stores no points.
    if (canScore && values.scored) {
      if (type === 'radio') {
        payload.option_points = Object.fromEntries(
          (payload.options || []).map((option) => [option, Number(values.option_points?.[option])])
        );
      } else if (type === 'slider') {
        payload.max_points = values.max_points;
      }
    }

    // Changing what a question scores re-scores every open review on this
    // form, so HR confirms first, with the numbers involved.
    if (templateId !== undefined && SCORED_TEMPLATE_IDS.includes(templateId) && scoringKey(question) !== scoringKey(payload)) {
      let counts: { open: number; locked: number } | null = null;
      try {
        counts = await ApiService.getRescorePreview(templateId);
      } catch {
        // Don't block the save over a failed count.
      }
      if (counts && counts.open + counts.locked > 0) {
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const confirmed = await modalApi.confirm({
          title: 'Re-score submitted reviews?',
          content:
            `Changing points will re-score ${plural(counts.open, 'open review')}. ` +
            `${plural(counts.locked, 'approved review')} keep${counts.locked === 1 ? 's its current score' : ' their current scores'}.`,
          okText: 'Save and re-score',
          cancelText: 'Cancel',
          centered: true,
        });
        if (!confirmed) return;
      }
    }

    setSubmitting(true);
    try {
      const updated = isEdit
        ? await ApiService.updateFormQuestion(templateId, question!.question_number, payload)
        : await ApiService.addFormQuestion(templateId, payload);
      message.success(isEdit ? 'Question updated' : 'Question added');
      onSaved(updated);
      onClose();
    } catch (err: any) {
      // Server-side validation messages (e.g. a reserved question name) are
      // shown as-is; the dialog stays open so the input isn't lost.
      message.error(err?.message || `Failed to ${isEdit ? 'update' : 'add'} question`);
      onSaveFailed?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit Question' : 'Add Question'}
      open={open}
      onCancel={submitting ? undefined : onClose}
      onOk={() => form.submit()}
      okText={isEdit ? 'Save' : 'Add'}
      confirmLoading={submitting}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
      forceRender
      // Stays in the middle at any zoom level or window height.
      centered
      width={900}
      // ~85vh overall: the body scrolls (header and Save/Cancel footer stay
      // put); 130px covers the header and footer.
      styles={{ body: { maxHeight: 'calc(85vh - 130px)', overflowY: 'auto', overflowX: 'hidden' } }}
    >
      {modalContext}
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        onValuesChange={handleValuesChange}
        disabled={submitting}
      >
        {isSystem && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            // The info Alert keeps antd's light-blue background (the theme
            // doesn't restyle alerts), but its text inherits the app's
            // near-white colorText — dark text keeps it readable.
            message={<span style={{ color: '#0A0817', fontWeight: 600 }}>System question</span>}
            description={
              <span style={{ color: '#2A2740' }}>
                The app relies on this question, so only its section and position can be changed.
              </span>
            }
          />
        )}

        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Form.Item
              name="question"
              label="Question"
              rules={[
                { required: true, whitespace: true, message: 'Question text is required' },
                { max: 500, message: 'Keep the question under 500 characters' },
              ]}
            >
              <TextArea
                autoSize={{ minRows: 1, maxRows: 4 }}
                disabled={isSystem}
                placeholder="e.g. What were your key accomplishments?"
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="section" label="Section" rules={[{ max: 100, message: 'Keep the section under 100 characters' }]}>
              <AutoComplete
                options={sectionOptions}
                placeholder="e.g. Key Performance Indicators"
                filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Form.Item
              name="type"
              label="Question type"
              rules={[{ required: true, message: 'Question type is required' }]}
              extra={
                !isSystem && typeLock === 'locked'
                  ? "This question already has answers, so its type can't be changed. Add a new question instead."
                  : !isSystem && typeLock === 'checking'
                  ? 'Checking for existing answers…'
                  : undefined
              }
            >
              <Select options={QUESTION_TYPE_OPTIONS} disabled={keepStoredType} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="position"
              label="Position"
              extra={
                isEdit
                  ? `1 is the first question on this form (1–${maxPosition}).`
                  : `1 is the first question on this form (1–${maxPosition}). Leave blank to add at the end.`
              }
              rules={[
                {
                  type: 'integer',
                  min: 1,
                  max: maxPosition,
                  message: `Position must be a whole number from 1 to ${maxPosition}`,
                },
              ]}
            >
              <InputNumber style={{ width: '100%' }} min={1} max={maxPosition} precision={0} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="required" label="Required" valuePropName="checked" style={compactItem}>
          <Switch disabled={isSystem} />
        </Form.Item>

        {canScore && (
          <Form.Item name="scored" label="Include in review score" valuePropName="checked" style={compactItem}>
            <Switch />
          </Form.Item>
        )}

        {canScore && scored && selectedType === 'radio' && (
          <Form.Item label="Maximum points (Weightage)" required style={compactItem}>
            <div style={inlineNoteRow}>
              <Form.Item
                name="weightage"
                noStyle
                dependencies={pointOptions.map((option) => ['option_points', option])}
                rules={[
                  { required: true, message: 'Weightage is required' },
                  { type: 'number', min: 0.01, max: 100, message: 'Weightage must be above 0 and at most 100' },
                  ({ getFieldValue }) => ({
                    validator: (_, value?: number) => {
                      const highest = highestPoints(getFieldValue('option_points'), pointOptions);
                      return value === undefined || value === null || highest === undefined || highest === value
                        ? Promise.resolve()
                        : Promise.reject(new Error("Weightage must equal the highest option's points"));
                    },
                  }),
                ]}
              >
                <InputNumber style={{ width: 180 }} min={0.01} max={100} step={5} controls={false} />
              </Form.Item>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 260px' }}>
                <InfoCircleOutlined style={{ color: 'rgba(255, 255, 255, 0.45)' }} />
                <Text type="secondary">
                  {usesRatingOptions
                    ? 'Typing 10 or 5 fills the points below (10: 5 / 7.5 / 10, 5: 1.75 / 3.75 / 5). Any other weightage: enter the points yourself.'
                    : 'Enter the points for each option below.'}
                </Text>
              </div>
            </div>
          </Form.Item>
        )}

        {canScore && scored && selectedType === 'radio' && (
          <Form.Item label="Points per option" required>
            <Row gutter={[24, 0]}>
              {pointOptions.map((option) => (
                <Col key={option} xs={24} md={pointOptions.length <= 3 ? 24 / Math.max(pointOptions.length, 1) : 8}>
                  <Form.Item
                    name={['option_points', option]}
                    label={option}
                    style={{ marginBottom: screens.md ? 0 : 16 }}
                    dependencies={usesRatingOptions ? DEFAULT_RATING_OPTIONS.map((o) => ['option_points', o]) : []}
                    rules={[
                      { required: true, message: 'Required' },
                      { type: 'number', min: 0, max: 100, message: '0 to 100' },
                      // Does not meet < Meets < Outstanding: each rating must
                      // be worth more than the one below it.
                      ({ getFieldValue }) => ({
                        validator: (_, value?: number) => {
                          const rank = DEFAULT_RATING_OPTIONS.indexOf(option);
                          if (!usesRatingOptions || rank <= 0 || value === undefined || value === null) return Promise.resolve();
                          const lower = DEFAULT_RATING_OPTIONS[rank - 1];
                          const lowerValue = getFieldValue(['option_points', lower]);
                          return typeof lowerValue !== 'number' || value > lowerValue
                            ? Promise.resolve()
                            : Promise.reject(new Error(`Must be more than ${lower}`));
                        },
                      }),
                    ]}
                  >
                    <InputNumber style={{ width: '100%' }} min={0} max={100} step={0.25} controls={false} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </Form.Item>
        )}

        {canScore && scored && selectedType === 'slider' && (
          <Form.Item
            name="max_points"
            label="Maximum points (Weightage)"
            extra="Earned in proportion to the answer, e.g. 75 on a 0-100 slider worth 10 earns 7.5."
            rules={[
              { required: true, message: 'Max points is required' },
              { type: 'number', min: 0.01, max: 100, message: 'Max points must be above 0 and at most 100' },
            ]}
          >
            <InputNumber style={{ width: '100%' }} min={0.01} max={100} step={0.5} controls={false} />
          </Form.Item>
        )}

        {!isSystem && selectedType === 'radio' && (
          <>
            <Row gutter={24}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="options"
                  label="Options"
                  extra="Type an option and press Enter."
                  rules={[
                    {
                      validator: (_, value?: string[]) => {
                        const options = (value || []).map((option) => option.trim()).filter(Boolean);
                        if (options.length < 2) return Promise.reject(new Error('Add at least two options'));
                        if (new Set(options).size !== options.length) {
                          return Promise.reject(new Error('Options must be unique'));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Select mode="tags" tokenSeparators={[',']} open={false} placeholder="e.g. Does not meet, Meets, Outstanding" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="has_comment" label="Comment box" valuePropName="checked" extra="Shown on the Manager and HR Review forms.">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
            {hasComment && (
              <Form.Item
                name="comment_label"
                label="Comment box label"
                rules={[{ max: 200, message: 'Keep the label under 200 characters' }]}
              >
                <Input placeholder="Comments" />
              </Form.Item>
            )}
          </>
        )}

        {!isSystem && selectedType === 'slider' && (
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              name="min"
              label="Min"
              style={{ flex: 1 }}
              rules={[{ required: true, message: 'Min is required' }]}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="max"
              label="Max"
              style={{ flex: 1 }}
              dependencies={['min']}
              rules={[
                { required: true, message: 'Max is required' },
                ({ getFieldValue }) => ({
                  validator: (_, value?: number) =>
                    value === undefined || value === null || value > getFieldValue('min')
                      ? Promise.resolve()
                      : Promise.reject(new Error('Max must be greater than min')),
                }),
              ]}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="step"
              label="Step"
              style={{ flex: 1 }}
              dependencies={['min', 'max']}
              rules={[
                { required: true, message: 'Step is required' },
                ({ getFieldValue }) => ({
                  validator: (_, value?: number) => {
                    if (value === undefined || value === null) return Promise.resolve();
                    if (value <= 0) return Promise.reject(new Error('Step must be greater than 0'));
                    const range = getFieldValue('max') - getFieldValue('min');
                    return range > 0 && value > range
                      ? Promise.reject(new Error('Step is larger than the range'))
                      : Promise.resolve();
                  },
                }),
              ]}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
          </div>
        )}
      </Form>
    </Modal>
  );
};

export default QuestionFormModal;
