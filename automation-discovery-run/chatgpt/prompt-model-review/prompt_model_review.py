#!/usr/bin/env python3
"""Audit Hub prompt/model governance and safely stage OpenRouter replacements."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable


DEFAULT_CATALOG_URL = "https://openrouter.ai/api/v1/models?output_modalities=all"
MODEL_PREFIX = "hub_sys_model_"
PROMPT_PREFIX = "hub_sys_prompt_"
EXCLUDED_DIRS = {
    ".git", "node_modules", "automation-discovery-run", "coverage", "dist", "build",
    ".cache", ".next", "vendor", "__pycache__",
}


class ReviewError(RuntimeError):
    """A safe, user-facing review failure."""


@dataclass(frozen=True)
class Slot:
    feature: str
    scope: str
    label: str
    note: str
    fallback: str
    group_id: str
    group_label: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def json_dump(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def js_string(line: str, field: str) -> str | None:
    match = re.search(rf"\b{re.escape(field)}\s*:\s*'((?:\\.|[^'])*)'", line)
    if not match:
        return None
    raw = match.group(1)
    return raw.replace("\\'", "'").replace("\\n", "\n").replace("\\\\", "\\")


def parse_slots(admin_route: Path) -> list[Slot]:
    if not admin_route.is_file():
        raise ReviewError(f"Admin route not found: {admin_route}")
    slots: list[Slot] = []
    group_id = "unknown"
    group_label = "Unknown"
    for line in admin_route.read_text(encoding="utf-8").splitlines():
        if "slots:" in line:
            next_group = js_string(line, "id")
            next_label = js_string(line, "label")
            if next_group and next_label:
                group_id, group_label = next_group, next_label
        if "feature:" not in line:
            continue
        feature = js_string(line, "feature")
        scope = js_string(line, "scope")
        label = js_string(line, "label")
        note = js_string(line, "note")
        fallback = js_string(line, "fallback")
        if all(value is not None for value in (feature, scope, label, note, fallback)):
            slots.append(Slot(feature, scope, label, note, fallback, group_id, group_label))
    if not slots:
        raise ReviewError(f"No SYSTEM_MODEL_GROUPS slots parsed from {admin_route}")
    return slots


def iter_source_files(repo: Path) -> Iterable[Path]:
    for path in repo.rglob("*.js"):
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if path.is_file():
            yield path


def scan_admin_usages(repo: Path) -> dict[str, list[dict[str, Any]]]:
    patterns = {
        "model": re.compile(r"\bgetSystemModel(?:Id|Key)\(\s*['\"]([^'\"]+)['\"]"),
        "prompt": re.compile(r"\bgetSystemPrompt\(\s*['\"]([^'\"]+)['\"]"),
    }
    result: dict[str, list[dict[str, Any]]] = {"model": [], "prompt": []}
    for path in iter_source_files(repo):
        relative = str(path.relative_to(repo))
        for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for kind, pattern in patterns.items():
                for match in pattern.finditer(line):
                    result[kind].append({"feature": match.group(1), "file": relative, "line": line_no})
    for rows in result.values():
        rows.sort(key=lambda row: (row["feature"], row["file"], row["line"]))
    return result


def open_db_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise ReviewError(f"Hub database not found: {path}")
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def read_hub_config(path: Path) -> dict[str, Any]:
    with open_db_read_only(path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = {"model_config", "crm_context"} - tables
        if missing:
            raise ReviewError(f"Hub database is missing required tables: {', '.join(sorted(missing))}")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(model_config)")}
        wanted = [
            "key", "label", "endpoint", "model_id", "tier", "search", "enabled", "user",
            "category", "cost_input", "cost_output", "context_length",
        ]
        selected = [column for column in wanted if column in columns]
        models = [dict(row) for row in connection.execute(
            f"SELECT {', '.join(selected)} FROM model_config ORDER BY key"
        )]
        context_rows = [dict(row) for row in connection.execute(
            "SELECT user,key,value FROM crm_context WHERE key LIKE ? OR key LIKE ? ORDER BY user,key",
            (f"{MODEL_PREFIX}%", f"{PROMPT_PREFIX}%"),
        )]
    return {"models": models, "context": context_rows, "model_columns": sorted(columns)}


def load_catalog(path: Path | None, url: str, timeout: int = 30) -> tuple[list[dict[str, Any]], str]:
    if path:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReviewError(f"Cannot load catalogue JSON {path}: {exc}") from exc
        source = str(path.resolve())
    else:
        headers = {"User-Agent": "mclellan-prompt-model-review/1.0"}
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
        except Exception as exc:  # urllib exposes several environment-specific exceptions
            raise ReviewError(f"OpenRouter catalogue fetch failed closed: {exc}") from exc
        source = url
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        raise ReviewError("Catalogue is malformed: expected a non-empty data array")
    clean = [row for row in data if isinstance(row, dict) and isinstance(row.get("id"), str)]
    if not clean:
        raise ReviewError("Catalogue contains no usable model rows")
    clean.sort(key=lambda row: row["id"])
    return clean, source


def parse_expiration(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    try:
        if "T" in candidate:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00")).date()
        return date.fromisoformat(candidate[:10])
    except ValueError:
        return None


def architecture(model: dict[str, Any]) -> dict[str, Any]:
    value = model.get("architecture")
    return value if isinstance(value, dict) else {}


def modalities(model: dict[str, Any], key: str) -> set[str]:
    value = architecture(model).get(key)
    if isinstance(value, list):
        return {str(item).lower() for item in value}
    modality = str(architecture(model).get("modality") or "").lower()
    if "->" in modality:
        left, right = modality.split("->", 1)
        return {left} if key == "input_modalities" else {right}
    return set()


def supported_parameters(model: dict[str, Any]) -> set[str]:
    value = model.get("supported_parameters")
    return {str(item) for item in value} if isinstance(value, list) else set()


def infer_requirements(slot: Slot, explicit: dict[str, Any] | None = None) -> dict[str, Any]:
    text = f"{slot.label} {slot.note}".lower()
    requirements: dict[str, Any] = {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "required_parameters": [],
        "parameter_any": [],
        "min_context": 0,
        "max_cost_multiplier": 2.0,
    }
    if "tool calling" in text or "tool-calling" in text:
        requirements["required_parameters"].append("tools")
    if "structured output" in text or "json schema" in text:
        requirements["parameter_any"].append(["structured_outputs", "response_format"])
    if "speech-to-text" in text or "transcrib" in text:
        requirements["input_modalities"] = ["audio"]
        requirements["output_modalities"] = ["transcription"]
    elif "text-to-speech" in text or "(tts)" in text:
        requirements["input_modalities"] = ["text"]
        requirements["output_modalities"] = ["speech"]
    elif "embedding" in text:
        requirements["input_modalities"] = ["text"]
        requirements["output_modalities"] = ["embeddings"]
    elif "vision" in text or "uploaded images" in text:
        requirements["input_modalities"] = ["image", "text"]
        requirements["output_modalities"] = ["text"]
    if explicit:
        for key, value in explicit.items():
            requirements[key] = copy.deepcopy(value)
    requirements["required_parameters"] = sorted(set(requirements["required_parameters"]))
    requirements["input_modalities"] = sorted(set(requirements["input_modalities"]))
    requirements["output_modalities"] = sorted(set(requirements["output_modalities"]))
    return requirements


def load_policy(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"slots": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewError(f"Cannot load policy {path}: {exc}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("slots", {}), dict):
        raise ReviewError("Policy must be an object with an optional slots object")
    return value


def model_lookup(catalog: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    direct: dict[str, dict[str, Any]] = {}
    suffixes: dict[str, list[dict[str, Any]]] = {}
    for model in catalog:
        direct[model["id"]] = model
        canonical = model.get("canonical_slug")
        if isinstance(canonical, str):
            direct.setdefault(canonical, model)
        suffixes.setdefault(model["id"].split("/", 1)[-1], []).append(model)
    return direct, suffixes


def comparable_model_id(model_id: str) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
    """Return author, semantic family words, and version tokens for alias matching."""
    candidate = model_id.lower().lstrip("~")
    candidate = re.sub(r"(?<=\d)-(?=\d{1,2}(?:\D|$))", ".", candidate)
    model_author = author(candidate)
    slug = candidate.split("/", 1)[-1]
    versions = tuple(token for token in re.findall(r"\d+(?:\.\d+)*", slug) if len(token.replace(".", "")) < 8)
    words = tuple(sorted(family_tokens(slug)))
    return model_author, words, versions


def resolve_model(model_id: str, direct: dict[str, dict[str, Any]], suffixes: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    if model_id in direct:
        return direct[model_id]
    candidates = suffixes.get(model_id, [])
    if len(candidates) == 1:
        return candidates[0]
    target = comparable_model_id(model_id)
    semantic_matches: dict[str, dict[str, Any]] = {}
    for candidate in direct.values():
        candidate_ids = [candidate.get("id"), candidate.get("canonical_slug")]
        if any(isinstance(value, str) and comparable_model_id(value) == target for value in candidate_ids):
            semantic_matches[candidate["id"]] = candidate
    return next(iter(semantic_matches.values())) if len(semantic_matches) == 1 else None


def effective_fallback_id(fallback: str, model_by_key: dict[str, dict[str, Any]]) -> tuple[str | None, str]:
    """Resolve display-oriented fallback text to an actual model ID where possible."""
    lowered = fallback.lower()
    if lowered.startswith("prompt only"):
        return None, "prompt-only"
    provider_ids = re.findall(r"~?[a-z0-9_.-]+/[a-z0-9_.:~-]+", fallback, flags=re.IGNORECASE)
    if provider_ids:
        return provider_ids[-1], "fallback"
    first_token = fallback.split()[0].strip("()") if fallback.split() else ""
    configured = model_by_key.get(first_token)
    if configured and configured.get("model_id"):
        return str(configured["model_id"]), "fallback-key"
    if " env" in lowered or " or " in lowered or "(" in fallback:
        return None, "dynamic"
    return fallback, "fallback"




def requirement_failures(model: dict[str, Any], requirements: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    model_inputs = modalities(model, "input_modalities")
    model_outputs = modalities(model, "output_modalities")
    for required in requirements.get("input_modalities", []):
        if required not in model_inputs:
            failures.append(f"missing input modality {required}")
    for required in requirements.get("output_modalities", []):
        if required not in model_outputs:
            failures.append(f"missing output modality {required}")
    parameters = supported_parameters(model)
    for required in requirements.get("required_parameters", []):
        if required not in parameters:
            failures.append(f"missing parameter {required}")
    for alternatives in requirements.get("parameter_any", []):
        if not any(option in parameters for option in alternatives):
            failures.append(f"needs one of parameters {', '.join(alternatives)}")
    minimum = int(requirements.get("min_context") or 0)
    actual = int(model.get("context_length") or 0)
    if minimum and actual < minimum:
        failures.append(f"context {actual} below required {minimum}")
    return failures


def price_per_token(model: dict[str, Any]) -> float | None:
    pricing = model.get("pricing")
    if not isinstance(pricing, dict):
        return None
    values: list[float] = []
    for key in ("prompt", "completion"):
        try:
            values.append(float(pricing[key]))
        except (KeyError, TypeError, ValueError):
            pass
    return sum(values) / len(values) if values else None


def family_tokens(model_id: str) -> set[str]:
    slug = model_id.lower().split("/", 1)[-1]
    tokens = set(re.findall(r"[a-z]+", slug))
    return tokens - {"latest", "preview", "instruct", "chat", "free", "turbo", "mini"}


def author(model_id: str) -> str:
    return model_id.split("/", 1)[0] if "/" in model_id else ""


def model_summary(model: dict[str, Any]) -> dict[str, Any]:
    price = model.get("pricing") if isinstance(model.get("pricing"), dict) else {}
    return {
        "id": model.get("id"),
        "name": model.get("name") or model.get("id"),
        "canonical_slug": model.get("canonical_slug"),
        "expiration_date": model.get("expiration_date"),
        "context_length": model.get("context_length"),
        "input_modalities": sorted(modalities(model, "input_modalities")),
        "output_modalities": sorted(modalities(model, "output_modalities")),
        "supported_parameters": sorted(supported_parameters(model)),
        "pricing": {key: price.get(key) for key in ("prompt", "completion")},
        "created": model.get("created"),
    }


def rank_replacements(
    current_id: str,
    current: dict[str, Any] | None,
    requirements: dict[str, Any],
    catalog: list[dict[str, Any]],
    as_of: date,
    limit: int = 5,
) -> list[dict[str, Any]]:
    current_tokens = family_tokens(current_id)
    current_author = author(current_id)
    current_context = int((current or {}).get("context_length") or requirements.get("min_context") or 0)
    current_price = price_per_token(current or {})
    max_multiplier = float(requirements.get("max_cost_multiplier") or 2.0)
    ranked: list[dict[str, Any]] = []
    for model in catalog:
        candidate_id = model["id"]
        if candidate_id == current_id:
            continue
        expiration = parse_expiration(model.get("expiration_date"))
        if expiration and expiration <= as_of:
            continue
        failures = requirement_failures(model, requirements)
        if failures:
            continue
        candidate_price = price_per_token(model)
        if current_price is not None and current_price > 0 and candidate_price is not None:
            if candidate_price > current_price * max_multiplier:
                continue
        candidate_tokens = family_tokens(candidate_id)
        union = current_tokens | candidate_tokens
        similarity = len(current_tokens & candidate_tokens) / len(union) if union else 0.0
        same_author = bool(current_author and author(candidate_id) == current_author)
        score = 0.35 * similarity + (0.25 if same_author else 0.0)
        reasons = [f"family token similarity {similarity:.2f}"]
        if same_author:
            reasons.append("same model author")
        if current:
            current_arch = architecture(current)
            candidate_arch = architecture(model)
            if current_arch.get("tokenizer") and current_arch.get("tokenizer") == candidate_arch.get("tokenizer"):
                score += 0.08
                reasons.append("same tokenizer")
            if current_arch.get("instruct_type") and current_arch.get("instruct_type") == candidate_arch.get("instruct_type"):
                score += 0.07
                reasons.append("same instruction format")
        candidate_context = int(model.get("context_length") or 0)
        if current_context:
            ratio = min(candidate_context, current_context) / max(candidate_context, current_context) if candidate_context else 0
            score += 0.12 * ratio
            reasons.append(f"context similarity {ratio:.2f}")
        else:
            score += 0.06
        if current_price is not None and candidate_price is not None:
            if current_price == candidate_price:
                price_similarity = 1.0
            else:
                maximum = max(current_price, candidate_price)
                price_similarity = 1.0 - abs(current_price - candidate_price) / maximum if maximum else 1.0
            score += 0.08 * price_similarity
            reasons.append(f"price similarity {price_similarity:.2f}")
        if candidate_id.startswith("~") or candidate_id.endswith("-latest"):
            score += 0.03
            reasons.append("latest-family alias")
        score = min(1.0, score)
        ranked.append({
            **model_summary(model),
            "score": round(score, 4),
            "confidence": "high" if score >= 0.72 else "medium" if score >= 0.55 else "low",
            "reasons": reasons,
            "capability_failures": [],
        })
    ranked.sort(key=lambda row: (-row["score"], str(row["id"])))
    return ranked[:limit]


def admin_links(feature: str) -> dict[str, str]:
    return {
        "catalogue": "/admin/models",
        "system_slot": f"/admin/models/system#sys-{feature}",
        "prompt": f"/admin/models/prompts#prompt-{feature}",
        "tiers": "/admin/models/tiers",
    }


def issue_id(feature: str, code: str) -> str:
    return f"slot:{feature}:{code}"


def review(
    repo: Path,
    hub_db: Path,
    catalog: list[dict[str, Any]],
    catalog_source: str,
    as_of: date,
    policy: dict[str, Any],
) -> dict[str, Any]:
    admin_route = repo / "routes" / "hub-admin.js"
    prompts_file = repo / "lib" / "prompts.js"
    slots = parse_slots(admin_route)
    usages = scan_admin_usages(repo)
    hub = read_hub_config(hub_db)
    direct, suffixes = model_lookup(catalog)
    model_by_key = {str(row.get("key")): row for row in hub["models"]}
    model_by_id = {str(row.get("model_id")): row for row in hub["models"] if row.get("model_id")}
    installed_live_ids: dict[str, dict[str, Any]] = {}
    for configured_id, configured_row in model_by_id.items():
        resolved = resolve_model(configured_id, direct, suffixes)
        if resolved:
            installed_live_ids[resolved["id"]] = configured_row
    assignments: dict[tuple[str, str], str] = {}
    prompt_overrides: set[tuple[str, str]] = set()
    for row in hub["context"]:
        key = str(row["key"])
        owner = str(row["user"])
        if key.startswith(MODEL_PREFIX):
            assignments[(owner, key[len(MODEL_PREFIX):])] = str(row["value"])
        elif key.startswith(PROMPT_PREFIX):
            prompt_overrides.add((owner, key[len(PROMPT_PREFIX):]))

    declared = {slot.feature for slot in slots}
    issues: list[dict[str, Any]] = []
    for kind, rows in usages.items():
        for feature in sorted({row["feature"] for row in rows} - declared):
            refs = [row for row in rows if row["feature"] == feature]
            issues.append({
                "id": f"usage:{feature}:missing_admin_slot",
                "severity": "error",
                "code": "missing_admin_slot",
                "feature": feature,
                "message": f"{kind} usage has no SYSTEM_MODEL_GROUPS admin slot",
                "references": refs,
                "admin_links": admin_links(feature),
                "recommendations": [],
                "auto_installable": False,
            })

    slot_rows: list[dict[str, Any]] = []
    for slot in slots:
        explicit = policy.get("slots", {}).get(slot.feature, {})
        requirements = infer_requirements(slot, explicit)
        resolved_scope = "system" if slot.scope == "system" else "user"
        assigned_key = assignments.get((resolved_scope, slot.feature))
        if assigned_key is None and slot.scope == "user":
            user_matches = [value for (owner, feature), value in assignments.items() if feature == slot.feature and owner != "system"]
            assigned_key = user_matches[0] if len(user_matches) == 1 else None
        assigned = model_by_key.get(assigned_key or "")
        fallback_id, fallback_source = effective_fallback_id(slot.fallback, model_by_key)
        prompt_only = fallback_source == "prompt-only"
        effective_id = str(assigned.get("model_id")) if assigned and assigned.get("enabled") else fallback_id
        effective_source = "assigned" if assigned and assigned.get("enabled") else fallback_source
        live = resolve_model(effective_id, direct, suffixes) if effective_id else None
        health = "not-applicable" if prompt_only else "dynamic" if fallback_source == "dynamic" else "healthy"
        expiration = parse_expiration((live or {}).get("expiration_date"))
        if not prompt_only and effective_id:
            if live is None:
                health = "unavailable"
            elif expiration and expiration <= as_of:
                health = "deprecated"
            elif expiration and (expiration - as_of).days <= 45:
                health = "expiring"
            elif requirement_failures(live, requirements):
                health = "capability-mismatch"
        if live and not requirements.get("min_context"):
            requirements["min_context"] = int(live.get("context_length") or 0)
        installed = bool(effective_id and (
            effective_id in model_by_id or (live is not None and live["id"] in installed_live_ids)
        ))
        row = {
            "feature": slot.feature,
            "label": slot.label,
            "group": {"id": slot.group_id, "label": slot.group_label},
            "scope": slot.scope,
            "note": slot.note,
            "fallback": slot.fallback,
            "effective_model_id": effective_id,
            "effective_source": effective_source,
            "assigned_model_key": assigned_key,
            "admin_catalogue_entry": model_by_id.get(effective_id) if effective_id else None,
            "admin_links": admin_links(slot.feature),
            "prompt_override_present": any(feature == slot.feature for _, feature in prompt_overrides),
            "capability_contract": requirements,
            "live_health": health,
            "live_model": model_summary(live) if live else None,
        }
        slot_rows.append(row)
        if prompt_only or health == "dynamic":
            continue
        codes: list[tuple[str, str, str]] = []
        if health in {"unavailable", "deprecated", "expiring", "capability-mismatch"}:
            severity = "error" if health in {"unavailable", "deprecated", "capability-mismatch"} else "warn"
            codes.append((health, severity, f"Effective model {effective_id} is {health}"))
        if not installed:
            codes.append(("missing_from_admin_catalogue", "warn", f"Effective model {effective_id} is not installed in /admin/models"))
        for code, severity, message in codes:
            if code == "missing_from_admin_catalogue" and live is not None and health == "healthy":
                recommendations = [{
                    **model_summary(live),
                    "score": 1.0,
                    "confidence": "high",
                    "reasons": ["current effective model is live and only needs catalogue installation"],
                    "capability_failures": [],
                }]
            else:
                recommendations = rank_replacements(effective_id or "", live, requirements, catalog, as_of)
            issues.append({
                "id": issue_id(slot.feature, code),
                "severity": severity,
                "code": code,
                "feature": slot.feature,
                "message": message,
                "effective_model_id": effective_id,
                "current_config": {
                    "tier": (assigned or {}).get("tier") or ("deep-research" if "strong" in slot.note.lower() else "everyday"),
                    "search": (assigned or {}).get("search") or "none",
                    "category": (assigned or {}).get("category") or "System models",
                },
                "capability_contract": requirements,
                "admin_links": admin_links(slot.feature),
                "recommendations": recommendations,
                "auto_installable": bool(recommendations and recommendations[0]["score"] >= 0.72),
            })

    slot_rows.sort(key=lambda row: (row["group"]["id"], row["feature"]))
    issues.sort(key=lambda row: (row["severity"], row["id"]))
    source_hashes = {
        str(admin_route.relative_to(repo)): sha256_file(admin_route),
        str(prompts_file.relative_to(repo)): sha256_file(prompts_file) if prompts_file.is_file() else None,
        str(hub_db.resolve()): sha256_file(hub_db),
    }
    return {
        "schema_version": 1,
        "as_of": as_of.isoformat(),
        "catalog_source": catalog_source,
        "catalog_model_count": len(catalog),
        "repo": str(repo.resolve()),
        "hub_db": str(hub_db.resolve()),
        "admin_locations": {
            "catalogue": "/admin/models",
            "system_slots": "/admin/models/system",
            "prompts": "/admin/models/prompts",
            "tiers": "/admin/models/tiers",
        },
        "summary": {
            "slot_count": len(slot_rows),
            "model_config_count": len(hub["models"]),
            "model_usage_count": len(usages["model"]),
            "prompt_usage_count": len(usages["prompt"]),
            "issue_count": len(issues),
            "error_count": sum(row["severity"] == "error" for row in issues),
            "warning_count": sum(row["severity"] == "warn" for row in issues),
            "auto_installable_count": sum(bool(row.get("auto_installable")) for row in issues),
        },
        "slots": slot_rows,
        "usages": usages,
        "issues": issues,
        "source_hashes": source_hashes,
    }


def markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Prompt and model governance review",
        "",
        f"As of: {report['as_of']}",
        f"OpenRouter catalogue: {report['catalog_model_count']} models",
        f"Hub slots: {summary['slot_count']} · model catalogue rows: {summary['model_config_count']} · issues: {summary['issue_count']}",
        "",
        "## Admin locations",
        "",
        "- Catalogue: `/admin/models`",
        "- System slots: `/admin/models/system`",
        "- Prompts: `/admin/models/prompts`",
        "- Tiers: `/admin/models/tiers`",
        "",
        "## Issues",
        "",
        "| Severity | Feature | Finding | Best candidate | Score | Admin |",
        "|---|---|---|---|---:|---|",
    ]
    for issue in report["issues"]:
        candidate = issue.get("recommendations", [{}])[0] if issue.get("recommendations") else {}
        links = issue.get("admin_links", {})
        admin = links.get("system_slot") or links.get("catalogue") or ""
        message = str(issue["message"]).replace("|", "\\|")
        lines.append(
            f"| {issue['severity']} | `{issue.get('feature','')}` | {message} | "
            f"`{candidate.get('id','')}` | {candidate.get('score','')} | `{admin}` |"
        )
    lines.extend(["", "## Slot inventory", "", "| Group | Feature | Effective model | Health | Model admin | Prompt admin |", "|---|---|---|---|---|---|"])
    for slot in report["slots"]:
        links = slot["admin_links"]
        lines.append(
            f"| {slot['group']['label']} | `{slot['feature']}` | `{slot.get('effective_model_id') or ''}` | "
            f"{slot['live_health']} | `{links['system_slot']}` | `{links['prompt']}` |"
        )
    lines.extend(["", "## Safety", "", "This review is read-only. Safe auto-install writes only a disabled catalogue row and never changes a slot assignment or prompt.", ""])
    return "\n".join(lines)


def slugify(model_id: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", model_id.lower()).strip("-")
    return value[:80] or "openrouter-model"


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def safe_auto_install(
    report: dict[str, Any],
    issue_selector: str,
    target_db: Path,
    write_root: Path,
    threshold: float,
) -> dict[str, Any]:
    root = write_root.resolve()
    target = target_db.resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ReviewError(f"Refusing to write outside write root {root}: {target}") from exc
    if not target.is_file():
        raise ReviewError(f"Install database not found: {target}")
    matches = [issue for issue in report.get("issues", []) if issue.get("id") == issue_selector]
    if len(matches) != 1:
        raise ReviewError(f"Issue selector must identify exactly one issue: {issue_selector}")
    issue = matches[0]
    recommendations = issue.get("recommendations") or []
    if not recommendations:
        raise ReviewError(f"Issue has no compatible replacement: {issue_selector}")
    candidate = recommendations[0]
    if float(candidate.get("score") or 0) < threshold:
        raise ReviewError(
            f"Best candidate score {candidate.get('score')} is below install threshold {threshold:.2f}"
        )
    before_hash = sha256_file(target)
    connection = sqlite3.connect(target)
    connection.row_factory = sqlite3.Row
    try:
        columns = table_columns(connection, "model_config")
        if not columns:
            raise ReviewError("Install database has no model_config table")
        context_before = connection.execute(
            "SELECT user,key,value FROM crm_context WHERE key LIKE ? OR key LIKE ? ORDER BY user,key",
            (f"{MODEL_PREFIX}%", f"{PROMPT_PREFIX}%"),
        ).fetchall()
        existing = connection.execute("SELECT key,enabled FROM model_config WHERE model_id = ?", (candidate["id"],)).fetchone()
        if existing:
            result = {"action": "already_present", "key": existing["key"], "enabled": existing["enabled"]}
        else:
            base_key = slugify(candidate["id"])
            key = base_key
            suffix = 2
            while connection.execute("SELECT 1 FROM model_config WHERE key = ?", (key,)).fetchone():
                key = f"{base_key}-{suffix}"
                suffix += 1
            config = issue.get("current_config") or {}
            price = candidate.get("pricing") or {}
            values = {
                "key": key,
                "label": candidate.get("name") or candidate["id"],
                "endpoint": "openrouter",
                "model_id": candidate["id"],
                "tier": config.get("tier") or "everyday",
                "search": config.get("search") or "none",
                "enabled": 0,
                "user": None,
                "category": config.get("category") or "Proposed replacements",
                "cost_input": float(price["prompt"]) * 1_000_000 if price.get("prompt") not in (None, "") else None,
                "cost_output": float(price["completion"]) * 1_000_000 if price.get("completion") not in (None, "") else None,
                "context_length": candidate.get("context_length"),
            }
            insert_columns = [column for column in values if column in columns]
            placeholders = ",".join("?" for _ in insert_columns)
            with connection:
                connection.execute(
                    f"INSERT INTO model_config ({','.join(insert_columns)}) VALUES ({placeholders})",
                    [values[column] for column in insert_columns],
                )
            result = {"action": "inserted_disabled", "key": key, "enabled": 0}
        context_after = connection.execute(
            "SELECT user,key,value FROM crm_context WHERE key LIKE ? OR key LIKE ? ORDER BY user,key",
            (f"{MODEL_PREFIX}%", f"{PROMPT_PREFIX}%"),
        ).fetchall()
        if [tuple(row) for row in context_before] != [tuple(row) for row in context_after]:
            raise ReviewError("Safety invariant failed: slot or prompt assignments changed")
    finally:
        connection.close()
    return {
        "issue_id": issue_selector,
        "candidate": candidate,
        "result": result,
        "database": str(target),
        "before_sha256": before_hash,
        "after_sha256": sha256_file(target),
        "slot_and_prompt_assignments_unchanged": True,
    }


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected YYYY-MM-DD") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    review_parser = subparsers.add_parser("review", help="Run a read-only governance review")
    review_parser.add_argument("--repo", type=Path, required=True)
    review_parser.add_argument("--hub-db", type=Path, required=True)
    review_parser.add_argument("--catalog-json", type=Path)
    review_parser.add_argument("--catalog-url", default=DEFAULT_CATALOG_URL)
    review_parser.add_argument("--save-catalog", type=Path, help="Save the normalized catalogue for repeatable offline reviews")
    review_parser.add_argument("--policy", type=Path)
    review_parser.add_argument("--as-of", type=parse_date, default=date.today())
    review_parser.add_argument("--output", type=Path, required=True, help="Output JSON path")
    review_parser.add_argument("--markdown", type=Path, help="Optional Markdown output path")

    install_parser = subparsers.add_parser("auto-install", help="Install the best verified candidate as disabled")
    install_parser.add_argument("--report", type=Path, required=True)
    install_parser.add_argument("--issue", required=True)
    install_parser.add_argument("--target-db", type=Path, required=True)
    install_parser.add_argument("--write-root", type=Path, required=True)
    install_parser.add_argument("--threshold", type=float, default=0.72)
    install_parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "review":
            repo = args.repo.resolve()
            hub_db = args.hub_db.resolve()
            catalog, source = load_catalog(args.catalog_json, args.catalog_url)
            if args.save_catalog:
                args.save_catalog.parent.mkdir(parents=True, exist_ok=True)
                args.save_catalog.write_text(json_dump({"data": catalog}), encoding="utf-8")
            report = review(repo, hub_db, catalog, source, args.as_of, load_policy(args.policy))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json_dump(report), encoding="utf-8")
            if args.markdown:
                args.markdown.parent.mkdir(parents=True, exist_ok=True)
                args.markdown.write_text(markdown_report(report), encoding="utf-8")
            print(json.dumps({"ok": True, "output": str(args.output), **report["summary"]}, sort_keys=True))
            return 0
        report = json.loads(args.report.read_text(encoding="utf-8"))
        result = safe_auto_install(report, args.issue, args.target_db, args.write_root, args.threshold)
        rendered = json_dump(result)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8")
        print(rendered, end="")
        return 0
    except (ReviewError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
