"""
Central audit writer — every change made through the tool should call write_audit().

component_path : AEM path (page, component, DAM asset, folder)
property_name  : field name OR action code (__page_create__, __dam_upload__, __component_add__, …)
old_value / new_value : human-readable strings
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from backend.app.models.audit import SessionLocal, AuditLog


# Standard action codes (shown in Audit Log "Field" column)
ACTION_PAGE_CREATE = "__page_create__"
ACTION_PAGE_FOLDER = "__page_folder__"
ACTION_DAM_FOLDER = "__dam_folder__"
ACTION_DAM_UPLOAD = "__dam_upload__"
ACTION_COMPONENT_ADD = "__component_add__"
ACTION_BULK_NOTE = "__bulk__"


def write_audit(
    *,
    component_path: str,
    property_name: str,
    old_value: Any = None,
    new_value: Any = None,
    success: bool = True,
    message: str = "",
    performed_by: str = "system",
) -> None:
    """Persist one audit row. Never raises to callers (logging must not break apply)."""
    try:
        db = SessionLocal()
        try:
            entry = AuditLog(
                timestamp=datetime.utcnow(),
                component_path=(component_path or "")[:2000],
                property_name=(property_name or "")[:500],
                old_value=None if old_value is None else str(old_value)[:4000],
                new_value=None if new_value is None else str(new_value)[:4000],
                success=bool(success),
                message=(message or "")[:2000],
                performed_by=(performed_by or "system")[:255],
            )
            db.add(entry)
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


def write_audit_many(rows: list, performed_by: str = "system") -> None:
    """Batch insert; each item is a dict of write_audit kwargs (performed_by optional)."""
    if not rows:
        return
    try:
        db = SessionLocal()
        try:
            for r in rows:
                entry = AuditLog(
                    timestamp=datetime.utcnow(),
                    component_path=str(r.get("component_path") or "")[:2000],
                    property_name=str(r.get("property_name") or "")[:500],
                    old_value=None if r.get("old_value") is None else str(r.get("old_value"))[:4000],
                    new_value=None if r.get("new_value") is None else str(r.get("new_value"))[:4000],
                    success=bool(r.get("success", True)),
                    message=str(r.get("message") or "")[:2000],
                    performed_by=str(r.get("performed_by") or performed_by or "system")[:255],
                )
                db.add(entry)
            db.commit()
        finally:
            db.close()
    except Exception:
        pass
