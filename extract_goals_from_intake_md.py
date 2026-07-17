#!/usr/bin/env python3
"""
Faerber Client OS — goal-weight backfill from intake markdown files.

The first goal-weight extraction pass (extract_goal_weights.py) only read
Monday Notes Docs + Trainerize chats. There's a richer source it missed:

  faerber-checkin/clients/backfill/*.md
  faerber-checkin/clients/*.md   (top level only)

These are hand-crafted intake notes (~30 files) with structured Goals
sections, history, mindset, etc. — the best per-client goal source available.

This script:
  1. Indexes every .md file in those two dirs by client name
  2. Loads server/monday-clients.json
  3. For every active client (is_past=false) where goal_weight_lbs is null,
     normalizes the name and tries to match an intake md file
  4. Sends the file to Claude haiku for explicit goal-weight extraction
  5. Writes back goal_weight_lbs / goal_weight_source / goal_weight_confidence
     / goal_weight_quote for matched-and-extracted clients

Safe to re-run — preserves any record that already has goal_weight_lbs set.

Run from terminal:
  .venv/bin/python extract_goals_from_intake_md.py
"""

from __future__ import annotations

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

from dotenv import load_dotenv

from anthropic import Anthropic

# ── Config ──────────────────────────────────────────────────────────
ENV_PATH = Path("/Users/zachef/Desktop/Playground - Claude/.env")
INTAKE_DIRS: tuple[Path, ...] = (
    Path("/Users/zachef/Desktop/Playground - Claude/faerber-checkin/clients/backfill"),
    Path("/Users/zachef/Desktop/Playground - Claude/faerber-checkin/clients"),
)
CLIENTS_JSON_PATH = (
    Path(__file__).resolve().parent / "server" / "monday-clients.json"
)
RESULTS_JSONL_PATH = (
    Path(__file__).resolve().parent / "extract_goals_from_intake_md.results.jsonl"
)

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CLAUDE_MAX_TOKENS = 400
MD_TRUNCATE_CHARS = 12000
PER_CLIENT_SLEEP_S = 0.2

# Force line-buffered stdout so progress shows up immediately.
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except AttributeError:  # pragma: no cover
    pass

logging.basicConfig(
    format="%(message)s",
    level=logging.INFO,
    stream=sys.stdout,
)
log = logging.getLogger("extract_goals_from_intake_md")


# ── Name normalization ─────────────────────────────────────────────
_NON_ALNUM_PATTERN = re.compile(r"[^a-z0-9 ]+")
_WS_PATTERN = re.compile(r"\s+")
_MIDDLE_INITIAL_PATTERN = re.compile(r"\b[a-z]\b")
# Parenthetical suffixes (e.g. "(Esshhha_boo2.0)") and trailing role notes.
_PAREN_PATTERN = re.compile(r"\([^)]*\)")
# Trailing "- 45 Call", "(copy)", etc.
_TRAILING_NOTES = re.compile(
    r"\s+-\s+(45|15|call|copy|onboard|husband|wife)\b.*$", re.IGNORECASE
)


# Manual name aliases (monday-clients name → intake filename stem).
# These cover real client/file mismatches:
#   - Nicknames (Bob → Robert, Kiki → Christine, Matt → Matthew)
#   - Compound surnames (Kelly Ann → Kellyann Hage)
#   - Slightly different formal names
NAME_ALIASES: dict[str, str] = {
    "bob merker": "robert merker",
    "matt bruhn": "matthew bruhn",
    "kiki axer": "christine axer",
    "kelly ann": "kellyann hage",
    "jessica munoz": "jessica munoz",  # diacritic normalization (ñ → n)
    # Ayesha (Esshhha_boo2.0) → ayesha-smith.md is already handled by paren-strip
    # + first-last matcher.
}


