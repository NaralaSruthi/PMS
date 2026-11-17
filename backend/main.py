import asyncio
import base64
import logging
import os
import re
import time
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv

load_dotenv()

import bcrypt
import jwt
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from azure.cosmos.exceptions import CosmosAccessConditionFailedError

import email_service

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("pms")

from assesment_form import (
    delete_draft,
    delete_employee,
    fetch_all_employees,
    fetch_assigned_employees,
    fetch_draft,
    fetch_employees_managed_by,
    fetch_form_by_template_id,
    fetch_review_period_ids,
    fetch_submission,
    fetch_submissions_for_period,
    fetch_submissions_for_template,
    fetch_template_document,
    question_has_answers,
    fetch_user_by_email,
    fetch_user_by_employee_id,
    fetch_users_by_designation,
    insert_employee,
    insert_form_submission,
    replace_template_document,
    set_submission_approval,
    set_submission_scoring,
    update_assigned_employees,
    update_employee,
    update_form_submission,
    upsert_draft,
)
from cosmos_client import lifespan, refresh_templates_cache_if_stale

app = FastAPI(lifespan=lifespan)


# HR can edit form questions at runtime (see /api/hr/forms below), so the
# startup-time templates cache is periodically reloaded — this is how other
# workers/instances pick up an edit made through a different one.
@app.middleware("http")
async def _refresh_templates_cache(request: Request, call_next):
    await refresh_templates_cache_if_stale(request.app)
    return await call_next(request)


# Ensures every unhandled error is actually recorded server-side (there was
# previously no logging at all, so a 500 left no trace to debug from) while
# still returning a generic message rather than a raw traceback to the client.
@app.exception_handler(Exception)
async def _log_unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"success": False, "message": "Internal server error"})


# Comma-separated list, e.g. "https://app.example.com,https://staging.example.com".
# Falls back to the known dev + current prod origins so local `uvicorn main:app`
# keeps working without an .env entry.
_default_origins = "http://localhost:3000,http://localhost:8080,https://dataflix-pms-webui-ftf4e0hrb3dubbfa.eastus-01.azurewebsites.net"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", _default_origins).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The frontend never sees this value — it only ever gets an already-signed
# token, and the browser cannot securely verify a signature anyway (see
# isTokenStructurallyValid in the frontend's jwtUtils.ts). No hardcoded
# fallback: an unset secret must fail startup rather than silently sign/verify
# tokens with a publicly-known default that lets anyone forge admin access.
JWT_SECRET = os.environ["JWT_SECRET"]

# Microsoft 365 sign-in: the frontend sends the ID token MSAL received, and
# /login/microsoft verifies its signature against the tenant's published keys
# before trusting the email inside it — the browser's word alone is never
# enough to issue a token. Optional: unset disables Microsoft login only.
AZURE_TENANT_ID = os.environ.get("AZURE_TENANT_ID", "")
AZURE_CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "")
_microsoft_jwks_client = (
    jwt.PyJWKClient(
        f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/discovery/v2.0/keys"
    )
    if AZURE_TENANT_ID
    else None
)

# Self-evaluations aren't scored (an employee rating their own performance
# isn't a meaningful metric) — only the manager's evaluation of them is. See
# get_team_submissions, which skips _score_submission for this template.
SELF_EVALUATION_TEMPLATE_ID = 1001
MANAGER_EVALUATION_TEMPLATE_ID = 1002
HR_EVALUATION_TEMPLATE_ID = 1003
# Final sign-off after the HR Evaluation is submitted — CDO-only. Has a real
# self_evaluation_form row (a single "Additional Comments" question, for the
# CDO's optional remarks) but is otherwise treated as a one-time "approved"
# marker — GET/POST /api/forms/1004/... work through the same two generic
# endpoints as every other template, no new routes needed.
OVERALL_REVIEW_TEMPLATE_ID = 1004
# The two reviews that carry a score. Each question's points live on the
# question itself (option_points / max_points, set by HR on the Forms page),
# never in code; the Overall Score is simply Manager points + HR points.
SCORED_TEMPLATE_IDS = (MANAGER_EVALUATION_TEMPLATE_ID, HR_EVALUATION_TEMPLATE_ID)

# The only signal today that a dataflix_users row gets HR-level access —
# there's no dedicated role/is_hr column, so this reuses the existing
# `designation` value (confirmed against real data: it's the job-title
# column, not `department`, that holds "Senior Human Resource Executive").
# Chief Delivery Officer is included by request, to get the identical view.
HR_DESIGNATIONS = {"Senior Human Resource Executive", "Chief Delivery Officer"}
# CDO gets one extra ability beyond regular HR: final approval of the Overall
# Review, after the HR Evaluation is submitted (see submit_form below).
CDO_DESIGNATION = "Chief Delivery Officer"
# Distinct from HR_DESIGNATIONS above — used specifically to target a Manager
# Evaluation submission notification at regular HR only, not the CDO (who
# gets their own, later notification once the HR Evaluation is submitted).
SENIOR_HR_DESIGNATION = "Senior Human Resource Executive"
# The one designation exempt from needing a reporting manager (see
# create_employee/update_employee_endpoint below) — everyone else sits under
# someone in the org chart; this is the top of it.
CEO_DESIGNATION = "President & CEO"

# Font sizes (px) applied to every form template rendered by the frontend —
# centralized here so all forms stay visually consistent from one source.
FORM_STYLES = {
    "title_font_size": 26,
    "header_font_size": 18,
    "question_font_size": 16,
    "answer_font_size": 16,
}


def _question_max_points(question) -> Optional[float]:
    # A question counts toward the score only once HR has given it points:
    # single-choice -> option_points ({"Meets": 7.5, ...}), its best option is
    # the maximum; slider -> max_points. None = not scored (free text, dates,
    # Review Period, or a rating nobody has assigned points to yet).
    if question.get("type") == "slider":
        max_points = question.get("max_points")
        return float(max_points) if isinstance(max_points, (int, float)) and max_points > 0 else None
    option_points = question.get("option_points")
    if isinstance(option_points, dict) and option_points:
        return float(max(option_points.values()))
    return None


def _question_points(question, answer) -> Optional[float]:
    # Points earned by one answer, or None if unanswered. A slider earns its
    # max_points in proportion to where the value sits in its min-max range
    # (e.g. 75 on a 0-100 slider worth 10 -> 7.5).
    if answer is None or answer == "":
        return None
    if question.get("type") == "slider":
        try:
            value = float(answer)
        except (TypeError, ValueError):
            return None
        lo = float(question.get("min", 0) or 0)
        hi = float(question.get("max", 10) or 10)
        if hi <= lo:
            return None
        fraction = min(max((value - lo) / (hi - lo), 0.0), 1.0)
        return round(fraction * float(question["max_points"]), 2)
    points = (question.get("option_points") or {}).get(answer)
    return float(points) if isinstance(points, (int, float)) else None


def _score_submission(questions, answers: Dict[str, Any]) -> Dict[str, Any]:
    # Per-question points plus totals, from each question's own stored points.
    # Saved on the submission at submit time and refreshed while the review is
    # open (see _rescore_open_submissions), so it can be read back directly.
    score = 0.0
    max_score = 0.0
    answered = 0
    per_question: Dict[str, Dict[str, Optional[float]]] = {}
    for question in questions:
        question_max = _question_max_points(question)
        if question_max is None:
            continue
        key = str(question["question_number"])
        points = _question_points(question, answers.get(key))
        max_score += question_max
        if points is not None:
            score += points
            answered += 1
        per_question[key] = {"points": points, "max_points": question_max}
    return {
        "score": round(score, 2),
        "max_score": round(max_score, 2),
        "answered": answered,
        "questions": per_question,
    }


def _submission_scoring(questions, submission) -> Optional[Dict[str, Any]]:
    # The score stored on the submission; worked out from the form's current
    # points only for a submission saved before scores were stored.
    if submission is None:
        return None
    stored = getattr(submission, "scoring", None)
    if isinstance(stored, dict):
        return stored
    return _score_submission(questions, submission.answers)


def _score_fields(questions, submission) -> Dict[str, Optional[float]]:
    # score / max_score (points) for the dashboards and Overall Review, plus
    # score_percentage for the donuts. All None when there's no submission or
    # the form has no scored questions — 0 would read as "worst possible".
    scoring = _submission_scoring(questions, submission)
    if scoring is None or not scoring.get("max_score"):
        return {"score": None, "max_score": None, "score_percentage": None}
    return {
        "score": scoring["score"],
        "max_score": scoring["max_score"],
        "score_percentage": round(scoring["score"] / scoring["max_score"] * 100, 2),
    }


def _current_academic_year_start() -> int:
    # Academic year runs July-June, so before July it's still the previous year's cycle.
    now = datetime.now()
    return now.year if now.month >= 7 else now.year - 1


def _current_academic_year() -> str:
    start_year = _current_academic_year_start()
    return f"{start_year}-{start_year + 1}"


def _current_review_period() -> str:
    # Which of the two half-year periods (matching the "Review Period"
    # question's own options in _load_questions) we're actually in right now.
    now = datetime.now()
    start_year = _current_academic_year_start()
    if now.month >= 7:
        return f"July {start_year} - December {start_year}"
    return f"January {start_year + 1} - June {start_year + 1}"


def _current_review_period_id() -> str:
    # Stable id form of the current review period, e.g. "Jul 2026 - Dec
    # 2026" / "Jan 2027 - Jun 2027" — this is what submissions are actually
    # keyed/partitioned by (see _review_period_id_for_template below), so a
    # submission never collides with one from a different half. Independent
    # of the "-H1"/"-H2" ids _performance_cycle_review_periods returns to the
    # frontend for a different, pre-existing purpose — not renamed here to
    # avoid touching that separate contract.
    start_year = _current_academic_year_start()
    if datetime.now().month >= 7:
        return f"Jul {start_year} - Dec {start_year}"
    return f"Jan {start_year + 1} - Jun {start_year + 1}"


# Stored review_period_id format (see _current_review_period_id above):
# "Jul {Y} - Dec {Y}" or "Jan {Y} - Jun {Y}" — both halves in the same year.
_REVIEW_PERIOD_ID_PATTERN = re.compile(r"^(?:Jul (\d{4}) - Dec (\d{4})|Jan (\d{4}) - Jun (\d{4}))$")
_REVIEW_PERIOD_MONTH_LABELS = {"Jan": "January", "Jun": "June", "Jul": "July", "Dec": "December"}


def _is_valid_review_period_id(review_period_id: str) -> bool:
    match = _REVIEW_PERIOD_ID_PATTERN.match(review_period_id)
    if match is None:
        return False
    years = [year for year in match.groups() if year is not None]
    return years[0] == years[1]


