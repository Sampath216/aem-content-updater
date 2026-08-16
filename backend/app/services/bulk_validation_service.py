"""
Post-bulk verification — high-level summary + pin-by-pin detailed report.
Excel is the source of truth; AEM is checked against every row/field/asset.
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Dict, List

from backend.app.services.aem_client import AEMClient
from backend.app.services.asset_bulk_service import plan_asset_uploads
from backend.app.services.component_add_service import ComponentAddService
from backend.app.services.dam_service import DamService
from backend.app.services.excel_bulk_service import parse_add_sheets, parse_workbook
from backend.app.services.page_bulk_service import preview_pages
from backend.app.services.page_service import PageService


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def _str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def normalize_compare_value(expected, actual) -> bool:
    """True if Excel expected and AEM actual should be treated as equal."""
    if expected is None and actual is None:
        return True
    e = "" if expected is None else str(expected).strip()
    a = "" if actual is None else str(actual).strip()
    if e == a:
        return True
    # case-insensitive
    if e.lower() == a.lower():
        return True
    # boolean-ish
    truthy = {"y", "yes", "true", "1", "on"}
    falsy = {"n", "no", "false", "0", "off"}
    el, al = e.lower(), a.lower()
    if el in truthy and al in truthy:
        return True
    if el in falsy and al in falsy:
        return True
    return False


def normalize_write_value(field_name: str, value):
    """Normalize Excel values before writing to AEM (booleans, heading type)."""
    if value is None:
        return value
    s = str(value).strip()
    fn = (field_name or "").lower()
    # Boolean fields
    truthy = {"y", "yes", "true", "1", "on"}
    falsy = {"n", "no", "false", "0", "off"}
    bool_hints = ("fullwidth", "full_width", "checkbox", "boolean", "enabled", "hide", "openinnewtab")
    if s.lower() in truthy or s.lower() in falsy:
        if any(h in fn for h in bool_hints) or fn in ("usefullwidth", "useFullWidth".lower()):
            return "true" if s.lower() in truthy else "false"
        # generic Y/N on unknown may still be boolean in AEM checkboxes
        if s.lower() in truthy | falsy and fn.endswith("width") or "full" in fn:
            return "true" if s.lower() in truthy else "false"
    # Title type / size: H1 → h1
    if fn in ("type", "titletype", "headingtype", "size") or "typesize" in fn.replace(" ", ""):
        if len(s) <= 3 and s.upper().startswith("H") and s[1:].isdigit():
            return s.lower()
    return value



def build_validation_report(content: bytes) -> dict:
    aem = AEMClient()
    dam = DamService()
    ps = PageService()
    add_svc = ComponentAddService()

    detailed: Dict[str, List[dict]] = {
        "assets": [],
        "pages": [],
        "components": [],
        "seo": [],
    }
    counters = {"pass": 0, "fail": 0, "warn": 0}

    def rec(section: str, check_id: str, ok: bool, message: str, **extra):
        item = {
            "id": check_id,
            "ok": ok,
            "severity": "pass" if ok else "fail",
            "message": message,
            **extra,
        }
        if extra.get("warn"):
            item["severity"] = "warn"
            counters["warn"] += 1
        elif ok:
            counters["pass"] += 1
        else:
            counters["fail"] += 1
        detailed[section].append(item)

    # ========== ASSETS ==========
    asset_plan = plan_asset_uploads(content)
    for p in asset_plan.get("plans") or []:
        src = p.get("source_path")
        tgt = p.get("target_path")
        row = p.get("excel_row")
        if p.get("errors"):
            rec(
                "assets",
                f"asset-src-r{row}",
                False,
                f"Local source invalid: {src}",
                excel_row=row,
                source_path=src,
                target_path=tgt,
                errors=p.get("errors"),
            )
            continue
        rec(
            "assets",
            f"asset-src-r{row}",
            True,
            f"Local source OK ({p.get('mode')})",
            excel_row=row,
            source_path=src,
            mode=p.get("mode"),
        )
        for i, up in enumerate(p.get("upload_plan") or []):
            dpath = up.get("dam_path")
            name = up.get("original_name") or up.get("dam_name")
            cid = f"asset-r{row}-{i}-{up.get('dam_name')}"
            if up.get("action") == "reject_size":
                rec(
                    "assets",
                    cid,
                    False,
                    f"Size rejected: {name}",
                    dam_path=dpath,
                    size_kb=up.get("size_kb"),
                    breakpoint=up.get("breakpoint"),
                    excel_row=row,
                )
                continue
            exists = bool(dpath and dam.path_exists(dpath))
            is_dam = False
            if exists:
                try:
                    is_dam = dam._is_dam_asset(dpath)
                except Exception:
                    is_dam = exists
            if not exists:
                rec(
                    "assets",
                    cid,
                    False,
                    f"DAM asset MISSING: {dpath}",
                    dam_path=dpath,
                    local_path=up.get("local_path"),
                    size_kb=up.get("size_kb"),
                    breakpoint=up.get("breakpoint"),
                    excel_row=row,
                )
            elif not is_dam:
                rec(
                    "assets",
                    cid,
                    False,
                    f"Node exists but not dam:Asset: {dpath}",
                    dam_path=dpath,
                    excel_row=row,
                    warn=True,
                )
            else:
                rec(
                    "assets",
                    cid,
                    True,
                    f"DAM asset OK: {name}",
                    dam_path=dpath,
                    size_kb=up.get("size_kb"),
                    breakpoint=up.get("breakpoint"),
                    excel_row=row,
                )

    if not asset_plan.get("plans"):
        rec("assets", "asset-none", True, "No Assets rows in Excel", warn=True)

    # ========== PAGES ==========
    pages = preview_pages(content)
    for plan in pages.get("plans") or []:
        path = plan.get("page_path")
        exists = bool(path and ps.path_exists(path))
        action = plan.get("action")
        cid = f"page-{path}"
        if action in ("create_page", "exists"):
            if exists:
                rec("pages", cid, True, f"Page exists: {path}", page_path=path, action=action)
            else:
                rec(
                    "pages",
                    cid,
                    False,
                    f"Page MISSING (Excel expected it): {path}",
                    page_path=path,
                    action=action,
                    errors=plan.get("errors"),
                )
        elif action == "blocked":
            rec(
                "pages",
                cid,
                False,
                f"Page was blocked in plan: {path}",
                page_path=path,
                errors=plan.get("errors"),
            )
        else:
            rec("pages", cid, True, f"Page skipped (Create=N): {path}", page_path=path, warn=True)

    # ========== COMPONENTS (Add sheets) ==========
    adds = parse_add_sheets(content)
    by_page: OrderedDict = OrderedDict()
    for row in adds.get("rows") or []:
        by_page.setdefault(row["page_path"], []).append(row)

    for page_path, rows in by_page.items():
        if not ps.path_exists(page_path):
            for row in rows:
                rec(
                    "components",
                    f"comp-page-missing-{row.get('excel_row')}",
                    False,
                    f"Page missing — cannot verify component '{row.get('component')}'",
                    page_path=page_path,
                    component=row.get("component"),
                    excel_row=row.get("excel_row"),
                    sheet=row.get("sheet"),
                )
            continue

        listed = aem.get_components(page_path)
        comps = listed.get("components") or []

        for row in rows:
            name = row.get("component") or ""
            excel_row = row.get("excel_row")
            sheet = row.get("sheet")
            props = row.get("properties") or {}
            res = add_svc.resolve_resource_type(name, page_path)
            if res.get("status") != "success":
                rec(
                    "components",
                    f"comp-resolve-{excel_row}",
                    False,
                    f"Cannot resolve component name '{name}'",
                    page_path=page_path,
                    component=name,
                    excel_row=excel_row,
                    sheet=sheet,
                )
                continue
            rt = res["resourceType"]
            rt_l = _norm(rt)
            leaf = rt_l.split("/")[-1]
            matches = []
            for c in comps:
                crt = _norm(c.get("resourceType") or "")
                if crt == rt_l or crt.endswith("/" + leaf) or crt.split("/")[-1] == leaf:
                    matches.append(c)
            if not matches:
                rec(
                    "components",
                    f"comp-missing-{excel_row}",
                    False,
                    f"Component '{name}' NOT on page",
                    page_path=page_path,
                    component=name,
                    resourceType=rt,
                    excel_row=excel_row,
                    sheet=sheet,
                )
                continue

            # Prefer last match (most recently added often last in list — best effort)
            target = matches[-1]
            cpath = target.get("path")
            fields_resp = aem.get_component_fields(cpath) if cpath else {}
            actual = fields_resp.get("fields") or {}
            if isinstance(actual, list):
                actual_map = {}
                for f in actual:
                    if isinstance(f, dict) and f.get("name"):
                        actual_map[f["name"]] = f.get("value") if "value" in f else f.get("currentValue")
            elif isinstance(actual, dict):
                actual_map = actual
            else:
                actual_map = {}

            field_checks = []
            all_ok = True
            for k, expected in props.items():
                if expected is None or _str(expected) == "":
                    field_checks.append({
                        "field": k,
                        "expected": expected,
                        "actual": None,
                        "ok": True,
                        "note": "blank in Excel — skipped",
                    })
                    continue
                key = k
                act = actual_map.get(key)
                if act is None and _norm(key) in ("image", "file", "file reference"):
                    key = "fileReference"
                    act = actual_map.get("fileReference") or actual_map.get("file")
                if act is None and _norm(key) in ("full width",):
                    key = "useFullWidth"
                    act = actual_map.get("useFullWidth")
                ok = normalize_compare_value(expected, act)
                if not ok:
                    all_ok = False
                field_checks.append({
                    "field": k,
                    "jcr_field": key,
                    "expected": _str(expected),
                    "actual": None if act is None else _str(act),
                    "ok": ok,
                    "note": None if act is not None else "field not present on component",
                })

            if all_ok:
                rec(
                    "components",
                    f"comp-ok-{excel_row}",
                    True,
                    f"Component '{name}' OK on {page_path}",
                    page_path=page_path,
                    component_path=cpath,
                    component=name,
                    resourceType=rt,
                    excel_row=excel_row,
                    sheet=sheet,
                    field_checks=field_checks,
                )
            else:
                rec(
                    "components",
                    f"comp-mismatch-{excel_row}",
                    False,
                    f"Component '{name}' field mismatch on {page_path}",
                    page_path=page_path,
                    component_path=cpath,
                    component=name,
                    resourceType=rt,
                    excel_row=excel_row,
                    sheet=sheet,
                    field_checks=field_checks,
                )

    # ========== COMPONENTS (Update sheets — Instance) ==========
    parsed_upd = parse_workbook(content)
    from backend.app.services.excel_bulk_service import _find_component_instance, normalize_compare_value as ncv
    # normalize_compare_value already in this module
    for row in parsed_upd.get("component_rows") or []:
        page_path = row.get("page_path")
        rt = row.get("resourceType") or row.get("component_label") or ""
        instance = int(row.get("instance") or 1)
        excel_row = row.get("excel_row")
        sheet = row.get("sheet")
        props = row.get("properties") or {}
        if not page_path or not props:
            continue
        if not ps.path_exists(page_path):
            rec(
                "components",
                f"upd-page-missing-{excel_row}",
                False,
                f"Update sheet: page missing {page_path}",
                page_path=page_path,
                excel_row=excel_row,
                sheet=sheet,
            )
            continue
        path, matching, err = _find_component_instance(aem, page_path, rt, instance)
        if err or not path:
            rec(
                "components",
                f"upd-missing-{excel_row}",
                False,
                f"Update sheet: {err or 'instance not found'}",
                page_path=page_path,
                component=rt,
                excel_row=excel_row,
                sheet=sheet,
                instance=instance,
            )
            continue
        fields_resp = aem.get_component_fields(path)
        actual = fields_resp.get("fields") or {}
        if isinstance(actual, list):
            actual_map = {}
            for f in actual:
                if isinstance(f, dict) and f.get("name"):
                    actual_map[f["name"]] = f.get("value") if "value" in f else f.get("currentValue")
        elif isinstance(actual, dict):
            actual_map = actual
        else:
            actual_map = {}
        field_checks = []
        all_ok = True
        for k, expected in props.items():
            if expected is None or _str(expected) == "":
                continue
            key = k
            act = actual_map.get(key)
            if act is None and _norm(key) == "title":
                key = "jcr:title"
                act = actual_map.get("jcr:title")
            ok = normalize_compare_value(expected, act)
            if not ok:
                all_ok = False
            field_checks.append({
                "field": k,
                "jcr_field": key,
                "expected": _str(expected),
                "actual": None if act is None else _str(act),
                "ok": ok,
            })
        if all_ok:
            rec(
                "components",
                f"upd-ok-{excel_row}-{instance}",
                True,
                f"Update OK: {rt} instance {instance} on {page_path}",
                page_path=page_path,
                component_path=path,
                component=rt,
                excel_row=excel_row,
                sheet=sheet,
                field_checks=field_checks,
            )
        else:
            rec(
                "components",
                f"upd-mismatch-{excel_row}-{instance}",
                False,
                f"Update mismatch: {rt} instance {instance} on {page_path}",
                page_path=page_path,
                component_path=path,
                component=rt,
                excel_row=excel_row,
                sheet=sheet,
                field_checks=field_checks,
            )

    # ========== SEO ==========
    parsed = parsed_upd
    for row in parsed.get("page_rows") or []:
        path = row.get("page_path")
        jcr = f"{path}/jcr:content"
        excel_row = row.get("excel_row")
        try:
            r = aem.session.get(f"{aem.base_url}{jcr}.json", timeout=aem.timeout)
            if r.status_code != 200:
                rec(
                    "seo",
                    f"seo-missing-{excel_row}",
                    False,
                    f"jcr:content missing: {path}",
                    page_path=path,
                    excel_row=excel_row,
                )
                continue
            data = r.json()
        except Exception as e:
            rec("seo", f"seo-err-{excel_row}", False, str(e), page_path=path)
            continue

        field_checks = []
        all_ok = True
        for k, exp in (row.get("properties") or {}).items():
            if exp is None or _str(exp) == "":
                continue
            act = data.get(k)
            ok = act is not None and normalize_compare_value(exp, act)
            if not ok:
                all_ok = False
            field_checks.append({
                "field": k,
                "expected": _str(exp),
                "actual": None if act is None else _str(act),
                "ok": ok,
            })
        if all_ok:
            rec(
                "seo",
                f"seo-ok-{excel_row}",
                True,
                f"Page properties OK: {path}",
                page_path=path,
                excel_row=excel_row,
                field_checks=field_checks,
            )
        else:
            rec(
                "seo",
                f"seo-mismatch-{excel_row}",
                False,
                f"Page properties mismatch: {path}",
                page_path=path,
                excel_row=excel_row,
                field_checks=field_checks,
            )

    # High-level summary (short)
    high_level = {
        "assets": {
            "pass": sum(1 for x in detailed["assets"] if x["severity"] == "pass"),
            "fail": sum(1 for x in detailed["assets"] if x["severity"] == "fail"),
            "warn": sum(1 for x in detailed["assets"] if x["severity"] == "warn"),
        },
        "pages": {
            "pass": sum(1 for x in detailed["pages"] if x["severity"] == "pass"),
            "fail": sum(1 for x in detailed["pages"] if x["severity"] == "fail"),
            "warn": sum(1 for x in detailed["pages"] if x["severity"] == "warn"),
        },
        "components": {
            "pass": sum(1 for x in detailed["components"] if x["severity"] == "pass"),
            "fail": sum(1 for x in detailed["components"] if x["severity"] == "fail"),
            "warn": sum(1 for x in detailed["components"] if x["severity"] == "warn"),
        },
        "seo": {
            "pass": sum(1 for x in detailed["seo"] if x["severity"] == "pass"),
            "fail": sum(1 for x in detailed["seo"] if x["severity"] == "fail"),
            "warn": sum(1 for x in detailed["seo"] if x["severity"] == "warn"),
        },
    }

    fails = counters["fail"]
    return {
        "status": "passed" if fails == 0 else "failed",
        "message": (
            f"Validation — pass: {counters['pass']}, fail: {fails}, warn: {counters['warn']}"
        ),
        "summary": counters,
        "high_level": high_level,
        "detailed": detailed,
    }
