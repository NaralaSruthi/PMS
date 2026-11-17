import React, { useEffect, useRef, useState } from 'react';
import { Table, Typography, Avatar, Input, Button, Modal, Form, Select, Row, Col, message } from 'antd';
import { TeamOutlined, SearchOutlined, PlusOutlined } from '@ant-design/icons';
import ApiService, { HREmployee, HRManager, EmployeeFormValues } from '../services/apiService';
import FormLoadingState from './FormLoadingState';
import { getInitials } from '../utils/teamStatusHelpers';
import { useAuth } from '../contexts/AuthContext';
import '../styles/pageLayout.css';
import '../styles/teamTable.css';

const { Title, Text } = Typography;

const EmptyEmployeesState: React.FC = () => (
  <div className="team-empty-state">
    <div className="team-empty-icon">
      <TeamOutlined />
    </div>
    <div className="team-empty-title">No employees found</div>
    <div className="team-empty-description">
      There are no other employees in the system yet.
    </div>
  </div>
);

interface EmployeeFormModalValues extends EmployeeFormValues {
  employee_id?: string;
}

// Plain org-wide employee directory — every row in dbo.dataflix_users except
// the HR caller themselves. Reuses GET /api/hr/employees (the same call
// HRDashboard/HREmployeeDetails already make) for the listing rather than a
// new read endpoint, since that response already carries every field this
// page needs. Add/Edit/Delete go through the three mutation endpoints added
// specifically for this page (createEmployee/updateEmployee/deleteEmployee
// in apiService.ts) — the list is refetched after each so the table always
// reflects the DB, not an optimistic guess.
const Employees: React.FC = () => {
  const { authState } = useAuth();
  // CDO shares HR's is_hr flag (see HR_DESIGNATIONS in main.py) and, since
  // GET /api/hr/employees is now readable by both, would otherwise be able to
  // load this page's list and Add/Edit forms too — even though every mutation
  // endpoint behind them still rejects a CDO caller. Guarded here, before any
  // fetch, so a CDO sees a clear message instead of a directory that looks
  // usable but silently fails on submit.
  const isCDO = authState.user?.isCDO || false;
  const [employees, setEmployees] = useState<HREmployee[]>([]);
  const [currentUser, setCurrentUser] = useState<HRManager | null>(null);
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<HREmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form] = Form.useForm<EmployeeFormModalValues>();
  // Hook form of Modal.confirm, so the confirm dialog picks up the app's
  // dark theme (the static Modal.confirm ignores ConfigProvider).
  const [modal, modalContextHolder] = Modal.useModal();
  // Guards against React StrictMode's dev-only double-invoke of effects.
  const hasFetchedRef = useRef(false);

  const fetchEmployees = async () => {
    setLoading(true);
    setError(null);
    try {
      // A staff directory, so the logged-in HR user is listed too.
      const response = await ApiService.getHRDashboard(undefined, { includeSelf: true });
      setEmployees(response.employees || []);
      setCurrentUser(response.current_user || null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load employees');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    // Skip the fetch entirely for a CDO — they'd never be able to act on
    // anything here anyway (every mutation endpoint still rejects them), so
    // there's no reason to pull the full roster over the wire just to show
    // a read-only list they can't do anything with.
    if (isCDO) {
      setLoading(false);
      return;
    }
    fetchEmployees();
  }, [isCDO]);

  const openAddModal = () => {
    setEditingEmployee(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const openEditModal = (employee: HREmployee) => {
    setEditingEmployee(employee);
    form.setFieldsValue({
      name: employee.name,
      work_email: employee.email,
      designation: employee.designation || undefined,
      department: employee.department || undefined,
      location: employee.location || undefined,
      manager_employee_id: employee.manager_ids?.[0],
    });
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingEmployee(null);
    form.resetFields();
  };

  const handleSubmit = async (values: EmployeeFormModalValues) => {
    setSubmitting(true);
    try {
      if (editingEmployee) {
        await ApiService.updateEmployee(editingEmployee.employee_id!, values);
        message.success('Employee updated');
      } else {
        await ApiService.createEmployee(values.employee_id!, values);
        message.success('Employee created');
      }
      closeModal();
      await fetchEmployees();
    } catch (err: any) {
      message.error(err?.message || `Failed to ${editingEmployee ? 'update' : 'create'} employee`);
    } finally {
      setSubmitting(false);
    }
  };

  // Centered confirmation before deleting, like every other dialog in the
  // app (it was a Popconfirm bubble beside the button). Returning
  // handleDelete's promise from onOk keeps the dialog open with a spinner on
  // Delete until the request finishes, so it can't be confirmed twice.
  const confirmDelete = (employee: HREmployee) => {
    modal.confirm({
      title: 'Delete this employee?',
      content: 'This also removes them as a manager from anyone who reports to them.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      centered: true,
      onOk: () => handleDelete(employee),
    });
  };

  const handleDelete = async (employee: HREmployee) => {
    if (!employee.employee_id) return;
    setDeletingId(employee.employee_id);
    try {
      await ApiService.deleteEmployee(employee.employee_id);
      message.success('Employee deleted');
      await fetchEmployees();
    } catch (err: any) {
      message.error(err?.message || 'Failed to delete employee');
    } finally {
      setDeletingId(null);
    }
  };

  if (isCDO) {
    return (
      <div className="app-page-container">
        <div className="app-page-header">
          <Title level={3} className="app-page-title">Employees</Title>
        </div>
        <div className="app-content-card">
          <Text type="secondary">
            The employee directory is managed by HR. As CDO, you can approve Overall Reviews from
            the Overall Review page, but employee records aren't editable from here.
          </Text>
        </div>
      </div>
    );
  }

  if (loading) {
    return <FormLoadingState />;
  }

  if (error) {
    return <Text type="danger">{error}</Text>;
  }

  const search = searchText.trim().toLowerCase();
  const filteredEmployees = search
    ? employees.filter((employee) =>
        [employee.name, employee.email, employee.designation, employee.department, employee.location, employee.manager_name]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(search))
      )
    : employees;

  // Anyone except the employee currently being edited — a manager doesn't
  // need to exist as an already-established manager, any employee is
  // eligible, matching how assigned_employees actually works (see main.py).
  // The roster already includes the logged-in HR user (includeSelf);
  // currentUser is only a fallback if it ever doesn't.
  const currentUserListed = employees.some((employee) => employee.employee_id === currentUser?.employee_id);
  const managerOptions = [...employees, ...(currentUser && !currentUserListed ? [currentUser] : [])]
    .filter((employee) => employee.employee_id && employee.employee_id !== editingEmployee?.employee_id)
    .map((employee) => ({ value: employee.employee_id, label: employee.name }));

  // HR's own row: editable, but never deletable (that would lock them out —
  // delete_employee_endpoint in main.py refuses it too).
  const isSelf = (record: HREmployee) =>
    (!!currentUser?.employee_id && record.employee_id === currentUser.employee_id) ||
    (!!record.email && record.email.toLowerCase() === authState.user?.email?.toLowerCase());

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
      title: 'Employee ID',
      key: 'employee_id',
      render: (_: unknown, record: HREmployee) => record.employee_id || '—',
    },
    {
      title: 'Designation',
      key: 'designation',
      render: (_: unknown, record: HREmployee) => record.designation || '—',
    },
    {
      title: 'Department',
      key: 'department',
      render: (_: unknown, record: HREmployee) => record.department || '—',
    },
    {
      title: 'Location',
      key: 'location',
      render: (_: unknown, record: HREmployee) => record.location || '—',
    },
    {
      title: 'Reporting Manager',
      key: 'manager_name',
      render: (_: unknown, record: HREmployee) => record.manager_name || '—',
    },
    {
      title: 'Action',
      key: 'action',
      render: (_: unknown, record: HREmployee) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" onClick={() => openEditModal(record)}>
            Edit
          </Button>
          {!isSelf(record) && (
            <Button
              size="small"
              danger
              loading={deletingId === record.employee_id}
              onClick={() => confirmDelete(record)}
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
      {modalContextHolder}
      {/* 8px here plus the title's own 8px = 16px below the title, matching
          the HR Review page. */}
      <div className="app-page-header" style={{ marginBottom: 8 }}>
        <Title level={3} className="app-page-title">Employees</Title>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Input
          allowClear
          placeholder="Search by name, email, designation, or department"
          prefix={<SearchOutlined />}
          style={{ maxWidth: 360 }}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
          Add Employee
        </Button>
      </div>

      <div className="app-content-card">
        {filteredEmployees.length === 0 ? (
          <EmptyEmployeesState />
        ) : (
          <Table
            className="team-table scrollable-team-table"
            columns={columns}
            dataSource={filteredEmployees}
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

      <Modal
        title={editingEmployee ? 'Edit Employee' : 'Add Employee'}
        open={isModalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={editingEmployee ? 'Save' : 'Add'}
        confirmLoading={submitting}
        destroyOnClose
        // Vertically centered rather than antd's fixed 100px from the top,
        // so it stays in the middle at any zoom level or window height.
        centered
      >
        {/* Two fields per row (the Col span 12s wrap in pairs) with tighter
            spacing, so the dialog stays short; Reporting Manager gets a full
            row for its longer names. */}
        <Form form={form} layout="vertical" onFinish={handleSubmit} className="employee-form-compact">
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="name"
                label="Name"
                rules={[{ required: true, message: 'Name is required' }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="work_email"
                label="Email"
                rules={[{ required: true, type: 'email', message: 'A valid email is required' }]}
              >
                <Input />
              </Form.Item>
            </Col>
            {!editingEmployee && (
              <Col xs={24} sm={12}>
                <Form.Item
                  name="employee_id"
                  label="Employee ID"
                  rules={[{ required: true, message: 'Employee ID is required' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12}>
              <Form.Item
                name="designation"
                label="Designation"
                rules={editingEmployee ? [] : [{ required: true, message: 'Designation is required' }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="department"
                label="Department"
                rules={editingEmployee ? [] : [{ required: true, message: 'Department is required' }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="location"
                label="Location"
                rules={editingEmployee ? [] : [{ required: true, message: 'Location is required' }]}
              >
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="manager_employee_id"
            label="Reporting Manager"
            dependencies={['designation']}
            rules={[
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (value || getFieldValue('designation') === 'President & CEO') {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('A reporting manager is required'));
                },
              }),
            ]}
          >
            <Select
              allowClear
              placeholder="Select a manager"
              options={managerOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Employees;