def _review_period_label(review_period_id: str) -> str:
    # "Jul 2026 - Dec 2026" -> "July 2026 - December 2026", the same label
    # form _current_review_period and the "Review Period" question use.
    return " ".join(_REVIEW_PERIOD_MONTH_LABELS.get(part, part) for part in review_period_id.split(" "))


def _review_period_id_sort_key(review_period_id: str):
    # Chronological: Jan-Jun {Y} before Jul-Dec {Y} before Jan-Jun {Y+1}.
    month, year = review_period_id.split(" ")[:2]
    return (int(year), 0 if month == "Jan" else 1)


def _resolve_review_period_id(user: Dict[str, Any], review_period_id: Optional[str]) -> str:
    # Which period a read request is about. Defaults to the current period;
    # a previous period may only be requested by HR — not the CDO, managers,
    # or employees (Requirements §6.5: "Only HR users may access review forms
    # from previous review periods"). Past periods are read-only: every write
    # endpoint stays pinned to the current period, and _is_period_locked
    # reports them as locked.
    current = _current_review_period_id()
    if review_period_id is None or review_period_id == current:
        return current
    if not (user.get("is_hr") and not user.get("is_cdo")):
        raise HTTPException(status_code=403, detail="Only HR can view previous review periods.")
    if not _is_valid_review_period_id(review_period_id):
        raise HTTPException(status_code=400, detail="Invalid review_period_id.")
    return review_period_id


def _review_period_id_for_template(template_id: int) -> Optional[str]:
    # Every template, including the Overall Review, is scoped one-submission-
    # per-current-period (see fetch_submission/insert_form_submission/
    # update_form_submission in assesment_form.py). The Overall Review has no
    # "Review Period" question of its own — unlike the other three templates,
    # its period comes entirely from this server-side resolution, never from
    # a submitted answer — but it's still tracked per cycle like the others,
    # so a later cycle's approval doesn't overwrite/hide an earlier one.
    return _current_review_period_id()


def _review_period_sort_key(period: str):
    # Plain alphabetical sort would put "January {Y+1}..." before "July
    # {Y}..." within the same cycle, which happens to look right, but breaks
    # across different years/cycles (e.g. "January 2026..." would sort
    # before "July 2025..." despite coming later). Parses the label back
    # into (start_year, half) so the dropdown always lists periods in true
    # chronological order, regardless of string comparison quirks.
    try:
        if period.startswith("July"):
            return (int(period.split()[1]), 0)
        if period.startswith("January"):
            return (int(period.split()[1]) - 1, 1)
    except (ValueError, IndexError):
        pass
    return (0, 0)


def _performance_cycle_id(start_year: int) -> str:
    # The identifier for the performance cycle that begins in July of
    # `start_year` — e.g. 2026 -> "2026-2027". Deterministic and derived, not
    # stored anywhere, so it's automatically correct for any past or future
    # year without a lookup table.
    return f"{start_year}-{start_year + 1}"


def _performance_cycle_review_periods(start_year: int):
    # Every performance cycle has exactly two six-month review periods. This
    # is the single place that fact is encoded — both _current_review_period
    # (the "which one is active" question) and this grouping logic build on
    # the same two labels, so they can never drift apart.
    return [
        {
            "review_period_id": f"{start_year}-H1",
            "label": f"July {start_year} - December {start_year}",
        },
        {
            "review_period_id": f"{start_year}-H2",
            "label": f"January {start_year + 1} - June {start_year + 1}",
        },
    ]


def _current_performance_cycle() -> Dict[str, Any]:
    # Groups the current review period with its sibling from the SAME
    # performance cycle — never "the last two periods seen" or "the previous
    # chronological period". Both periods share one start_year (the same one
    # _current_academic_year_start() already derives), which is the actual
    # grouping key: July {Y}-Dec {Y} and Jan {Y+1}-June {Y+1} belong together
    # because they come from the same start_year, not because they happen to
    # be adjacent in time. This is why, e.g., during Jul 2027-Dec 2027 this
    # never pulls in Jan 2027-June 2027 (start_year 2026) — that period's
    # start_year doesn't match this cycle's.
    start_year = _current_academic_year_start()
    current_period_label = _current_review_period()
    periods = [
        {**period, "is_current": period["label"] == current_period_label}
        for period in _performance_cycle_review_periods(start_year)
    ]
    return {
        "performance_cycle_id": _performance_cycle_id(start_year),
        "name": _performance_cycle_id(start_year),
        "review_periods": periods,
    }


class LoginRequest(BaseModel):
    username: str
    password: str  # base64-encoded by the frontend before sending


class MicrosoftLoginRequest(BaseModel):
    id_token: str  # MSAL ID token, verified server-side before use


class SubmitFormRequest(BaseModel):
    answers: Dict[str, Any]


class SaveDraftRequest(BaseModel):
    answers: Dict[str, Any]


class SetApprovalRequest(BaseModel):
    status: Literal["approved", "rejected"]
    # Required when status is "rejected" (enforced in set_form_approval, not
    # here — Pydantic has no clean cross-field "required if" for this).
    # Optional at the model level only so approval keeps working without
    # callers needing to pass anything extra.
    reason: Optional[str] = None


class CreateEmployeeRequest(BaseModel):
    name: str
    work_email: str
    employee_id: str
    designation: str = ""
    department: str = ""
    location: str = ""
    # employee_id of this employee's manager — stored as this employee's own
    # assigned_employees array (see fetch_assigned_employees in
    # assesment_form.py: that field lives on the report's document, not the
    # manager's). None/omitted means "no manager assigned".
    manager_employee_id: Optional[str] = None


class UpdateEmployeeRequest(BaseModel):
    name: str
    work_email: str
    designation: str = ""
    department: str = ""
    location: str = ""
    manager_employee_id: Optional[str] = None


def _get_current_user(authorization: Optional[str]) -> Dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return {
        "email": payload["email"],
        "name": payload["name"],
        "is_hr": bool(payload.get("is_hr", False)),
        "is_cdo": bool(payload.get("is_cdo", False)),
    }


# Session length is now controlled solely by the frontend's 1-hour inactivity
# timeout (see sessionTimeout.ts), not by a token expiry — but the frontend's
# own JWT validation (jwtUtils.ts) treats a token with no `exp` claim at all
# as invalid, not as "never expires", so `exp` can't simply be omitted. A
# 10-year expiry is the practical equivalent of "no cap": it satisfies that
# validation while never actually being the thing that ends a session.
TOKEN_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60


def _issue_token(
    *,
    email: str,
    name: str,
    designation: str = "",
    department: str = "",
    employee_id: str = "",
    has_team: bool = False,
    is_hr: bool = False,
    is_cdo: bool = False,
    auth_method: str = "manual",
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "email": email,
            "name": name,
            "designation": designation,
            "department": department,
            "employee_id": employee_id,
            "has_team": has_team,
            "is_hr": is_hr,
            "is_cdo": is_cdo,
            # "manual" (password) or "microsoft" — lets the frontend show how
            # the user signed in after a page reload rebuilds them from here.
            "auth_method": auth_method,
            "view": True,
            "edit": True,
            "settings": True,
            "iat": now,
            "exp": now + TOKEN_LIFETIME_SECONDS,
        },
        JWT_SECRET,
        algorithm="HS256",
    )


# Username/password sign-in — for local testing only. The /login route is
# registered only when ENABLE_MANUAL_LOGIN=true is set (e.g. in backend/.env),
# so anywhere without it (production) the endpoint doesn't exist (404).
MANUAL_LOGIN_ENABLED = os.environ.get("ENABLE_MANUAL_LOGIN", "").strip().lower() == "true"


async def login(payload: LoginRequest, request: Request):
    try:
        decoded_password = base64.b64decode(payload.password).decode("utf-8")
    except Exception:
        decoded_password = payload.password

    users_container = request.app.state.users_container
    user = await fetch_user_by_email(users_container, payload.username)

    if user is None or not user.password_hash:
        return {
            "success": False,
            "message": "Invalid username or password"
        }

    if not bcrypt.checkpw(
        decoded_password.encode("utf-8"),
        user.password_hash.encode("utf-8")
    ):
        return {
            "success": False,
            "message": "Invalid username or password"
        }

    return await _login_success(users_container, user, auth_method="manual")


if MANUAL_LOGIN_ENABLED:
    app.post("/login")(login)


async def _login_success(users_container, user, *, auth_method: str):
    token = _issue_token(
        email=user.work_email,
        name=user.name,
        designation=user.designation or "",
        department=user.department or "",
        employee_id=user.employee_id or "",
        has_team=bool(user.employee_id)
        and len(
            await fetch_assigned_employees(users_container, user.employee_id)
        ) > 0,
        is_hr=(user.designation or "") in HR_DESIGNATIONS,
        is_cdo=(user.designation or "") == CDO_DESIGNATION,
        auth_method=auth_method,
    )

    return {
        "success": True,
        "message": "Login successful",
        "token": token,
        "expires_in": TOKEN_LIFETIME_SECONDS,
    }


def _verify_microsoft_id_token(id_token: str) -> dict:
    # Blocking (fetches the tenant's signing keys over HTTP, cached by
    # PyJWKClient after the first call) — run via run_in_threadpool.
    signing_key = _microsoft_jwks_client.get_signing_key_from_jwt(id_token)
    return jwt.decode(
        id_token,
        signing_key.key,
        algorithms=["RS256"],
        audience=AZURE_CLIENT_ID,
        issuer=f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/v2.0",
    )


@app.post("/login/microsoft")
async def login_microsoft(payload: MicrosoftLoginRequest, request: Request):
    if _microsoft_jwks_client is None or not AZURE_CLIENT_ID:
        return {
            "success": False,
            "message": "Microsoft login is not configured on the server"
        }

    try:
        claims = await run_in_threadpool(
            _verify_microsoft_id_token, payload.id_token
        )
    except jwt.PyJWTError as exc:
        logger.warning("Rejected Microsoft ID token: %s", exc)
        return {
            "success": False,
            "message": "Microsoft sign-in could not be verified"
        }

    # preferred_username is the address the user signed in with (may be an
    # alias); email is the mailbox address — try both, sign-in address first.
    users_container = request.app.state.users_container
    user = None
    for email in (claims.get("preferred_username"), claims.get("email")):
        if email:
            user = await fetch_user_by_email(users_container, email)
            if user is not None:
                break

    if user is None:
        return {
            "success": False,
            "message": "No PMS account found for this Microsoft account"
        }

    return await _login_success(users_container, user, auth_method="microsoft")

