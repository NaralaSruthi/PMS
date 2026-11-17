import { emitServerError } from './serverErrorBus';

// API Service for backend endpoints used by Login, Dashboard, and Self-Assessment
// Centralized API management with proper error handling and token management

// Baked in at build time from .env — deliberately no fallback, so a build
// missing it fails loudly instead of silently calling the production API.
const API_BASE_URL = process.env.REACT_APP_API_URL || '';
if (!API_BASE_URL) {
  console.error('REACT_APP_API_URL is not set — set it in .env and rebuild. API calls will fail.');
}

const DEFAULT_500_TITLE = 'Unable to Load Details';
const DEFAULT_500_MESSAGE =
  'A temporary connection issue occurred while fetching data. Please try again.';
const AUTO_RETRY_500_DELAY_MS = 300;

interface LoginRequest {
  username: string;
  password: string; // Should be base64 encoded when using real API
}

interface LoginResponse {
  success: boolean;
  message: string;
  token?: string;
  expires_in?: number;
  error?: string;
}

interface ApiError {
  message: string;
  code?: string;
  status?: number;
  data?: any; // Include response data for cases where error response contains usable data
}

export interface FormQuestion {
  question_id: number;
  question: string;
  type: string;
  order: number;
  question_number: number;
  answer: string;
  section: string;
  options?: string[];
  has_comment?: boolean;
  comment_label?: string;
  comment_answer?: string;
  // Only present for type: 'slider' — the control's range and increment
  // (e.g. min:0, max:10, step:1 renders a 0-through-10 slider).
  min?: number;
  max?: number;
  step?: number;
  // Secondary, muted-text explanation shown under a question's title (e.g.
  // "How do you rate him/her on a scale of 0 to 10?") — currently only
  // populated for slider questions (see RatingQuestion), but not type-limited
  // since any question could reasonably use one.
  description?: string;
  // Whether this question must be answered before Next/Submit — a required
  // Form.Item validation rule reads this, not the question's own type.
  required?: boolean;
  // Points, set by HR on the Forms page (Manager/HR Review only) — a question
  // without them isn't scored. Single choice: points per option; slider: the
  // points a full-range answer earns (earned in proportion to the value).
  option_points?: Record<string, number>;
  max_points?: number;
}

export interface FormStyles {
  title_font_size: number;
  header_font_size: number;
  question_font_size: number;
  answer_font_size: number;
}

export interface PerformanceCycleReviewPeriod {
  review_period_id: string;
  label: string;
  is_current: boolean;
}

export interface PerformanceCycle {
  performance_cycle_id: string;
  name: string;
  review_periods: PerformanceCycleReviewPeriod[];
}

export interface FormTemplateResponse {
  template_id: number;
  type: string;
  title: string;
  header_title: string;
  questions: FormQuestion[];
  styles: FormStyles;
  review_period?: string;
  // Groups review_period with its sibling from the same performance cycle —
  // not wired into any UI yet, just typed and ready (see backend's
  // _current_performance_cycle in main.py for the grouping logic itself).
  performance_cycle?: PerformanceCycle;
}

interface SubmitFormResponse {
  success: boolean;
  message: string;
}

// One entry per thing that's ever happened to a submission (submitted,
// resubmitted, rejected, approved) — unlike approval_status/by/at below,
// which only ever reflect the CURRENT decision, this is append-only
// server-side, so a rejection followed by a resubmission still shows both
// events. `by` is the person who performed that specific action; `reason`
// is only ever populated on a "rejected" event.
export interface ReviewHistoryEvent {
  event: 'submitted' | 'resubmitted' | 'approved' | 'rejected';
  at: string;
  by?: string;
  reason?: string;
}

