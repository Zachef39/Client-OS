#!/usr/bin/env python3
"""
Faerber Client OS — Monday.com Coach Board sync.

Pulls every client item from the Coach Board (8896739421), extracts:
  - Status (color_mkpv34wt)
  - Programmed To date (date_mkqvn4qe)
  - Notes text (text_mkpqvyd4)
  - Notes Doc object_id (doc_mm2sfz0d) → fetches doc markdown
  - Starting / current / goal weights + started date (regex-parsed from doc)

Writes everything to server/monday-clients.json so the dashboard at
localhost:3737 can render off Monday instead of Supabase.

Run from terminal:
  .venv/bin/python sync_monday_clients.py
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

# ── Config ──────────────────────────────────────────────────────────
COACH_BOARD_ID: int = 8896739421
NOTES_DOC_COLUMN_ID: str = "doc_mm2sfz0d"
STATUS_COLUMN_ID: str = "color_mkpv34wt"
PROGRAMMED_TO_COLUMN_ID: str = "date_mkqvn4qe"
NOTES_TEXT_COLUMN_ID: str = "text_mkpqvyd4"

PAGE_SIZE: int = 100
PAST_STATUSES: tuple[str, ...] = ("Paused", "Expired")

ENV_PATH = Path("/Users/zachef/Desktop/Playground - Claude/.env")
OUTPUT_PATH = (
    Path(__file__).resolve().parent / "server" / "monday-clients.json"
)
MONDAY_API_URL = "https://api.monday.com/v2"
TRAINERIZE_API_URL = "https://api.trainerize.com/v03"
TRAINERIZE_PAGE_SIZE: int = 200
# Trainerize /calendar/getList caps each call at <1 year. We chunk into windows
# of just under 365 days and walk backward up to TRAINERIZE_BACKFILL_MAX_YEARS.
TRAINERIZE_BACKFILL_WINDOW_DAYS: int = 360
TRAINERIZE_BACKFILL_MAX_YEARS: int = 3
TRAINERIZE_PER_CLIENT_SLEEP_S: float = 0.05

logging.basicConfig(
    format="%(message)s",
    level=logging.INFO,
    stream=sys.stdout,
)
log = logging.getLogger("sync_monday_clients")


# ── Data shape ──────────────────────────────────────────────────────
@dataclass
class ClientRecord:
    monday_item_id: str
    name: str
    status: str | None = None
    starting_weight_lbs: float | None = None
    current_weight_lbs: float | None = None
    goal_weight_lbs: float | None = None
    started_at: str | None = None
    programmed_to: str | None = None
    notes_short: str | None = None
    doc_object_id: str | None = None
    trainerize_user_id: str | None = None
    weight_change_lbs: float | None = None
    is_past: bool = False
    is_active_in_trainerize: bool = False
    # Compliance fields (active clients only — computed from Trainerize last 7d)
    auto_flag: str | None = None
    workouts_completed_7d: int | None = None
    workouts_scheduled_7d: int | None = None
    workouts_missed_7d: int | None = None
    days_logged_7d: int | None = None
    avg_protein_7d: float | None = None
    protein_goal_g: float | None = None
    workout_pct: float | None = None
    log_pct: float | None = None
    protein_pct: float | None = None
    last_weighin_date: str | None = None
    # Week-over-week weight trend (computed from Trainerize bodyStat history)
    weight_lbs_prev_week: float | None = None
    weight_change_lbs_7d: float | None = None
    goal_direction: str | None = None  # "loss" | "gain" | "maintain"
    trend_direction: str | None = None  # "down" | "up" | "flat"
    trend_aligned_with_goal: bool | None = None
    trend_downgrade: bool = False
    # Provenance flags (not serialized) — track which fields came from the Notes Doc
    # so the Trainerize backfill can win over the Monday `created_at` fallback but
    # never overwrite a value the Notes Doc set explicitly.
    started_at_from_doc: bool = field(default=False, repr=False)
    starting_weight_from_doc: bool = field(default=False, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "monday_item_id": self.monday_item_id,
            "trainerize_user_id": self.trainerize_user_id,
            "name": self.name,
            "status": self.status,
            "starting_weight_lbs": self.starting_weight_lbs,
            "current_weight_lbs": self.current_weight_lbs,
            "goal_weight_lbs": self.goal_weight_lbs,
            "started_at": self.started_at,
            "programmed_to": self.programmed_to,
            "notes_short": self.notes_short,
            "doc_object_id": self.doc_object_id,
            "weight_change_lbs": self.weight_change_lbs,
            "is_past": self.is_past,
            "is_active_in_trainerize": self.is_active_in_trainerize,
            "auto_flag": self.auto_flag,
            "workouts_completed_7d": self.workouts_completed_7d,
            "workouts_scheduled_7d": self.workouts_scheduled_7d,
            "workouts_missed_7d": self.workouts_missed_7d,
            "days_logged_7d": self.days_logged_7d,
            "avg_protein_7d": self.avg_protein_7d,
            "protein_goal_g": self.protein_goal_g,
            "workout_pct": self.workout_pct,
            "log_pct": self.log_pct,
            "protein_pct": self.protein_pct,
            "last_weighin_date": self.last_weighin_date,
            "weight_lbs_prev_week": self.weight_lbs_prev_week,
            "weight_change_lbs_7d": self.weight_change_lbs_7d,
            "goal_direction": self.goal_direction,
            "trend_direction": self.trend_direction,
            "trend_aligned_with_goal": self.trend_aligned_with_goal,
            "trend_downgrade": self.trend_downgrade,
        }


@dataclass
class ParseStats:
    total: int = 0
    skipped_past: int = 0
    docs_fetched: int = 0
    docs_failed: int = 0
    has_start: int = 0
    has_current: int = 0
    has_goal: int = 0
    has_started_date: int = 0
    parse_failures: list[str] = field(default_factory=list)
    # Trainerize backfill stats
    tz_eligible: int = 0
    tz_name_matched: int = 0
    tz_name_unmatched: int = 0
    tz_bodystats_fetched: int = 0
    tz_bodystats_failed: int = 0
    tz_zero_bodystats: int = 0
    tz_backfilled_starting: int = 0
    tz_backfilled_current: int = 0
    tz_backfilled_started_at: int = 0
    tz_failures: list[str] = field(default_factory=list)
    # Active-status gating stats
    tz_active_clients: int = 0
    tz_demoted_to_past: int = 0
    tz_active_but_monday_past: int = 0
    tz_demotion_examples: list[str] = field(default_factory=list)
    # Compliance / RAG stats
    flag_red: int = 0
    flag_yellow: int = 0
    flag_green: int = 0
    flag_onboarding: int = 0
    flag_ghosting: int = 0
    compliance_failures: list[str] = field(default_factory=list)
    # Weight-trend stats
    trend_with_data: int = 0
    trend_aligned: int = 0
    trend_misaligned: int = 0
    trend_flat: int = 0
    trend_downgrades: int = 0


# ── Monday API ──────────────────────────────────────────────────────
class MondayClient:
    """Thin Monday GraphQL client. Honors the token-as-Authorization-header pattern."""

    def __init__(self, token: str) -> None:
        if not token:
            raise RuntimeError("MONDAY_API_TOKEN is empty")
        self._token = token
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Content-Type": "application/json",
                "Authorization": token,  # raw token, no "Bearer " prefix
                "API-Version": "2024-01",
            }
        )

    def query(self, query: str, retries: int = 3) -> dict[str, Any]:
        for attempt in range(retries):
            try:
                res = self._session.post(
                    MONDAY_API_URL, json={"query": query}, timeout=30
                )
                if res.status_code >= 500:
                    raise requests.HTTPError(f"{res.status_code}: {res.text[:200]}")
                data = res.json()
                if data.get("errors"):
                    # Many "errors" surface as soft errors with partial data — return as-is
                    return data
                return data
            except (requests.RequestException, ValueError) as e:
                if attempt + 1 >= retries:
                    raise
                wait = 1.5 * (attempt + 1)
                log.warning("  Monday query retry %s after %s", attempt + 1, e)
                time.sleep(wait)
        return {}


# ── Trainerize API ─────────────────────────────────────────────────
class TrainerizeClient:
    """Thin Trainerize v03 client. Basic-auth with base64(group_id:token)."""

    def __init__(self, group_id: str, api_token: str) -> None:
        if not group_id or not api_token:
            raise RuntimeError("TRAINERIZE_GROUP_ID / TRAINERIZE_API_TOKEN missing")
        basic = base64.b64encode(f"{group_id}:{api_token}".encode("utf-8")).decode("ascii")
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/json",
            }
        )

    def post(self, path: str, body: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
        url = f"{TRAINERIZE_API_URL}{path}"
        res = self._session.post(url, json=body, timeout=timeout)
        if res.status_code >= 500:
            raise requests.HTTPError(f"{res.status_code}: {res.text[:200]}")
        if not res.ok:
            raise requests.HTTPError(f"{res.status_code}: {res.text[:200]}")
        try:
            return res.json()
        except ValueError as exc:
            raise requests.HTTPError(f"non-JSON response: {res.text[:200]}") from exc

    def get_all_users(self) -> list[dict[str, Any]]:
        """Paginate /user/getList. Returns full user list (active + inactive, all types)."""
        users: list[dict[str, Any]] = []
        start = 0
        while True:
            data = self.post("/user/getList", {"start": start, "count": TRAINERIZE_PAGE_SIZE})
            batch = data.get("users") or []
            users.extend(batch)
            total = data.get("total") or 0
            if not batch or len(users) >= total:
                break
            start += TRAINERIZE_PAGE_SIZE
        return users

    def get_calendar(self, user_id: int | str, start_date: str, end_date: str) -> dict[str, Any]:
        return self.post(
            "/calendar/getList",
            {"userID": user_id, "startDate": start_date, "endDate": end_date},
        )

    def get_daily_nutrition(
        self, user_id: int | str, start_date: str, end_date: str
    ) -> dict[str, Any]:
        return self.post(
            "/dailyNutrition/getList",
            {"userID": user_id, "startDate": start_date, "endDate": end_date},
        )

    def get_meal_plan(self, user_id: int | str) -> dict[str, Any]:
        return self.post("/mealPlan/get", {"userID": user_id})

    def get_nutrition_goal(self, user_id: int | str) -> dict[str, Any]:
        return self.post("/goal/getNutrition", {"userID": user_id})


# ── Trainerize name matching ───────────────────────────────────────
_PAREN_PATTERN = re.compile(r"\([^)]*\)")
# Strip everything after a ` - ` separator (descriptors like "- 45 Call", "- Husband")
_DASH_SUFFIX_PATTERN = re.compile(r"\s+-\s+.*$")
# Strip emoji + most non-letter symbols; keep ASCII letters, digits, whitespace, apostrophes
# (diacritics get folded to ASCII by _strip_diacritics before this runs)
_NON_NAME_CHARS = re.compile(r"[^A-Za-z0-9\s']")


def _strip_diacritics(s: str) -> str:
    """Unicode NFKD → drop combining marks. e.g. Muñoz → Munoz."""
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _normalize_name(raw: str) -> str:
    """Strip parentheticals, dash-suffixes, diacritics, emoji; lowercase; collapse whitespace."""
    if not raw:
        return ""
    s = _PAREN_PATTERN.sub(" ", raw)
    s = _DASH_SUFFIX_PATTERN.sub("", s)
    s = _strip_diacritics(s)
    s = _NON_NAME_CHARS.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _split_concat_tokens(token: str) -> list[str]:
    """Split a glued token like 'kellyann' into ['kelly', 'ann'] using CamelCase hints.

    Operates on the raw (pre-lowercased) string. Used only on first names where
    Monday spells them apart but Trainerize concatenates (or vice versa).
    """
    # If the token already has internal capitals (KellyAnn), split there.
    parts = re.findall(r"[A-Z][a-z]+|[a-z]+", token)
    return [p.lower() for p in parts] if parts else [token.lower()]


# Nickname → real first-name aliases for Monday display names that don't match
# the Trainerize account's first name. Add new entries as you discover them.
NICKNAME_ALIASES: dict[str, str] = {
    "bob": "robert",
    "matt": "matthew",
    "kiki": "christine",
}


def _apply_nickname_alias(name: str) -> str:
    """Replace a leading nickname token with its canonical first name."""
    parts = name.split()
    if not parts:
        return name
    first = parts[0].lower()
    canonical = NICKNAME_ALIASES.get(first)
    if not canonical:
        return name
    return " ".join([canonical] + parts[1:])


def _build_tz_user_index(users: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """Return list of (normalized_full_name, user) tuples.

    Also splits CamelCase first names (e.g. KellyAnn → Kelly Ann) so the matcher
    can resolve Monday names that use space-separated tokens for those.
    """
    index: list[tuple[str, dict[str, Any]]] = []
    for u in users:
        first_raw = (u.get("firstName") or "").strip()
        last_raw = (u.get("lastName") or "").strip()
        # Expand CamelCase first names (KellyAnn → kelly ann) before joining
        first_tokens = _split_concat_tokens(first_raw) if first_raw else []
        first_expanded = " ".join(first_tokens) if first_tokens else first_raw
        full = f"{first_expanded} {last_raw}".strip()
        if not full:
            full = (u.get("name") or "").strip()
        if not full:
            continue
        norm = _normalize_name(full)
        if norm:
            index.append((norm, u))
    return index


_TRACE_MATCH = os.environ.get("TRACE_MATCH", "").strip().lower() in ("1", "true", "yes", "on")


def _user_label(u: dict[str, Any]) -> str:
    """Compact identifier used by TRACE_MATCH logs."""
    first = (u.get("firstName") or "").strip()
    last = (u.get("lastName") or "").strip()
    name = f"{first} {last}".strip() or (u.get("name") or "").strip() or "?"
    uid = u.get("id") or u.get("userID") or u.get("userId") or "?"
    return f"{name} (id={uid})"


def match_trainerize_user(
    monday_name: str,
    user_index: list[tuple[str, dict[str, Any]]],
) -> dict[str, Any] | None:
    """Match Monday item name to a Trainerize user via case-insensitive substring.

    Strategy (in order):
      1. Exact normalized match — always wins (no ambiguity possible after dedupe).
      2. Token-overlap candidates (every token of shorter side present in longer).
      3. First-name-only fallback — requires EXACTLY one TZ user has that first
         name AND that user's last-name initial matches the Monday last initial
         (so "Jessica Linkin" only matches TZ "Jessica L..." users, not arbitrary
         single-first-name TZ users).

    Ambiguity rule:
      If >=2 distinct TZ candidates survive, return None. We never silently pick
      the "longest" — that collision was the root cause of the 3-Jessicas bug
      where one short-named TZ user got assigned to multiple Monday rows.

    Set env var TRACE_MATCH=1 to log per-name decisions.
    """
    target = _normalize_name(monday_name)
    if not target:
        if _TRACE_MATCH:
            print(f"[TRACE_MATCH] {monday_name!r}: empty after normalize → None")
        return None

    # Apply nickname alias (Bob → Robert, Matt → Matthew, Kiki → Christine, etc.)
    target_aliased = _apply_nickname_alias(target)

    # Exact match wins immediately (original or alias-applied)
    exact_hits: list[dict[str, Any]] = []
    for norm, user in user_index:
        if norm == target or norm == target_aliased:
            exact_hits.append(user)
    if exact_hits:
        # Deduplicate by user id — same TZ user can appear twice if firstName had
        # CamelCase expansion that re-collapsed to the same norm.
        seen_ids: set[Any] = set()
        unique_exact = []
        for u in exact_hits:
            uid = u.get("id") or u.get("userID") or u.get("userId")
            if uid in seen_ids:
                continue
            seen_ids.add(uid)
            unique_exact.append(u)
        if len(unique_exact) == 1:
            if _TRACE_MATCH:
                print(f"[TRACE_MATCH] {monday_name!r}: EXACT → {_user_label(unique_exact[0])}")
            return unique_exact[0]
        # Multiple distinct TZ users with the same normalized name — ambiguous.
        if _TRACE_MATCH:
            labels = ", ".join(_user_label(u) for u in unique_exact)
            print(f"[TRACE_MATCH] {monday_name!r}: AMBIGUOUS exact ({labels}) → None")
        return None

    # Use the aliased form for downstream substring/token matching
    target = target_aliased

    target_tokens = target.split()
    if not target_tokens:
        if _TRACE_MATCH:
            print(f"[TRACE_MATCH] {monday_name!r}: no target tokens → None")
        return None

    candidates: list[dict[str, Any]] = []
    seen_candidate_ids: set[Any] = set()

    def _maybe_add(user: dict[str, Any]) -> None:
        uid = user.get("id") or user.get("userID") or user.get("userId")
        if uid in seen_candidate_ids:
            return
        seen_candidate_ids.add(uid)
        candidates.append(user)

    for norm, user in user_index:
        if not norm:
            continue
        tz_tokens = norm.split()
        if not tz_tokens:
            continue
        # Token-overlap: every Monday token must appear in TZ tokens. We DO NOT
        # accept "TZ tokens ⊆ Monday tokens" (e.g. TZ "Jessica" ⊆ Monday
        # "Jessica Linkin") here — that path is what produced the 3-Jessicas
        # collision. The first-name-only fallback below handles legit
        # short-TZ-name matches with a strict last-initial guard.
        if len(target_tokens) <= len(tz_tokens):
            if all(t in tz_tokens for t in target_tokens):
                _maybe_add(user)
                continue
        # Substring as a softer fallback — only Monday-fully-contained-in-TZ
        # (catches "Anne-Marie" vs "Annemarie" style). Never the reverse.
        if target_tokens and target in norm and target != norm:
            _maybe_add(user)

    # First-name-only fallback: safe ONLY when EXACTLY one TZ user has that first
    # name AND that TZ user's last-name initial matches the Monday last initial.
    # Prevents "Jessica Linkin" matching TZ "Jessica Munoz".
    if not candidates and len(target_tokens) >= 2:
        target_first = target_tokens[0]
        target_last_initial = target_tokens[-1][:1]
        first_name_matches = [
            user for norm, user in user_index
            if norm.split() and norm.split()[0] == target_first
        ]
        if len(first_name_matches) == 1:
            only = first_name_matches[0]
            tz_last = (only.get("lastName") or "").strip().lower()
            tz_last = _strip_diacritics(tz_last)
            if tz_last and tz_last[:1] == target_last_initial:
                if _TRACE_MATCH:
                    print(
                        f"[TRACE_MATCH] {monday_name!r}: first+last-initial fallback "
                        f"→ {_user_label(only)}"
                    )
                return only
            if _TRACE_MATCH:
                print(
                    f"[TRACE_MATCH] {monday_name!r}: first-name fallback REJECTED "
                    f"(last initial mismatch; target={target_last_initial!r}, "
                    f"tz_last={tz_last!r}) → None"
                )
            return None

    if not candidates:
        if _TRACE_MATCH:
            print(f"[TRACE_MATCH] {monday_name!r}: no candidates → None")
        return None

    # Ambiguity guard — DO NOT silently pick "longest". A collision here means
    # multiple TZ users are plausible and we'd rather skip than wrong-assign.
    if len(candidates) >= 2:
        if _TRACE_MATCH:
            labels = ", ".join(_user_label(u) for u in candidates)
            print(f"[TRACE_MATCH] {monday_name!r}: AMBIGUOUS ({labels}) → None")
        return None

    if _TRACE_MATCH:
        print(f"[TRACE_MATCH] {monday_name!r}: matched → {_user_label(candidates[0])}")
    return candidates[0]


# ── Trainerize bodyStat extraction ─────────────────────────────────
def extract_bodystat_weights(calendar_data: dict[str, Any]) -> list[tuple[str, float]]:
    """Walk /calendar/getList response, return ascending [(date, weight_lbs), ...]."""
    out: list[tuple[str, float]] = []
    days = calendar_data.get("calendar") or []
    for day in days:
        day_date = day.get("date")
        for item in day.get("items") or []:
            if item.get("type") != "bodyStat":
                continue
            detail = item.get("detail") or {}
            weight = detail.get("weight")
            item_date = item.get("date") or day_date
            if weight is None or not item_date:
                continue
            try:
                weight_f = float(weight)
            except (TypeError, ValueError):
                continue
            if weight_f <= 0:
                continue
            out.append((str(item_date)[:10], weight_f))
    # Ascending by date
    out.sort(key=lambda pair: pair[0])
    return out


def fetch_bodystat_history(
    tz_client: TrainerizeClient,
    user_id: int | str,
    today: date,
    max_years: int = TRAINERIZE_BACKFILL_MAX_YEARS,
    window_days: int = TRAINERIZE_BACKFILL_WINDOW_DAYS,
) -> tuple[list[tuple[str, float]], int]:
    """Pull bodyStat weights walking backward in <1-year windows.

    Returns (sorted_weights, windows_called). Stops walking back once a window
    returns zero bodyStats AND we've already collected at least one — assumes
    the client's history is contiguous (or doesn't extend further back).
    """
    all_weights: list[tuple[str, float]] = []
    windows_called = 0
    end_date = today
    earliest_allowed = today - timedelta(days=365 * max_years)

    for _ in range(max_years + 1):
        if end_date <= earliest_allowed:
            break
        start_date = max(end_date - timedelta(days=window_days), earliest_allowed)
        if start_date >= end_date:
            break
        cal = tz_client.get_calendar(
            user_id, start_date.isoformat(), end_date.isoformat()
        )
        windows_called += 1
        weights = extract_bodystat_weights(cal)
        if weights:
            all_weights.extend(weights)
        else:
            # No data in this window — if we already have some data, assume
            # client started later; stop walking further back.
            if all_weights:
                break
        # Next window ends the day BEFORE this window started, no overlap.
        end_date = start_date - timedelta(days=1)

    # Dedup + sort ascending
    seen: set[tuple[str, float]] = set()
    deduped: list[tuple[str, float]] = []
    for d, w in all_weights:
        key = (d, round(w, 2))
        if key in seen:
            continue
        seen.add(key)
        deduped.append((d, w))
    deduped.sort(key=lambda pair: pair[0])
    return deduped, windows_called


# ── Compliance / RAG computation ───────────────────────────────────
_WORKOUT_TYPES = {"workoutRegular", "workoutInterval"}


def count_workouts_last_7d(calendar_data: dict[str, Any]) -> tuple[int, int]:
    """Walk /calendar/getList response. Return (completed, missed).

    completed: items where type ∈ workout types AND status == "tracked"
    missed   : items where type ∈ workout types AND status == "scheduled" (i.e.,
               past-date but not done — caller is responsible for only querying
               windows that end at "today")
    """
    completed = 0
    missed = 0
    days = calendar_data.get("calendar") or []
    for day in days:
        for item in day.get("items") or []:
            if item.get("type") not in _WORKOUT_TYPES:
                continue
            status = (item.get("status") or "").strip().lower()
            if status == "tracked":
                completed += 1
            elif status == "scheduled":
                missed += 1
    return completed, missed


def last_weighin_date_from_calendar(calendar_data: dict[str, Any]) -> str | None:
    """Return latest YYYY-MM-DD bodyStat date in the calendar window, or None."""
    latest: str | None = None
    days = calendar_data.get("calendar") or []
    for day in days:
        day_date = day.get("date")
        for item in day.get("items") or []:
            if item.get("type") != "bodyStat":
                continue
            d = (item.get("date") or day_date) or ""
            d = str(d)[:10]
            if not d:
                continue
            if latest is None or d > latest:
                latest = d
    return latest


def summarize_nutrition_7d(
    nutrition_data: dict[str, Any],
) -> tuple[int, float | None]:
    """Return (days_logged, avg_protein_g_or_None).

    Response key is `nutrition` (NOT `dailyNutritions` — Trainerize quirk).
    A day counts as "logged" iff calories > 0. Average protein is across logged
    days only.
    """
    days = nutrition_data.get("nutrition") or nutrition_data.get("dailyNutritions") or []
    days_logged = 0
    protein_sum = 0.0
    for day in days:
        try:
            cals = float(day.get("calories") or 0)
        except (TypeError, ValueError):
            cals = 0.0
        if cals <= 0:
            continue
        days_logged += 1
        try:
            p = float(day.get("proteinGrams") or 0)
        except (TypeError, ValueError):
            p = 0.0
        protein_sum += p
    if days_logged == 0:
        return 0, None
    return days_logged, round(protein_sum / days_logged, 1)


def fetch_protein_goal(
    tz_client: TrainerizeClient, user_id: int | str
) -> float | None:
    """Try /mealPlan/get first; fall back to /goal/getNutrition. Return None if neither."""
    try:
        plan = tz_client.get_meal_plan(user_id)
        if isinstance(plan, dict):
            # Some responses nest under "mealPlan"
            container = plan.get("mealPlan") if isinstance(plan.get("mealPlan"), dict) else plan
            goal = container.get("proteinGrams")
            if goal is not None:
                try:
                    g = float(goal)
                    if g > 0:
                        return g
                except (TypeError, ValueError):
                    pass
    except Exception:
        pass

    try:
        nut = tz_client.get_nutrition_goal(user_id)
        if isinstance(nut, dict):
            container = nut.get("goal") if isinstance(nut.get("goal"), dict) else nut
            goal = container.get("proteinGrams") or container.get("protein")
            if goal is not None:
                try:
                    g = float(goal)
                    if g > 0:
                        return g
                except (TypeError, ValueError):
                    pass
    except Exception:
        pass

    return None


def compute_auto_flag(
    started_at: str | None,
    today: date,
    workouts_completed: int,
    workouts_scheduled: int,
    days_logged: int,
    avg_protein: float | None,
    protein_goal: float | None,
) -> tuple[str, float | None, float, float | None]:
    """Return (auto_flag, workout_pct, log_pct, protein_pct).

    See task spec for thresholds.
    """
    # Days since start
    days_since_start: int | None = None
    if started_at:
        try:
            start_dt = datetime.strptime(started_at[:10], "%Y-%m-%d").date()
            days_since_start = (today - start_dt).days
        except (TypeError, ValueError):
            days_since_start = None

    # Compute percentages up-front so they get returned regardless of branch
    workout_pct: float | None = (
        (workouts_completed / workouts_scheduled) if workouts_scheduled > 0 else None
    )
    log_pct = days_logged / 7.0
    protein_pct: float | None = (
        (avg_protein / protein_goal)
        if (avg_protein is not None and protein_goal and protein_goal > 0)
        else None
    )

    if days_since_start is not None and days_since_start < 30:
        return "onboarding", workout_pct, log_pct, protein_pct

    if workouts_completed == 0 and days_logged == 0:
        return "ghosting", workout_pct, log_pct, protein_pct

    # If nothing scheduled, don't penalize the workout side
    effective_workout_pct = workout_pct if workout_pct is not None else 1.0

    if (
        effective_workout_pct < 0.5
        or log_pct < 0.4
        or (protein_pct is not None and protein_pct < 0.7)
    ):
        return "red", workout_pct, log_pct, protein_pct
    if (
        effective_workout_pct < 0.75
        or log_pct < 0.7
        or (protein_pct is not None and protein_pct < 0.85)
    ):
        return "yellow", workout_pct, log_pct, protein_pct
    return "green", workout_pct, log_pct, protein_pct


def compute_compliance_for_active_clients(
    records: list[ClientRecord],
    tz_client: TrainerizeClient,
    stats: ParseStats,
) -> None:
    """For every active client with a trainerize_user_id, pull last-7d activity
    + nutrition + protein goal, then compute auto_flag. Mutates records in place.
    """
    today = date.today()
    since = today - timedelta(days=7)
    since_iso = since.isoformat()
    today_iso = today.isoformat()

    for record in records:
        if record.is_past:
            continue
        if not record.trainerize_user_id:
            # Edge case: active but no TZ id (shouldn't happen post-backfill).
            continue

        user_id = record.trainerize_user_id

        # Workouts + last weigh-in date from calendar
        workouts_completed = 0
        workouts_missed = 0
        last_weighin: str | None = None
        try:
            cal = tz_client.get_calendar(user_id, since_iso, today_iso)
            workouts_completed, workouts_missed = count_workouts_last_7d(cal)
            last_weighin = last_weighin_date_from_calendar(cal)
        except Exception as exc:
            stats.compliance_failures.append(
                f"{record.name}: calendar fetch ({exc})"
            )

        workouts_scheduled = workouts_completed + workouts_missed

        # Nutrition (days logged + avg protein)
        days_logged = 0
        avg_protein: float | None = None
        try:
            nut = tz_client.get_daily_nutrition(user_id, since_iso, today_iso)
            days_logged, avg_protein = summarize_nutrition_7d(nut)
        except Exception as exc:
            stats.compliance_failures.append(
                f"{record.name}: nutrition fetch ({exc})"
            )

        # Protein goal (mealPlan → nutrition goal fallback)
        protein_goal: float | None = None
        try:
            protein_goal = fetch_protein_goal(tz_client, user_id)
        except Exception as exc:
            stats.compliance_failures.append(
                f"{record.name}: protein goal fetch ({exc})"
            )

        # Compute flag
        flag, workout_pct, log_pct, protein_pct = compute_auto_flag(
            record.started_at,
            today,
            workouts_completed,
            workouts_scheduled,
            days_logged,
            avg_protein,
            protein_goal,
        )

        # Write to record
        record.workouts_completed_7d = workouts_completed
        record.workouts_scheduled_7d = workouts_scheduled
        record.workouts_missed_7d = workouts_missed
        record.days_logged_7d = days_logged
        record.avg_protein_7d = avg_protein
        record.protein_goal_g = protein_goal
        record.workout_pct = (
            round(workout_pct, 2) if workout_pct is not None else None
        )
        record.log_pct = round(log_pct, 2)
        record.protein_pct = (
            round(protein_pct, 2) if protein_pct is not None else None
        )
        record.last_weighin_date = last_weighin

        # Trend-based downgrade: if the WoW trend is moving AWAY from the goal
        # AND the client is past onboarding (>30 days in), pull the flag down
        # one level (green → yellow, yellow → red, red stays red).
        days_since_start: int | None = None
        if record.started_at:
            try:
                start_dt = datetime.strptime(record.started_at[:10], "%Y-%m-%d").date()
                days_since_start = (today - start_dt).days
            except (TypeError, ValueError):
                days_since_start = None
        past_onboarding = days_since_start is not None and days_since_start >= 30
        if (
            record.trend_aligned_with_goal is False
            and past_onboarding
            and flag in {"green", "yellow"}
        ):
            flag = "yellow" if flag == "green" else "red"
            record.trend_downgrade = True
            stats.trend_downgrades += 1

        record.auto_flag = flag

        # Tally stats
        if flag == "red":
            stats.flag_red += 1
        elif flag == "yellow":
            stats.flag_yellow += 1
        elif flag == "green":
            stats.flag_green += 1
        elif flag == "onboarding":
            stats.flag_onboarding += 1
        elif flag == "ghosting":
            stats.flag_ghosting += 1

        time.sleep(TRAINERIZE_PER_CLIENT_SLEEP_S)


# ── Column extraction ──────────────────────────────────────────────
def column_value(item: dict[str, Any], column_id: str) -> dict[str, Any] | None:
    for col in item.get("column_values", []) or []:
        if col.get("id") == column_id:
            return col
    return None


def parse_status(item: dict[str, Any]) -> str | None:
    col = column_value(item, STATUS_COLUMN_ID)
    if not col:
        return None
    text = col.get("text") or None
    if text:
        return text.strip() or None
    # Fall back to value JSON's label
    val = col.get("value")
    if val:
        try:
            parsed = json.loads(val)
            label = parsed.get("label", {}).get("text") if isinstance(parsed.get("label"), dict) else None
            if label:
                return label.strip()
        except (json.JSONDecodeError, AttributeError):
            pass
    return None


def parse_programmed_to(item: dict[str, Any]) -> str | None:
    col = column_value(item, PROGRAMMED_TO_COLUMN_ID)
    if not col:
        return None
    text = (col.get("text") or "").strip() or None
    if text:
        return text
    val = col.get("value")
    if not val:
        return None
    try:
        parsed = json.loads(val)
        return parsed.get("date") or None
    except json.JSONDecodeError:
        return None


def parse_notes_text(item: dict[str, Any]) -> str | None:
    col = column_value(item, NOTES_TEXT_COLUMN_ID)
    if not col:
        return None
    text = col.get("text")
    if text:
        return text.strip() or None
    return None


def parse_doc_object_id(item: dict[str, Any]) -> str | None:
    col = column_value(item, NOTES_DOC_COLUMN_ID)
    if not col:
        return None
    val = col.get("value")
    if not val:
        return None
    try:
        parsed = json.loads(val)
    except json.JSONDecodeError:
        return None
    files = parsed.get("files") if isinstance(parsed, dict) else None
    if not files:
        return None
    first = files[0] if isinstance(files, list) and files else None
    if not isinstance(first, dict):
        return None
    object_id = first.get("objectId") or first.get("object_id")
    return str(object_id) if object_id else None


# ── Doc fetching ───────────────────────────────────────────────────
def fetch_doc_markdown(client: MondayClient, object_id: str) -> str:
    """Fetch a Monday Doc by object_id and return a plain-text concatenation of its blocks.

    NOTE: must query ONE doc per call. Batched `docs(object_ids: [a, b])` reliably
    returns 0 results in this Monday API version even for valid IDs that work solo.
    """
    query = (
        "query { docs(object_ids: [" + str(object_id) + "]) { blocks { content } } }"
    )
    data = client.query(query)
    docs = (data.get("data") or {}).get("docs") or []
    if not docs:
        return ""
    blocks = docs[0].get("blocks") or []
    chunks: list[str] = []
    for block in blocks:
        raw_content = block.get("content")
        if not raw_content:
            continue
        text = _block_content_to_text(raw_content)
        if text.strip():
            chunks.append(text)
    # One block per line — preserves "Key: value" separation needed by regex
    return "\n".join(chunks)


def _block_content_to_text(raw: str) -> str:
    """Block content is a JSON string. Extract any 'text' fields, recursively."""
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return str(raw) if raw else ""
    return _extract_text(parsed)


def _extract_text(node: Any) -> str:
    """Walk Monday's block content tree.

    Block content shape (example):
      {
        "deltaFormat": [
          { "insert": "Starting Weight:", "attributes": { "bold": true } },
          { "insert": " 96 lbs" }
        ],
        "indentation": 0
      }

    The actual text lives in the "insert" key on each delta entry.
    Also handle alt shapes ("text", "content", "children", "blocks", "ops")
    for forward-compatibility.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_extract_text(x) for x in node)
    if isinstance(node, dict):
        parts: list[str] = []
        # Quill-delta style: each op has an "insert" string
        if "insert" in node and isinstance(node["insert"], str):
            parts.append(node["insert"])
        # Plain text shape
        if "text" in node and isinstance(node["text"], str):
            parts.append(node["text"])
        for key in ("deltaFormat", "content", "children", "blocks", "ops"):
            if key in node:
                parts.append(_extract_text(node[key]))
        return "".join(parts)
    return ""