def _load_questions(row):
    # row.questions comes from the startup-time templates cache, shared
    # across every request — copy before mutating (sort + injected
    # question_number/options) so this never corrupts the cached template.
    questions = [dict(q) for q in row.questions]
    questions.sort(key=lambda q: q["order"])
    # Once HR has edited a template (see _ensure_stable_question_numbers),
    # each question carries its own permanent question_number — answers are
    # keyed by it, so it must never shift when a question is added, moved,
    # or deleted. Untouched templates keep the original position-based
    # numbering, which is exactly what their stored numbers are seeded from.
    stable_numbers = bool(getattr(row, "stable_question_numbers", False))
    for number, question in enumerate(questions, start=1):
        if not stable_numbers:
            question["question_number"] = number
        if question.get("question") == "Review Period":
            start_year = _current_academic_year_start()
            question["options"] = [
                f"July {start_year} - December {start_year}",
                f"January {start_year + 1} - June {start_year + 1}",
            ]
    return questions


# Question types answered with free text — the same set as isTextQuestion in
# the frontend's formFieldRendering.tsx.
TEXT_QUESTION_TYPES = ("text", "textarea")


def _trim_text_answers(questions, answers: Dict[str, Any]) -> Dict[str, Any]:
    # Leading/trailing whitespace is never part of a typed answer — trimmed
    # before any answer is saved (submit and draft); internal spaces are kept.
    # Typed text only (text/textarea answers, {n}_comment boxes, project
    # names): radio/slider values are left exactly as sent so they keep
    # matching their options for scoring. Mirrors trimTextAnswers in the
    # frontend, re-applied here so a direct API call is held to the same rule.
    trimmed = dict(answers)
    for question in questions:
        key = str(question["question_number"])
        value = trimmed.get(key)
        if question.get("type") in TEXT_QUESTION_TYPES and isinstance(value, str):
            trimmed[key] = value.strip()
        elif question.get("type") == "repeatable_text" and isinstance(value, list):
            trimmed[key] = [
                entry.strip() if isinstance(entry, str)
                else {**entry, "name": entry["name"].strip()}
                if isinstance(entry, dict) and isinstance(entry.get("name"), str)
                else entry
                for entry in value
            ]
        comment_key = f"{key}_comment"
        if question.get("has_comment") and isinstance(trimmed.get(comment_key), str):
            trimmed[comment_key] = trimmed[comment_key].strip()
    return trimmed


def _reject_blank_required_text_answers(template_id: int, questions, answers: Dict[str, Any]) -> None:
    # Server-side counterpart of the forms' `whitespace: true` rule: a
    # required text question answered with nothing but spaces ("" once
    # _trim_text_answers has run) isn't an answer. Auto-filled system
    # questions (Employee Name, Department, ...) and the Overall Review's
    # optional Additional Comments are skipped, as the forms never require
    # them either; only answers actually sent are checked.
    for question in questions:
        if (
            question.get("type") in TEXT_QUESTION_TYPES
            and question.get("required", True) is not False
            and not _is_system_question_text(template_id, question.get("question"))
            and answers.get(str(question["question_number"])) == ""
        ):
            raise HTTPException(status_code=400, detail=f'"{question["question"]}" is required.')


async def _resolve_target_employee(
    users_container, user: Dict[str, Any], employee_id: Optional[str], require_manager_relationship: bool = False
) -> Dict[str, str]:
    # Who is this submission *about*? Self by default (self-assessment always
    # works this way). When `employee_id` is given, there are two ways a
    # caller can be authorized to act on that employee's identity instead of
    # their own:
    #   1. A manager evaluating one of their own reports (existing behavior,
    #      unchanged) — verified via the same assigned-employees lookup the
    #      /team endpoint already trusts.
    #   2. HR, who can act on ANY employee (needed so HR can view/edit any
    #      submission from the HR Dashboard) — resolved directly by
    #      employee_id rather than requiring a manager relationship.
    # require_manager_relationship forces callers through path 1 even when
    # they're HR — Manager Review's own submit call sets this, since HR/CDO
    # sharing is_hr must not grant them blanket access to evaluate reports
    # that aren't theirs (see Capability Matrix: HR/CDO can only evaluate a
    # direct report "if also a manager" of that specific person). Every other
    # caller (HR Review, approval, drafts) leaves this False and keeps the
    # exact behavior above.
    if employee_id is None:
        return {"email": user["email"], "name": user["name"]}

    if user.get("is_hr") and not require_manager_relationship:
        employee = await fetch_user_by_employee_id(users_container, employee_id)
        if employee is None:
            raise HTTPException(status_code=404, detail="No employee found with that ID.")
        return {"email": employee.work_email, "name": employee.name}

    manager = await fetch_user_by_email(users_container, user["email"])
    if manager is None or not manager.employee_id:
        raise HTTPException(status_code=403, detail="You do not have any assigned employees.")

    for employee in await fetch_assigned_employees(users_container, manager.employee_id):
        if employee.employee_id == employee_id:
            return {"email": employee.work_email, "name": employee.name}

    raise HTTPException(status_code=403, detail="This employee is not assigned to you.")


async def _is_period_locked(
    submissions_container, employee_email: str, review_period_id: Optional[str] = None
) -> bool:
    # Once the CDO submits the Overall Review, the whole review cycle for
    # this employee + current period is closed — every Self, Manager, HR, and
    # Overall Review becomes read-only (see Requirements §5.3/§5.4). The
    # Overall Review submission's existence IS the lock; there's no separate
    # flag to keep in sync. A previous period (HR's read-only history view,
    # see _resolve_review_period_id) is always locked.
    if review_period_id is not None and review_period_id != _current_review_period_id():
        return True
    overall_submission = await fetch_submission(
        submissions_container, OVERALL_REVIEW_TEMPLATE_ID, employee_email, _current_review_period_id()
    )
    return overall_submission is not None


PERIOD_LOCKED_DETAIL = "This review period is locked because the Overall Review has been submitted."


@app.get("/api/employees/results")
async def get_my_profile(request: Request, authorization: Optional[str] = Header(default=None)):
    # Everything the employee Dashboard (DashboardContent.tsx) and
    # MyReviewDetails.tsx need about the caller's own review status, in one
    # round trip — those two pages used to make 6+ separate requests each
    # (a getFormTemplate + getFormSubmission pair per template, just to learn
    # each one's "Review Period" question_number and current submission), each
    # paying its own connection overhead on top of the query itself. Shape
    # mirrors get_hr_employees' per-employee fields (self_assessment/
    # manager_evaluation/hr_evaluation) so both callers can share the exact
    # same period-matching logic already written for HR's pages, just against
    # a single employee instead of the whole roster.
    user = _get_current_user(authorization)
    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    drafts_container = request.app.state.drafts_container
    templates_cache = request.app.state.templates_cache

    me = await fetch_user_by_email(users_container, user["email"])
    manager_ids = _manager_employee_ids(me.assigned_employees) if me is not None else []
    manager_names = []
    for manager_id in manager_ids:
        manager = await fetch_user_by_employee_id(users_container, manager_id)
        if manager is not None:
            manager_names.append(manager.name)

    self_form_row = await fetch_form_by_template_id(templates_cache, SELF_EVALUATION_TEMPLATE_ID)
    manager_form_row = await fetch_form_by_template_id(templates_cache, MANAGER_EVALUATION_TEMPLATE_ID)
    hr_form_row = await fetch_form_by_template_id(templates_cache, HR_EVALUATION_TEMPLATE_ID)
    self_questions = _load_questions(self_form_row)
    manager_questions = _load_questions(manager_form_row)
    hr_questions = _load_questions(hr_form_row)
    self_review_period_qn = _review_period_question_number(self_questions)
    manager_review_period_qn = _review_period_question_number(manager_questions)
    hr_review_period_qn = _review_period_question_number(hr_questions)

    current_review_period_id = _current_review_period_id()
    self_submission = await fetch_submission(
        submissions_container, SELF_EVALUATION_TEMPLATE_ID, user["email"], current_review_period_id
    )
    manager_submission = await fetch_submission(
        submissions_container, MANAGER_EVALUATION_TEMPLATE_ID, user["email"], current_review_period_id
    )
    hr_submission = await fetch_submission(
        submissions_container, HR_EVALUATION_TEMPLATE_ID, user["email"], current_review_period_id
    )
    # No _load_questions/review-period lookup for this one — its one
    # question ("Additional Comments") isn't a "Review Period" question, so
    # there's no submitted answer to resolve a period from — but the
    # submission itself is still scoped to the current period like every
    # other template (see _review_period_id_for_template).
    overall_submission = await fetch_submission(
        submissions_container, OVERALL_REVIEW_TEMPLATE_ID, user["email"], current_review_period_id
    )
    # Only meaningful while there's no real submission yet — once submitted,
    # submit_form has already deleted whatever draft existed for this exact
    # period.
    self_draft = (
        None
        if self_submission is not None
        else await fetch_draft(drafts_container, SELF_EVALUATION_TEMPLATE_ID, user["email"], current_review_period_id)
    )

    return {
        "manager_name": ", ".join(manager_names) if manager_names else None,
        "performance_cycle": _current_performance_cycle(),
        "self_assessment": {
            "submitted": self_submission is not None,
            "submitted_at": self_submission.submitted_at if self_submission is not None else None,
            "review_period": _submission_review_period(self_submission, self_review_period_qn),
            "has_draft": self_draft is not None,
        },
        # Full questions + submitted answers — not just status — for the two
        # places that need to actually render or fill out this exact form:
        # MyReviewDetails' "Self Review" tab, and the Dashboard's own inline
        # "Start Assessment"/"Continue" form. Folded in here since
        # self_form_row/self_submission above are already fetched for
        # self_assessment's summary fields, so this costs zero extra queries.
        # Shaped identically to get_form_with_submission's own response
        # ({template, submission}) so either caller can hand it straight to
        # useSectionedFormTemplate/HRSelfAssessmentTab as preloaded data
        # instead of that hook/component fetching GET /api/forms/1001/full
        # itself a moment later.
        "self_assessment_form": {
            "template": {
                "template_id": self_form_row.template_id,
                "type": self_form_row.type,
                "title": f"{self_form_row.title} ({_current_academic_year()})",
                "header_title": self_form_row.header_title,
                "questions": self_questions,
                "styles": FORM_STYLES,
                "review_period": _current_review_period(),
                "performance_cycle": _current_performance_cycle(),
            },
            "submission": (
                {
                    "submitted": True,
                    "answers": self_submission.answers,
                    "submitted_at": self_submission.submitted_at,
                    "employee_name": me.name if me is not None else None,
                }
                if self_submission is not None
                else {
                    "submitted": False,
                    "employee_name": me.name if me is not None else None,
                    "draft_answers": self_draft.answers if self_draft is not None else None,
                }
            ),
        },
        "manager_evaluation": {
            "submitted": manager_submission is not None,
            "submitted_at": manager_submission.submitted_at if manager_submission is not None else None,
            "review_period": _submission_review_period(manager_submission, manager_review_period_qn),
            **_score_fields(manager_questions, manager_submission),
        },
        "hr_evaluation": {
            "submitted": hr_submission is not None,
            "submitted_at": hr_submission.submitted_at if hr_submission is not None else None,
            "review_period": _submission_review_period(hr_submission, hr_review_period_qn),
            **_score_fields(hr_questions, hr_submission),
        },
        "overall_review": {
            "submitted": overall_submission is not None,
            "submitted_at": overall_submission.submitted_at if overall_submission is not None else None,
        },
    }


