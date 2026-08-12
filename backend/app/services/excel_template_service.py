"""
Generate Excel templates from selected components + fields using field dictionary.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import List

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

# Project import style (same as main.py / other services)
from backend.app.services.dictionary_service import load_dictionary, resolve_label


def _preferred_label(aliases) -> str:
    if isinstance(aliases, list) and aliases:
        return str(aliases[0])
    if isinstance(aliases, str) and aliases:
        return aliases.split(",")[0].strip()
    return ""


def generate_template(
    selections: List[dict],
    include_seo: bool = True,
) -> bytes:
    """
    selections: [
      {
        "resourceType": "...",
        "label": "Hero Image",
        "fields": ["heading", "title", ...]
      }
    ]
    Returns xlsx file as bytes.
    """
    data = load_dictionary()
    wb = Workbook()

    # --- Instructions sheet ---
    ws0 = wb.active
    ws0.title = "Instructions"
    lines = [
        "AEM CONTENT UPDATER — EXCEL TEMPLATE",
        f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC",
        "",
        "HOW TO USE",
        "1. SEO sheet (if present): one row per page. Page Path is required.",
        "2. Each component sheet: one row per component instance to update.",
        "3. Column headers use CA-friendly labels from the Dictionary in the tool.",
        "4. Do NOT rename header row — tool maps headers back to dialog field names.",
        "5. Leave a cell blank to skip that field.",
        "6. Instance column: 1 for first occurrence of that component on the page, 2 for second, etc.",
        "",
        "COLUMNS COMMON TO COMPONENT SHEETS",
        "Page Path   — full path e.g. /content/we-retail/ca/en/men",
        "Instance    — 1-based index when the same component type appears multiple times",
        "",
        "SECURITY RULE",
        "Only fields that exist on the component dialog will be applied. Unknown columns are rejected.",
        "",
        "SEO NOTES",
        "Title column maps to dialog field jcr:title (CA may also call this Meta Title).",
        "Description column maps to dialog field jcr:description (CA may also call this Meta Description).",
        "Do not invent extra columns such as Keywords unless they exist on the page dialog.",
        "",
        "SPECIAL FIELD VALUES",
        "Checkbox / boolean: true or false",
        "Dropdown / select: use the option value (e.g. h1, static, children)",
        "Multifield (e.g. Actions, Pages): separate items with | ",
        "  Composite item (link + text): /content/path::Button Label | /content/other::Other Label",
        "  Simple list: /content/a | /content/b | /content/c",
    ]
    for i, line in enumerate(lines, 1):
        ws0.cell(i, 1, line)
        if i == 1:
            ws0.cell(i, 1).font = Font(bold=True, size=14, color="1E3A5F")
    ws0.column_dimensions["A"].width = 100

    header_fill = PatternFill("solid", fgColor="1E3A5F")
    header_font = Font(bold=True, color="FFFFFF")
    thin = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="thin", color="CBD5E1"),
    )

    # --- SEO sheet (only once) ---
    # Columns come ONLY from field_dictionary.json → page_properties.fields
    # Never invent keywords / metaTitle / metaDescription as separate JCR fields.
    if include_seo:
        seo_entry = data.get("page_properties") or {}
        seo_fields = seo_entry.get("fields") or {
            "jcr:title": ["Title", "Meta Title"],
            "pageTitle": ["Page Title"],
            "navTitle": ["Navigation Title"],
            "jcr:description": ["Description", "Meta Description"],
            "cq:canonicalUrl": ["Canonical URL"],
        }

        ws = wb.create_sheet("SEO", 1)
        headers = ["Page Path"]
        for fn, aliases in seo_fields.items():
            headers.append(_preferred_label(aliases) or fn)

        for col, h in enumerate(headers, 1):
            cell = ws.cell(1, col, h)
            cell.fill = header_fill
            cell.font = header_font
            cell.border = thin

        ws.freeze_panes = "A2"
        for i, h in enumerate(headers, 1):
            ws.column_dimensions[get_column_letter(i)].width = max(16, min(28, len(str(h)) + 4))

        for r in range(2, 6):
            for c in range(1, len(headers) + 1):
                ws.cell(r, c).border = thin

    # --- Component sheets ---
    used_names = {"Instructions", "SEO"}

    for sel in selections:
        rt = sel.get("resourceType") or ""
        label = sel.get("label") or (rt.split("/")[-1] if rt else "Component")
        field_names = sel.get("fields") or []
        entry = data.get(rt) or {}
        dict_fields = entry.get("fields") or {}

        base = re.sub(r"[^\w\s-]", "", label)[:28].strip() or "Component"
        sheet_name = base
        n = 1
        while sheet_name in used_names:
            n += 1
            sheet_name = f"{base[:26]}_{n}"
        used_names.add(sheet_name)

        ws = wb.create_sheet(sheet_name)
        headers = ["Page Path", "Instance"]
        for fn in field_names:
            aliases = dict_fields.get(fn) or [fn]
            headers.append(_preferred_label(aliases) or fn)

        for col, h in enumerate(headers, 1):
            cell = ws.cell(1, col, h)
            cell.fill = header_fill
            cell.font = header_font
            cell.border = thin

        ws.freeze_panes = "A2"
        for i, h in enumerate(headers, 1):
            ws.column_dimensions[get_column_letter(i)].width = max(14, min(30, len(str(h)) + 4))

        for r in range(2, 8):
            for c in range(1, len(headers) + 1):
                ws.cell(r, c).border = thin
        # Only first data row shows example Instance = 1; other rows stay blank for CA
        if len(headers) >= 2:
            ws.cell(2, 2, 1)

        # Hidden metadata for importer (resourceType)
        meta_col = len(headers) + 2
        ws.cell(1, meta_col, f"__resourceType__={rt}")
        ws.cell(1, meta_col).font = Font(color="FFFFFF", size=1)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