# ── Weight parsing ─────────────────────────────────────────────────
_WEIGHT_NUM = r"~?\s*(\d{2,3}(?:\.\d+)?)(?!\d)"  # 2-3 digit weight, NOT followed by another digit
_LB_SUFFIX = r"(?:\s*lbs?\b)?"

# Patterns: try in order, take first match. Allow optional **markdown bold**.
STARTING_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?i)\*{{0,2}}\s*start(?:ing)?\s*(?:weight)?\s*\*{{0,2}}\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\*{{0,2}}\s*starting\s+(?:weight|at)\s*\*{{0,2}}\s*[:\-]?\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\bstarted\s+at\s+{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\bstart\s+weight\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
)

CURRENT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?i)\*{{0,2}}\s*current\s*(?:weight)?\s*\*{{0,2}}\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\*{{0,2}}\s*now\s*\*{{0,2}}\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\bcurrently\s+(?:at\s+)?{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\blatest\s+weight\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
)

GOAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(rf"(?i)\*{{0,2}}\s*goal\s*(?:weight)?\s*\*{{0,2}}\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\*{{0,2}}\s*target\s*(?:weight)?\s*\*{{0,2}}\s*[:\-]\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
    re.compile(rf"(?i)\bgoal\s+weight\s*[:\-]?\s*{_WEIGHT_NUM}{_LB_SUFFIX}"),
)