def normalize_name(raw: str) -> str:
    """Lowercase, drop punctuation, parentheticals, trailing role labels, middle initials."""
    if not raw:
        return ""
    s = raw.lower().strip()
    # Diacritic normalization (ñ → n, é → e, etc.)
    s = (
        s.replace("ñ", "n")
        .replace("é", "e")
        .replace("è", "e")
        .replace("á", "a")
        .replace("à", "a")
        .replace("í", "i")
        .replace("ó", "o")
        .replace("ú", "u")
        .replace("ü", "u")
        .replace("ç", "c")
    )
    s = _PAREN_PATTERN.sub(" ", s)
    s = _TRAILING_NOTES.sub("", s)
    s = _NON_ALNUM_PATTERN.sub(" ", s)
    s = _MIDDLE_INITIAL_PATTERN.sub(" ", s)
    s = _WS_PATTERN.sub(" ", s).strip()
    # Apply alias substitution AFTER normalization
    if s in NAME_ALIASES:
        s = NAME_ALIASES[s]
    return s


def first_last_key(normalized: str) -> str:
    """Return 'first last' (first token + last token) for fuzzy match."""
    tokens = normalized.split()
    if not tokens:
        return ""
    if len(tokens) == 1:
        return tokens[0]
    return f"{tokens[0]} {tokens[-1]}"


# ── Index intake markdown files ────────────────────────────────────
@dataclass(frozen=True)
class IntakeFile:
    path: Path
    raw_filename_name: str  # name derived from filename ("Alex Pettyjohn")
    normalized: str
    first_last: str


def filename_to_name(p: Path) -> str:
    stem = p.stem
    # Strip "-new-phase-2" type suffixes
    stem = re.sub(r"-(new|phase|copy|onboard).*$", "", stem)
    parts = stem.split("-")
    return " ".join(part.capitalize() for part in parts if part)


def build_intake_index() -> tuple[dict[str, IntakeFile], dict[str, IntakeFile], list[IntakeFile]]:
    """Return (by_normalized, by_first_last, all_files)."""
    by_normalized: dict[str, IntakeFile] = {}
    by_first_last: dict[str, IntakeFile] = {}
    all_files: list[IntakeFile] = []

    for d in INTAKE_DIRS:
        if not d.exists():
            log.warning("Intake dir missing: %s", d)
            continue
        # ONLY .md, ONLY direct children (don't recurse from clients/ into backfill/ twice)
        for p in sorted(d.glob("*.md")):
            human = filename_to_name(p)
            norm = normalize_name(human)
            fl = first_last_key(norm)
            entry = IntakeFile(
                path=p, raw_filename_name=human, normalized=norm, first_last=fl
            )
            all_files.append(entry)
            # backfill dir is listed FIRST → top-level entries won't overwrite
            # the (more thorough) backfill versions.
            by_normalized.setdefault(norm, entry)
            by_first_last.setdefault(fl, entry)

    return by_normalized, by_first_last, all_files


def match_client_to_intake(
    client_name: str,
    by_normalized: dict[str, IntakeFile],
    by_first_last: dict[str, IntakeFile],
) -> IntakeFile | None:
    norm = normalize_name(client_name)
    if not norm:
        return None
    if norm in by_normalized:
        return by_normalized[norm]
    fl = first_last_key(norm)
    if fl in by_first_last:
        return by_first_last[fl]
    # Token-level fuzzy: client first token must match intake first token AND
    # last token must match last token.
    client_tokens = norm.split()
    if len(client_tokens) >= 2:
        c_first, c_last = client_tokens[0], client_tokens[-1]
        for entry in by_normalized.values():
            entry_tokens = entry.normalized.split()
            if len(entry_tokens) < 2:
                continue
            if entry_tokens[0] == c_first and entry_tokens[-1] == c_last:
                return entry
    # Single-token fallback: e.g. monday says "Cee", intake is "cee-jay.md"
    if len(client_tokens) == 1:
        target = client_tokens[0]
        candidates = [
            e for e in by_normalized.values()
            if e.normalized.split() and e.normalized.split()[0] == target
        ]
        if len(candidates) == 1:
            return candidates[0]
    return None


