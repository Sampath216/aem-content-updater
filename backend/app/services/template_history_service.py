"""Store previously generated Excel template definitions for reuse. Most-used first."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

HISTORY_PATH = Path(__file__).resolve().parent / "template_history.json"


def _empty() -> dict:
    return {"templates": []}


def load_history() -> dict:
    if not HISTORY_PATH.exists():
        return _empty()
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or "templates" not in data:
            return _empty()
        return data
    except Exception:
        return _empty()


def save_history(data: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def list_templates() -> List[dict]:
    templates = list(load_history().get("templates") or [])
    templates.sort(
        key=lambda t: (int(t.get("use_count") or 0), str(t.get("last_used") or "")),
        reverse=True,
    )
    return templates


def get_template(template_id: str) -> Optional[dict]:
    for t in load_history().get("templates") or []:
        if t.get("id") == template_id:
            return t
    return None


def _fingerprint(selections: List[dict], include_seo: bool) -> str:
    parts = [f"seo={1 if include_seo else 0}"]
    for s in sorted(selections, key=lambda x: x.get("resourceType") or ""):
        fields = sorted(s.get("fields") or [])
        parts.append(f"{s.get('resourceType')}:{','.join(fields)}")
    return "|".join(parts)


def save_template(
    name: str,
    selections: List[dict],
    include_seo: bool = False,
    source: str = "dictionary",
) -> dict:
    data = load_history()
    now = datetime.utcnow().isoformat()
    fingerprint = _fingerprint(selections, include_seo)
    for t in data["templates"]:
        if t.get("fingerprint") == fingerprint:
            t["use_count"] = int(t.get("use_count") or 0) + 1
            t["last_used"] = now
            if name:
                t["name"] = name
            save_history(data)
            return {"status": "success", "template": t, "message": "Existing template usage updated"}

    tid = "tpl_" + datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    entry = {
        "id": tid,
        "name": name or f"Template {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}",
        "created_at": now,
        "last_used": now,
        "use_count": 1,
        "include_seo": bool(include_seo),
        "source": source,
        "selections": selections,
        "fingerprint": fingerprint,
        "summary": {
            "component_count": len(selections),
            "field_count": sum(len(s.get("fields") or []) for s in selections),
            "labels": [s.get("label") or s.get("resourceType") for s in selections],
        },
    }
    data["templates"].insert(0, entry)
    save_history(data)
    return {"status": "success", "template": entry, "message": "Template saved"}


def mark_used(template_id: str) -> dict:
    data = load_history()
    for t in data["templates"]:
        if t.get("id") == template_id:
            t["use_count"] = int(t.get("use_count") or 0) + 1
            t["last_used"] = datetime.utcnow().isoformat()
            save_history(data)
            return {"status": "success", "template": t}
    return {"status": "error", "message": "Template not found"}


def delete_template(template_id: str) -> dict:
    data = load_history()
    before = len(data["templates"])
    data["templates"] = [t for t in data["templates"] if t.get("id") != template_id]
    if len(data["templates"]) == before:
        return {"status": "error", "message": "Template not found"}
    save_history(data)
    return {"status": "success", "message": "Template deleted"}