# A→B style ranges. Captures starting (a) + low/high of goal range (b_low, b_high).
# We scan PER LINE so we can require an "lb" token somewhere in the same line —
# this filters out protein-gram lines like "124 → 120g P" without false negatives
# on "(171 → 150) in 16 weeks" style phrasing where the lb sits at line start.
RANGE_PATTERN = re.compile(
    rf"{_WEIGHT_NUM}(?:\s*lbs?\b)?\s*(?:→|->|to)\s*{_WEIGHT_NUM}(?:\s*[-–]\s*{_WEIGHT_NUM})?"
)

# Started date — ISO preferred but accept M/D/YYYY-ish too
STARTED_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\*{0,2}\s*start(?:ed)?\s*(?:date)?\s*\*{0,2}\s*[:\-]\s*(\d{4}-\d{2}-\d{2})"),
    re.compile(r"(?i)\*{0,2}\s*started\s*\*{0,2}\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})"),
    re.compile(r"(?i)\*{0,2}\s*start\s*date\s*\*{0,2}\s*[:\-]\s*([\d/-]+)"),
)


def _try_float(s: str) -> float | None:
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    if v < 50 or v > 800:  # human plausibility filter
        return None
    return v


def _first_match(patterns: tuple[re.Pattern[str], ...], text: str) -> float | None:
    for p in patterns:
        m = p.search(text)
        if m:
            val = _try_float(m.group(1))
            if val is not None:
                return val
    return None


