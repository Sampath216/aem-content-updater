
"""
Bulk session keyed by client page-load session id (not durable).
- Full browser reload → new client id → empty session (fresh).
- "Clear bulk session" → new client id mid-page without reload.
- Delta preview only within the same page-load session after an apply.
"""
from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, Optional

from backend.app.services.excel_bulk_service import parse_add_sheets, parse_workbook

# session_id -> { file_hash, applied_at, snapshot, username }
_SESSIONS: Dict[str, dict] = {}


def _file_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()[:16]


def _snapshot_from_excel(content: bytes) -> dict:
    snap = {"adds": {}, "updates": {}, "seo": {}}
    adds = parse_add_sheets(content)
    for row in adds.get("rows") or []:
        key = f"add|{row.get('page_path')}|{row.get('component')}|{row.get('excel_row')}"
        snap["adds"][key] = {
            "page_path": row.get("page_path"),
            "component": row.get("component"),
            "sheet": row.get("sheet"),
            "properties": dict(row.get("properties") or {}),
        }
    parsed = parse_workbook(content)
    for row in parsed.get("page_rows") or []:
        key = f"seo|{row.get('page_path')}|{row.get('excel_row')}"
        snap["seo"][key] = {
            "page_path": row.get("page_path"),
            "properties": dict(row.get("properties") or {}),
        }
    for row in parsed.get("component_rows") or []:
        key = (
            f"upd|{row.get('page_path')}|{row.get('resourceType')}|"
            f"{row.get('instance')}|{row.get('excel_row')}"
        )
        snap["updates"][key] = {
            "page_path": row.get("page_path"),
            "resourceType": row.get("resourceType"),
            "instance": row.get("instance"),
            "properties": dict(row.get("properties") or {}),
        }
    return snap


def get_session(session_id: Optional[str]) -> Optional[dict]:
    if not session_id:
        return None
    return _SESSIONS.get(session_id)


def clear_session(session_id: Optional[str]) -> dict:
    if session_id and session_id in _SESSIONS:
        del _SESSIONS[session_id]
    return {
        "status": "success",
        "message": "Bulk session cleared — next preview is a full baseline (same page, no reload needed)",
    }


def mark_applied(session_id: Optional[str], content: bytes, username: str = "") -> dict:
    if not session_id:
        return {"status": "error", "message": "Missing bulk session id"}
    snap = _snapshot_from_excel(content)
    _SESSIONS[session_id] = {
        "file_hash": _file_hash(content),
        "applied_at": time.time(),
        "snapshot": snap,
        "username": username or "",
    }
    return {"status": "success", "message": "Session snapshot saved after apply"}


def diff_against_session(session_id: Optional[str], content: bytes) -> dict:
    current = _snapshot_from_excel(content)
    sess = get_session(session_id)
    if not sess or not sess.get("snapshot"):
        return {
            "status": "success",
            "mode": "full",
            "message": "No prior apply in this page session — full preview",
            "changed": [],
            "unchanged_count": 0,
            "current_snapshot_keys": (
                len(current["adds"]) + len(current["updates"]) + len(current["seo"])
            ),
        }

    prev = sess["snapshot"]
    changed = []

    def compare_section(section: str, cur_map: dict, prev_map: dict):
        for key, cur in cur_map.items():
            old = prev_map.get(key)
            if not old:
                changed.append({
                    "section": section,
                    "key": key,
                    "change_type": "new_row",
                    "page_path": cur.get("page_path"),
                    "component": cur.get("component") or cur.get("resourceType"),
                    "properties": cur.get("properties") or {},
                })
                continue
            old_props = old.get("properties") or {}
            new_props = cur.get("properties") or {}
            field_diffs = {}
            for fk in set(old_props) | set(new_props):
                ov = old_props.get(fk)
                nv = new_props.get(fk)
                if str(ov if ov is not None else "").strip() != str(nv if nv is not None else "").strip():
                    field_diffs[fk] = {"from": ov, "to": nv}
            if field_diffs:
                changed.append({
                    "section": section,
                    "key": key,
                    "change_type": "field_update",
                    "page_path": cur.get("page_path"),
                    "component": cur.get("component") or cur.get("resourceType"),
                    "field_diffs": field_diffs,
                    "properties": new_props,
                })

    compare_section("add", current["adds"], prev.get("adds") or {})
    compare_section("update", current["updates"], prev.get("updates") or {})
    compare_section("seo", current["seo"], prev.get("seo") or {})

    total_cur = len(current["adds"]) + len(current["updates"]) + len(current["seo"])
    return {
        "status": "success",
        "mode": "delta" if changed else "unchanged",
        "message": (
            f"{len(changed)} row(s) changed since last apply in this page session"
            if changed
            else "No field changes vs last apply in this page session"
        ),
        "changed": changed,
        "unchanged_hint": "Only listed fields need re-apply",
        "previous_applied_at": sess.get("applied_at"),
        "current_snapshot_keys": total_cur,
    }