# ── Claude prompt + call ───────────────────────────────────────────
def build_prompt(
    client_name: str,
    starting: float | None,
    current: float | None,
    md_content: str,
) -> str:
    md = (md_content or "").strip()[:MD_TRUNCATE_CHARS] or "(no notes available)"
    start_str = f"{starting} lb" if starting is not None else "unknown"
    curr_str = f"{current} lb" if current is not None else "unknown"
    return (
        f"Read this client intake / coaching note and extract their goal weight in pounds.\n\n"
        f"Client: {client_name}\n"
        f"Starting weight: {start_str}\n"
        f"Current weight: {curr_str}\n\n"
        f"Intake notes:\n{md}\n\n"
        "Return ONLY JSON: "
        "{\"goal_weight_lbs\": <number or null>, "
        "\"confidence\": \"high\"|\"medium\"|\"low\"|null, "
        "\"source_quote\": \"<verbatim>\"}\n\n"
        "Rules:\n"
        "- Extract only if EXPLICITLY stated as a number\n"
        "- \"Lose X lbs\" → goal = starting - X (if starting known)\n"
        "- \"Get back to wedding weight Y\" → Y\n"
        "- Ranges like \"180-190\" → midpoint if loss goal\n"
        "- If only body-fat % or jeans size mentioned (no lb number) → null\n"
        "- If multiple goals, pick the most recent / latest one\n"
        "- Don't infer if not stated explicitly"
    )


_JSON_BLOCK_PATTERN = re.compile(r"\{[\s\S]*\}")


