import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from azure.core import MatchConditions
from azure.cosmos.exceptions import CosmosHttpResponseError, CosmosResourceNotFoundError


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_namespace(item: Optional[dict]) -> Optional[SimpleNamespace]:
    # Cosmos returns plain dicts; wrapping in SimpleNamespace preserves every
    # existing `row.field` access in main.py that pyodbc's Row objects used
    # to support, so callers didn't need to change.
    return SimpleNamespace(**item) if item is not None else None


async def fetch_user_by_email(users_container, email: str):
    # id == partition key == work_email (lower-cased) by design (see
    # cosmos_client.py container setup) — this is a true point read, the
    # hottest path in the app (resolves the JWT caller on EVERY request,
    # including login) — so a transient failure here fails the entire
    # request. Retried once on a transient Cosmos error (throttling/network
    # blip) before giving up, same reasoning the original Azure SQL
    # connection helper retried once on a dropped connection: a fresh
    # attempt immediately after typically succeeds.
    email = email.lower()
    last_error: Optional[CosmosHttpResponseError] = None
    for attempt in range(2):
        try:
            item = await users_container.read_item(item=email, partition_key=email)
            return _as_namespace(item)
        except CosmosResourceNotFoundError:
            return None
        except CosmosHttpResponseError as exc:
            last_error = exc
            if attempt == 0:
                await asyncio.sleep(0.3)
    raise last_error


async def fetch_user_by_employee_id(users_container, employee_id: str):
    # employee_id isn't the partition key, so this is a cross-partition
    # scan — acceptable given it's not called on every request.
    query = "SELECT * FROM c WHERE c.employee_id = @employee_id"
    params = [{"name": "@employee_id", "value": employee_id}]
    async for item in users_container.query_items(query=query, parameters=params):
        return _as_namespace(item)
    return None


async def fetch_all_employees(users_container, exclude_email: str):
    query = "SELECT * FROM c WHERE c.work_email != @exclude_email"
    params = [{"name": "@exclude_email", "value": exclude_email.lower()}]
    return [_as_namespace(item) async for item in users_container.query_items(query=query, parameters=params)]


async def fetch_users_by_designation(users_container, designation: str):
    # Cross-partition scan — resolves who to notify for a given review
    # stage (see submit_form's notification queueing in main.py), not a hot
    # path, so this isn't optimized beyond what fetch_all_employees above
    # already does the same way.
    query = "SELECT * FROM c WHERE c.designation = @designation"
    params = [{"name": "@designation", "value": designation}]
    return [_as_namespace(item) async for item in users_container.query_items(query=query, parameters=params)]


async def fetch_assigned_employees(users_container, manager_employee_id: str):
    # "Get my reports": every user whose own assigned_employees array names
    # this manager's employee_id. ARRAY_CONTAINS is Cosmos's native
    # equivalent of the old CROSS APPLY OPENJSON containment check — missing
    # or empty assigned_employees fields simply don't match, no ISJSON-style
    # guard needed since Cosmos is schemaless.
    query = "SELECT * FROM c WHERE ARRAY_CONTAINS(c.assigned_employees, @manager_employee_id)"
    params = [{"name": "@manager_employee_id", "value": manager_employee_id}]
    return [_as_namespace(item) async for item in users_container.query_items(query=query, parameters=params)]


async def fetch_employees_managed_by(users_container, manager_employee_id: str):
    # Same containment check as fetch_assigned_employees, used only when
    # deleting an employee (see delete_employee below) to find every other
    # employee who lists that employee_id as a manager.
    query = "SELECT * FROM c WHERE ARRAY_CONTAINS(c.assigned_employees, @manager_employee_id)"
    params = [{"name": "@manager_employee_id", "value": manager_employee_id}]
    return [_as_namespace(item) async for item in users_container.query_items(query=query, parameters=params)]


async def insert_employee(
    users_container,
    name: str,
    work_email: str,
    employee_id: str,
    designation: str,
    department: str,
    location: str,
    assigned_employees: Optional[List[str]],
):
    work_email = work_email.lower()
    await users_container.create_item(
        body={
            "id": work_email,
            "work_email": work_email,
            "employee_id": employee_id,
            "name": name,
            "designation": designation,
            "department": department,
            "location": location,
            "password_hash": None,
            "assigned_employees": assigned_employees or [],
        }
    )