def parse_weights(markdown: str, starting_hint: float | None = None) -> dict[str, float | None]:
    """Return {starting, current, goal} parsed from doc markdown."""
    starting = _first_match(STARTING_PATTERNS, markdown)
    current = _first_match(CURRENT_PATTERNS, markdown)
    goal = _first_match(GOAL_PATTERNS, markdown)

    # Handle "230 → 180-190" or "(171 → 150)" style ranges if explicit goal didn't match.
    # Scan PER LINE so we can require an "lb"/"lbs" anchor on the same line — this
    # filters out unrelated arrow ranges (protein/calories) without losing legit
    # parenthesized goal ranges where the suffix lives outside the parens.
    if goal is None:
        for line in markdown.splitlines():
            if not re.search(r"\blbs?\b", line, flags=re.IGNORECASE):
                continue
            m = RANGE_PATTERN.search(line)
            if not m:
                continue
            a = _try_float(m.group(1))
            b_low = _try_float(m.group(2))
            b_high = _try_float(m.group(3)) if m.group(3) else None
            if a is None or b_low is None:
                continue
            if starting is None:
                starting = a
            reference = starting if starting is not None else a
            if b_high is None:
                goal = b_low
            else:
                wants_loss = reference > b_low
                goal = b_low if wants_loss else b_high
            break

    return {"starting": starting, "current": current, "goal": goal}