def parse_claude_json(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    m = _JSON_BLOCK_PATTERN.search(raw)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def call_claude(client: Anthropic, prompt: str) -> dict[str, Any] | None:
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=CLAUDE_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    parts: list[str] = []
    for block in resp.content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return parse_claude_json("".join(parts))


# ── Result types ───────────────────────────────────────────────────
@dataclass
class ExtractionResult:
    name: str
    monday_item_id: str
    starting_weight_lbs: float | None
    current_weight_lbs: float | None
    intake_path: str | None
    goal_weight_lbs: float | None
    confidence: str | None
    source_quote: str | None
    skipped_reason: str | None = None


@dataclass
class RunStats:
    total_active_missing: int = 0
    matched_to_file: int = 0
    not_matched: list[str] = field(default_factory=list)
    extracted_high: int = 0
    extracted_medium: int = 0
    extracted_low_skipped: int = 0
    no_goal_found: int = 0
    claude_failures: int = 0
    suspicious: list[str] = field(default_factory=list)


def is_suspicious(r: ExtractionResult) -> str | None:
    goal = r.goal_weight_lbs
    if goal is None:
        return None
    if r.starting_weight_lbs is not None and abs(goal - r.starting_weight_lbs) < 0.5:
        return f"goal ({goal}) ≈ starting ({r.starting_weight_lbs}) — no change implied"
    if r.current_weight_lbs is not None and abs(goal - r.current_weight_lbs) < 0.5:
        return f"goal ({goal}) ≈ current ({r.current_weight_lbs}) — possible echo"
    if goal < 80 or goal > 500:
        return f"goal ({goal}) outside plausible 80-500 lb range"
    return None


# ── I/O ────────────────────────────────────────────────────────────
def load_clients_file() -> dict[str, Any]:
    with CLIENTS_JSON_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_clients_file(payload: dict[str, Any]) -> None:
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    CLIENTS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = CLIENTS_JSON_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    tmp_path.replace(CLIENTS_JSON_PATH)


# ── Main ───────────────────────────────────────────────────────────
def main() -> int:
    load_dotenv(dotenv_path=ENV_PATH)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("Missing ANTHROPIC_API_KEY in %s", ENV_PATH)
        return 1

    log.info("Goal-weight backfill from intake markdown files")
    log.info("  Model: %s", CLAUDE_MODEL)

    by_norm, by_fl, all_files = build_intake_index()
    log.info("  Indexed %s intake .md files", len(all_files))
    for d in INTAKE_DIRS:
        count = len(list(d.glob("*.md"))) if d.exists() else 0
        log.info("    - %s → %s files", d, count)

    payload = load_clients_file()
    clients = payload.get("clients") or []

    eligible_idxs: list[int] = []
    for i, c in enumerate(clients):
        if c.get("is_past"):
            continue
        if c.get("goal_weight_lbs") is not None:
            continue
        eligible_idxs.append(i)

    stats = RunStats()
    stats.total_active_missing = len(eligible_idxs)
    log.info("  Active clients missing goal_weight_lbs: %s", stats.total_active_missing)
    log.info("")

    # Match each eligible client to an intake file
    @dataclass
    class Pending:
        idx: int
        name: str
        intake: IntakeFile

    pending: list[Pending] = []
    for idx in eligible_idxs:
        c = clients[idx]
        name = c.get("name") or "(unknown)"
        match = match_client_to_intake(name, by_norm, by_fl)
        if match is None:
            stats.not_matched.append(name)
        else:
            pending.append(Pending(idx=idx, name=name, intake=match))
    stats.matched_to_file = len(pending)

    log.info("Match results:")
    log.info("  matched to intake file: %s", stats.matched_to_file)
    log.info("  NOT matched           : %s", len(stats.not_matched))
    log.info("")

    if not pending:
        log.info("Nothing to extract — exiting.")
        # Still write back so updated_at refreshes? No — preserve file as-is.
        return 0

    claude = Anthropic(api_key=api_key)
    results: list[ExtractionResult] = []

    # Reset JSONL log
    RESULTS_JSONL_PATH.write_text("", encoding="utf-8")

    t0 = time.time()
    for n, item in enumerate(pending, 1):
        record = clients[item.idx]
        name = item.name
        starting = record.get("starting_weight_lbs")
        current = record.get("current_weight_lbs")
        intake_path = item.intake.path

        log.info("[%s/%s] %s ← %s", n, len(pending), name, intake_path.name)

        try:
            md_content = intake_path.read_text(encoding="utf-8")
        except Exception as exc:
            log.warning("  read failed: %s", exc)
            results.append(
                ExtractionResult(
                    name=name,
                    monday_item_id=str(record.get("monday_item_id") or ""),
                    starting_weight_lbs=starting,
                    current_weight_lbs=current,
                    intake_path=str(intake_path),
                    goal_weight_lbs=None,
                    confidence=None,
                    source_quote=None,
                    skipped_reason=f"read_error: {exc}",
                )
            )
            continue

        prompt = build_prompt(name, starting, current, md_content)
        try:
            parsed = call_claude(claude, prompt)
        except Exception as exc:
            log.warning("  Claude call failed: %s", exc)
            stats.claude_failures += 1
            results.append(
                ExtractionResult(
                    name=name,
                    monday_item_id=str(record.get("monday_item_id") or ""),
                    starting_weight_lbs=starting,
                    current_weight_lbs=current,
                    intake_path=str(intake_path),
                    goal_weight_lbs=None,
                    confidence=None,
                    source_quote=None,
                    skipped_reason=f"claude_error: {exc}",
                )
            )
            time.sleep(PER_CLIENT_SLEEP_S)
            continue

        if not parsed:
            stats.claude_failures += 1
            log.info("  → unparseable response")
            results.append(
                ExtractionResult(
                    name=name,
                    monday_item_id=str(record.get("monday_item_id") or ""),
                    starting_weight_lbs=starting,
                    current_weight_lbs=current,
                    intake_path=str(intake_path),
                    goal_weight_lbs=None,
                    confidence=None,
                    source_quote=None,
                    skipped_reason="claude_unparseable_response",
                )
            )
            time.sleep(PER_CLIENT_SLEEP_S)
            continue

        goal_raw = parsed.get("goal_weight_lbs")
        conf_raw = parsed.get("confidence")
        quote_raw = parsed.get("source_quote")

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

        result = ExtractionResult(
            name=name,
            monday_item_id=str(record.get("monday_item_id") or ""),
            starting_weight_lbs=starting,
            current_weight_lbs=current,
            intake_path=str(intake_path),
            goal_weight_lbs=goal,
            confidence=confidence,
            source_quote=quote,
        )
        results.append(result)

        # Decide write-back
        if goal is None:
            stats.no_goal_found += 1
            log.info("  → no goal stated")
        elif confidence == "low":
            stats.extracted_low_skipped += 1
            log.info("  → LOW conf ({} lb) — NOT writing".format(goal))
        else:
            suspicion = is_suspicious(result)
            if suspicion:
                stats.suspicious.append(
                    f"{name}: goal={goal}, conf={confidence} — {suspicion}"
                )
                log.info(
                    "  → SUSPICIOUS ({} lb, {} conf) — {} — writing anyway".format(
                        goal, confidence, suspicion
                    )
                )
            else:
                log.info("  → goal={} lb, conf={}".format(goal, confidence))

            if confidence == "high":
                stats.extracted_high += 1
            elif confidence == "medium":
                stats.extracted_medium += 1

            record["goal_weight_lbs"] = goal
            record["goal_weight_source"] = "intake_md"
            record["goal_weight_confidence"] = confidence
            record["goal_weight_quote"] = quote

        # Persist per-client to JSONL
        with RESULTS_JSONL_PATH.open("a", encoding="utf-8") as rf:
            rf.write(json.dumps({
                "n": n,
                "name": result.name,
                "monday_item_id": result.monday_item_id,
                "intake_path": result.intake_path,
                "starting_weight_lbs": result.starting_weight_lbs,
                "current_weight_lbs": result.current_weight_lbs,
                "goal_weight_lbs": result.goal_weight_lbs,
                "confidence": result.confidence,
                "source_quote": result.source_quote,
                "skipped_reason": result.skipped_reason,
            }) + "\n")

        time.sleep(PER_CLIENT_SLEEP_S)

    elapsed = time.time() - t0

    write_clients_file(payload)
    log.info("")
    log.info("Wrote %s (%.1fs)", CLIENTS_JSON_PATH.name, elapsed)

    # ── Summary ──
    log.info("")
    log.info("=" * 70)
    log.info("Summary")
    log.info("=" * 70)
    log.info("  intake .md files indexed       : %s", len(all_files))
    log.info("  active clients missing goal    : %s", stats.total_active_missing)
    log.info("  matched to a file              : %s", stats.matched_to_file)
    log.info("  NOT matched (need other source): %s", len(stats.not_matched))
    log.info("  extracted (HIGH conf)          : %s", stats.extracted_high)
    log.info("  extracted (MEDIUM conf)        : %s", stats.extracted_medium)
    log.info("  low-conf (skipped)             : %s", stats.extracted_low_skipped)
    log.info("  no goal found in file          : %s", stats.no_goal_found)
    log.info("  Claude failures                : %s", stats.claude_failures)
    log.info("  suspicious (still written)     : %s", len(stats.suspicious))

    if stats.not_matched:
        log.info("")
        log.info("Clients NOT matched to an intake file:")
        for n in stats.not_matched:
            log.info("  - %s", n)

    if stats.suspicious:
        log.info("")
        log.info("Suspicious extractions (sanity check):")
        for s in stats.suspicious:
            log.info("  - %s", s)

    # ── Extracted-goals table ──
    extracted = [
        r for r in results
        if r.goal_weight_lbs is not None and r.confidence != "low"
    ]
    log.info("")
    log.info("All extracted goals (written to monday-clients.json):")
    log.info("")
    if not extracted:
        log.info("  (none extracted)")
    else:
        name_w = max(len(r.name) for r in extracted)
        name_w = max(name_w, 12)
        header = (
            f"  {'name':<{name_w}}  {'start':>6}  {'curr':>6}  {'goal':>6}  "
            f"{'conf':<6}  quote"
        )
        log.info(header)
        log.info("  " + "-" * (name_w + 50))
        for r in extracted:
            start_s = f"{r.starting_weight_lbs:>6.1f}" if r.starting_weight_lbs is not None else f"{'—':>6}"
            curr_s = f"{r.current_weight_lbs:>6.1f}" if r.current_weight_lbs is not None else f"{'—':>6}"
            goal_s = f"{r.goal_weight_lbs:>6.1f}" if r.goal_weight_lbs is not None else f"{'—':>6}"
            quote = (r.source_quote or "").strip().replace("\n", " ")
            if len(quote) > 80:
                quote = quote[:80] + "..."
            log.info(
                f"  {r.name:<{name_w}}  {start_s}  {curr_s}  {goal_s}  "
                f"{(r.confidence or '?'):<6}  {quote}"
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