@app.get("/api/forms/{template_id}/submission")
async def get_submission(
    template_id: int,
    request: Request,
    employee_id: Optional[str] = None,
    # HR-only: view a previous period (see _resolve_review_period_id).
    review_period_id: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)
    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container

    period_id = _resolve_review_period_id(user, review_period_id)
    target = await _resolve_target_employee(users_container, user, employee_id)
    row = await fetch_submission(submissions_container, template_id, target["email"], period_id)

    locked = await _is_period_locked(submissions_container, target["email"], period_id)

    if row is None:
        return {"submitted": False, "employee_name": target["name"], "locked": locked}

    return {
        "submitted": True,
        "locked": locked,
        "answers": row.answers,
        "submitted_at": row.submitted_at,
        "employee_name": target["name"],
        "approval_status": getattr(row, "approval_status", None),
        "approval_by": getattr(row, "approval_by", None),
        "approval_at": getattr(row, "approval_at", None),
        "history": getattr(row, "history", []),
    }


@app.get("/api/forms/{template_id}/full")
async def get_form_with_submission(
    template_id: int,
    request: Request,
    employee_id: Optional[str] = None,
    # HR-only: view a previous period (see _resolve_review_period_id).
    review_period_id: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    # Every caller that needs a form's questions also needs to know what (if
    # anything) was already submitted for it — useSectionedFormTemplate (the
    # fill-in form hook), HRSelfAssessmentTab, and OverallReviewTab all used
    # to call get_form + get_submission above as a pair just to get both
    # halves of the same picture every single time. One response covers both.
    # get_form/get_submission above are left in place for any caller that
    # only ever needs one half.
    user = _get_current_user(authorization)
    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    drafts_container = request.app.state.drafts_container
    templates_cache = request.app.state.templates_cache

    row = await fetch_form_by_template_id(templates_cache, template_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No form found for template_id: {template_id}")

    period_id = _resolve_review_period_id(user, review_period_id)
    is_current_period = period_id == _current_review_period_id()
    target = await _resolve_target_employee(users_container, user, employee_id)
    submission_row = await fetch_submission(submissions_container, template_id, target["email"], period_id)

    template = {
        "template_id": row.template_id,
        "type": row.type,
        "title": f"{row.title} ({_current_academic_year()})",
        "header_title": row.header_title,
        "questions": _load_questions(row),
        "styles": FORM_STYLES,
        "review_period": _current_review_period(),
        "performance_cycle": _current_performance_cycle(),
    }
    if submission_row is None:
        # A previous period is read-only history — an abandoned draft from
        # back then isn't part of it.
        draft_row = (
            await fetch_draft(drafts_container, template_id, target["email"], period_id)
            if is_current_period
            else None
        )
        submission = {
            "submitted": False,
            "employee_name": target["name"],
            "draft_answers": draft_row.answers if draft_row is not None else None,
        }
    else:
        submission = {
            "submitted": True,
            "answers": submission_row.answers,
            "submitted_at": submission_row.submitted_at,
            "employee_name": target["name"],
            "approval_status": getattr(submission_row, "approval_status", None),
            "approval_by": getattr(submission_row, "approval_by", None),
            "approval_at": getattr(submission_row, "approval_at", None),
            "history": getattr(submission_row, "history", []),
        }
    # Lets the frontend hide Edit/Approve/Reject/Revise once the period is
    # closed — the endpoints below enforce the same lock server-side.
    submission["locked"] = await _is_period_locked(submissions_container, target["email"], period_id)

    return {"template": template, "submission": submission}


@app.put("/api/forms/{template_id}/draft")
async def save_draft(
    template_id: int,
    payload: SaveDraftRequest,
    request: Request,
    employee_id: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    # Best-effort autosave, addressed exactly like the submission it'll
    # eventually become (same _resolve_target_employee resolution submit_form
    # uses) — no workflow gates here, since a draft has no side effects
    # (no notifications, no approval logic, nothing else reads it except the
    # same person resuming this same form).
    user = _get_current_user(authorization)
    # Same rule as submit_form: a Self Review is only ever the employee's own
    # words, so nobody (HR included) may draft one on someone else's behalf —
    # otherwise opening another employee's Self Review would autosave over
    # their in-progress draft.
    if template_id == SELF_EVALUATION_TEMPLATE_ID and employee_id is not None:
        raise HTTPException(status_code=403, detail="Self Review can only be drafted for yourself.")
    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    drafts_container = request.app.state.drafts_container

    target = await _resolve_target_employee(users_container, user, employee_id)
    if await _is_period_locked(submissions_container, target["email"]):
        raise HTTPException(status_code=409, detail=PERIOD_LOCKED_DETAIL)
    review_period_id = _review_period_id_for_template(template_id)
    form_row = await fetch_form_by_template_id(request.app.state.templates_cache, template_id)
    answers = _trim_text_answers(_load_questions(form_row) if form_row is not None else [], payload.answers)
    await upsert_draft(drafts_container, template_id, target["email"], answers, review_period_id)
    return {"success": True}


async def _queue_submission_notifications(
    template_id: int,
    target: Dict[str, str],
    user: Dict[str, Any],
    users_container,
    background_tasks: BackgroundTasks,
) -> None:
    # Resolving recipients happens here (awaited, so it's part of the
    # request), but the actual email send is queued as a BackgroundTask —
    # it runs after the response is returned, so a slow/unreachable SendGrid
    # never delays the submission response. Wrapped in its own try/except on
    # top of email_service's internal one: a failure resolving recipients
    # (e.g. a Cosmos hiccup) must never surface as a failure of the
    # submission itself, which has already succeeded by the time this runs.
    try:
        review_period = _current_review_period()
        if template_id == SELF_EVALUATION_TEMPLATE_ID:
            employee = await fetch_user_by_email(users_container, target["email"])
            manager_ids = _manager_employee_ids(employee.assigned_employees) if employee is not None else []
            for manager_id in manager_ids:
                manager = await fetch_user_by_employee_id(users_container, manager_id)
                if manager is not None:
                    background_tasks.add_task(
                        email_service.send_review_submitted_email,
                        to_email=manager.work_email,
                        to_name=manager.name,
                        employee_name=target["name"],
                        review_period=review_period,
                        template_id=template_id,
                        submitted_by=user["name"],
                    )
        elif template_id in (MANAGER_EVALUATION_TEMPLATE_ID, HR_EVALUATION_TEMPLATE_ID):
            designation = SENIOR_HR_DESIGNATION if template_id == MANAGER_EVALUATION_TEMPLATE_ID else CDO_DESIGNATION
            recipients = await fetch_users_by_designation(users_container, designation)
            for recipient in recipients:
                background_tasks.add_task(
                    email_service.send_review_submitted_email,
                    to_email=recipient.work_email,
                    to_name=recipient.name,
                    employee_name=target["name"],
                    review_period=review_period,
                    template_id=template_id,
                    submitted_by=user["name"],
                )
        elif template_id == OVERALL_REVIEW_TEMPLATE_ID:
            background_tasks.add_task(
                email_service.send_overall_review_complete_email,
                to_email=target["email"],
                to_name=target["name"],
                review_period=review_period,
                approved_by=user["name"],
            )
    except Exception:
        logger.exception("Failed to queue submission notification for template_id=%s", template_id)


@app.post("/api/forms/{template_id}/submit")
async def submit_form(
    template_id: int,
    payload: SubmitFormRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    employee_id: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)

    # HR Evaluation is never self-service — only HR submits it, and always
    # about a specific employee (there's no "fill out my own HR Evaluation"
    # concept, unlike Self Assessment). The CDO shares HR's is_hr flag (see
    # HR_DESIGNATIONS above) so they can view this tab, but they're
    # deliberately excluded here — CDO gets read-only access to HR Evaluation,
    # mirrored client-side by canEditHR in HREvaluationTab.tsx, so this isn't
    # just a client-side check. Checked before touching the DB at all.
    if template_id == HR_EVALUATION_TEMPLATE_ID and not (
        user.get("is_hr") and not user.get("is_cdo") and employee_id is not None
    ):
        raise HTTPException(status_code=403, detail="Only HR can submit an HR Evaluation, for a specific employee.")

    # Overall Review approval is CDO-only — stricter than HR Evaluation
    # (is_hr also covers regular HR designations; is_cdo does not), and
    # always about a specific employee, same reasoning as above.
    if template_id == OVERALL_REVIEW_TEMPLATE_ID and not (user.get("is_cdo") and employee_id is not None):
        raise HTTPException(status_code=403, detail="Only the CDO can approve the Overall Review, for a specific employee.")

    # Self Review is always about the caller — unlike Manager/HR Review,
    # there's no legitimate "fill this out for someone else" case for it, so
    # unlike those two (handled generically by _resolve_target_employee)
    # this one is rejected outright rather than resolved.
    if template_id == SELF_EVALUATION_TEMPLATE_ID and employee_id is not None:
        raise HTTPException(status_code=403, detail="Self Review can only be submitted for yourself.")

    # Manager Review is always about someone else — the mirror image of Self
    # Review above — and must go through the real manager-relationship check
    # even for an HR/CDO caller (see require_manager_relationship on
    # _resolve_target_employee below), not the blanket "HR can act on any
    # employee" shortcut that's correct for HR Review.
    if template_id == MANAGER_EVALUATION_TEMPLATE_ID and employee_id is None:
        raise HTTPException(status_code=403, detail="Manager Review must be submitted for a specific employee.")

    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    drafts_container = request.app.state.drafts_container
    current_review_period_id = _current_review_period_id()

    target = await _resolve_target_employee(
        users_container, user, employee_id,
        require_manager_relationship=(template_id == MANAGER_EVALUATION_TEMPLATE_ID),
    )

    # Checked before every workflow gate and the insert-vs-update branch
    # below, so no submit, resubmit, or HR edit can slip through once the
    # Overall Review has closed this employee's period.
    if await _is_period_locked(submissions_container, target["email"]):
        raise HTTPException(status_code=409, detail=PERIOD_LOCKED_DETAIL)

    # Workflow gate, enforced here (not just in the UI): HR Evaluation
    # can't be created until this employee's Self Assessment and Manager
    # Evaluation both have a real submission FOR THE CURRENT PERIOD — mirrors
    # hrEvaluationAvailable in HREmployeeDetails.tsx, just re-checked
    # server-side so the gate can't be bypassed by calling this endpoint
    # directly.
    if template_id == HR_EVALUATION_TEMPLATE_ID:
        self_submission = await fetch_submission(
            submissions_container, SELF_EVALUATION_TEMPLATE_ID, target["email"], current_review_period_id
        )
        manager_submission = await fetch_submission(
            submissions_container, MANAGER_EVALUATION_TEMPLATE_ID, target["email"], current_review_period_id
        )
        if self_submission is None or manager_submission is None:
            raise HTTPException(
                status_code=400,
                detail="Self Assessment and Manager Evaluation must both be submitted before HR Evaluation.",
            )

    # Same idea, one step later: the Overall Review can't be approved
    # until the HR Evaluation itself has a real submission for the current
    # period, AND the Manager Evaluation is Pending or Approved (Requirements
    # §5.1/§5.8). Only a rejected-and-not-yet-resubmitted Manager Evaluation
    # blocks approval here; a resubmission clears approval_status back to
    # Pending (see update_form_submission), which unblocks it again.
    if template_id == OVERALL_REVIEW_TEMPLATE_ID:
        hr_submission = await fetch_submission(
            submissions_container, HR_EVALUATION_TEMPLATE_ID, target["email"], current_review_period_id
        )
        if hr_submission is None:
            raise HTTPException(
                status_code=400,
                detail="HR Evaluation must be submitted before the Overall Review can be approved.",
            )
        manager_submission = await fetch_submission(
            submissions_container, MANAGER_EVALUATION_TEMPLATE_ID, target["email"], current_review_period_id
        )
        if manager_submission is None or getattr(manager_submission, "approval_status", None) == "rejected":
            raise HTTPException(
                status_code=400,
                detail="The Overall Review cannot be approved while the Manager Evaluation is rejected.",
            )

    form_row = await fetch_form_by_template_id(request.app.state.templates_cache, template_id)
    questions = _load_questions(form_row) if form_row is not None else []
    answers = _trim_text_answers(questions, payload.answers)
    _reject_blank_required_text_answers(template_id, questions, answers)
    # Points per question + totals with the form's current points, saved on
    # the submission so they can be read back directly (Manager/HR only).
    scoring = _score_submission(questions, answers) if template_id in SCORED_TEMPLATE_IDS else None

    review_period_id = _review_period_id_for_template(template_id)
    existing = await fetch_submission(submissions_container, template_id, target["email"], review_period_id)

    if existing is not None:
        # Every submission is otherwise permanent for its review period —
        # this is the one carve-out, and only for HR explicitly acting on a
        # specific employee_id (never for someone editing their own
        # submission, which still 409s exactly as before). Manager
        # Evaluation is excluded from this HR carve-out entirely — HR can no
        # longer edit a manager's evaluation directly (mirrored client-side
        # by HRManagerEvaluationTab.tsx no longer offering an Edit action).
        can_edit_existing = (
            user.get("is_hr") and employee_id is not None and template_id != MANAGER_EVALUATION_TEMPLATE_ID
        )
        # The one way a Manager Evaluation becomes editable again: HR/CDO
        # explicitly rejected it (see set_form_approval below), and the
        # caller is the SAME manager who owns this report. That includes a
        # manager who is also HR/CDO: for this template,
        # _resolve_target_employee runs with require_manager_relationship,
        # so every caller (HR or not) has already been verified as this
        # employee's own manager — no one else can reach this point.
        if (
            template_id == MANAGER_EVALUATION_TEMPLATE_ID
            and getattr(existing, "approval_status", None) == "rejected"
        ):
            can_edit_existing = True
        if can_edit_existing:
            await update_form_submission(
                submissions_container, template_id, target["email"], answers, review_period_id,
                actor_name=user["name"], scoring=scoring,
            )
            await delete_draft(drafts_container, template_id, target["email"], review_period_id)
            await _queue_submission_notifications(template_id, target, user, users_container, background_tasks)
            return {"success": True, "message": "Form updated successfully"}
        raise HTTPException(status_code=409, detail="You have already submitted this form.")

    await insert_form_submission(
        submissions_container, template_id, target["email"], target["name"], answers, review_period_id,
        actor_name=user["name"], scoring=scoring,
    )
    await delete_draft(drafts_container, template_id, target["email"], review_period_id)

    # Approving the Overall Review also approves a Manager Evaluation that
    # HR never decided on — the period is now locked, so otherwise it would
    # stay "Pending" for good with no way left to approve it. manager_submission
    # was loaded by the Overall Review gate above (never rejected by then).
    # A failure here is logged, not raised: the Overall Review itself saved.
    if template_id == OVERALL_REVIEW_TEMPLATE_ID and getattr(manager_submission, "approval_status", None) is None:
        try:
            await set_submission_approval(
                submissions_container, MANAGER_EVALUATION_TEMPLATE_ID, target["email"],
                current_review_period_id, "approved", user["name"],
            )
        except Exception:
            logger.exception("Failed to auto-approve Manager Evaluation for %s", target["email"])

    await _queue_submission_notifications(template_id, target, user, users_container, background_tasks)
    return {"success": True, "message": "Form submitted successfully"}


@app.post("/api/forms/{template_id}/approval")
async def set_form_approval(
    template_id: int,
    payload: SetApprovalRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    employee_id: str,
    authorization: Optional[str] = Header(default=None),
):
    # HR/CDO's decision on an already-submitted Manager Evaluation — the only
    # template with an approve/reject workflow today. is_hr already covers
    # the CDO designation (see HR_DESIGNATIONS above), so no separate is_cdo
    # check is needed to let the CDO act here too.
    user = _get_current_user(authorization)
    if template_id != MANAGER_EVALUATION_TEMPLATE_ID:
        raise HTTPException(status_code=404, detail="Approval is not supported for this form.")
    if not user.get("is_hr"):
        raise HTTPException(status_code=403, detail="Only HR can approve or reject a Manager Evaluation.")
    # Enforced here, not just by the Reject modal client-side, so a direct
    # API call can't record a rejection with no reason either.
    if payload.status == "rejected" and not (payload.reason or "").strip():
        raise HTTPException(status_code=400, detail="A reason is required to reject a Manager Evaluation.")

    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    # is_hr resolves any employee_id directly (see _resolve_target_employee) —
    # this isn't restricted to a manager acting on their own reports.
    target = await _resolve_target_employee(users_container, user, employee_id)

    # No approve/reject once the Overall Review has closed the period.
    if await _is_period_locked(submissions_container, target["email"]):
        raise HTTPException(status_code=409, detail=PERIOD_LOCKED_DETAIL)

    review_period_id = _review_period_id_for_template(template_id)
    existing = await fetch_submission(submissions_container, template_id, target["email"], review_period_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="No Manager Evaluation submission found for this employee.")
    # Requirements §5.6: a rejected Manager Evaluation can't be decided on
    # again (approved, or re-rejected) until the manager resubmits it — the
    # resubmission clears approval_status back to Pending (see
    # update_form_submission), which reopens it for a decision.
    if getattr(existing, "approval_status", None) == "rejected":
        raise HTTPException(
            status_code=409,
            detail="This Manager Evaluation was rejected. It can be approved only after the manager resubmits it.",
        )

    await set_submission_approval(
        submissions_container, template_id, target["email"], review_period_id, payload.status, user["name"],
        payload.reason,
    )

    if payload.status == "rejected":
        # Previously silent (see REQUIREMENTS.md §13): rejecting a Manager
        # Evaluation is the single most time-sensitive event in the
        # workflow, but until now the manager could only discover it by
        # checking the app. Mirrors the recipient-lookup pattern used for
        # the Self Review "submitted" notification in
        # _queue_submission_notifications above — resolved and awaited here
        # (part of the request), the actual send queued as a background
        # task so a slow/unreachable SendGrid never delays the response.
        try:
            employee = await fetch_user_by_email(users_container, target["email"])
            manager_ids = _manager_employee_ids(employee.assigned_employees) if employee is not None else []
            review_period = _current_review_period()
            for manager_id in manager_ids:
                manager = await fetch_user_by_employee_id(users_container, manager_id)
                if manager is not None:
                    background_tasks.add_task(
                        email_service.send_manager_review_rejected_email,
                        to_email=manager.work_email,
                        to_name=manager.name,
                        employee_name=target["name"],
                        review_period=review_period,
                        template_id=template_id,
                        rejected_by=user["name"],
                        reason=payload.reason or "",
                    )
        except Exception:
            logger.exception("Failed to queue rejection notification for template_id=%s", template_id)

    return {"success": True, "message": f"Manager Evaluation {payload.status}"}


@app.get("/api/manager/team")
async def get_manager_team(request: Request, authorization: Optional[str] = Header(default=None)):
    # ManagerEvaluationsList (the "Manager Review" list) and ManagerEmployeeReview
    # (its per-employee detail page) each used to call get_team_submissions
    # above TWICE — once for template 1001 (Self Assessment), once for 1002
    # (Manager Evaluation) — to build one table with both status columns. Same
    # per-employee queries either way; this just does both template's worth of
    # them behind one HTTP round trip instead of two, and returns them in the
    # exact same `team`-array shape those two calls already produced, so
    # callers only need to stop making the second request rather than
    # restructure how they consume the response.
    user = _get_current_user(authorization)
    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    drafts_container = request.app.state.drafts_container
    templates_cache = request.app.state.templates_cache

    manager = await fetch_user_by_email(users_container, user["email"])
    if manager is None or not manager.employee_id:
        empty = {"team": [], "review_period": _current_review_period(), "review_periods": [_current_review_period()]}
        return {"self_team": empty, "manager_team": empty}

    self_form_row = await fetch_form_by_template_id(templates_cache, SELF_EVALUATION_TEMPLATE_ID)
    manager_form_row = await fetch_form_by_template_id(templates_cache, MANAGER_EVALUATION_TEMPLATE_ID)
    manager_questions = _load_questions(manager_form_row)
    self_review_period_qn = _review_period_question_number(_load_questions(self_form_row))
    manager_review_period_qn = _review_period_question_number(manager_questions)

    current_review_period_id = _current_review_period_id()
    self_team = []
    manager_team = []
    self_review_periods_seen = {_current_review_period()}
    manager_review_periods_seen = {_current_review_period()}

    async def fetch_report_status(employee):
        # Self + Manager Review point reads together; the draft read only
        # matters (and only happens) when there's no Manager Review yet.
        self_submission, manager_submission = await asyncio.gather(
            fetch_submission(
                submissions_container, SELF_EVALUATION_TEMPLATE_ID, employee.work_email, current_review_period_id
            ),
            fetch_submission(
                submissions_container, MANAGER_EVALUATION_TEMPLATE_ID, employee.work_email, current_review_period_id
            ),
        )
        manager_draft = (
            await fetch_draft(
                drafts_container, MANAGER_EVALUATION_TEMPLATE_ID, employee.work_email, current_review_period_id
            )
            if manager_submission is None
            else None
        )
        return self_submission, manager_submission, manager_draft

    # Every report's reads run concurrently rather than one report after
    # another — previously up to 3 back-to-back round trips per report
    # (measured at 0.5-0.8 s for a 9-person team in the Nov 2026 load test).
    # Results come back in the same order as `employees`, so the response is
    # unchanged.
    employees = await fetch_assigned_employees(users_container, manager.employee_id)
    statuses = await asyncio.gather(*(fetch_report_status(employee) for employee in employees))
    for employee, (self_submission, manager_submission, manager_draft) in zip(employees, statuses):
        base_entry = {
            "employee_id": employee.employee_id,
            "name": employee.name,
            "email": employee.work_email,
            "designation": employee.designation or None,
            "department": employee.department or None,
        }

        self_entry = dict(base_entry, submitted=self_submission is not None)
        if self_submission is not None:
            self_entry["submitted_at"] = self_submission.submitted_at
            review_period = _submission_review_period(self_submission, self_review_period_qn)
            self_entry["review_period"] = review_period
            if review_period:
                self_review_periods_seen.add(review_period)
        self_team.append(self_entry)

        manager_entry = dict(base_entry, submitted=manager_submission is not None)
        if manager_submission is not None:
            manager_entry["submitted_at"] = manager_submission.submitted_at
            review_period = _submission_review_period(manager_submission, manager_review_period_qn)
            manager_entry["review_period"] = review_period
            if review_period:
                manager_review_periods_seen.add(review_period)
            scoring = _submission_scoring(manager_questions, manager_submission)
            manager_entry.update({"score": scoring["score"], "max_score": scoring["max_score"], "answered": scoring["answered"]})
            # So the manager's list can show "Rejected" (and offer Revise)
            # once HR/the CDO sends it back, instead of plain "Submitted".
            manager_entry["approval_status"] = getattr(manager_submission, "approval_status", None)
        else:
            manager_entry["has_draft"] = manager_draft is not None
        manager_team.append(manager_entry)

    return {
        "self_team": {
            "team": self_team,
            "review_period": _current_review_period(),
            "review_periods": sorted(self_review_periods_seen, key=_review_period_sort_key),
        },
        "manager_team": {
            "team": manager_team,
            "review_period": _current_review_period(),
            "review_periods": sorted(manager_review_periods_seen, key=_review_period_sort_key),
        },
    }


def _review_period_question_number(questions) -> Optional[int]:
    # Same technique already used for the Employee Dashboard's "My
    # Assessments" section: the only link a submission has to a specific
    # period is its own answer to the "Review Period" question, not
    # submitted_at (an employee could submit late) and not a stored column
    # (there isn't one). Resolving this once per template, rather than per
    # submission, since every submission of the same template shares the
    # same question_number for it.
    for question in questions:
        if question.get("question") == "Review Period":
            return question["question_number"]
    return None


def _submission_review_period(submission, review_period_question_number: Optional[int]) -> Optional[str]:
    if submission is None or review_period_question_number is None:
        return None
    return submission.answers.get(str(review_period_question_number))


def _hr_evaluation_eligible(
    self_review_period: Optional[str],
    manager_review_period: Optional[str],
    target_review_period: Optional[str],
) -> bool:
    # Workflow gate: HR Evaluation can only be created, saved as a draft, or
    # submitted for a given employee + review period once BOTH the Self
    # Assessment and the Manager Evaluation have a submission whose own
    # "Review Period" answer matches that exact target period — same matching
    # rule _submission_review_period already establishes for every other
    # period-aware comparison in this file.
    #
    # There is currently no HR Evaluation template (no template_id 1003) and
    # no create/save-draft/submit endpoint for it — those are paused pending
    # real question content, so nothing calls this function yet. It exists
    # now so that whichever endpoints are added later enforce this exact
    # rule server-side, rather than relying on the frontend tab merely being
    # disabled. When target_review_period is None (HR viewing "All Periods",
    # no specific period selected), eligibility falls back to "both were
    # submitted for some period" rather than requiring an exact match.
    if target_review_period is None:
        return self_review_period is not None and manager_review_period is not None
    return self_review_period == target_review_period and manager_review_period == target_review_period


def _manager_employee_ids(assigned_employees: Optional[List[str]]) -> list:
    # assigned_employees lives on the EMPLOYEE's own document and lists the
    # employee_id(s) of their manager(s) (see fetch_assigned_employees in
    # assesment_form.py). Cosmos stores this as a native array (or it may be
    # absent/None for an employee with no manager) — no parsing needed.
    return assigned_employees if isinstance(assigned_employees, list) else []


@app.get("/api/hr/employees")
async def get_hr_employees(
    request: Request,
    # HR-only: load the roster for a previous period (see _resolve_review_period_id).
    review_period_id: Optional[str] = None,
    # The Employees tab (a staff directory) lists the caller too; the HR
    # Review dashboard leaves it off so HR never reviews themselves.
    include_self: bool = False,
    authorization: Optional[str] = Header(default=None),
):
    # Read-only roster — unlike the three mutation endpoints below (which stay HR-only, not
    # CDO), the CDO needs this same listing to reach an employee's Overall Review tab from the
    # HR Dashboard. is_hr already covers CDO (see HR_DESIGNATIONS above), so no separate is_cdo
    # check is needed to let them read this too; CDO already has equivalent per-employee read
    # access via GET /api/forms/{template_id}/full?employee_id=... (is_hr resolves any
    # employee_id there too), so this doesn't expose any data category that wasn't already
    # reachable one employee at a time — it just lets CDO browse the same list HR sees.
    user = _get_current_user(authorization)
    if not user["is_hr"]:
        raise HTTPException(status_code=403, detail="HR access required.")

    users_container = request.app.state.users_container
    submissions_container = request.app.state.submissions_container
    templates_cache = request.app.state.templates_cache

    period_id = _resolve_review_period_id(user, review_period_id)
    current_review_period_id = _current_review_period_id()
    # Periods offered in the dashboard's selector: every period that has at
    # least one submission, plus the current one (even if nothing's been
    # submitted yet). Only HR may look back — the CDO gets the current
    # period alone.
    available_period_ids = {current_review_period_id}
    if not user["is_cdo"]:
        available_period_ids.update(
            pid for pid in await fetch_review_period_ids(submissions_container)
            if pid and _is_valid_review_period_id(pid)
        )
    review_period_options = [
        {
            "review_period_id": pid,
            "label": _review_period_label(pid),
            "is_current": pid == current_review_period_id,
        }
        for pid in sorted(available_period_ids, key=_review_period_id_sort_key)
    ]

    all_employees = await fetch_all_employees(users_container, user["email"])
    me = await fetch_user_by_email(users_container, user["email"])
    if include_self and me is not None:
        all_employees = [*all_employees, me]
    # A manager is just another row in this same org-wide roster, so this
    # reuses the list already fetched above rather than a second query —
    # maps employee_id -> name for resolving assigned_employees into a
    # display name below.
    # The caller is included too, since they can be someone's manager.
    name_by_employee_id = {
        e.employee_id: e.name for e in [*all_employees, *([me] if me is not None else [])] if e.employee_id
    }

    # Resolved once per template (not per employee/submission) — every
    # submission of the same template shares the same "Review Period"
    # question_number.
    self_form_row = await fetch_form_by_template_id(templates_cache, SELF_EVALUATION_TEMPLATE_ID)
    manager_form_row = await fetch_form_by_template_id(templates_cache, MANAGER_EVALUATION_TEMPLATE_ID)
    hr_form_row = await fetch_form_by_template_id(templates_cache, HR_EVALUATION_TEMPLATE_ID)
    manager_questions = _load_questions(manager_form_row)
    hr_questions = _load_questions(hr_form_row)
    self_review_period_qn = _review_period_question_number(_load_questions(self_form_row))
    manager_review_period_qn = _review_period_question_number(manager_questions)
    hr_review_period_qn = _review_period_question_number(hr_questions)

    employees = []
    # Distinct managers who actually have at least one report — built
    # while resolving each employee's manager(s) below, not a separate
    # query, and keyed by employee_id so duplicate names can't collide.
    managers_by_id: Dict[str, str] = {}
    # The whole roster's submissions for the selected period in one query,
    # instead of one query per employee inside the loop below.
    submissions_by_employee = await fetch_submissions_for_period(submissions_container, period_id)
    for employee in all_employees:
        submissions_by_template = submissions_by_employee.get(employee.work_email.lower(), {})
        self_submission = submissions_by_template.get(SELF_EVALUATION_TEMPLATE_ID)
        manager_submission = submissions_by_template.get(MANAGER_EVALUATION_TEMPLATE_ID)
        hr_submission = submissions_by_template.get(HR_EVALUATION_TEMPLATE_ID)
        # No _load_questions/review-period lookup for this one — its one
        # question ("Additional Comments") isn't a "Review Period" question,
        # so there'd be nothing to resolve from a submitted answer — but the
        # submission itself is still scoped to the current period, same as
        # every other template (see _review_period_id_for_template).
        overall_submission = submissions_by_template.get(OVERALL_REVIEW_TEMPLATE_ID)

        manager_ids = _manager_employee_ids(employee.assigned_employees)
        # Falls back to the raw employee_id (rather than hiding it) if a
        # manager's own row wasn't in this roster — e.g. if the HR caller
        # themselves is that manager, since fetch_all_employees excludes
        # the caller's own row.
        manager_names = [name_by_employee_id.get(mid, mid) for mid in manager_ids]
        for manager_id, manager_name in zip(manager_ids, manager_names):
            managers_by_id[manager_id] = manager_name

        self_review_period = _submission_review_period(self_submission, self_review_period_qn)
        manager_review_period = _submission_review_period(manager_submission, manager_review_period_qn)
        hr_review_period = _submission_review_period(hr_submission, hr_review_period_qn)

        employees.append({
            "employee_id": employee.employee_id,
            "name": employee.name,
            "email": employee.work_email,
            "designation": employee.designation or None,
            "department": employee.department or None,
            "location": employee.location or None,
            "manager_ids": manager_ids,
            "manager_name": ", ".join(manager_names) if manager_names else None,
            "self_assessment": {
                "submitted": self_submission is not None,
                "submitted_at": self_submission.submitted_at if self_submission is not None else None,
                "review_period": self_review_period,
            },
            "manager_evaluation": {
                "submitted": manager_submission is not None,
                "submitted_at": manager_submission.submitted_at if manager_submission is not None else None,
                "has_manager": bool(manager_ids),
                "review_period": manager_review_period,
                **_score_fields(manager_questions, manager_submission),
                # Powers the Overall Review tab's gate — the CDO can't approve
                # until this is "approved", not just submitted (see
                # OVERALL_REVIEW_TEMPLATE_ID's gate in submit_form).
                "approval_status": (
                    getattr(manager_submission, "approval_status", None) if manager_submission is not None else None
                ),
            },
            "hr_evaluation": {
                "submitted": hr_submission is not None,
                "submitted_at": hr_submission.submitted_at if hr_submission is not None else None,
                "review_period": hr_review_period,
                **_score_fields(hr_questions, hr_submission),
            },
            "overall_review": {
                "submitted": overall_submission is not None,
                "submitted_at": overall_submission.submitted_at if overall_submission is not None else None,
            },
        })

    return {
        # The period this roster is for (the current one unless HR asked for
        # a previous one), plus every period HR can switch to.
        "review_period_id": period_id,
        "review_period": _review_period_label(period_id),
        "current_review_period_id": current_review_period_id,
        "review_period_options": review_period_options,
        "review_periods": [option["label"] for option in review_period_options],
        "managers": [
            {"employee_id": manager_id, "name": manager_name}
            for manager_id, manager_name in sorted(managers_by_id.items(), key=lambda item: item[1])
        ],
        "employees": employees,
        # The caller themselves — left out of `employees` above (HR doesn't
        # review themselves), but still eligible as someone's reporting
        # manager in the Employees tab.
        "current_user": (
            {"employee_id": me.employee_id, "name": me.name}
            if me is not None and me.employee_id
            else None
        ),
    }


@app.post("/api/hr/employees")
async def create_employee(payload: CreateEmployeeRequest, request: Request, authorization: Optional[str] = Header(default=None)):
    user = _get_current_user(authorization)
    if not user["is_hr"] or user["is_cdo"]:
        raise HTTPException(status_code=403, detail="HR access required.")

    if payload.manager_employee_id == payload.employee_id:
        raise HTTPException(status_code=400, detail="An employee cannot be their own manager.")

    if not payload.manager_employee_id and payload.designation != CEO_DESIGNATION:
        raise HTTPException(
            status_code=400,
            detail="A reporting manager is required",
        )

    users_container = request.app.state.users_container

    if await fetch_user_by_email(users_container, payload.work_email) is not None:
        raise HTTPException(status_code=409, detail="An employee with this email already exists.")
    if await fetch_user_by_employee_id(users_container, payload.employee_id) is not None:
        raise HTTPException(status_code=409, detail="An employee with this Employee ID already exists.")
    if payload.manager_employee_id and await fetch_user_by_employee_id(users_container, payload.manager_employee_id) is None:
        raise HTTPException(status_code=400, detail="Selected manager does not exist.")

    assigned_employees = [payload.manager_employee_id] if payload.manager_employee_id else None
    await insert_employee(
        users_container,
        payload.name,
        payload.work_email,
        payload.employee_id,
        payload.designation,
        payload.department,
        payload.location,
        assigned_employees,
    )
    return {"success": True, "message": "Employee created successfully"}


@app.put("/api/hr/employees/{employee_id}")
async def update_employee_endpoint(
    employee_id: str,
    payload: UpdateEmployeeRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)
    if not user["is_hr"] or user["is_cdo"]:
        raise HTTPException(status_code=403, detail="HR access required.")

    if payload.manager_employee_id == employee_id:
        raise HTTPException(status_code=400, detail="An employee cannot be their own manager.")

    if not payload.manager_employee_id and payload.designation != CEO_DESIGNATION:
        raise HTTPException(
            status_code=400,
            detail="A reporting manager is required",
        )

    users_container = request.app.state.users_container

    if await fetch_user_by_employee_id(users_container, employee_id) is None:
        raise HTTPException(status_code=404, detail="Employee not found.")

    # A different employee already using the new email is only a
    # conflict if it isn't this same employee — an unchanged email must
    # still pass through untouched.
    email_owner = await fetch_user_by_email(users_container, payload.work_email)
    if email_owner is not None and email_owner.employee_id != employee_id:
        raise HTTPException(status_code=409, detail="Another employee already uses this email.")
    if payload.manager_employee_id and await fetch_user_by_employee_id(users_container, payload.manager_employee_id) is None:
        raise HTTPException(status_code=400, detail="Selected manager does not exist.")

    assigned_employees = [payload.manager_employee_id] if payload.manager_employee_id else None
    await update_employee(
        users_container,
        employee_id,
        payload.name,
        payload.work_email,
        payload.designation,
        payload.department,
        payload.location,
        assigned_employees,
    )
    return {"success": True, "message": "Employee updated successfully"}


@app.delete("/api/hr/employees/{employee_id}")
async def delete_employee_endpoint(employee_id: str, request: Request, authorization: Optional[str] = Header(default=None)):
    user = _get_current_user(authorization)
    if not user["is_hr"] or user["is_cdo"]:
        raise HTTPException(status_code=403, detail="HR access required.")

    users_container = request.app.state.users_container

    target = await fetch_user_by_employee_id(users_container, employee_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Employee not found.")
    # HR's own record is listed in the Employees tab, but deleting it would
    # lock them out of the app.
    if (target.work_email or "").lower() == user["email"].lower():
        raise HTTPException(status_code=400, detail="You can't delete your own employee record.")

    # Strip this employee_id out of every report's assigned_employees
    # array before deleting the row itself, so no one is left pointing at
    # a manager that no longer exists (per requested delete behavior).
    for report in await fetch_employees_managed_by(users_container, employee_id):
        remaining = [mid for mid in (report.assigned_employees or []) if mid != employee_id]
        await update_assigned_employees(users_container, report.employee_id, remaining if remaining else None)

    await delete_employee(users_container, employee_id)
    return {"success": True, "message": "Employee deleted successfully"}


# ---------------------------------------------------------------------------
# HR form editor: add / edit / delete the questions inside the four fixed
# review forms (1001-1004). The forms themselves can't be created or deleted —
# the workflow is built around exactly these four template_ids.
# ---------------------------------------------------------------------------

EDITABLE_TEMPLATE_IDS = (
    SELF_EVALUATION_TEMPLATE_ID,
    MANAGER_EVALUATION_TEMPLATE_ID,
    HR_EVALUATION_TEMPLATE_ID,
    OVERALL_REVIEW_TEMPLATE_ID,
)

# Questions the app finds by their exact wording — auto-filled on the forms
# (see AUTO_FILLED_QUESTION_TEXTS in selfassesment.tsx/ManagerEvaluation.tsx)
# or used to resolve a submission's period (_review_period_question_number).
# They can be moved, but not renamed, retyped, or deleted.
SYSTEM_QUESTION_TEXTS = {"Employee Name", "Designation", "Department", "Date", "Review Period"}
# Per-form additions: OverallReviewTab.tsx finds the CDO's comments box by
# this exact wording on the Overall Review form only.
SYSTEM_QUESTION_TEXTS_BY_TEMPLATE = {OVERALL_REVIEW_TEMPLATE_ID: {"Additional Comments"}}


def _is_system_question_text(template_id: int, text: Optional[str]) -> bool:
    return text in SYSTEM_QUESTION_TEXTS or text in SYSTEM_QUESTION_TEXTS_BY_TEMPLATE.get(template_id, set())


class FormQuestionRequest(BaseModel):
    question: str
    # Every type the form renderer knows (see renderField/ProjectDetailsField
    # in the frontend's formFieldRendering.tsx).
    type: Literal["textarea", "text", "date", "radio", "slider", "repeatable_text"]
    section: str = ""
    # Position within the form; omitted on add means "at the end".
    order: Optional[float] = None
    required: bool = True
    description: Optional[str] = None
    # radio only
    options: Optional[List[str]] = None
    # radio only: optional comment box under the answer
    has_comment: bool = False
    comment_label: Optional[str] = None
    # slider only
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    # Points (Manager/HR Review only). radio: points per option, e.g.
    # {"Does not meet": 5, "Meets": 7.5, "Outstanding": 10}; slider: the
    # points a full-range answer earns. Omitted = not scored.
    option_points: Optional[Dict[str, float]] = None
    max_points: Optional[float] = None


def _require_hr_editor(user: Dict[str, Any]) -> None:
    # HR and the CDO (both carry is_hr) — unlike the employee directory
    # endpoints above, which stay HR-only.
    if not user["is_hr"]:
        raise HTTPException(status_code=403, detail="HR access required.")


def _ensure_stable_question_numbers(document: dict) -> dict:
    # First edit of a template: freeze each question's current position-based
    # number (exactly what _load_questions has always computed, and what every
    # existing answer is keyed by) into the question itself, and start a
    # counter for new questions. From then on numbers never shift or get
    # reused — a deleted question's number stays retired so a new question
    # can't inherit its old answers.
    if document.get("stable_question_numbers"):
        return document
    questions = sorted(document.get("questions", []), key=lambda q: q["order"])
    for number, question in enumerate(questions, start=1):
        question["question_number"] = number
    document["questions"] = questions
    document["next_question_number"] = len(questions) + 1
    document["stable_question_numbers"] = True
    return document


def _build_question(payload: FormQuestionRequest, base: Optional[dict] = None) -> dict:
    # Validates the request and returns the stored question dict. Fields that
    # don't apply to the chosen type are dropped, so a question changed from
    # radio to textarea doesn't keep stale options.
    text = payload.question.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Question text is required.")
    question = dict(base or {})
    for key in ("options", "has_comment", "comment_label", "min", "max", "step", "weight", "option_points", "max_points"):
        question.pop(key, None)
    question.update({
        "question": text,
        "type": payload.type,
        "section": payload.section.strip(),
        "required": payload.required,
    })
    # Omitted (the Forms page doesn't offer this field) keeps whatever
    # description the question already has; an explicit blank clears it.
    if payload.description is not None:
        if payload.description.strip():
            question["description"] = payload.description.strip()
        else:
            question.pop("description", None)
    if payload.order is not None:
        question["order"] = payload.order

    if payload.type == "radio":
        options = [option.strip() for option in (payload.options or []) if option and option.strip()]
        if len(options) < 2:
            raise HTTPException(status_code=400, detail="A radio question needs at least two options.")
        if len(set(options)) != len(options):
            raise HTTPException(status_code=400, detail="Radio options must be unique.")
        question["options"] = options
        if payload.has_comment:
            question["has_comment"] = True
            question["comment_label"] = (payload.comment_label or "").strip() or "Comments"
    elif payload.type == "slider":
        lo = 0 if payload.min is None else payload.min
        hi = 10 if payload.max is None else payload.max
        step = 1 if payload.step is None else payload.step
        if hi <= lo:
            raise HTTPException(status_code=400, detail="Slider max must be greater than min.")
        if step <= 0:
            raise HTTPException(status_code=400, detail="Slider step must be greater than 0.")
        question.update({"min": lo, "max": hi, "step": step})

    # Points are dropped above for every type and stored back only where they
    # apply, so a question changed to another type doesn't keep stale points.
    if payload.type == "radio" and payload.option_points:
        options = question["options"]
        if set(payload.option_points) != set(options):
            raise HTTPException(status_code=400, detail="Give points for every option, and only for the options listed.")
        if any(points < 0 or points > 100 for points in payload.option_points.values()):
            raise HTTPException(status_code=400, detail="Points must be between 0 and 100.")
        # The standard rating scale must earn more at each step up:
        # Does not meet < Meets < Outstanding.
        rating_scale = ("Does not meet", "Meets", "Outstanding")
        if set(options) == set(rating_scale):
            scale_points = [payload.option_points[rating] for rating in rating_scale]
            if not all(low < high for low, high in zip(scale_points, scale_points[1:])):
                raise HTTPException(status_code=400, detail="Points must increase: Does not meet < Meets < Outstanding.")
        question["option_points"] = {option: payload.option_points[option] for option in options}
    elif payload.type == "slider" and payload.max_points is not None:
        if not 0 < payload.max_points <= 100:
            raise HTTPException(status_code=400, detail="Max points must be greater than 0 and at most 100.")
        question["max_points"] = payload.max_points
    return question


def _form_editor_response(document: dict) -> Dict[str, Any]:
    questions = sorted(
        (dict(q) for q in document.get("questions", [])),
        key=lambda q: (q["order"], q.get("question_number", 0)),
    )
    stable_numbers = bool(document.get("stable_question_numbers"))
    for number, question in enumerate(questions, start=1):
        if not stable_numbers:
            question["question_number"] = number
        question["is_system"] = _is_system_question_text(document["template_id"], question.get("question"))
    return {
        "template_id": document["template_id"],
        "title": document.get("title"),
        "header_title": document.get("header_title"),
        "questions": questions,
    }


async def _load_editable_template(request: Request, template_id: int) -> dict:
    if template_id not in EDITABLE_TEMPLATE_IDS:
        raise HTTPException(status_code=404, detail=f"No form found for template_id: {template_id}")
    document = await fetch_template_document(request.app.state.templates_container, template_id)
    if document is None:
        raise HTTPException(status_code=404, detail=f"No form found for template_id: {template_id}")
    return _ensure_stable_question_numbers(document)


async def _save_template(request: Request, document: dict) -> Dict[str, Any]:
    try:
        saved = await replace_template_document(request.app.state.templates_container, document)
    except CosmosAccessConditionFailedError:
        # Another HR user saved this form after we read it — refuse rather
        # than overwrite their change (or hand out a duplicate question
        # number). The page reloads the form and the user can retry.
        raise HTTPException(
            status_code=409, detail="This form was just changed by someone else. Reload it and try again."
        )
    # This worker sees the change immediately; others within
    # TEMPLATES_CACHE_MAX_AGE_SECONDS (see refresh_templates_cache_if_stale).
    request.app.state.templates_cache[saved["template_id"]] = saved
    if saved["template_id"] in SCORED_TEMPLATE_IDS:
        # The form itself has saved; a failure re-scoring is logged, not
        # raised, and the next save of this form retries every open review.
        try:
            await _rescore_open_submissions(
                request.app.state.submissions_container, saved["template_id"], saved.get("questions", [])
            )
        except Exception:
            logger.exception("Failed to re-score open submissions for template_id=%s", saved["template_id"])
    return _form_editor_response(saved)


async def _split_open_and_locked_submissions(submissions_container, template_id: int):
    # Open = the employee's Overall Review for that period isn't approved yet
    # (its score still follows the form's points). Locked = approved, or an
    # earlier period — its stored score is final and never touched again.
    open_items, locked_items = [], []
    for item in await fetch_submissions_for_template(submissions_container, template_id):
        locked = await _is_period_locked(submissions_container, item["employee_email"], item.get("review_period_id"))
        (locked_items if locked else open_items).append(item)
    return open_items, locked_items


async def _rescore_open_submissions(submissions_container, template_id: int, questions) -> int:
    # After HR changes a scored form: every open review is re-scored with the
    # new points; locked ones keep the score they were finalised with.
    # Returns how many open reviews were re-scored.
    open_items, _ = await _split_open_and_locked_submissions(submissions_container, template_id)
    for item in open_items:
        await set_submission_scoring(submissions_container, item, _score_submission(questions, item.get("answers") or {}))
    return len(open_items)


@app.get("/api/hr/forms/{template_id}/rescore-preview")
async def get_rescore_preview(template_id: int, request: Request, authorization: Optional[str] = Header(default=None)):
    # Counts for the Forms page's warning before a points change is saved:
    # "Changing points will re-score N open reviews. M approved reviews keep
    # their current scores."
    user = _get_current_user(authorization)
    _require_hr_editor(user)
    if template_id not in SCORED_TEMPLATE_IDS:
        return {"open": 0, "locked": 0}
    open_items, locked_items = await _split_open_and_locked_submissions(
        request.app.state.submissions_container, template_id
    )
    return {"open": len(open_items), "locked": len(locked_items)}


def _find_question(document: dict, question_number: int) -> dict:
    for question in document.get("questions", []):
        if question.get("question_number") == question_number:
            return question
    raise HTTPException(status_code=404, detail="Question not found.")


@app.get("/api/hr/forms")
async def list_forms(request: Request, authorization: Optional[str] = Header(default=None)):
    user = _get_current_user(authorization)
    _require_hr_editor(user)
    forms = []
    for template_id in EDITABLE_TEMPLATE_IDS:
        document = await fetch_template_document(request.app.state.templates_container, template_id)
        if document is not None:
            forms.append(_form_editor_response(document))
    return {"forms": forms}


@app.get("/api/hr/forms/{template_id}/questions/{question_number}/has-answers")
async def get_question_has_answers(
    template_id: int,
    question_number: int,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    # Asked by the edit dialog when it opens, so it can lock the Type field
    # up front instead of HR finding out on Save — update_form_question below
    # still enforces the same rule.
    user = _get_current_user(authorization)
    _require_hr_editor(user)
    document = await _load_editable_template(request, template_id)
    _find_question(document, question_number)
    has_answers = await question_has_answers(
        request.app.state.submissions_container,
        request.app.state.drafts_container,
        template_id,
        question_number,
    )
    return {"has_answers": has_answers}


@app.post("/api/hr/forms/{template_id}/questions")
async def add_form_question(
    template_id: int,
    payload: FormQuestionRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)
    _require_hr_editor(user)
    if _is_system_question_text(template_id, payload.question.strip()):
        raise HTTPException(status_code=400, detail="That question name is reserved by the system.")

    document = await _load_editable_template(request, template_id)
    question = _build_question(payload)
    if "order" not in question:
        question["order"] = max((q["order"] for q in document["questions"]), default=0) + 1
    question["question_number"] = document["next_question_number"]
    document["next_question_number"] += 1
    document["questions"].append(question)
    return await _save_template(request, document)


@app.put("/api/hr/forms/{template_id}/questions/{question_number}")
async def update_form_question(
    template_id: int,
    question_number: int,
    payload: FormQuestionRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)
    _require_hr_editor(user)

    document = await _load_editable_template(request, template_id)
    existing = _find_question(document, question_number)
    if _is_system_question_text(template_id, existing.get("question")):
        # System questions may only be moved (order/section).
        if payload.question.strip() != existing["question"] or payload.type != existing.get("type"):
            raise HTTPException(
                status_code=400, detail="This system question can be moved, but its text and type can't be changed."
            )
        # Everything else stays exactly as stored — not re-validated through
        # _build_question, since e.g. "Review Period" is a radio whose options
        # are generated at load time (_load_questions) and may not be stored.
        updated = dict(existing)
        updated["section"] = payload.section.strip()
        if payload.order is not None:
            updated["order"] = payload.order
    elif _is_system_question_text(template_id, payload.question.strip()):
        raise HTTPException(status_code=400, detail="That question name is reserved by the system.")
    else:
        # Answers are stored in a shape that depends on the type (text, date,
        # number, project list...), so once any exist the type is fixed.
        if payload.type != existing.get("type") and await question_has_answers(
            request.app.state.submissions_container,
            request.app.state.drafts_container,
            template_id,
            question_number,
        ):
            raise HTTPException(
                status_code=409,
                detail="This question already has answers, so its type can't be changed. Add a new question instead.",
            )
        updated = _build_question(payload, base=existing)
    updated["question_number"] = question_number
    document["questions"] = [
        updated if q.get("question_number") == question_number else q for q in document["questions"]
    ]
    return await _save_template(request, document)


@app.delete("/api/hr/forms/{template_id}/questions/{question_number}")
async def delete_form_question(
    template_id: int,
    question_number: int,
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    user = _get_current_user(authorization)
    _require_hr_editor(user)

    document = await _load_editable_template(request, template_id)
    existing = _find_question(document, question_number)
    if _is_system_question_text(template_id, existing.get("question")):
        raise HTTPException(status_code=400, detail="This system question can't be deleted.")
    # Removed from the stored template outright. Answers already saved
    # against this number stay in their submissions/drafts but are no longer
    # shown, and the number is never reused (see next_question_number).
    document["questions"] = [q for q in document["questions"] if q.get("question_number") != question_number]
    return await _save_template(request, document)