def parse_started_date(markdown: str) -> str | None:
    for p in STARTED_PATTERNS:
        m = p.search(markdown)
        if not m:
            continue
        raw = m.group(1).strip()
        # Normalize MM/DD/YYYY → YYYY-MM-DD
        if re.match(r"^\d{1,2}/\d{1,2}/\d{4}$", raw):
            try:
                dt = datetime.strptime(raw, "%m/%d/%Y")
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
        if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
            return raw
    return None


# ── Item pagination ────────────────────────────────────────────────
ITEMS_FIELDS = """
  id
  name
  created_at
  column_values {
    id
    text
    value
  }
""".strip()


def fetch_all_items(client: MondayClient) -> list[dict[str, Any]]:
    """Pull every item on the Coach Board via cursor pagination."""
    items: list[dict[str, Any]] = []

    first_query = f"""
    query {{
      boards(ids: {COACH_BOARD_ID}) {{
        items_page(limit: {PAGE_SIZE}) {{
          cursor
          items {{ {ITEMS_FIELDS} }}
        }}
      }}
    }}
    """
    data = client.query(first_query)
    if data.get("errors"):
        raise RuntimeError(f"Monday board query failed: {data['errors']}")

    boards = (data.get("data") or {}).get("boards") or []
    if not boards:
        raise RuntimeError("Monday returned no boards")
    page = boards[0].get("items_page") or {}
    items.extend(page.get("items") or [])
    cursor = page.get("cursor")

    while cursor:
        cursor_escaped = cursor.replace('"', '\\"')
        page_query = f"""
        query {{
          next_items_page(limit: {PAGE_SIZE}, cursor: "{cursor_escaped}") {{
            cursor
            items {{ {ITEMS_FIELDS} }}
          }}
        }}
        """
        data = client.query(page_query)
        if data.get("errors"):
            log.warning("  Page errors (continuing): %s", data["errors"])
        next_page = (data.get("data") or {}).get("next_items_page") or {}
        page_items = next_page.get("items") or []
        items.extend(page_items)
        cursor = next_page.get("cursor")
        if not page_items:
            break

    return items


