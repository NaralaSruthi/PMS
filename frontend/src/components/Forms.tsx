import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Table, Typography, Button, Tabs, Modal, Tooltip, message } from 'antd';
import { FileSearchOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import ApiService, { EditableForm, EditableFormQuestion } from '../services/apiService';
import FormLoadingState from './FormLoadingState';
import QuestionFormModal, { QUESTION_TYPE_OPTIONS } from './QuestionFormModal';
import { questionMaxPoints } from '../utils/ratingSummary';
import { formatPoints } from './EvaluationSummary';
import '../styles/pageLayout.css';
import '../styles/teamTable.css';
import '../styles/formsTable.css';

const { Title, Text } = Typography;

const FORM_NAMES: Record<number, string> = {
  1001: 'Self Review',
  1002: 'Manager Review',
  1003: 'HR Review',
  1004: 'Overall Review',
};

const QUESTION_TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  ...Object.fromEntries(QUESTION_TYPE_OPTIONS.map((option) => [option.value, option.label])),
};

// HR and CDO editor for the questions inside the four review forms — add, edit
// (including order), and delete. Backed by /api/hr/forms in main.py, which
// gives every question a permanent number so edits never shift answers
// already saved, and protects the questions the app finds by their wording
// (is_system): they're listed with a System badge and can only be moved. Every mutation returns the updated form, so the table is
// refreshed straight from the server's response.
const Forms: React.FC = () => {
  const [forms, setForms] = useState<EditableForm[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<EditableFormQuestion | null>(null);
  const [deletingNumber, setDeletingNumber] = useState<number | null>(null);
  // Hook form of Modal.confirm, so the confirm dialog picks up the app's
  // dark theme (the static Modal.confirm ignores ConfigProvider).
  const [modal, modalContextHolder] = Modal.useModal();
  // Guards against React StrictMode's dev-only double-invoke of effects.
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    const fetchForms = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await ApiService.getEditableForms();
        setForms(response.forms || []);
        setActiveTemplateId(response.forms?.[0]?.template_id);
      } catch (err: any) {
        setError(err?.message || 'Failed to load forms');
      } finally {
        setLoading(false);
      }
    };
    fetchForms();
  }, []);

  const activeForm = forms.find((f) => f.template_id === activeTemplateId);

  // Sections already used on this form, offered as suggestions so a new
  // question lands in an existing section rather than a misspelled new one.
  const sectionOptions = useMemo(
    () =>
      Array.from(new Set((activeForm?.questions || []).map((q) => q.section).filter(Boolean))).map((section) => ({
        value: section,
      })),
    [activeForm]
  );

  const replaceForm = (updated: EditableForm) => {
    setForms((prev) => prev.map((f) => (f.template_id === updated.template_id ? updated : f)));
  };

  // After a failed save/delete (e.g. another HR user changed the form first),
  // re-read the forms so the table shows what's actually stored. Quiet: the
  // failure itself has already been reported, and the current tab is kept.
  const reloadForms = async () => {
    try {
      const response = await ApiService.getEditableForms();
      setForms(response.forms || []);
    } catch {
      // Keep showing what we have; the next action will surface any error.
    }
  };

  // The dialog itself (QuestionFormModal) loads the question's values and
  // saves through the API; this page only says which question, if any.
  const openAddModal = () => {
    setEditingQuestion(null);
    setIsModalOpen(true);
  };

  const openEditModal = (question: EditableFormQuestion) => {
    setEditingQuestion(question);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
  };

  // Centered confirmation before deleting. Returning handleDelete's promise
  // from onOk keeps the dialog open with a spinner on Delete until the
  // request finishes, so it can't be confirmed twice.
  const confirmDelete = async (question: EditableFormQuestion) => {
    // Deleting a scored question re-scores every open review on this form
    // (Manager/HR Review), so the confirmation says how many.
    let rescoreNote = '';
    if (activeTemplateId !== undefined && questionMaxPoints(question) !== undefined) {
      try {
        const counts = await ApiService.getRescorePreview(activeTemplateId);
        if (counts.open + counts.locked > 0) {
          rescoreNote =
            ` This will re-score ${counts.open} open review${counts.open === 1 ? '' : 's'}.` +
            ` ${counts.locked} approved review${counts.locked === 1 ? ' keeps its current score' : 's keep their current scores'}.`;
        }
      } catch {
        // Don't block the delete over a failed count.
      }
    }
    modal.confirm({
      title: 'Delete this question?',
      content: `It's removed from the form. Answers already submitted for it will no longer be shown.${rescoreNote}`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      centered: true,
      onOk: () => handleDelete(question),
    });
  };

  const handleDelete = async (question: EditableFormQuestion) => {
    if (activeTemplateId === undefined) return;
    setDeletingNumber(question.question_number);
    try {
      replaceForm(await ApiService.deleteFormQuestion(activeTemplateId, question.question_number));
      message.success('Question deleted');
    } catch (err: any) {
      message.error(err?.message || 'Failed to delete question');
      await reloadForms();
    } finally {
      setDeletingNumber(null);
    }
  };

  if (loading) {
    return <FormLoadingState />;
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  // Fixed widths for the short columns; Question takes the remaining space
  // (table-layout: fixed). Section/Type/Required drop out on narrower
  // screens so the table never needs its own horizontal scrollbar.
  const columns = [
    {
      title: 'Order',
      key: 'order',
      width: 80,
      align: 'center' as const,
      // Position on the form (1, 2, 3...) rather than the stored order value,
      // which can be fractional after a move. The Add/Edit dialog uses the
      // same numbering.
      render: (_: unknown, _record: EditableFormQuestion, index: number) => (
        <span className="forms-order-text">{index + 1}</span>
      ),
    },
    {
      title: 'Section',
      key: 'section',
      width: 200,
      responsive: ['md' as const],
      render: (_: unknown, record: EditableFormQuestion) => (
        <span className="forms-section-text">{record.section || '—'}</span>
      ),
    },
    {
      title: 'Question',
      key: 'question',
      render: (_: unknown, record: EditableFormQuestion) => (
        <div className="forms-question-cell">
          <span className="forms-question-text">{record.question}</span>
          {record.is_system && (
            <Tooltip title="Used by the system — can be moved, but not renamed or deleted">
              <span className="forms-system-badge">
                <LockOutlined />
                System
              </span>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 160,
      responsive: ['sm' as const],
      render: (_: unknown, record: EditableFormQuestion) => (
        <span className="forms-type-badge">{QUESTION_TYPE_LABELS[record.type] || record.type}</span>
      ),
    },
    {
      // A scored question's weightage is its best answer's points (set in the
      // Edit dialog); unscored questions show a dash.
      title: 'Weightage',
      key: 'weightage',
      width: 110,
      align: 'center' as const,
      responsive: ['md' as const],
      render: (_: unknown, record: EditableFormQuestion) => {
        const maxPoints = questionMaxPoints(record);
        return maxPoints !== undefined ? (
          <span className="forms-required-yes">{formatPoints(maxPoints)}</span>
        ) : (
          <span className="forms-section-text">—</span>
        );
      },
    },
    {
      title: 'Required',
      key: 'required',
      width: 110,
      align: 'center' as const,
      responsive: ['lg' as const],
      render: (_: unknown, record: EditableFormQuestion) =>
        record.required === false ? (
          <span className="forms-required-no">No</span>
        ) : (
          <span className="forms-required-yes">Yes</span>
        ),
    },
    {
      title: 'Action',
      key: 'action',
      width: 172,
      align: 'right' as const,
      render: (_: unknown, record: EditableFormQuestion) => (
        <div className="forms-table-actions">
          <Button size="small" onClick={() => openEditModal(record)} disabled={deletingNumber !== null}>
            Edit
          </Button>
          {record.is_system ? (
            <Tooltip title="System questions can't be deleted">
              <Button size="small" danger disabled>
                Delete
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="small"
              danger
              onClick={() => confirmDelete(record)}
              loading={deletingNumber === record.question_number}
              disabled={deletingNumber !== null && deletingNumber !== record.question_number}
            >
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="app-page-container">
      {/* 16px below the description, matching the HR Review/Employees gap
          below their titles. */}
      <div className="app-page-header" style={{ marginBottom: 16 }}>
        <Title level={3} className="app-page-title">Forms</Title>
        <Text className="app-page-description">
          Add, Edit, or Delete the questions on each review form. Changes apply to forms opened from now on.
        </Text>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Tabs
          activeKey={activeTemplateId !== undefined ? String(activeTemplateId) : undefined}
          onChange={(key) => setActiveTemplateId(Number(key))}
          items={forms.map((f) => ({ key: String(f.template_id), label: FORM_NAMES[f.template_id] || f.title }))}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal} disabled={!activeForm || deletingNumber !== null}>
          Add Question
        </Button>
      </div>

      <div className="app-content-card">
        <Table
          className="team-table scrollable-team-table forms-question-table"
          columns={columns}
          dataSource={activeForm?.questions || []}
          rowClassName={(record) => (record.is_system ? 'forms-row-system' : '')}
          rowKey="question_number"
          tableLayout="fixed"
          // Fixed header, scrolling rows — same setup as the Manager Review
          // table (see scrollable-team-table in teamTable.css, which makes
          // the body fill the card; the 240 is only antd's trigger).
          scroll={{ y: 240 }}
          pagination={false}
          locale={{
            emptyText: (
              <div className="team-empty-state">
                <div className="team-empty-icon">
                  <FileSearchOutlined />
                </div>
                <div className="team-empty-title">No questions yet</div>
                <div className="team-empty-description">Use Add Question to add the first question to this form.</div>
              </div>
            ),
          }}
        />
      </div>

      {modalContextHolder}

      <QuestionFormModal
        open={isModalOpen}
        templateId={activeTemplateId}
        question={editingQuestion}
        sectionOptions={sectionOptions}
        formQuestions={activeForm?.questions || []}
        onClose={closeModal}
        onSaved={replaceForm}
        onSaveFailed={reloadForms}
      />
    </div>
  );
};

export default Forms;