export interface FormSubmissionStatus {
  submitted: boolean;
  answers?: Record<string, any>;
  submitted_at?: string;
  employee_name?: string;
  // HR/CDO's decision on this submission — currently only ever set for a
  // Manager Evaluation (see set_form_approval in main.py). undefined/null
  // means no decision has been made yet.
  approval_status?: 'approved' | 'rejected' | null;
  approval_by?: string | null;
  approval_at?: string | null;
  history?: ReviewHistoryEvent[];
  // True once the Overall Review has been submitted for this employee's
  // current period — every review form for that period is then read-only
  // (see _is_period_locked in main.py, which enforces the same lock).
  locked?: boolean;
  // Only ever present when submitted is false — the server-persisted
  // autosave (see PUT .../draft in main.py) for this exact form, or null if
  // nothing's been saved yet.
  draft_answers?: Record<string, any> | null;
}

export interface TeamMemberSubmission {
  employee_id?: string;
  name: string;
  email: string;
  designation?: string;
  department?: string;
  submitted: boolean;
  submitted_at?: string;
  // The period this submission's own "Review Period" answer names — not
  // necessarily the current period, since it's whichever one the employee
  // actually answered. Undefined when there's no submission at all.
  review_period?: string;
  score?: number;
  max_score?: number;
  answered?: number;
  // Only ever present when submitted is false (see get_manager_team in
  // main.py) — a server-persisted draft exists for this employee's Manager
  // Evaluation.
  has_draft?: boolean;
  // Manager Evaluation only, once submitted: HR/the CDO's decision —
  // "approved", "rejected", or null while pending.
  approval_status?: string | null;
}

export interface TeamSubmissionsResponse {
  team: TeamMemberSubmission[];
  review_period: string;
  review_periods: string[];
}

export interface ManagerTeamResponse {
  self_team: TeamSubmissionsResponse;
  manager_team: TeamSubmissionsResponse;
}

export interface HRAssessmentStatus {
  submitted: boolean;
  submitted_at?: string;
  // The period the submission's own "Review Period" answer names — not
  // necessarily the current period, since it's whichever one the employee
  // actually answered (there's no stored link between a submission and a
  // period otherwise). Undefined when there's no submission at all.
  review_period?: string;
  // Only ever populated for MyDashboardResponse.self_assessment (see
  // get_my_profile in main.py) — a server-persisted draft exists for the
  // caller's own Self Assessment.
  has_draft?: boolean;
}

export interface HREmployee {
  employee_id?: string;
  name: string;
  email: string;
  designation?: string;
  department?: string;
  location?: string;
  manager_ids?: string[];
  manager_name?: string;
  self_assessment: HRAssessmentStatus;
  // score / max_score: points earned / possible, stored on the submission
  // (see _score_fields in main.py); score_percentage is the same as a %.
  // OverallReviewTab adds Manager + HR points for the Overall Score.
  // Undefined when not submitted, or the form has no scored questions.
  // approval_status: "approved" | "rejected" | undefined — gates the Overall
  // Review tab's Approve button (see overallReviewAvailable in
  // HREmployeeDetails.tsx and OVERALL_REVIEW_TEMPLATE_ID's gate in main.py).
  manager_evaluation: HRAssessmentStatus & { has_manager: boolean; approval_status?: string } & ReviewScore;
  hr_evaluation: HRAssessmentStatus & ReviewScore;
  // No review_period field — the Overall Review pseudo-template has no
  // "Review Period" question at all (see OVERALL_REVIEW_TEMPLATE_ID in
  // main.py), so approval is tracked as a one-time, period-agnostic act.
  overall_review: Pick<HRAssessmentStatus, 'submitted' | 'submitted_at'>;
}

export interface ReviewScore {
  score?: number;
  max_score?: number;
  score_percentage?: number;
}