async def update_employee(
    users_container,
    employee_id: str,
    name: str,
    work_email: str,
    designation: str,
    department: str,
    location: str,
    assigned_employees: Optional[List[str]],
):
    # employee_id isn't the partition key, so the document (and its current
    # work_email, which IS the partition key) must be resolved first.
    existing = await fetch_user_by_employee_id(users_container, employee_id)
    work_email = work_email.lower()
    item = {
        "id": work_email,
        "work_email": work_email,
        "employee_id": employee_id,
        "name": name,
        "designation": designation,
        "department": department,
        "location": location,
        "password_hash": existing.password_hash if existing is not None else None,
        "assigned_employees": assigned_employees or [],
    }
    if existing is not None and existing.work_email != work_email:
        # Partition key changed — Cosmos can't move an item between logical
        # partitions in place, so this is a delete-and-recreate under the
        # new id/partition key rather than a replace_item.
        await users_container.delete_item(item=existing.work_email, partition_key=existing.work_email)
    await users_container.upsert_item(body=item)


async def delete_employee(users_container, employee_id: str):
    existing = await fetch_user_by_employee_id(users_container, employee_id)
    if existing is not None:
        await users_container.delete_item(item=existing.work_email, partition_key=existing.work_email)


async def update_assigned_employees(users_container, employee_id: str, assigned_employees: Optional[List[str]]):
    existing = await fetch_user_by_employee_id(users_container, employee_id)
    if existing is None:
        return
    item = dict(vars(existing))
    item["assigned_employees"] = assigned_employees or []
    await users_container.replace_item(item=item["id"], body=item)


async def fetch_form_by_template_id(templates_cache: Dict[int, dict], template_id: int):
    # Templates are static and loaded once at startup (see
    # cosmos_client.py::_load_templates_cache) — this is a dict lookup, not
    # a Cosmos round trip.
    return _as_namespace(templates_cache.get(template_id))


async def fetch_template_document(templates_container, template_id: int) -> Optional[dict]:
    # Fresh read straight from Cosmos (not the templates cache) — used by
    # HR's form editor (see the /api/hr/forms endpoints in main.py) so an
    # edit always starts from the latest stored version, even if another
    # worker's cache hasn't refreshed yet. Raw dict, since it's written back
    # whole by replace_template_document below.
    query = "SELECT * FROM c WHERE c.template_id = @template_id"
    params = [{"name": "@template_id", "value": template_id}]
    async for item in templates_container.query_items(query=query, parameters=params):
        return item
    return None


async def replace_template_document(templates_container, document: dict) -> dict:
    # Whole-document replace; the partition key is read from the document
    # itself. Returns the stored version so callers can refresh their cache.
    # Conditional on the _etag the document was read with: if someone else
    # saved this form in between, Cosmos rejects the write
    # (CosmosAccessConditionFailedError) instead of silently overwriting
    # their change — see _save_template in main.py.
    etag = document.get("_etag")
    if etag:
        return await templates_container.replace_item(
            item=document["id"], body=document, etag=etag, match_condition=MatchConditions.IfNotModified
        )
    return await templates_container.replace_item(item=document["id"], body=document)


async def question_has_answers(
    submissions_container, drafts_container, template_id: int, question_number: int
) -> bool:
    # Whether any submission or draft of this form has an answer stored under
    # this question number — used to stop HR changing a question's type once
    # answers exist (an old answer of a different shape would no longer
    # display or reload correctly). Cross-partition, but TOP 1 stops at the
    # first match. question_number is an int, so building the property path
    # from it is safe.
    query = f'SELECT TOP 1 c.id FROM c WHERE c.template_id = @template_id AND IS_DEFINED(c.answers["{int(question_number)}"])'
    params = [{"name": "@template_id", "value": template_id}]
    for container in (submissions_container, drafts_container):
        async for _ in container.query_items(query=query, parameters=params):
            return True
    return False


def _submission_id(template_id: int, review_period_id: Optional[str]) -> str:
    # Submissions (including the Overall Review) are scoped one-per-review-
    # period. Identity is server-authoritative: callers always pass the
    # server's own current-period id (main.py's _review_period_id_for_
    # template), never anything parsed from client-submitted answers. The
    # falsy-id fallback below is unreachable today (every template resolves
    # a real period id) — kept only in case a future template genuinely
    # needs a one-time, period-agnostic id the way the Overall Review used to.
    return f"{template_id}_{review_period_id}" if review_period_id else str(template_id)


