#!/usr/bin/env python3
"""
Faerber Client OS — one-time goal-weight backfill via Claude.

Most active clients (53 of 58 at last count) have no goal_weight_lbs because
the regex parser in sync_monday_clients.py only catches doc-stated goals in a
narrow format. Plenty of goals live in conversational form inside the Monday
Notes Doc or in their Trainerize chat history.

This script:
  1. Loads server/monday-clients.json
  2. Filters to active clients (is_past=false) where goal_weight_lbs is null
     AND trainerize_user_id is not null
  3. For each: pulls the Notes Doc markdown + first 200 Trainerize messages
  4. Asks Claude (haiku-4-5) to extract a goal weight + confidence + quote
  5. Writes back goal_weight_lbs / goal_weight_source / goal_weight_confidence
     / goal_weight_quote on records where confidence != "low"

Safe to re-run — skips clients that already have a goal_weight_lbs set.
Not wired into sync_all.py — one-time backfill.

Run from terminal:
  .venv/bin/python extract_goal_weights.py
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from anthropic import Anthropic

# ── Config ──────────────────────────────────────────────────────────
ENV_PATH = Path("/Users/zachef/Desktop/Playground - Claude/.env")
INPUT_PATH = (
    Path(__file__).resolve().parent / "server" / "monday-clients.json"
)
OUTPUT_PATH = INPUT_PATH  # write back in place
# Per-client results log (JSONL) — survives even if stdout is buffered/lost.
RESULTS_JSONL_PATH = Path(__file__).resolve().parent / "extract_goal_weights.results.jsonl"
# Clients still null after extraction → manual review queue.
NEEDS_REVIEW_CSV_PATH = Path(__file__).resolve().parent / "extract_goal_weights.needs_review.csv"
# Project memory files w/ locked goals (e.g. "Jaelyn 165→145 in 12 wks").
MEMORY_GLOB = Path("/Users/zachef/.claude/projects/-Users-zachef/memory")
# Local intake markdown files (faerber-checkin/clients/backfill/*.md).
INTAKE_DIR = Path("/Users/zachef/Desktop/Playground - Claude/faerber-checkin/clients/backfill")

MONDAY_API_URL = "https://api.monday.com/v2"
TRAINERIZE_API_URL = "https://api.trainerize.com/v03"

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CLAUDE_MAX_TOKENS = 400

DOC_TRUNCATE_CHARS = 6000
CHAT_TRUNCATE_CHARS = 8000
CHAT_MESSAGE_COUNT = 200
MEMORY_TRUNCATE_CHARS = 3000
INTAKE_TRUNCATE_CHARS = 4000
ZACH_TRAINERIZE_USER_ID = 3525989

PER_CLIENT_SLEEP_S = 0.2
TRAINERIZE_RETRY_BACKOFF_S = 2.0

# Tags Trainerize embeds in HTML message bodies — strip them.
_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
_WS_PATTERN = re.compile(r"\s+")

# Force line-buffered stdout so progress shows up immediately even when piped to tee.
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except AttributeError:  # pragma: no cover — older Pythons
    pass

logging.basicConfig(
    format="%(message)s",
    level=logging.INFO,
    stream=sys.stdout,
)
log = logging.getLogger("extract_goal_weights")


# ── Data shape for results ─────────────────────────────────────────
@dataclass
class ExtractionResult:
    name: str
    monday_item_id: str
    starting_weight_lbs: float | None
    current_weight_lbs: float | None
    goal_weight_lbs: float | None
    confidence: str | None
    source_quote: str | None
    source: str | None = None  # memory|notes_doc|intake|chat|computed
    skipped_reason: str | None = None  # set when we did NOT write back


@dataclass
class RunStats:
    eligible: int = 0
    processed: int = 0
    extracted_high: int = 0
    extracted_medium: int = 0
    extracted_low_skipped: int = 0
    no_goal_found: int = 0
    claude_failures: int = 0
    doc_failures: int = 0
    chat_failures: int = 0
    suspicious: list[str] = field(default_factory=list)


# ── Monday client (raw-token Authorization, mirrors sync_monday_clients.py) ──
class MondayClient:
    def __init__(self, token: str) -> None:
        if not token:
            raise RuntimeError("MONDAY_API_TOKEN is empty")
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Content-Type": "application/json",
                "Authorization": token,
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
                return res.json()
            except (requests.RequestException, ValueError) as exc:
                if attempt + 1 >= retries:
                    raise
                time.sleep(1.5 * (attempt + 1))
                log.warning("  Monday retry %s after %s", attempt + 1, exc)
        return {}


def fetch_doc_markdown(client: MondayClient, object_id: str) -> str:
    """Pull one Monday Doc by object_id → flattened text. Mirror of sync_monday_clients.fetch_doc_markdown."""
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
    return "\n".join(chunks)


def _block_content_to_text(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return str(raw) if raw else ""
    return _extract_text(parsed)


def _extract_text(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_extract_text(x) for x in node)
    if isinstance(node, dict):
        parts: list[str] = []
        if "insert" in node and isinstance(node["insert"], str):
            parts.append(node["insert"])
        if "text" in node and isinstance(node["text"], str):
            parts.append(node["text"])
        for key in ("deltaFormat", "content", "children", "blocks", "ops"):
            if key in node:
                parts.append(_extract_text(node[key]))
        return "".join(parts)
    return ""


# ── Trainerize client (basic auth, mirror of sync_monday_clients.py) ──
class TrainerizeClient:
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
        # Retry once on 401/429/5xx with the documented 2s backoff.
        for attempt in range(2):
            res = self._session.post(
                f"{TRAINERIZE_API_URL}{path}", json=body, timeout=timeout
            )
            if res.status_code in (401, 429) or res.status_code >= 500:
                if attempt == 0:
                    time.sleep(TRAINERIZE_RETRY_BACKOFF_S)
                    continue
                raise requests.HTTPError(f"{res.status_code}: {res.text[:200]}")
            if not res.ok:
                raise requests.HTTPError(f"{res.status_code}: {res.text[:200]}")
            try:
                return res.json()
            except ValueError as exc:
                raise requests.HTTPError(f"non-JSON: {res.text[:200]}") from exc
        return {}

    def find_thread_for_client(self, client_user_id: int) -> int | None:
        """Walk /message/getThreads pages until a thread w/ ccUsers containing client_user_id appears."""
        start = 0
        count = 200
        # Walk up to ~5 pages — Faerber inbox isn't huge.
        for _ in range(5):
            data = self.post(
                "/message/getThreads",
                {
                    "view": "inbox",
                    "userID": ZACH_TRAINERIZE_USER_ID,
                    "start": start,
                    "count": count,
                },
            )
            threads = data.get("threads") or []
            if not threads:
                return None
            for t in threads:
                cc_users = t.get("ccUsers") or []
                for cc in cc_users:
                    if str(cc.get("userID")) == str(client_user_id):
                        return t.get("id") or t.get("threadID")
            total = data.get("total") or 0
            start += count
            if start >= total:
                return None
        return None

    def get_messages(self, thread_id: int, count: int = CHAT_MESSAGE_COUNT) -> list[dict[str, Any]]:
        data = self.post(
            "/message/getMessages",
            {"threadID": thread_id, "start": 0, "count": count},
        )
        return data.get("messages") or []

    def get_messages_window(
        self, thread_id: int, start: int, count: int = CHAT_MESSAGE_COUNT
    ) -> tuple[list[dict[str, Any]], int]:
        """Return (messages, total_rows). Trainerize sorts newest-first; start=0 = newest page."""
        data = self.post(
            "/message/getMessages",
            {"threadID": thread_id, "start": start, "count": count},
        )
        messages = data.get("messages") or []
        # totalRows is on every message; pull from first
        total = 0
        if messages:
            total = int(messages[0].get("totalRows") or len(messages))
        return messages, total

    def get_messages_newest_and_oldest(
        self, thread_id: int, slice_size: int = 100
    ) -> list[dict[str, Any]]:
        """Pull a newest-slice + oldest-slice so goal info from onboarding AND recent
        check-ins both make it into the prompt. Returns newest-first concatenation.
        """
        newest, total = self.get_messages_window(thread_id, start=0, count=slice_size)
        if total <= slice_size or not newest:
            return newest
        # Calculate offset for the oldest slice (last page).
        oldest_start = max(0, total - slice_size)
        if oldest_start <= slice_size:
            # threads barely larger than one slice — one big pull covers it
            big, _ = self.get_messages_window(thread_id, start=0, count=total)
            return big
        oldest, _ = self.get_messages_window(thread_id, start=oldest_start, count=slice_size)
        # newest already newest-first; oldest is also newest-first w/in its window.
        # Concatenate: newest slice then a separator marker then oldest slice.
        return newest + [{"_separator": True}] + oldest


# ── Chat formatting ────────────────────────────────────────────────
def _strip_html(s: str) -> str:
    s = _HTML_TAG_PATTERN.sub(" ", s)
    s = _WS_PATTERN.sub(" ", s).strip()
    return s


def format_chat_for_prompt(
    messages: list[dict[str, Any]], client_user_id: int
) -> str:
    """Concatenate messages in reverse-chronological order (newest first) with sender prefix.

    Skip attachments / messages with no body. Trainerize returns messages newest-first
    by default. Sender attribution uses `sender.type` ("client" vs "trainer") which is
    the canonical Trainerize signal — the bare `sender.userID` matches multiple
    coaching-staff users (Zach + Zach's assistant) so type-based labeling is cleaner.
    """
    lines: list[str] = []
    for m in messages:
        if m.get("_separator"):
            lines.append("--- (older messages below, also newest-first) ---")
            continue
        body = m.get("body") or m.get("text") or ""
        if not isinstance(body, str):
            continue
        clean = _strip_html(body)
        if not clean:
            continue
        sender = m.get("sender") or {}
        sender_type = sender.get("type")
        if sender_type == "trainer":
            sender_label = "Coach"
        elif sender_type == "client":
            sender_label = "Client"
        else:
            # Fallback to userID comparison if sender.type is missing
            sid = sender.get("userID") or m.get("fromUserID")
            sender_label = "Coach" if str(sid) == str(ZACH_TRAINERIZE_USER_ID) else "Client"
        sent = m.get("sentTime") or m.get("date") or m.get("sentDate") or ""
        date_prefix = f"[{sent[:10]}] " if isinstance(sent, str) and sent else ""
        lines.append(f"{date_prefix}{sender_label}: {clean}")
    return "\n".join(lines)


# ── Memory / intake file loaders ───────────────────────────────────
def _name_to_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


def load_memory_file(name: str) -> str:
    """Load ~/.claude/.../memory/project_<slug>.md if it exists."""
    slug = _name_to_slug(name)
    if not slug:
        return ""
    candidate = MEMORY_GLOB / f"project_{slug}.md"
    if candidate.exists():
        try:
            return candidate.read_text(encoding="utf-8")
        except Exception:
            return ""
    # Try first-name-only fallback (e.g. "Jaelyn Towle" → "jaelyn")
    first = slug.split("_")[0]
    if first and first != slug:
        candidate = MEMORY_GLOB / f"project_{first}.md"
        if candidate.exists():
            try:
                return candidate.read_text(encoding="utf-8")
            except Exception:
                return ""
    return ""


def load_intake_md(name: str) -> str:
    """Load faerber-checkin/clients/backfill/<slug>.md if it exists. Slug uses dashes."""
    if not INTAKE_DIR.exists():
        return ""
    slug_dashes = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    if not slug_dashes:
        return ""
    candidate = INTAKE_DIR / f"{slug_dashes}.md"
    if candidate.exists():
        try:
            return candidate.read_text(encoding="utf-8")
        except Exception:
            return ""
    return ""


# ── Claude prompt + call ───────────────────────────────────────────
def build_prompt(
    name: str,
    starting_weight: float | None,
    current_weight: float | None,
    doc_markdown: str,
    chat_text: str,
    memory_text: str,
    intake_text: str,
) -> str:
    doc_section = (doc_markdown or "").strip()[:DOC_TRUNCATE_CHARS] or "(no notes doc available)"
    chat_section = (chat_text or "").strip()[:CHAT_TRUNCATE_CHARS] or "(no chat history available)"
    memory_section = (memory_text or "").strip()[:MEMORY_TRUNCATE_CHARS] or "(no project memory file)"
    intake_section = (intake_text or "").strip()[:INTAKE_TRUNCATE_CHARS] or "(no intake md)"
    start_str = f"{starting_weight} lb" if starting_weight is not None else "unknown"
    curr_str = f"{current_weight} lb" if current_weight is not None else "unknown"
    return (
        f"You are reading a coaching client's profile data to extract their goal weight.\n\n"
        f"Client: {name}\n"
        f"Starting weight: {start_str}\n"
        f"Current weight: {curr_str}\n\n"
        f"=== SOURCE 1: Coach's project memory file (most authoritative — locked goals) ===\n{memory_section}\n\n"
        f"=== SOURCE 2: Monday Notes Doc ===\n{doc_section}\n\n"
        f"=== SOURCE 3: Local intake markdown ===\n{intake_section}\n\n"
        f"=== SOURCE 4: Trainerize chat history (most recent first) ===\n{chat_section}\n\n"
        "Extract the client's goal weight in pounds. Be AGGRESSIVE about extraction — coaches rarely state goals as 'goal: 150 lb'. Look for:\n"
        "- explicit: \"goal weight 150\", \"target 145\", \"down to X\"\n"
        "- delta: \"lose 30 lbs\", \"drop 20\", \"-25 lb\" → compute goal = starting - delta\n"
        "- nostalgic: \"back to 160\", \"pre-pregnancy weight of X\", \"my wedding weight (Y)\"\n"
        "- event: \"X lbs by [date/event]\"\n"
        "- size: \"size 8 jeans (~140 lb)\" — only if a specific lb number is bracketed/implied numerically\n"
        "- range: \"between 180-190\" → midpoint for loss, conservative for gain\n\n"
        "Source priority — memory file > Notes Doc > intake > chat. If sources conflict, prefer the most recent.\n\n"
        "Return ONLY valid JSON in this exact shape:\n"
        "{\"goal_weight_lbs\": <number or null>, \"confidence\": \"high\"|\"medium\"|\"low\"|null, "
        "\"source_quote\": \"<verbatim quote from any source, or null>\", "
        "\"source\": \"memory\"|\"notes_doc\"|\"intake\"|\"chat\"|\"computed\"|null}\n\n"
        "Rules:\n"
        "- If client says \"lose 30 lbs\" AND starting weight is known → compute goal = starting - 30, source='computed', confidence='medium'\n"
        "- Multiple goals → pick LATEST mention (chronologically) or memory file (most authoritative)\n"
        "- Don't invent numbers. If no goal AND no delta found anywhere → null"
    )


# Greedy JSON-object extractor — Claude sometimes wraps the JSON in prose.
_JSON_BLOCK_PATTERN = re.compile(r"\{[\s\S]*\}")


def parse_claude_json(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    raw = raw.strip()
    # Strip code fences
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    # Try direct JSON parse first
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    match = _JSON_BLOCK_PATTERN.search(raw)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def call_claude(client: Anthropic, prompt: str) -> dict[str, Any] | None:
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=CLAUDE_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    text_parts = []
    for block in resp.content:
        # SDK block types vary by version — be permissive.
        text = getattr(block, "text", None)
        if isinstance(text, str):
            text_parts.append(text)
    raw = "".join(text_parts)
    return parse_claude_json(raw)


# ── Per-client extraction ──────────────────────────────────────────
def extract_for_client(
    client_record: dict[str, Any],
    monday: MondayClient,
    trainerize: TrainerizeClient,
    claude: Anthropic,
) -> ExtractionResult:
    name = client_record.get("name") or "(unknown)"
    monday_item_id = str(client_record.get("monday_item_id") or "")
    starting = client_record.get("starting_weight_lbs")
    current = client_record.get("current_weight_lbs")
    doc_object_id = client_record.get("doc_object_id")
    trainerize_user_id = client_record.get("trainerize_user_id")

    # 1. Notes Doc
    doc_markdown = ""
    if doc_object_id:
        try:
            doc_markdown = fetch_doc_markdown(monday, str(doc_object_id))
        except Exception as exc:
            log.warning("  [%s] doc fetch failed: %s", name, exc)

    # 2. Trainerize chat — pull newest 100 + oldest 100 so onboarding goals make it in.
    chat_text = ""
    if trainerize_user_id:
        try:
            thread_id = trainerize.find_thread_for_client(int(trainerize_user_id))
            if thread_id:
                messages = trainerize.get_messages_newest_and_oldest(
                    int(thread_id), slice_size=100
                )
                chat_text = format_chat_for_prompt(messages, int(trainerize_user_id))
        except Exception as exc:
            log.warning("  [%s] chat fetch failed: %s", name, exc)

    # 3. Memory file (~/.claude/.../memory/project_<slug>.md)
    memory_text = load_memory_file(name)

    # 4. Intake md (faerber-checkin/clients/backfill/<slug>.md)
    intake_text = load_intake_md(name)

    # 5. Claude call
    if not doc_markdown and not chat_text and not memory_text and not intake_text:
        return ExtractionResult(
            name=name,
            monday_item_id=monday_item_id,
            starting_weight_lbs=starting,
            current_weight_lbs=current,
            goal_weight_lbs=None,
            confidence=None,
            source_quote=None,
            skipped_reason="no_sources_available",
        )

    prompt = build_prompt(name, starting, current, doc_markdown, chat_text, memory_text, intake_text)
    try:
        parsed = call_claude(claude, prompt)
    except Exception as exc:
        log.warning("  [%s] Claude call failed: %s", name, exc)
        return ExtractionResult(
            name=name,
            monday_item_id=monday_item_id,
            starting_weight_lbs=starting,
            current_weight_lbs=current,
            goal_weight_lbs=None,
            confidence=None,
            source_quote=None,
            skipped_reason=f"claude_error: {exc}",
        )

    if not parsed:
        return ExtractionResult(
            name=name,
            monday_item_id=monday_item_id,
            starting_weight_lbs=starting,
            current_weight_lbs=current,
            goal_weight_lbs=None,
            confidence=None,
            source_quote=None,
            skipped_reason="claude_unparseable_response",
        )

    goal_raw = parsed.get("goal_weight_lbs")
    conf_raw = parsed.get("confidence")
    quote_raw = parsed.get("source_quote")
    source_raw = parsed.get("source")

    # Coerce types
    goal: float | None = None
    if isinstance(goal_raw, (int, float)):
        goal = float(goal_raw)
    elif isinstance(goal_raw, str):
        try:
            goal = float(goal_raw)
        except ValueError:
            goal = None

    confidence: str | None = None
    if isinstance(conf_raw, str) and conf_raw.lower() in {"high", "medium", "low"}:
        confidence = conf_raw.lower()

    quote: str | None = None
    if isinstance(quote_raw, str) and quote_raw.strip():
        quote = quote_raw.strip()

    source_val: str | None = None
    if isinstance(source_raw, str) and source_raw.lower() in {"memory", "notes_doc", "intake", "chat", "computed"}:
        source_val = source_raw.lower()

    return ExtractionResult(
        name=name,
        monday_item_id=monday_item_id,
        starting_weight_lbs=starting,
        current_weight_lbs=current,
        goal_weight_lbs=goal,
        confidence=confidence,
        source_quote=quote,
        source=source_val,
    )


# ── Suspicion check ────────────────────────────────────────────────
def is_suspicious(result: ExtractionResult) -> str | None:
    """Return reason string if this looks like a false positive, else None."""
    goal = result.goal_weight_lbs
    if goal is None:
        return None
    start = result.starting_weight_lbs
    curr = result.current_weight_lbs
    # Equal to start → no change implied → likely false positive
    if start is not None and abs(goal - start) < 0.5:
        return f"goal ({goal}) ≈ starting ({start}) — no change implied"
    # Equal to current → likely echo of weigh-in
    if curr is not None and abs(goal - curr) < 0.5:
        return f"goal ({goal}) ≈ current ({curr}) — possible echo"
    # Wildly out of range
    if goal < 80 or goal > 500:
        return f"goal ({goal}) outside plausible 80-500 lb range"
    return None


# ── I/O ────────────────────────────────────────────────────────────
def load_clients_file() -> dict[str, Any]:
    with INPUT_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_clients_file(payload: dict[str, Any]) -> None:
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = OUTPUT_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    tmp_path.replace(OUTPUT_PATH)


# ── Main ───────────────────────────────────────────────────────────
def main() -> int:
    load_dotenv(dotenv_path=ENV_PATH)
    monday_token = os.environ.get("MONDAY_API_TOKEN")
    tz_group_id = os.environ.get("TRAINERIZE_GROUP_ID")
    tz_token = os.environ.get("TRAINERIZE_API_TOKEN")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    missing = [
        n for n, v in [
            ("MONDAY_API_TOKEN", monday_token),
            ("TRAINERIZE_GROUP_ID", tz_group_id),
            ("TRAINERIZE_API_TOKEN", tz_token),
            ("ANTHROPIC_API_KEY", anthropic_key),
        ]
        if not v
    ]
    if missing:
        log.error("Missing env vars: %s (looked in %s)", ", ".join(missing), ENV_PATH)
        return 1

    log.info("Goal-weight extraction backfill")
    log.info("  Input/Output: %s", INPUT_PATH)
    log.info("  Model: %s", CLAUDE_MODEL)

    payload = load_clients_file()
    clients = payload.get("clients") or []
    log.info("  Loaded %s total client records", len(clients))

    # Filter eligible
    eligible_indexes: list[int] = []
    for i, c in enumerate(clients):
        if c.get("is_past"):
            continue
        if c.get("goal_weight_lbs") is not None:
            continue
        if not c.get("trainerize_user_id"):
            continue
        eligible_indexes.append(i)

    stats = RunStats()
    stats.eligible = len(eligible_indexes)
    log.info("  Eligible (active, no goal, has trainerize_user_id): %s", stats.eligible)
    log.info("")

    monday = MondayClient(monday_token)  # type: ignore[arg-type]
    trainerize = TrainerizeClient(tz_group_id, tz_token)  # type: ignore[arg-type]
    claude = Anthropic(api_key=anthropic_key)

    results: list[ExtractionResult] = []
    t0 = time.time()

    # Reset the JSONL results log for this run.
    RESULTS_JSONL_PATH.write_text("", encoding="utf-8")

    for n, idx in enumerate(eligible_indexes, 1):
        record = clients[idx]
        name = record.get("name") or "(unknown)"
        log.info("[%s/%s] %s ...", n, stats.eligible, name)

        result = extract_for_client(record, monday, trainerize, claude)
        results.append(result)
        stats.processed += 1

        # Persist per-client result so we have ground truth even if stdout is buffered.
        with RESULTS_JSONL_PATH.open("a", encoding="utf-8") as rf:
            rf.write(json.dumps({
                "n": n,
                "name": result.name,
                "monday_item_id": result.monday_item_id,
                "starting_weight_lbs": result.starting_weight_lbs,
                "current_weight_lbs": result.current_weight_lbs,
                "goal_weight_lbs": result.goal_weight_lbs,
                "confidence": result.confidence,
                "source_quote": result.source_quote,
                "source": result.source,
                "skipped_reason": result.skipped_reason,
            }) + "\n")

        # Decide whether to write back
        if result.goal_weight_lbs is None:
            stats.no_goal_found += 1
            log.info("  → no goal found")
        elif result.confidence == "low":
            stats.extracted_low_skipped += 1
            log.info(
                "  → LOW confidence ({} lb) — NOT writing".format(result.goal_weight_lbs)
            )
        else:
            # Suspicion check
            suspicion = is_suspicious(result)
            if suspicion:
                stats.suspicious.append(
                    f"{name}: goal={result.goal_weight_lbs}, conf={result.confidence} — {suspicion}"
                )
                log.info(
                    "  → SUSPICIOUS ({} lb, {} conf) — {} — writing anyway".format(
                        result.goal_weight_lbs, result.confidence, suspicion
                    )
                )
            else:
                log.info(
                    "  → goal={} lb, conf={}".format(
                        result.goal_weight_lbs, result.confidence
                    )
                )

            if result.confidence == "high":
                stats.extracted_high += 1
            elif result.confidence == "medium":
                stats.extracted_medium += 1

            # Write back into the in-memory record
            record["goal_weight_lbs"] = result.goal_weight_lbs
            record["goal_weight_source"] = result.source or "llm_extraction"
            record["goal_weight_confidence"] = result.confidence
            record["goal_weight_quote"] = result.source_quote

        time.sleep(PER_CLIENT_SLEEP_S)

    elapsed = time.time() - t0

    # Persist
    write_clients_file(payload)
    log.info("")
    log.info("Wrote updated %s (%.1fs)", OUTPUT_PATH.name, elapsed)

    # ── Summary ──
    log.info("")
    log.info("Summary:")
    log.info("  processed              : %s", stats.processed)
    log.info("  extracted (HIGH conf)  : %s", stats.extracted_high)
    log.info("  extracted (MEDIUM conf): %s", stats.extracted_medium)
    log.info("  low-conf (skipped)     : %s", stats.extracted_low_skipped)
    log.info("  no goal found          : %s", stats.no_goal_found)
    log.info("  suspicious (still written): %s", len(stats.suspicious))

    if stats.suspicious:
        log.info("")
        log.info("Suspicious extractions (sanity check these):")
        for s in stats.suspicious:
            log.info("  - %s", s)

    # ── needs_review CSV: clients still null OR low-conf for manual entry ──
    import csv as _csv
    review_rows = [
        r for r in results
        if (r.goal_weight_lbs is None) or (r.confidence == "low")
    ]
    with NEEDS_REVIEW_CSV_PATH.open("w", encoding="utf-8", newline="") as cf:
        w = _csv.writer(cf)
        w.writerow(["name", "monday_item_id", "starting_weight_lbs", "current_weight_lbs", "manual_goal_weight_lbs", "llm_reason", "llm_quote"])
        for r in review_rows:
            reason = r.skipped_reason or (f"low_conf_{r.confidence}" if r.confidence == "low" else "no_goal_found")
            w.writerow([r.name, r.monday_item_id, r.starting_weight_lbs, r.current_weight_lbs, "", reason, (r.source_quote or "").replace("\n", " ")[:300]])
    log.info("Manual review queue: %s clients → %s", len(review_rows), NEEDS_REVIEW_CSV_PATH.name)

    # ── 10 sample extractions ──
    log.info("")
    log.info("Sample extractions (up to 10 w/ a goal extracted):")
    samples = [r for r in results if r.goal_weight_lbs is not None][:10]
    if not samples:
        log.info("  (none extracted)")
    for r in samples:
        delta = ""
        if r.starting_weight_lbs is not None and r.goal_weight_lbs is not None:
            delta = f" Δ={r.goal_weight_lbs - r.starting_weight_lbs:+.1f} lb"
        log.info(
            "  • %s  start=%s curr=%s  GOAL=%s lb  (%s)%s",
            r.name,
            r.starting_weight_lbs,
            r.current_weight_lbs,
            r.goal_weight_lbs,
            r.confidence or "?",
            delta,
        )
        quote = (r.source_quote or "").strip()
        if quote:
            if len(quote) > 200:
                quote = quote[:200] + "..."
            log.info("      ↳ \"%s\"", quote)

    return 0


if __name__ == "__main__":
    sys.exit(main())