export interface MyDashboardResponse {
  manager_name?: string;
  performance_cycle: PerformanceCycle;
  self_assessment: HRAssessmentStatus;
  // Same stored scores as HREmployee's own fields above — powers the
  // employee's own Overall Review tab exactly the way it powers HR's.
  manager_evaluation: HRAssessmentStatus & ReviewScore;
  hr_evaluation: HRAssessmentStatus & ReviewScore;
  // No review_period field — same reason as HREmployee's own overall_review:
  // the Overall Review pseudo-template has no "Review Period" question at
  // all, so approval is tracked as a one-time, period-agnostic act.
  overall_review: Pick<HRAssessmentStatus, 'submitted' | 'submitted_at'>;
  // Full Self Assessment content (not just status), shaped exactly like
  // getFormWithSubmission's own response — lets MyReviewDetails hand this to
  // HRSelfAssessmentTab, and the Dashboard's inline "Start Assessment"/
  // "Continue" form hand it to useSectionedFormTemplate, instead of either
  // one separately calling GET /api/forms/1001/full a moment later.
  self_assessment_form: {
    template: FormTemplateResponse;
    submission: FormSubmissionStatus;
  };
}

export interface HRManager {
  employee_id: string;
  name: string;
}

// One selectable period on the HR Dashboard. review_period_id is the stored
// form ("Jul 2026 - Dec 2026") the API accepts; label is the full-month
// display form ("July 2026 - December 2026").
export interface ReviewPeriodOption {
  review_period_id: string;
  label: string;
  is_current: boolean;
}

export interface HRDashboardResponse {
  // The period this roster is for — the current one unless HR asked for a
  // previous one (see get_hr_employees in main.py).
  review_period_id: string;
  review_period: string;
  current_review_period_id: string;
  // Every period HR can switch to (only the current one for the CDO).
  review_period_options: ReviewPeriodOption[];
  review_periods: string[];
  managers: HRManager[];
  employees: HREmployee[];
  // The logged-in HR user — not in `employees`, but selectable as a
  // reporting manager in the Employees tab.
  current_user?: HRManager | null;
}

// HR form editor (see /api/hr/forms in main.py). is_system marks questions
// the app finds by their exact wording (Employee Name, Review Period, ...):
// they can be moved, but not renamed, retyped, or deleted.
export type EditableFormQuestion = FormQuestion & { is_system: boolean };

export interface EditableForm {
  template_id: number;
  title?: string;
  header_title?: string;
  questions: EditableFormQuestion[];
}

export interface EditableFormsResponse {
  forms: EditableForm[];
}

export type FormQuestionType = 'textarea' | 'text' | 'date' | 'radio' | 'slider' | 'repeatable_text';

// Body for adding/editing a question — options/has_comment/comment_label
// apply to radio only, min/max/step to slider only.
export interface FormQuestionValues {
  question: string;
  type: FormQuestionType;
  section?: string;
  order?: number;
  required?: boolean;
  description?: string;
  options?: string[];
  has_comment?: boolean;
  comment_label?: string;
  min?: number;
  max?: number;
  step?: number;
  option_points?: Record<string, number>;
  max_points?: number;
}

// Shared by createEmployee/updateEmployee — manager_employee_id sets this
// employee's own assigned_employees array on the backend (see
// CreateEmployeeRequest in main.py), not the manager's. undefined/omitted
// means "no manager assigned".
export interface EmployeeFormValues {
  name: string;
  work_email: string;
  designation?: string;
  department?: string;
  location?: string;
  manager_employee_id?: string;
}

interface EmployeeMutationResponse {
  success: boolean;
  message: string;
}

class ApiService {
  private static getAuthToken(): string | null {
    const token = sessionStorage.getItem('authToken') || localStorage.getItem('authToken');
    return token;
  }

