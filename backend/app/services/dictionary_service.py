"""
Persistent field dictionary service.
Stores CA aliases for dialog field names. Continuous save to JSON file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

_DATA_DIR = Path(__file__).resolve().parent
_DICT_PATH = _DATA_DIR / "field_dictionary.json"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())



def get_dict_path() -> Path:
    return _DICT_PATH



def load_dictionary() -> dict:
    if _DICT_PATH.exists():
        return json.loads(_DICT_PATH.read_text(encoding="utf-8"))
    return {
        "_meta": {
            "description": "Maps dialog field names to CA-friendly labels",
            "version": 1,
        }
    }



def save_dictionary(data: dict) -> dict:
    _DICT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if "_meta" not in data:
        data["_meta"] = {"description": "Maps dialog field names to CA-friendly labels", "version": 1}
    _DICT_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"status": "success", "message": "Dictionary saved", "path": str(_DICT_PATH)}



def list_components(data: Optional[dict] = None) -> List[dict]:
    data = data or load_dictionary()
    out = []
    for rt, entry in data.items():
        if rt == "_meta" or not isinstance(entry, dict):
            continue
        fields = entry.get("fields") or {}
        out.append({
            "resourceType": rt,
            "label": entry.get("label") or rt.split("/")[-1],
            "field_count": len(fields),
            "fields": [
                {
                    "field_name": fn,
                    "ca_labels": aliases if isinstance(aliases, list) else [str(aliases)],
                    "preferred": (aliases[0] if isinstance(aliases, list) and aliases else fn),
                }
                for fn, aliases in fields.items()
            ],
        })
    return out



def upsert_component(resource_type: str, label: str, fields: dict) -> dict:
    data = load_dictionary()
    existing = data.get(resource_type) or {"label": label, "fields": {}}
    existing["label"] = label or existing.get("label") or resource_type
    existing_fields = existing.get("fields") or {}
    for fn, aliases in (fields or {}).items():
        if not fn:
            continue
        if isinstance(aliases, str):
            aliases = [a.strip() for a in aliases.split(",") if a.strip()]
        if not isinstance(aliases, list):
            aliases = [str(aliases)]
        prev = existing_fields.get(fn) or []
        if not isinstance(prev, list):
            prev = [str(prev)]
        merged = []
        seen = set()
        for a in list(aliases) + list(prev):
            k = _norm(str(a))
            if k and k not in seen:
                seen.add(k)
                merged.append(str(a).strip())
        existing_fields[fn] = merged or [fn]
    existing["fields"] = existing_fields
    data[resource_type] = existing
    save_dictionary(data)
    return {"status": "success", "resourceType": resource_type, "fields": existing_fields}



def update_field_aliases(resource_type: str, field_name: str, ca_labels: List[str]) -> dict:
    data = load_dictionary()
    if resource_type not in data or resource_type == "_meta":
        return {"status": "error", "message": f"Component not in dictionary: {resource_type}"}
    entry = data[resource_type]
    fields = entry.get("fields") or {}
    if isinstance(ca_labels, str):
        ca_labels = [a.strip() for a in ca_labels.split(",") if a.strip()]
    cleaned = []
    seen = set()
    for a in ca_labels:
        k = _norm(str(a))
        if k and k not in seen:
            seen.add(k)
            cleaned.append(str(a).strip())
    if not cleaned:
        cleaned = [field_name]
    fields[field_name] = cleaned
    entry["fields"] = fields
    data[resource_type] = entry
    save_dictionary(data)
    return {"status": "success", "resourceType": resource_type, "field_name": field_name, "ca_labels": cleaned}



def resolve_label(resource_type: str, ca_label: str) -> Optional[str]:
    data = load_dictionary()
    entry = data.get(resource_type) or {}
    fields = entry.get("fields") or {}
    key = _norm(ca_label)
    for fn, aliases in fields.items():
        if _norm(fn) == key:
            return fn
        alist = aliases if isinstance(aliases, list) else [str(aliases)]
        for a in alist:
            if _norm(str(a)) == key:
                return fn
    return None



def sync_from_catalog_fields(resource_type: str, label: str, field_names: List[str]) -> dict:
    data = load_dictionary()
    entry = data.get(resource_type) or {"label": label or resource_type, "fields": {}}
    entry["label"] = label or entry.get("label") or resource_type
    fields = entry.get("fields") or {}
    added = []
    for fn in field_names:
        if not fn:
            continue
        if fn not in fields:
            fields[fn] = [fn]
            added.append(fn)
    entry["fields"] = fields
    data[resource_type] = entry
    save_dictionary(data)
    return {"status": "success", "added": added, "resourceType": resource_type}

