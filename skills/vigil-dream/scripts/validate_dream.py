#!/usr/bin/env python3
"""Validate a Vigil Dream v2.1 batch against its Host-prepared context."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "2.1"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
EVIDENCE_ID = re.compile(r"^ev-[0-9a-f]{16}$")
ACCEPTED_OUTCOMES = {"findings", "state_updated", "duplicate_only", "no_finding"}
BLOCKED_OUTCOME = "blocked_incomplete_sources"
FORECAST_OUTCOMES = {"supported", "contradicted", "inconclusive", "not_observable"}


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: root must be an object")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def context_hash(context: dict[str, Any]) -> str:
    unsigned = dict(context)
    unsigned.pop("context_hash", None)
    return hashlib.sha256(canonical_json(unsigned).encode("utf-8")).hexdigest()


def exact_keys(value: Any, keys: set[str], path: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{path}: must be an object")
        return
    missing = keys - set(value)
    extra = set(value) - keys
    if missing:
        errors.append(f"{path}: missing properties {sorted(missing)}")
    if extra:
        errors.append(f"{path}: unexpected properties {sorted(extra)}")


def evidence_refs(change: dict[str, Any]) -> set[str]:
    revision = change.get("revision") or {}
    refs = set(revision.get("evidence_ids") or [])
    refs.update(revision.get("counter_evidence_ids") or [])
    for fact in revision.get("facts") or revision.get("findings") or []:
        refs.update(fact.get("evidence_ids") or [])
    for evaluation in revision.get("forecast_evaluations") or []:
        refs.update(evaluation.get("evidence_ids") or [])
    return refs


def pool(context: dict[str, Any], name: str) -> set[str]:
    values = (context.get("issued_ids") or {}).get(name) or []
    return {str(value) for value in values}


def known_by_id(context: dict[str, Any], name: str) -> dict[str, dict[str, Any]]:
    values = (context.get("known_state") or {}).get(name) or []
    return {value.get("id"): value for value in values if isinstance(value, dict) and value.get("id")}


def validate_context(context: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    exact_keys(context, {"kind", "schema_version", "run", "input_manifest", "evidence_catalog", "known_state", "issued_ids", "limits", "context_hash"}, "context", errors)
    if context.get("kind") != "dream_context":
        errors.append("context.kind: must be dream_context")
    if context.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"context.schema_version: must be {SCHEMA_VERSION}")
    actual_hash = context_hash(context)
    if context.get("context_hash") != actual_hash:
        errors.append("context.context_hash: does not match canonical Host context")
    evidence_ids: set[str] = set()
    source_keys: set[str] = set()
    for index, item in enumerate(context.get("evidence_catalog") or []):
        evidence_id = item.get("id") if isinstance(item, dict) else None
        source_key = item.get("source_key") if isinstance(item, dict) else None
        if not isinstance(evidence_id, str) or not EVIDENCE_ID.match(evidence_id):
            errors.append(f"context.evidence_catalog[{index}].id: invalid")
        elif evidence_id in evidence_ids:
            errors.append(f"context.evidence_catalog[{index}].id: duplicate")
        else:
            evidence_ids.add(evidence_id)
        if not source_key:
            errors.append(f"context.evidence_catalog[{index}].source_key: missing")
        elif source_key in source_keys:
            errors.append(f"context.evidence_catalog[{index}].source_key: duplicate")
        else:
            source_keys.add(source_key)
        if source_key and evidence_id:
            expected = "ev-" + hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:16]
            if evidence_id != expected:
                errors.append(f"context.evidence_catalog[{index}].id: does not match source_key")
    return errors


def validate_supersession(changes: list[dict[str, Any]], entity_key: str, path: str, errors: list[str]) -> None:
    by_id = {change.get(entity_key): change for change in changes}
    supersedes: dict[str, str] = {}
    superseded_by: dict[str, str] = {}
    for change in changes:
        entity_id = change.get(entity_key)
        revision = change.get("revision") or {}
        old_id = revision.get("supersedes")
        new_id = revision.get("superseded_by")
        if old_id:
            if old_id in supersedes and supersedes[old_id] != entity_id:
                errors.append(f"{path}: one entity cannot be superseded by multiple replacements")
            supersedes[old_id] = entity_id
        if new_id:
            superseded_by[entity_id] = new_id
    for old_id, new_id in supersedes.items():
        old = by_id.get(old_id)
        if not old or (old.get("revision") or {}).get("superseded_by") != new_id:
            errors.append(f"{path}: supersession must include paired old superseded_by revision")
    for old_id, new_id in superseded_by.items():
        new = by_id.get(new_id)
        if not new or (new.get("revision") or {}).get("supersedes") != old_id:
            errors.append(f"{path}: superseded_by must have paired replacement revision")
    for start in supersedes:
        seen: set[str] = set()
        current = start
        while current in supersedes:
            if current in seen:
                errors.append(f"{path}: supersession cycle detected")
                break
            seen.add(current)
            current = supersedes[current]


def validate_batch(batch: dict[str, Any], context: dict[str, Any]) -> list[str]:
    errors = validate_context(context)
    exact_keys(batch, {"kind", "schema_version", "run", "signal_changes", "topic_decision", "topic_changes"}, "batch", errors)
    if batch.get("kind") != "dream_batch":
        errors.append("batch.kind: must be dream_batch")
    if batch.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"batch.schema_version: must be {SCHEMA_VERSION}")

    run = batch.get("run") or {}
    run_keys = {"id", "scope", "generated_at", "horizon", "context_hash", "idempotency_key", "known_state", "cursor", "outcome", "notes", "candidates", "suppression_groups"}
    exact_keys(run, run_keys, "batch.run", errors)
    prepared = context.get("run") or {}
    bindings = {
        "id": prepared.get("id"),
        "scope": prepared.get("scope"),
        "horizon": prepared.get("horizon"),
        "context_hash": context.get("context_hash"),
        "idempotency_key": prepared.get("idempotency_key"),
        "known_state": prepared.get("known_state"),
    }
    for name, expected in bindings.items():
        if run.get(name) != expected:
            errors.append(f"batch.run.{name}: must equal Host-prepared value")
    cursor = run.get("cursor") or {}
    if cursor.get("before") != prepared.get("cursor_before"):
        errors.append("batch.run.cursor.before: must equal Host-prepared cursor")
    if cursor.get("candidate_after") != (prepared.get("horizon") or {}).get("end"):
        errors.append("batch.run.cursor.candidate_after: must equal Host horizon end")

    signals = batch.get("signal_changes") if isinstance(batch.get("signal_changes"), list) else []
    topics = batch.get("topic_changes") if isinstance(batch.get("topic_changes"), list) else []
    outcome = run.get("outcome")
    if outcome == BLOCKED_OUTCOME:
        if cursor.get("advance_on_publish") is not False:
            errors.append("blocked run must not advance cursor")
        if signals or topics:
            errors.append("blocked run cannot contain Signal or Topic changes")
    elif outcome in ACCEPTED_OUTCOMES:
        if cursor.get("advance_on_publish") is not True:
            errors.append("accepted run must advance cursor")
    else:
        errors.append("batch.run.outcome: invalid")

    limits = context.get("limits") or {}
    if len(signals) > int(limits.get("max_signal_changes", 0)):
        errors.append("signal_changes: exceeds Host limit")
    if len(topics) > int(limits.get("max_topic_changes", 0)):
        errors.append("topic_changes: exceeds Host limit")

    candidates = {candidate.get("id"): candidate for candidate in run.get("candidates") or [] if isinstance(candidate, dict)}
    issued_candidates = pool(context, "candidates")
    if set(candidates) - issued_candidates:
        errors.append("batch.run.candidates: contains IDs not issued by Host")

    evidence = {item.get("id"): item for item in context.get("evidence_catalog") or [] if isinstance(item, dict)}
    source_keys = {item.get("source_key") for item in evidence.values()}
    for group in run.get("suppression_groups") or []:
        if group.get("id") not in pool(context, "suppression_groups"):
            errors.append("suppression group uses an ID not issued by Host")
        if group.get("canonical_source_key") not in source_keys:
            errors.append("suppression group canonical source is not in Host evidence")
        unknown = set(group.get("suppressed_source_keys") or []) - source_keys
        if unknown:
            errors.append("suppression group references unknown Host evidence")
        canonical = next((item for item in evidence.values() if item.get("source_key") == group.get("canonical_source_key")), None)
        if canonical and canonical.get("canonical") is not True:
            errors.append("suppression group canonical source is not canonical in Host evidence")
        for source_key in group.get("suppressed_source_keys") or []:
            item = next((entry for entry in evidence.values() if entry.get("source_key") == source_key), None)
            if item and (item.get("canonical") is not False or item.get("duplicate_of") != canonical.get("id")):
                errors.append("suppression group is inconsistent with Host duplicate lineage")

    known_signals = known_by_id(context, "signals")
    known_topics = known_by_id(context, "topics")
    known_forecasts = known_by_id(context, "forecasts")
    fingerprints: dict[str, str] = {}
    for signal_id, signal in known_signals.items():
        fp = signal.get("fingerprint") or {}
        for value in [fp.get("current"), *(fp.get("aliases") or [])]:
            if value:
                fingerprints[value] = signal_id

    touched_signals: set[str] = set()
    evaluated: set[str] = set()
    for index, change in enumerate(signals):
        path = f"signal_changes[{index}]"
        candidate_id = change.get("candidate_id")
        if candidate_id not in candidates:
            errors.append(f"{path}.candidate_id: must reference run candidate")
        if change.get("change_id") not in pool(context, "signal_changes"):
            errors.append(f"{path}.change_id: not issued for Signal changes")
        revision = change.get("revision") or {}
        if revision.get("id") not in pool(context, "signal_revisions"):
            errors.append(f"{path}.revision.id: not issued for Signal revisions")
        signal_id = change.get("signal_id")
        touched_signals.add(signal_id)
        if change.get("change_type") == "create":
            if signal_id not in pool(context, "signals") or signal_id in known_signals:
                errors.append(f"{path}.signal_id: invalid create identity")
        elif signal_id not in known_signals:
            errors.append(f"{path}.signal_id: update target is unknown")
        fp = revision.get("fingerprint") or {}
        current = fp.get("current")
        if not isinstance(current, str) or not HEX64.match(current):
            errors.append(f"{path}.revision.fingerprint.current: invalid")
        owner = fingerprints.get(current)
        if owner and owner != signal_id:
            errors.append(f"{path}.revision.fingerprint.current: already belongs to Signal {owner}")
        previous = known_signals.get(signal_id, {}).get("fingerprint") or {}
        if previous.get("current") and previous.get("current") != current and previous.get("current") not in (fp.get("aliases") or []):
            errors.append(f"{path}.revision.fingerprint.aliases: previous current fingerprint must be retained")
        refs = evidence_refs(change)
        if refs - set(evidence):
            errors.append(f"{path}: references evidence not issued by Host")
        if change.get("change_type") in {"create", "update"}:
            canonical_evidence = [evidence[item] for item in refs if item in evidence and evidence[item].get("canonical") is True]
            groups = {item.get("independence_group") for item in canonical_evidence if item.get("independence_group")}
            has_strong = any(int(item.get("tier", 99)) <= 2 for item in canonical_evidence)
            direct_high = any(int(item.get("tier", 99)) == 1 and item.get("directness") == "direct" for item in canonical_evidence) and float(revision.get("importance", 0)) >= 0.75
            if not ((len(groups) >= 2 and has_strong) or direct_high):
                errors.append(f"{path}: does not satisfy Signal promotion evidence gate")
        for evaluation in revision.get("forecast_evaluations") or []:
            if evaluation.get("id") not in pool(context, "forecast_evaluations"):
                errors.append(f"{path}: forecast evaluation ID not issued by Host")
            forecast_id = evaluation.get("forecast_id")
            if forecast_id not in known_forecasts:
                errors.append(f"{path}: forecast evaluation target is unknown")
            if evaluation.get("outcome") not in FORECAST_OUTCOMES:
                errors.append(f"{path}: invalid forecast evaluation outcome")
            if forecast_id in evaluated:
                errors.append(f"{path}: forecast evaluated more than once")
            evaluated.add(forecast_id)
        for forecast in revision.get("forecasts") or []:
            if forecast.get("id") not in pool(context, "forecasts") or forecast.get("id") in known_forecasts:
                errors.append(f"{path}: new forecast ID not issued or already known")

    horizon_end = (prepared.get("horizon") or {}).get("end", "")
    for forecast_id, forecast in known_forecasts.items():
        due = bool(forecast.get("due_at") and forecast.get("due_at") <= horizon_end)
        touched = forecast.get("signal_id") in touched_signals
        if forecast.get("status", "open") == "open" and (due or touched) and forecast_id not in evaluated and outcome != BLOCKED_OUTCOME:
            errors.append(f"forecast {forecast_id}: due or touched open forecast must be evaluated")

    created_signal_ids = {change.get("signal_id") for change in signals if change.get("change_type") == "create"}
    for index, change in enumerate(topics):
        path = f"topic_changes[{index}]"
        if change.get("candidate_id") not in candidates:
            errors.append(f"{path}.candidate_id: must reference run candidate")
        if change.get("change_id") not in pool(context, "topic_changes"):
            errors.append(f"{path}.change_id: not issued for Topic changes")
        revision = change.get("revision") or {}
        if revision.get("id") not in pool(context, "topic_revisions"):
            errors.append(f"{path}.revision.id: not issued for Topic revisions")
        topic_id = change.get("topic_id")
        if change.get("change_type") == "create":
            if topic_id not in pool(context, "topics") or topic_id in known_topics:
                errors.append(f"{path}.topic_id: invalid create identity")
        elif topic_id not in known_topics:
            errors.append(f"{path}.topic_id: update target is unknown")
        unknown_signals = set(revision.get("signal_ids") or []) - (set(known_signals) | created_signal_ids)
        if unknown_signals:
            errors.append(f"{path}: references unknown Signals")
        if evidence_refs(change) - set(evidence):
            errors.append(f"{path}: references evidence not issued by Host")

    action = (batch.get("topic_decision") or {}).get("action")
    if action == "none" and topics:
        errors.append("topic_decision none cannot contain topic_changes")
    if action != "none" and not topics:
        errors.append("topic_decision requires a matching topic change")
    if outcome in {"duplicate_only", "no_finding"} and (signals or topics):
        errors.append(f"{outcome} run cannot contain entity changes")
    if outcome in {"findings", "state_updated"} and not (signals or topics or evaluated):
        errors.append(f"{outcome} run must contain a material state change")
    validate_supersession(signals, "signal_id", "signal_changes", errors)
    validate_supersession(topics, "topic_id", "topic_changes", errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("batch", type=Path)
    parser.add_argument("--context", type=Path, required=True)
    args = parser.parse_args()
    try:
        batch = read_json(args.batch)
        context = read_json(args.context)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 1
    errors = validate_batch(batch, context)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"OK: {args.batch} is a context-bound Dream v{SCHEMA_VERSION} batch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