async def insert_form_submission(
    submissions_container,
    template_id: int,
    employee_email: str,
    employee_name: str,
    answers: Dict[str, Any],
    review_period_id: Optional[str] = None,
    actor_name: Optional[str] = None,
    scoring: Optional[Dict[str, Any]] = None,
):
    employee_email = employee_email.lower()
    submitted_at = _now_iso()
    first_event: Dict[str, Any] = {"event": "submitted", "at": submitted_at}
    # actor_name is the CALLER (whoever is logged in and submitting), not
    # employee_name above (who the review is ABOUT) — the two are the same
    # person for a Self Assessment, but different for e.g. a Manager
    # Evaluation, where the manager submits about their report.
    if actor_name:
        first_event["by"] = actor_name
    await submissions_container.create_item(
        body={
            "id": _submission_id(template_id, review_period_id),
            "template_id": template_id,
            "review_period_id": review_period_id,
            "employee_email": employee_email,
            "employee_name": employee_name,
            "answers": answers,
            "submitted_at": submitted_at,
            # Append-only log of everything that's happened to this
            # submission (submitted/resubmitted/rejected/approved), so a
            # later rejection or resubmission never has to erase what came
            # before it — unlike approval_status/by/at below, which only
            # ever reflect the CURRENT decision and do get overwritten/
            # cleared.
            "history": [first_event],
            # Manager/HR Review only: points earned per question and totals,
            # worked out from the form's points at submit time (see
            # _score_submission in main.py) — None for unscored forms.
            **({"scoring": scoring} if scoring is not None else {}),
        }
    )


async def update_form_submission(
    submissions_container,
    template_id: int,
    employee_email: str,
    answers: Dict[str, Any],
    review_period_id: Optional[str] = None,
    actor_name: Optional[str] = None,
    scoring: Optional[Dict[str, Any]] = None,
):
    employee_email = employee_email.lower()
    item = await submissions_container.read_item(
        item=_submission_id(template_id, review_period_id), partition_key=employee_email
    )
    item["answers"] = answers
    # Re-scored from the new answers with the form's current points.
    if scoring is not None:
        item["scoring"] = scoring
    item["submitted_at"] = _now_iso()
    # A resubmission invalidates whatever approval decision was made against
    # the PREVIOUS answers — most relevantly, this is what actually reopens a
    # rejected Manager Evaluation for re-review once the manager fixes it
    # (see set_submission_approval below and submit_form in main.py).
    item.pop("approval_status", None)
    item.pop("approval_by", None)
    item.pop("approval_at", None)
    # Unlike the three fields above, history is append-only — a resubmission
    # adds a new "resubmitted" entry rather than erasing the earlier
    # rejection, so History can show the full sequence (e.g. Submitted ->
    # Rejected -> Resubmitted -> Approved). This function is only ever called
    # for an already-existing submission (see submit_form in main.py's
    # insert-vs-update branch), so "resubmitted" — distinct from
    # insert_form_submission's initial "submitted" — is always correct here.
    # setdefault covers documents created before this field existed.
    event: Dict[str, Any] = {"event": "resubmitted", "at": item["submitted_at"]}
    if actor_name:
        event["by"] = actor_name
    item.setdefault("history", []).append(event)
    await submissions_container.replace_item(item=item["id"], body=item)


def _draft_id(template_id: int, review_period_id: Optional[str]) -> str:
    # Same addressing scheme as _submission_id — a draft and the submission
    # it'll eventually become are always the same (template_id,
    # review_period_id, employee_email) triple, just in different
    # containers.
    return f"{template_id}_{review_period_id}" if review_period_id else str(template_id)


async def upsert_draft(
    drafts_container,
    template_id: int,
    employee_email: str,
    answers: Dict[str, Any],
    review_period_id: Optional[str] = None,
) -> None:
    # Disposable autosave data — no history/approval fields, and no
    # insert-vs-update branch like insert_form_submission/
    # update_form_submission: every save just overwrites whatever draft (if
    # any) already existed.
    employee_email = employee_email.lower()
    await drafts_container.upsert_item(
        body={
            "id": _draft_id(template_id, review_period_id),
            "template_id": template_id,
            "review_period_id": review_period_id,
            "employee_email": employee_email,
            "answers": answers,
            "updated_at": _now_iso(),
        }
    )


async def fetch_draft(
    drafts_container, template_id: int, employee_email: str, review_period_id: Optional[str] = None
):
    try:
        item = await drafts_container.read_item(
            item=_draft_id(template_id, review_period_id), partition_key=employee_email.lower()
        )
    except CosmosResourceNotFoundError:
        return None
    return _as_namespace(item)