# ── Per-item assembly ──────────────────────────────────────────────
def build_record(
    client: MondayClient,
    item: dict[str, Any],
    stats: ParseStats,
) -> ClientRecord:
    monday_item_id = str(item["id"])
    name = (item.get("name") or "").strip() or f"Item {monday_item_id}"
    status = parse_status(item)
    programmed_to = parse_programmed_to(item)
    notes_text = parse_notes_text(item)
    doc_object_id = parse_doc_object_id(item)

    record = ClientRecord(
        monday_item_id=monday_item_id,
        name=name,
        status=status,
        programmed_to=programmed_to,
        notes_short=(notes_text or None),
        doc_object_id=doc_object_id,
    )

    if status and status in PAST_STATUSES:
        record.is_past = True

    # Fetch + parse doc markdown
    markdown = ""
    if doc_object_id:
        try:
            markdown = fetch_doc_markdown(client, doc_object_id)
            stats.docs_fetched += 1
        except Exception as exc:  # network/parse errors
            stats.docs_failed += 1
            stats.parse_failures.append(f"{name}: doc fetch failed ({exc})")

    if markdown:
        weights = parse_weights(markdown)
        record.starting_weight_lbs = weights["starting"]
        record.current_weight_lbs = weights["current"]
        record.goal_weight_lbs = weights["goal"]
        record.started_at = parse_started_date(markdown)
        # Track Notes-Doc provenance so the Trainerize backfill can defer to it
        record.starting_weight_from_doc = record.starting_weight_lbs is not None
        record.started_at_from_doc = record.started_at is not None
        # Truncate doc snippet for notes_short if no notes column text
        if not record.notes_short:
            snippet = markdown.strip().splitlines()
            if snippet:
                record.notes_short = " · ".join(s.strip() for s in snippet[:3] if s.strip())[:280] or None

    # Fallbacks for started_at — Monday created_at; Trainerize backfill may still win over this
    if not record.started_at:
        created_at = item.get("created_at")
        if created_at:
            try:
                record.started_at = created_at[:10]
            except (TypeError, IndexError):
                pass

    # Tally parse stats
    if record.starting_weight_lbs is not None:
        stats.has_start += 1
    if record.current_weight_lbs is not None:
        stats.has_current += 1
    if record.goal_weight_lbs is not None:
        stats.has_goal += 1
    if record.started_at is not None:
        stats.has_started_date += 1

    # Compute weight_change_lbs
    if (
        record.current_weight_lbs is not None
        and record.starting_weight_lbs is not None
    ):
        record.weight_change_lbs = round(
            record.current_weight_lbs - record.starting_weight_lbs, 1
        )

    return record


# ── Week-over-week weight trend ────────────────────────────────────
# Anything within ±FLAT_TOLERANCE_LB of zero is "flat" (noise, not real movement).
FLAT_TOLERANCE_LB = 0.2
# Look for a "previous week" bodyStat in this window before the latest weigh-in.
TREND_LOOKBACK_MIN_DAYS = 5
TREND_LOOKBACK_MAX_DAYS = 10