  private static async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
    isPublic: boolean = false,
    attempt: number = 0
  ): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const token = this.getAuthToken();

    const defaultHeaders: HeadersInit = {
      'Content-Type': 'application/json',
      'accept': 'application/json',
    };

    // Only add Authorization header if not a public endpoint
    if (!isPublic) {
      const authToken = token;
      if (authToken) {
        defaultHeaders['Authorization'] = `Bearer ${authToken}`;
      } else {
        console.warn('⚠️ [ApiService] No auth token available for endpoint:', endpoint);
      }
    }

    const config: RequestInit = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
    };

    try {
      const method = String(config.method || options.method || 'GET').toUpperCase();
      const response = await fetch(url, config);

      // Handle non-JSON responses
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        if (!response.ok) {
          if (response.status === 500) {
            if (method === 'GET' && attempt === 0) {
              await new Promise<void>((r) => window.setTimeout(r, AUTO_RETRY_500_DELAY_MS));
              return this.makeRequest<T>(endpoint, options, isPublic, attempt + 1);
            }

            if (method === 'GET') {
              emitServerError({ title: DEFAULT_500_TITLE, message: DEFAULT_500_MESSAGE });
            }

            const apiErr: ApiError = {
              message: DEFAULT_500_MESSAGE,
              status: 500,
              data: { statusText: response.statusText },
            };
            throw apiErr;
          }

          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return {} as T;
      }

      // Get response as text first to see raw response
      const responseText = await response.text();

      // Parse JSON from text
      const data = JSON.parse(responseText);

      if (!response.ok) {
        if (response.status === 500 && method === 'GET' && attempt === 0) {
          await new Promise<void>((r) => window.setTimeout(r, AUTO_RETRY_500_DELAY_MS));
          return this.makeRequest<T>(endpoint, options, isPublic, attempt + 1);
        }

        const backendMessage =
          data.message || data.error || data.detail || `HTTP ${response.status}: ${response.statusText}`;
        const errorMessage = response.status === 500 ? DEFAULT_500_MESSAGE : backendMessage;

        // Skip logging for "Internal API error: 400" pattern as it's often a false positive
        // (email might be sent successfully but backend has response handling issue)
        const isInternalAPIError =
          response.status === 500 && backendMessage.includes('Internal API error');

        if (response.status >= 500 && !isInternalAPIError) {
          console.error('API Error:', {
            endpoint,
            status: response.status,
            message: errorMessage
          });
        }

        if (response.status === 500 && method === 'GET') {
          emitServerError({ title: DEFAULT_500_TITLE, message: DEFAULT_500_MESSAGE });
        }

        const error: ApiError = {
          message: errorMessage,
          code: data.code,
          status: response.status,
          data: data, // Include response data so components can access it even on error
        };

        // Throw the ApiError object so components can check the status code
        // Don't convert to plain Error - let components handle based on status
        throw error;
      }

      return data;
    } catch (error) {
      // If it's an ApiError (has status property), throw it as-is so components can check status
      if (error && typeof error === 'object' && 'status' in error) {
        throw error;
      }

      if (error instanceof Error) {
        // Check if it's a CORS error (more specific - only actual CORS-related messages)
        if (error.message.includes('CORS') || error.message.includes('cors') ||
            error.message.includes('Access-Control-Allow-Origin') ||
            error.message.includes('blocked by CORS policy')) {
          throw new Error('CORS Error: The API server needs to allow requests from this domain. Please contact the backend team to add CORS headers.');
        }

        // Check for network errors (separate from CORS)
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
          throw new Error('Network Error: Unable to connect to the API server. Please check your internet connection and try again.');
        }

        throw error;
      }
      throw new Error('Network error occurred');
    }
  }

  // Authentication endpoints
  static async login(credentials: LoginRequest): Promise<LoginResponse> {
    try {
      const response = await this.makeRequest<LoginResponse>('/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }, true); // Public endpoint - no token exists yet at login time
      return response;
    } catch (error) {
      throw error;
    }
  }

  // Microsoft 365 login - exchange the MSAL ID token for a backend JWT token.
  // The backend verifies the ID token's signature with Microsoft and reads the
  // email from it, so the browser never gets to assert who the user is.
  static async microsoftLogin(idToken: string): Promise<LoginResponse> {
    try {
      const response = await this.makeRequest<LoginResponse>('/login/microsoft', {
        method: 'POST',
        body: JSON.stringify({ id_token: idToken }),
      }, true); // Mark as public endpoint - don't send Authorization header
      return response;
    } catch (error) {
      throw error;
    }
  }

  // Everything the current user needs about their own review status in one
  // round trip (performance cycle + self/manager/HR submission status, plus
  // reporting manager name) — see get_my_profile in main.py for why this
  // replaced 6 separate getFormTemplate/getFormSubmission calls.
  static async getMyProfile(): Promise<MyDashboardResponse> {
    return this.makeRequest('/api/employees/results', {
      method: 'GET',
    });
  }

  // Check whether the current user has already submitted a given form template.
  // Pass employeeId when a manager is checking one of their reports' submission
  // (e.g. Manager Evaluation) rather than their own.
  static async getFormSubmission(
    templateId: number | string,
    employeeId?: string
  ): Promise<FormSubmissionStatus> {
    const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
    return this.makeRequest(`/api/forms/${encodeURIComponent(templateId)}/submission${query}`, {
      method: 'GET',
    });
  }

  // Both halves of what useSectionedFormTemplate/HRSelfAssessmentTab/
  // OverallReviewTab always fetched as a getFormTemplate+getFormSubmission
  // pair, in one round trip — see get_form_with_submission in main.py.
  // reviewPeriodId: HR-only, to view a previous period (read-only); omit for
  // the current period.
  static async getFormWithSubmission(
    templateId: number | string,
    employeeId?: string,
    reviewPeriodId?: string
  ): Promise<{ template: FormTemplateResponse; submission: FormSubmissionStatus }> {
    const params = new URLSearchParams();
    if (employeeId) params.set('employee_id', employeeId);
    if (reviewPeriodId) params.set('review_period_id', reviewPeriodId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.makeRequest(`/api/forms/${encodeURIComponent(templateId)}/full${query}`, {
      method: 'GET',
    });
  }

  // Submit answers for a form template. Pass employeeId when a manager is
  // submitting on behalf of one of their reports rather than themselves.
  static async submitFormTemplate(
    templateId: number | string,
    answers: Record<string, any>,
    employeeId?: string
  ): Promise<SubmitFormResponse> {
    const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
    return this.makeRequest(`/api/forms/${encodeURIComponent(templateId)}/submit${query}`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
  }

  // Best-effort autosave of in-progress (unsubmitted) answers — see PUT
  // .../draft in main.py. Same employeeId convention as submitFormTemplate:
  // pass it when a manager is saving a draft on behalf of one of their
  // reports rather than themselves.
  static async saveFormDraft(
    templateId: number | string,
    answers: Record<string, any>,
    employeeId?: string
  ): Promise<{ success: boolean }> {
    const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
    return this.makeRequest(`/api/forms/${encodeURIComponent(templateId)}/draft${query}`, {
      method: 'PUT',
      body: JSON.stringify({ answers }),
    });
  }

  // HR/CDO approving or rejecting an already-submitted Manager Evaluation —
  // see set_form_approval in main.py. Rejecting is what lets the owning
  // manager resubmit it (see submit_form's approval_status carve-out there).
  static async setFormApproval(
    templateId: number | string,
    employeeId: string,
    status: 'approved' | 'rejected',
    reason?: string
  ): Promise<SubmitFormResponse> {
    return this.makeRequest(
      `/api/forms/${encodeURIComponent(templateId)}/approval?employee_id=${encodeURIComponent(employeeId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ status, reason }),
      }
    );
  }

  // Both the Self Assessment and Manager Evaluation team rosters a manager's
  // "Manager Review" pages need, in one round trip — see get_manager_team in
  // main.py for why this replaced two separate getTeamSubmissions calls
  // (ManagerEvaluationsList and ManagerEmployeeReview each made both).
  static async getManagerTeam(): Promise<ManagerTeamResponse> {
    return this.makeRequest('/api/manager/team', {
      method: 'GET',
    });
  }

  // HR-only: org-wide self-assessment + manager-evaluation status for every
  // employee (not scoped to any one manager's reports). Backend 403s if the
  // caller isn't HR.
  // reviewPeriodId: HR-only, to load a previous period's roster; omit for the
  // current period.
  // includeSelf: also list the logged-in user (the Employees tab only — the
  // HR Review dashboard leaves them off so HR never reviews themselves).
  static async getHRDashboard(
    reviewPeriodId?: string,
    { includeSelf = false }: { includeSelf?: boolean } = {}
  ): Promise<HRDashboardResponse> {
    const params = new URLSearchParams();
    if (reviewPeriodId) params.set('review_period_id', reviewPeriodId);
    if (includeSelf) params.set('include_self', 'true');
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.makeRequest(`/api/hr/employees${query}`, {
      method: 'GET',
    });
  }

  // HR-only: create a new dataflix_users row. employee_id must be unique
  // (enforced server-side) — there's no auto-generation, HR assigns it.
  static async createEmployee(
    employeeId: string,
    values: EmployeeFormValues
  ): Promise<EmployeeMutationResponse> {
    return this.makeRequest('/api/hr/employees', {
      method: 'POST',
      body: JSON.stringify({ ...values, employee_id: employeeId }),
    });
  }

  // HR-only: update name/email/designation/department/manager for an
  // existing employee. employee_id itself isn't editable (it's the path
  // identifier, not part of the body).
  static async updateEmployee(
    employeeId: string,
    values: EmployeeFormValues
  ): Promise<EmployeeMutationResponse> {
    return this.makeRequest(`/api/hr/employees/${encodeURIComponent(employeeId)}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    });
  }

  // HR-only: deletes the employee row. Backend also strips this employee_id
  // out of every report's assigned_employees array first, so no one is left
  // pointing at a manager that no longer exists.
  static async deleteEmployee(employeeId: string): Promise<EmployeeMutationResponse> {
    return this.makeRequest(`/api/hr/employees/${encodeURIComponent(employeeId)}`, {
      method: 'DELETE',
    });
  }

  // HR-only form editor (see /api/hr/forms in main.py): the four review
  // forms with their questions, as stored.
  static async getEditableForms(): Promise<EditableFormsResponse> {
    return this.makeRequest('/api/hr/forms', {
      method: 'GET',
    });
  }

  // Whether any submission or draft has answered this question — once one
  // has, its type can't be changed (see update_form_question in main.py).
  // How many submitted reviews of this form a points change would re-score
  // (open) vs leave as they are (locked by an approved Overall Review).
  static async getRescorePreview(templateId: number): Promise<{ open: number; locked: number }> {
    return this.makeRequest(`/api/hr/forms/${encodeURIComponent(templateId)}/rescore-preview`, {
      method: 'GET',
    });
  }

  static async getFormQuestionHasAnswers(templateId: number, questionNumber: number): Promise<{ has_answers: boolean }> {
    return this.makeRequest(
      `/api/hr/forms/${encodeURIComponent(templateId)}/questions/${encodeURIComponent(questionNumber)}/has-answers`,
      {
        method: 'GET',
      }
    );
  }

  // Each mutation returns the whole updated form, so the page can re-render
  // straight from the response.
  static async addFormQuestion(templateId: number, values: FormQuestionValues): Promise<EditableForm> {
    return this.makeRequest(`/api/hr/forms/${encodeURIComponent(templateId)}/questions`, {
      method: 'POST',
      body: JSON.stringify(values),
    });
  }

  static async updateFormQuestion(
    templateId: number,
    questionNumber: number,
    values: FormQuestionValues
  ): Promise<EditableForm> {
    return this.makeRequest(
      `/api/hr/forms/${encodeURIComponent(templateId)}/questions/${encodeURIComponent(questionNumber)}`,
      {
        method: 'PUT',
        body: JSON.stringify(values),
      }
    );
  }

  // Removes the question from the stored form. Answers already saved for it
  // stay in their submissions but are no longer shown.
  static async deleteFormQuestion(templateId: number, questionNumber: number): Promise<EditableForm> {
    return this.makeRequest(
      `/api/hr/forms/${encodeURIComponent(templateId)}/questions/${encodeURIComponent(questionNumber)}`,
      {
        method: 'DELETE',
      }
    );
  }
}

export default ApiService;
export { type LoginRequest };