async def delete_draft(
    drafts_container, template_id: int, employee_email: str, review_period_id: Optional[str] = None
) -> None:
    # Called once a real submission exists for this same (template_id,
    # review_period_id, employee_email) — the draft's job is done. Not an
    # error if there was never a draft to begin with (e.g. the form was
    # filled out and submitted in one sitting, faster than the debounce ever
    # fired).
    try:
        await drafts_container.delete_item(
            item=_draft_id(template_id, review_period_id), partition_key=employee_email.lower()
        )
    except CosmosResourceNotFoundError:
        pass


async def set_submission_approval(
    submissions_container,
    template_id: int,
    employee_email: str,
    review_period_id: Optional[str],
    status: str,
    actor_name: str,
    reason: Optional[str] = None,
):
    # HR/CDO's decision on an already-submitted evaluation — currently only
    # used for the Manager Evaluation (see set_form_approval in main.py).
    # Additive fields on the same submission document rather than a new
    # container, since this is metadata about that one submission, not a
    # submission in its own right.
    employee_email = employee_email.lower()
    item = await submissions_container.read_item(
        item=_submission_id(template_id, review_period_id), partition_key=employee_email
    )
    approval_at = _now_iso()
    item["approval_status"] = status
    item["approval_by"] = actor_name
    item["approval_at"] = approval_at
    # reason is only ever collected for a rejection today (see
    # set_form_approval in main.py) — omitted from the history entry
    # entirely when absent, rather than stored as an empty/null "reason",
    # so the frontend never has to special-case a blank reason itself.
    event: Dict[str, Any] = {"event": status, "at": approval_at, "by": actor_name}
    if reason:
        event["reason"] = reason
    item.setdefault("history", []).append(event)
    await submissions_container.replace_item(item=item["id"], body=item)


async def fetch_submission(
    submissions_container, template_id: int, employee_email: str, review_period_id: Optional[str] = None
):
    # (template_id, review_period_id, employee_email) is the item's (id,
    # partition key) — a true point read.
    try:
        item = await submissions_container.read_item(
            item=_submission_id(template_id, review_period_id), partition_key=employee_email.lower()
        )
    except CosmosResourceNotFoundError:
        return None
    return _as_namespace(item)


async def fetch_submissions_for_template(submissions_container, template_id: int) -> List[dict]:
    # Every submission of one form, org-wide and across all periods — used to
    # re-score open reviews after HR changes the form's points (see
    # _rescore_open_submissions in main.py). Cross-partition, but only run on
    # a form edit, never on a normal page load.
    query = "SELECT * FROM c WHERE c.template_id = @template_id"
    params = [{"name": "@template_id", "value": template_id}]
    return [item async for item in submissions_container.query_items(query=query, parameters=params)]


async def set_submission_scoring(submissions_container, item: dict, scoring: Dict[str, Any]) -> None:
    # Replaces only the stored scoring of an already-read submission document
    # (answers, history and approval are untouched).
    item["scoring"] = scoring
    await submissions_container.replace_item(item=item["id"], body=item)


async def fetch_review_period_ids(submissions_container) -> List[str]:
    # Every review period that has at least one submission, org-wide — feeds
    # the HR Dashboard's period selector (see get_hr_employees in main.py).
    # Cross-partition scan, but only one small field per document and only
    # called once per dashboard load. De-duplicated here as well as by
    # DISTINCT, since cross-partition DISTINCT can return a value once per
    # partition range.
    query = "SELECT DISTINCT VALUE c.review_period_id FROM c"
    seen = set()
    async for value in submissions_container.query_items(query=query):
        if value:
            seen.add(value)
    return list(seen)


async def fetch_submissions_for_period(
    submissions_container, review_period_id: str
) -> Dict[str, Dict[int, SimpleNamespace]]:
    # Every employee's 1001/1002/1003/1004 submissions for one review period,
    # in ONE cross-partition query — returned as
    # {employee_email (lower-cased): {template_id: submission}}. Used by
    # get_hr_employees, which previously ran one single-partition query per
    # employee in sequence: ~80 back-to-back round trips for the whole roster
    # (measured at 2.2-2.5 s in the Nov 2026 load test), growing with
    # headcount. A submission's id is "{template_id}_{review_period_id}"
    # within its employee_email partition, so filtering to one period leaves
    # at most one document per (employee, template) and the inner dict can't
    # collide.
    query = "SELECT * FROM c WHERE c.review_period_id = @review_period_id"
    params = [{"name": "@review_period_id", "value": review_period_id}]
    by_employee: Dict[str, Dict[int, SimpleNamespace]] = {}
    async for item in submissions_container.query_items(query=query, parameters=params):
        by_employee.setdefault(item["employee_email"].lower(), {})[item["template_id"]] = _as_namespace(item)
    return by_employee