def compute_week_trend(
    weights: list[tuple[str, float]],
    starting_weight_lbs: float | None,
    goal_weight_lbs: float | None,
) -> tuple[float | None, float | None, str, str | None, bool | None]:
    """Compute week-over-week trend fields from sorted (date, weight) history.

    Returns (weight_lbs_prev_week, weight_change_lbs_7d, goal_direction,
             trend_direction, trend_aligned_with_goal).

    - weight_lbs_prev_week / weight_change_lbs_7d: None if no prior weigh-in falls
      in the 5-10d window before the latest. Sparse history → graceful None.
    - goal_direction: "loss" | "gain" | "maintain". Defaults to "maintain" when
      starting or goal is missing.
    - trend_direction: "up" | "down" | "flat". None if no 7d change.
    - trend_aligned_with_goal: True/False alignment; None if not enough signal
      (e.g. flat for a loss/gain goal — not enough data to tell).
    """
    # Goal direction first (independent of trend data)
    if starting_weight_lbs is None or goal_weight_lbs is None:
        goal_direction = "maintain"
    elif goal_weight_lbs < starting_weight_lbs:
        goal_direction = "loss"
    elif goal_weight_lbs > starting_weight_lbs:
        goal_direction = "gain"
    else:
        goal_direction = "maintain"

    if not weights or len(weights) < 2:
        return None, None, goal_direction, None, None

    latest_date_str, latest_weight = weights[-1]
    try:
        latest_dt = datetime.strptime(latest_date_str[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None, None, goal_direction, None, None

    # Find the bodyStat closest to 7 days before latest, within [5, 10] days.
    target_min = latest_dt - timedelta(days=TREND_LOOKBACK_MAX_DAYS)
    target_max = latest_dt - timedelta(days=TREND_LOOKBACK_MIN_DAYS)

    best_entry: tuple[str, float] | None = None
    best_distance: int | None = None
    for entry_date_str, entry_weight in weights[:-1]:
        try:
            entry_dt = datetime.strptime(entry_date_str[:10], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        if entry_dt < target_min or entry_dt > target_max:
            continue
        # Closest to 7 days back wins
        distance = abs((latest_dt - entry_dt).days - 7)
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_entry = (entry_date_str, entry_weight)

    if best_entry is None:
        return None, None, goal_direction, None, None

    prev_weight = best_entry[1]
    change_7d = round(latest_weight - prev_weight, 1)

    if change_7d < -FLAT_TOLERANCE_LB:
        trend_direction = "down"
    elif change_7d > FLAT_TOLERANCE_LB:
        trend_direction = "up"
    else:
        trend_direction = "flat"

    # Alignment matrix
    if goal_direction == "loss":
        if trend_direction == "down":
            trend_aligned: bool | None = True
        elif trend_direction == "up":
            trend_aligned = False
        else:  # flat — not enough signal
            trend_aligned = None
    elif goal_direction == "gain":
        if trend_direction == "up":
            trend_aligned = True
        elif trend_direction == "down":
            trend_aligned = False
        else:
            trend_aligned = None
    else:  # maintain
        if trend_direction == "flat":
            trend_aligned = True
        else:
            trend_aligned = False

    return (
        round(prev_weight, 1),
        change_7d,
        goal_direction,
        trend_direction,
        trend_aligned,
    )


# ── Trainerize backfill ────────────────────────────────────────────
def backfill_from_trainerize(
    records: list[ClientRecord],
    tz_client: TrainerizeClient,
    stats: ParseStats,
) -> None:
    """Fill weight gaps for active clients from Trainerize bodyStat history.

    Mutates records in place:
      - starting_weight_lbs: set only if Notes Doc did NOT parse one (Notes wins)
      - current_weight_lbs : ALWAYS overwrite with most recent bodyStat weight
      - started_at         : set only if Notes Doc did NOT parse one (Notes wins)
      - weight_change_lbs  : recomputed from final start + current values
      - trainerize_user_id : set to matched TZ user id
      - is_active_in_trainerize: True iff matched user has isActive=true + type=="client"
      - is_past            : demoted to True if not active in Trainerize (Monday
                             Paused/Expired still wins regardless)
    """
    try:
        users = tz_client.get_all_users()
    except Exception as exc:
        log.warning("  Trainerize user list fetch failed: %s — skipping backfill", exc)
        stats.tz_failures.append(f"user list fetch: {exc}")
        return

    user_index = _build_tz_user_index(users)
    log.info("  Trainerize users cached: %s", len(user_index))

    today = date.today()

    # Stat pass: count Monday-past clients who are STILL active in Trainerize.
    # These are "would-be-active but Monday says Paused/Expired" — they keep
    # is_past=True (Monday wins) but we want visibility into the count.
    for record in records:
        if not (record.status and record.status in PAST_STATUSES):
            continue
        try:
            user = match_trainerize_user(record.name, user_index)
        except Exception:
            continue
        if not user:
            continue
        tz_is_active = bool(user.get("isActive"))
        tz_type = (user.get("type") or "").strip().lower()
        if tz_is_active and tz_type == "client":
            stats.tz_active_but_monday_past += 1

    # Pass 1: walk ALL non-Monday-past records and gate on Trainerize active status.
    # Pass 2 (weight backfill) only runs for records that survive this gate.
    for record in records:
        # Monday Paused/Expired wins — don't touch these (keep is_past=True, never
        # backfill weights). They may still have an active TZ record but the coach
        # has paused them.
        if record.is_past:
            continue
        if record.status and record.status in PAST_STATUSES:
            # Defensive — build_record already set is_past for these
            record.is_past = True
            continue

        stats.tz_eligible += 1

        try:
            user = match_trainerize_user(record.name, user_index)
        except Exception as exc:
            stats.tz_failures.append(f"{record.name}: match error ({exc})")
            stats.tz_name_unmatched += 1
            record.is_active_in_trainerize = False
            record.is_past = True
            stats.tz_demoted_to_past += 1
            if len(stats.tz_demotion_examples) < 10:
                stats.tz_demotion_examples.append(f"{record.name}: TZ match error")
            continue

        if not user:
            stats.tz_name_unmatched += 1
            record.is_active_in_trainerize = False
            record.is_past = True
            stats.tz_demoted_to_past += 1
            if len(stats.tz_demotion_examples) < 10:
                stats.tz_demotion_examples.append(
                    f"{record.name}: no Trainerize match (status={record.status or '--'})"
                )
            continue

        stats.tz_name_matched += 1
        user_id = user.get("id") or user.get("userID")
        if user_id is None:
            stats.tz_failures.append(f"{record.name}: matched user has no id")
            record.is_active_in_trainerize = False
            record.is_past = True
            stats.tz_demoted_to_past += 1
            if len(stats.tz_demotion_examples) < 10:
                stats.tz_demotion_examples.append(f"{record.name}: TZ match missing id")
            continue
        record.trainerize_user_id = str(user_id)

        # Gate: must be isActive=true AND type=="client" to stay in active sections.
        tz_is_active = bool(user.get("isActive"))
        tz_type = (user.get("type") or "").strip().lower()
        if not tz_is_active or tz_type != "client":
            record.is_active_in_trainerize = False
            record.is_past = True
            stats.tz_demoted_to_past += 1
            if len(stats.tz_demotion_examples) < 10:
                reason = (
                    f"isActive={tz_is_active}, type={tz_type or 'unknown'}"
                )
                stats.tz_demotion_examples.append(
                    f"{record.name}: matched TZ user but {reason}"
                )
            # Skip weight backfill for non-active TZ users
            time.sleep(TRAINERIZE_PER_CLIENT_SLEEP_S)
            continue

        record.is_active_in_trainerize = True
        stats.tz_active_clients += 1

        try:
            weights, _windows = fetch_bodystat_history(tz_client, user_id, today)
            stats.tz_bodystats_fetched += 1
        except Exception as exc:
            stats.tz_bodystats_failed += 1
            stats.tz_failures.append(f"{record.name}: calendar fetch ({exc})")
            time.sleep(TRAINERIZE_PER_CLIENT_SLEEP_S)
            continue

        if not weights:
            stats.tz_zero_bodystats += 1
            time.sleep(TRAINERIZE_PER_CLIENT_SLEEP_S)
            continue

        first_date, first_weight = weights[0]
        _last_date, last_weight = weights[-1]

        # starting_weight: Notes Doc wins; only backfill if doc didn't supply one
        if not record.starting_weight_from_doc:
            if record.starting_weight_lbs is None:
                stats.has_start += 1
            record.starting_weight_lbs = round(first_weight, 1)
            stats.tz_backfilled_starting += 1

        # current_weight: ALWAYS overwrite with most recent weigh-in
        was_set = record.current_weight_lbs is not None
        record.current_weight_lbs = round(last_weight, 1)
        if not was_set:
            stats.has_current += 1
        stats.tz_backfilled_current += 1

        # started_at: Notes Doc wins. Otherwise Trainerize first bodyStat beats
        # the Monday created_at fallback (closer to "actual training start").
        if not record.started_at_from_doc:
            if record.started_at is None:
                stats.has_started_date += 1
            record.started_at = first_date
            stats.tz_backfilled_started_at += 1

        # Recompute weight_change_lbs from final values
        if (
            record.current_weight_lbs is not None
            and record.starting_weight_lbs is not None
        ):
            record.weight_change_lbs = round(
                record.current_weight_lbs - record.starting_weight_lbs, 1
            )

        # Week-over-week trend (uses full bodyStat history we just fetched)
        prev_w, change_7d, goal_dir, trend_dir, aligned = compute_week_trend(
            weights, record.starting_weight_lbs, record.goal_weight_lbs
        )
        record.weight_lbs_prev_week = prev_w
        record.weight_change_lbs_7d = change_7d
        record.goal_direction = goal_dir
        record.trend_direction = trend_dir
        record.trend_aligned_with_goal = aligned
        if change_7d is not None:
            stats.trend_with_data += 1
            if aligned is True:
                stats.trend_aligned += 1
            elif aligned is False:
                stats.trend_misaligned += 1
            else:
                stats.trend_flat += 1

        time.sleep(TRAINERIZE_PER_CLIENT_SLEEP_S)


# ── Output ─────────────────────────────────────────────────────────
def write_output(records: list[ClientRecord]) -> None:
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "clients": [r.to_dict() for r in records],
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = OUTPUT_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    tmp_path.replace(OUTPUT_PATH)
    log.info("Wrote %s clients → %s", len(records), OUTPUT_PATH)


# ── Main ───────────────────────────────────────────────────────────
def main() -> int:
    load_dotenv(dotenv_path=ENV_PATH)
    token = os.environ.get("MONDAY_API_TOKEN")
    if not token:
        log.error("MONDAY_API_TOKEN missing (looked in %s)", ENV_PATH)
        return 1

    log.info("Monday → Coach Board sync (board %s)", COACH_BOARD_ID)
    log.info("  Output: %s", OUTPUT_PATH)

    client = MondayClient(token)
    t0 = time.time()

    log.info("  Fetching board items (paginated)...")
    items = fetch_all_items(client)
    log.info("  Pulled %s items in %.1fs", len(items), time.time() - t0)

    stats = ParseStats()
    records: list[ClientRecord] = []

    for i, item in enumerate(items, 1):
        stats.total += 1
        try:
            record = build_record(client, item, stats)
        except Exception as exc:
            stats.parse_failures.append(f"item {item.get('id')}: {exc}")
            continue
        if record.is_past:
            stats.skipped_past += 1
        records.append(record)
        if i % 20 == 0:
            log.info("    %s / %s items processed", i, len(items))

    # ── Trainerize backfill pass ──
    tz_group_id = os.environ.get("TRAINERIZE_GROUP_ID")
    tz_token = os.environ.get("TRAINERIZE_API_TOKEN")
    tz_client: TrainerizeClient | None = None
    if not tz_group_id or not tz_token:
        log.warning("TRAINERIZE_GROUP_ID / TRAINERIZE_API_TOKEN missing — skipping Trainerize backfill")
    else:
        log.info("")
        log.info("Trainerize backfill: filling weight gaps from bodyStats...")
        try:
            tz_client = TrainerizeClient(tz_group_id, tz_token)
            backfill_from_trainerize(records, tz_client, stats)
        except Exception as exc:
            log.warning("  Trainerize backfill failed (continuing): %s", exc)
            stats.tz_failures.append(f"top-level: {exc}")
            tz_client = None

    # ── Compliance / RAG flag pass (active clients only) ──
    if tz_client is not None:
        log.info("")
        log.info("Trainerize compliance: computing RAG flags from last 7d activity...")
        try:
            compute_compliance_for_active_clients(records, tz_client, stats)
        except Exception as exc:
            log.warning("  Compliance compute failed (continuing): %s", exc)
            stats.compliance_failures.append(f"top-level: {exc}")

    # Sort by name for stable output
    records.sort(key=lambda r: r.name.lower())

    # Recompute final past count (includes Monday-past + TZ-demoted)
    stats.skipped_past = sum(1 for r in records if r.is_past)

    write_output(records)

    # Summary
    elapsed = time.time() - t0
    log.info("")
    log.info("Summary (%.1fs):", elapsed)
    log.info("  total items     : %s", stats.total)
    log.info("  docs fetched    : %s", stats.docs_fetched)
    log.info("  docs failed     : %s", stats.docs_failed)
    log.info("  has starting wt : %s", stats.has_start)
    log.info("  has current wt  : %s", stats.has_current)
    log.info("  has goal wt     : %s", stats.has_goal)
    log.info("  has started date: %s", stats.has_started_date)
    log.info("  past (final, incl TZ demotions): %s", stats.skipped_past)
    log.info("")
    log.info("Trainerize backfill:")
    log.info("  eligible (non-Monday-past): %s", stats.tz_eligible)
    log.info("  name matched              : %s", stats.tz_name_matched)
    log.info("  name unmatched            : %s", stats.tz_name_unmatched)
    log.info("  calendars fetched         : %s", stats.tz_bodystats_fetched)
    log.info("  calendars failed          : %s", stats.tz_bodystats_failed)
    log.info("  zero bodyStats logged     : %s", stats.tz_zero_bodystats)
    log.info("  backfilled starting       : %s", stats.tz_backfilled_starting)
    log.info("  backfilled current        : %s", stats.tz_backfilled_current)
    log.info("  backfilled started_at     : %s", stats.tz_backfilled_started_at)
    log.info("")
    log.info("Trainerize active-status gating:")
    log.info("  active in TZ (kept active): %s", stats.tz_active_clients)
    log.info("  demoted to past (no/inactive TZ): %s", stats.tz_demoted_to_past)
    log.info("  active in TZ but Monday Paused/Expired: %s", stats.tz_active_but_monday_past)
    if stats.tz_demotion_examples:
        log.info("")
        log.info("  demotion examples (showing first 10):")
        for ex in stats.tz_demotion_examples[:10]:
            log.info("    - %s", ex)
    if stats.parse_failures:
        log.info("")
        log.info("  parse issues (showing first 10):")
        for fail in stats.parse_failures[:10]:
            log.info("    - %s", fail)
    if stats.tz_failures:
        log.info("")
        log.info("  trainerize issues (showing first 10):")
        for fail in stats.tz_failures[:10]:
            log.info("    - %s", fail)

    log.info("")
    log.info("Compliance RAG flags (active clients only):")
    log.info("  red       : %s", stats.flag_red)
    log.info("  yellow    : %s", stats.flag_yellow)
    log.info("  green     : %s", stats.flag_green)
    log.info("  onboarding: %s", stats.flag_onboarding)
    log.info("  ghosting  : %s", stats.flag_ghosting)
    log.info("")
    log.info("Week-over-week weight trend:")
    log.info("  with trend data    : %s", stats.trend_with_data)
    log.info("  aligned w/ goal    : %s", stats.trend_aligned)
    log.info("  MISALIGNED w/ goal : %s", stats.trend_misaligned)
    log.info("  flat (no signal)   : %s", stats.trend_flat)
    log.info("  flag downgrades    : %s", stats.trend_downgrades)
    if stats.compliance_failures:
        log.info("")
        log.info("  compliance issues (showing first 10):")
        for fail in stats.compliance_failures[:10]:
            log.info("    - %s", fail)

    return 0


if __name__ == "__main__":
    sys.exit(main())
