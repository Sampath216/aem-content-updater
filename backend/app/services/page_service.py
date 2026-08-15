"""
AEM page creation — Adobe-aligned template rules (dynamic, no hardcoding).

Templates (NOT components):
  - Editable: jcr:content/status = enabled
  - Site/page: cq:allowedTemplates
  - Template: allowedPaths, allowedParents, allowedChildren
  - templateGroup = category label (NOT componentGroup)

Components use componentGroup separately (see component_add_service).
"""
from __future__ import annotations

import fnmatch
import re
from typing import Any, Dict, List, Optional

from backend.app.services.aem_client import AEMClient


def normalize_content_path(path: str) -> str:
    p = (path or "").strip().replace("\\", "/")
    if not p:
        raise ValueError("Page path is required")
    if not p.startswith("/"):
        p = "/" + p
    p = re.sub(r"/+", "/", p).rstrip("/")
    if not p.startswith("/content/"):
        raise ValueError("Page path must start with /content/")
    if p == "/content":
        raise ValueError("Cannot use /content alone as target page path")
    return p


def path_segments(path: str) -> List[str]:
    return [s for s in path.split("/") if s]


def adobe_page_name(name: str) -> str:
    n = (name or "").strip().lower().replace(" ", "-")
    n = re.sub(r"[^a-z0-9._\-]", "-", n)
    n = re.sub(r"-{2,}", "-", n).strip("-")
    return n or "page"


class PageService:
    def __init__(self, aem: Optional[AEMClient] = None):
        self.aem = aem or AEMClient()
        self.base_url = self.aem.base_url
        self.session = self.aem.session
        self.timeout = self.aem.timeout

    def path_exists(self, path: str) -> bool:
        try:
            r = self.session.get(f"{self.base_url}{path}.json", timeout=self.timeout)
            return r.status_code == 200
        except Exception:
            return False

    def _load_json(self, path: str) -> Optional[dict]:
        try:
            r = self.session.get(f"{self.base_url}{path}.json", timeout=self.timeout)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return None

    def get_node_info(self, path: str) -> dict:
        try:
            r = self.session.get(f"{self.base_url}{path}.json", timeout=self.timeout)
            if r.status_code != 200:
                return {"exists": False, "path": path}
            data = r.json()
            primary = data.get("jcr:primaryType")
            title = resource_type = template = None
            jc = data.get("jcr:content")
            if isinstance(jc, dict):
                title = jc.get("jcr:title")
                resource_type = jc.get("sling:resourceType")
                template = jc.get("cq:template")
            else:
                jc2 = self._load_json(f"{path}/jcr:content") or {}
                title = jc2.get("jcr:title")
                resource_type = jc2.get("sling:resourceType")
                template = jc2.get("cq:template")
            kind = "unknown"
            if primary == "cq:Page":
                kind = "page"
            elif primary in ("sling:Folder", "sling:OrderedFolder", "nt:folder"):
                kind = "folder"
            return {
                "exists": True,
                "path": path,
                "jcr:primaryType": primary,
                "kind": kind,
                "title": title,
                "sling:resourceType": resource_type,
                "cq:template": template,
            }
        except Exception as e:
            return {"exists": False, "path": path, "error": str(e)}

    def inspect_page_path(self, target_path: str) -> dict:
        target = normalize_content_path(target_path)
        parts = path_segments(target)
        if len(parts) < 3:
            return {"status": "error", "message": "Path too short — need /content/<site>/..."}
        chain = []
        current = ""
        for part in parts:
            current = f"{current}/{part}"
            info = self.get_node_info(current)
            chain.append({
                "segment": part,
                "path": current,
                "exists": info.get("exists", False),
                "kind": info.get("kind") if info.get("exists") else None,
                "jcr:primaryType": info.get("jcr:primaryType"),
                "title": info.get("title"),
            })
        missing = [c for c in chain if not c["exists"]]
        if chain and chain[0]["path"] == "/content" and not chain[0]["exists"]:
            return {"status": "error", "message": "/content does not exist", "chain": chain}
        target_exists = chain[-1]["exists"] if chain else False
        return {
            "status": "success",
            "target_path": target,
            "target_name": parts[-1],
            "target_exists": target_exists,
            "chain": chain,
            "missing": missing,
            "all_ready": len(missing) == 0,
            "message": (
                "Path already exists"
                if target_exists
                else f"{len(missing)} segment(s) missing"
            ),
        }

    # ----- Templates (Adobe) -----

    def _template_info(self, template_path: str) -> Optional[dict]:
        data = self._load_json(template_path)
        if not data:
            return None
        title = data.get("jcr:title")
        template_group = data.get("templateGroup")
        allowed_paths = data.get("allowedPaths")
        allowed_parents = data.get("allowedParents")
        allowed_children = data.get("allowedChildren")
        if isinstance(allowed_paths, str):
            allowed_paths = [allowed_paths]
        if isinstance(allowed_parents, str):
            allowed_parents = [allowed_parents]
        if isinstance(allowed_children, str):
            allowed_children = [allowed_children]

        status = resource_type = None
        jc = data.get("jcr:content")
        if isinstance(jc, dict):
            title = title or jc.get("jcr:title")
            status = jc.get("status")
            resource_type = jc.get("sling:resourceType")
            template_group = template_group or jc.get("templateGroup")
        else:
            jc2 = self._load_json(f"{template_path}/jcr:content") or {}
            title = title or jc2.get("jcr:title")
            status = jc2.get("status")
            resource_type = jc2.get("sling:resourceType")
            template_group = template_group or jc2.get("templateGroup")

        struct = self._load_json(f"{template_path}/structure/jcr:content") or {}
        resource_type = resource_type or struct.get("sling:resourceType")

        primary = data.get("jcr:primaryType")
        # Only real page templates (Adobe cq:Template). Skip ACL / policy / folders.
        if primary and primary not in ("cq:Template", "cq:Page"):
            if primary.startswith("rep:") or primary in ("sling:Folder", "sling:OrderedFolder", "nt:folder"):
                return None

        # Normalize path: /conf/.../templates/./name → /conf/.../templates/name
        clean_path = template_path.replace("/./", "/").replace("//", "/")
        name = clean_path.rstrip("/").split("/")[-1]
        if name in ("rep:policy", "jcr:content") or name.startswith("rep:"):
            return None

        return {
            "path": clean_path,
            "title": title or name,
            "jcr:primaryType": primary,
            "sling:resourceType": resource_type,
            "name": name,
            "status": status,
            "templateGroup": template_group,
            "allowedPaths": allowed_paths or [],
            "allowedParents": allowed_parents or [],
            "allowedChildren": allowed_children or [],
        }

    def _template_enabled(self, info: dict) -> bool:
        st = (info.get("status") or "").strip().lower()
        if not st:
            return True
        return st == "enabled"

    def _path_matches_patterns(self, path: str, patterns) -> bool:
        if not patterns:
            return True
        for pat in patterns:
            p = str(pat).strip()
            if not p:
                continue
            if p.endswith("/.*") or p.endswith(".*"):
                prefix = p.replace("/.*", "").replace(".*", "").rstrip("/")
                if path == prefix or path.startswith(prefix + "/"):
                    return True
            if fnmatch.fnmatch(path, p.replace(".*", "*")):
                return True
            if path.startswith(p.rstrip(".*").rstrip("/")):
                return True
        return False

    def _template_allowed_for_parent(self, info: dict, parent_path: str) -> bool:
        if not info or not self._template_enabled(info):
            return False
        paths = info.get("allowedPaths") or []
        parents = info.get("allowedParents") or []
        if not paths and not parents:
            return True
        ok_path = self._path_matches_patterns(parent_path, paths) if paths else True
        ok_parent = self._path_matches_patterns(parent_path, parents) if parents else True
        if paths and parents:
            return ok_path and ok_parent
        if paths:
            return ok_path
        return ok_parent

    def _expand_template_pattern(self, pattern: str) -> List[dict]:
        results = []
        pattern = (pattern or "").strip()
        if not pattern:
            return results
        if "*" in pattern:
            base = pattern.split("*")[0].rstrip("/")
            base = re.sub(r"/\([^)]*$", "", base).rstrip("/")
            try:
                r = self.session.get(f"{self.base_url}{base}.1.json", timeout=self.timeout)
                if r.status_code == 200:
                    data = r.json()
                    for name in data.keys():
                        if name.startswith(("jcr:", "cq:", "sling:", "rep:")):
                            continue
                        if name in ("rep:policy",):
                            continue
                        info = self._template_info(f"{base}/{name}")
                        if info and info.get("jcr:primaryType") == "cq:Template":
                            results.append(info)
            except Exception:
                pass
        else:
            info = self._template_info(pattern)
            if info:
                results.append(info)
        return results

    def _discover_conf_templates(self, parent_path: str) -> List[dict]:
        """Dynamic conf discovery from site segment under /content/<site>/..."""
        found = []
        parts = path_segments(parent_path)
        candidates = []
        if len(parts) >= 2 and parts[0] == "content":
            site = parts[1]
            candidates.extend([
                f"/conf/{site}/settings/wcm/templates",
                f"/apps/{site}/templates",
            ])
        candidates.extend([
            "/conf/global/settings/wcm/templates",
        ])
        seen = set()
        for base in candidates:
            if base in seen:
                continue
            seen.add(base)
            try:
                r = self.session.get(f"{self.base_url}{base}.1.json", timeout=self.timeout)
                if r.status_code != 200:
                    continue
                data = r.json()
                for name in data.keys():
                    if name.startswith(("jcr:", "cq:", "sling:", "rep:")):
                        continue
                    if name in ("rep:policy",):
                        continue
                    info = self._template_info(f"{base}/{name}")
                    if info and info.get("jcr:primaryType") == "cq:Template":
                        found.append(info)
            except Exception:
                continue
        return found

    def list_allowed_templates(self, parent_path: str, walk_ancestors: bool = True) -> dict:
        if parent_path.startswith("/content"):
            parent_path = normalize_content_path(parent_path)
        else:
            parent_path = parent_path.rstrip("/")

        def read_patterns(path: str) -> list:
            jc = self._load_json(f"{path}/jcr:content") or {}
            allowed = jc.get("cq:allowedTemplates")
            if allowed is None:
                return []
            if isinstance(allowed, str):
                return [allowed]
            if isinstance(allowed, list):
                return [str(a) for a in allowed if a]
            return []

        patterns = []
        cursor = parent_path if self.path_exists(parent_path) else parent_path.rsplit("/", 1)[0]
        while cursor and cursor not in ("", "/"):
            patterns.extend(read_patterns(cursor))
            if not walk_ancestors or cursor == "/content":
                break
            cursor = cursor.rsplit("/", 1)[0]
        # unique
        seen_p = set()
        patterns = [p for p in patterns if not (p in seen_p or seen_p.add(p))]

        templates = []
        seen = set()

        def add_info(info):
            if not info or not info.get("path"):
                return
            p = str(info["path"]).replace("/./", "/")
            info = dict(info)
            info["path"] = p
            if p in seen:
                return
            if info.get("jcr:primaryType") and info.get("jcr:primaryType") != "cq:Template":
                return
            if not self._template_enabled(info):
                return
            if not self._template_allowed_for_parent(info, parent_path):
                return
            seen.add(p)
            templates.append(info)

        for pattern in patterns:
            for info in self._expand_template_pattern(str(pattern)):
                add_info(self._template_info(info["path"]) or info)

        conf = self._discover_conf_templates(parent_path)
        for info in conf:
            full = self._template_info(info["path"]) or info
            if patterns:
                matched = False
                for pat in patterns:
                    root = str(pat).split(".*")[0].rstrip("/")
                    if full["path"].startswith(root) or self._path_matches_patterns(full["path"], [pat]):
                        matched = True
                        break
                if not matched:
                    continue
            add_info(full)

        if not templates:
            for info in conf:
                add_info(self._template_info(info["path"]) or info)

        return {
            "status": "success",
            "parent_path": parent_path,
            "resolved_from": parent_path if templates else None,
            "cq_allowedTemplates_patterns": patterns,
            "template_count": len(templates),
            "templates": templates,
            "message": (
                f"Found {len(templates)} enabled template(s) for {parent_path}"
                if templates
                else "No enabled templates matched Adobe template rules"
            ),
            "adobe_notes": [
                "Editable templates: jcr:content/status=enabled",
                "Page/site cq:allowedTemplates restricts available templates",
                "Template allowedPaths/allowedParents further restrict use",
                "templateGroup is a template category — NOT componentGroup",
            ],
        }

    def validate_template_for_parent(self, parent_path: str, template_path: str) -> dict:
        listing = self.list_allowed_templates(parent_path, walk_ancestors=True)
        allowed_paths = {t.get("path") for t in (listing.get("templates") or []) if t.get("path")}
        if not allowed_paths:
            return {
                "allowed": False,
                "message": "No allowed templates resolved for this parent",
                "resolved_from": listing.get("resolved_from"),
            }
        if template_path not in allowed_paths:
            return {
                "allowed": False,
                "message": f"Template not allowed for {parent_path}",
                "resolved_from": listing.get("resolved_from"),
                "allowed_paths": sorted(allowed_paths),
            }
        return {"allowed": True, "resolved_from": listing.get("resolved_from"), "message": "Template allowed"}

    def create_folder(self, parent_path: str, name: str, title: Optional[str] = None) -> dict:
        parent_path = parent_path.rstrip("/")
        node = adobe_page_name(name)
        target = f"{parent_path}/{node}"
        if self.path_exists(target):
            return {"status": "success", "path": target, "created": False, "kind": "folder"}
        if not self.path_exists(parent_path):
            return {"status": "error", "message": f"Parent does not exist: {parent_path}"}
        data = {
            f"{node}/jcr:primaryType": "sling:OrderedFolder",
            f"{node}/jcr:content/jcr:primaryType": "nt:unstructured",
            f"{node}/jcr:content/jcr:title": title or name,
        }
        try:
            r = self.session.post(f"{self.base_url}{parent_path}", data=data, timeout=self.timeout)
            if r.status_code in (200, 201) and self.path_exists(target):
                return {
                    "status": "success",
                    "path": target,
                    "created": True,
                    "kind": "folder",
                    "jcr:primaryType": "sling:OrderedFolder",
                }
            return {"status": "error", "message": f"Folder create failed ({r.status_code}): {r.text[:250]}", "path": target}
        except Exception as e:
            return {"status": "error", "message": str(e), "path": target}

    def create_page(
        self,
        parent_path: str,
        name: str,
        title: str,
        template_path: str,
        resource_type: Optional[str] = None,
    ) -> dict:
        parent_path = parent_path.rstrip("/")
        node = adobe_page_name(name)
        target = f"{parent_path}/{node}"
        if self.path_exists(target):
            return {"status": "success", "path": target, "created": False, "kind": "page", "message": "Page already exists"}
        if not self.path_exists(parent_path):
            return {"status": "error", "message": f"Parent does not exist: {parent_path}"}

        v = self.validate_template_for_parent(parent_path, template_path)
        if not v.get("allowed"):
            return {"status": "error", "message": v.get("message"), "path": target, "validation": v}

        tinfo = self._template_info(template_path) or {}
        rt = resource_type or tinfo.get("sling:resourceType") or "weretail/components/structure/page"

        try:
            r = self.session.post(
                f"{self.base_url}/bin/wcmcommand",
                data={
                    "cmd": "createPage",
                    "parentPath": parent_path,
                    "title": title or name,
                    "label": node,
                    "template": template_path,
                },
                timeout=self.timeout,
            )
            if r.status_code in (200, 201) and self.path_exists(target):
                return {
                    "status": "success",
                    "path": target,
                    "created": True,
                    "kind": "page",
                    "strategy": "wcmcommand",
                    "cq:template": template_path,
                }
            wcm_status, wcm_body = r.status_code, r.text[:200]
        except Exception as e:
            wcm_status, wcm_body = None, str(e)

        data = {
            f"{node}/jcr:primaryType": "cq:Page",
            f"{node}/jcr:content/jcr:primaryType": "cq:PageContent",
            f"{node}/jcr:content/jcr:title": title or name,
            f"{node}/jcr:content/cq:template": template_path,
            f"{node}/jcr:content/sling:resourceType": rt,
        }
        try:
            r2 = self.session.post(f"{self.base_url}{parent_path}", data=data, timeout=self.timeout)
            if r2.status_code in (200, 201) and self.path_exists(target):
                return {
                    "status": "success",
                    "path": target,
                    "created": True,
                    "kind": "page",
                    "strategy": "sling-cq:Page",
                    "cq:template": template_path,
                    "sling:resourceType": rt,
                }
            return {
                "status": "error",
                "message": f"Page create failed. wcm={wcm_status} ({wcm_body}); sling={r2.status_code}",
                "path": target,
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": target}

    def create_path_plan(self, target_path: str) -> dict:
        inspection = self.inspect_page_path(target_path)
        if inspection.get("status") != "success":
            return inspection
        if inspection.get("all_ready"):
            return {
                "status": "success",
                "action": "none",
                "message": "Entire path already exists",
                "inspection": inspection,
            }
        plan = []
        for seg in inspection["chain"]:
            if seg["exists"]:
                plan.append({
                    "path": seg["path"],
                    "segment": seg["segment"],
                    "action": "exists",
                    "kind": seg.get("kind"),
                })
                continue
            parent = seg["path"].rsplit("/", 1)[0]
            t = self.list_allowed_templates(parent, walk_ancestors=True)
            templates = t.get("templates") or []
            is_final = seg["path"] == inspection["target_path"]
            msg = (
                "Select template for the new page"
                if is_final
                else "Choose folder OR page (pick a template if page)"
            )
            if templates and t.get("resolved_from") and t.get("resolved_from") != parent:
                msg += f" — templates from ancestor {t.get('resolved_from')}"
            plan.append({
                "path": seg["path"],
                "segment": seg["segment"],
                "parent_path": parent,
                "action": "create",
                "is_target_page": is_final,
                "choices": ["page", "folder"] if not is_final else ["page"],
                "templates": templates,
                "templates_resolved_from": t.get("resolved_from"),
                "message": msg,
            })
        return {
            "status": "success",
            "action": "plan",
            "target_path": inspection["target_path"],
            "plan": plan,
            "inspection": inspection,
            "message": "Review plan — choose folder or page+template for missing segments",
        }

    def execute_create(self, target_path: str, steps: List[dict], default_title: Optional[str] = None) -> dict:
        target = normalize_content_path(target_path)
        ordered = sorted(steps, key=lambda s: s.get("path") or "")
        results = []
        for step in ordered:
            path = normalize_content_path(step.get("path") or "")
            parent = path.rsplit("/", 1)[0]
            name = path.rsplit("/", 1)[-1]
            stype = (step.get("type") or "page").lower()
            title = step.get("title") or default_title or name.replace("-", " ").title()
            if self.path_exists(path):
                results.append({"path": path, "status": "skipped", "message": "Already exists"})
                continue
            if not self.path_exists(parent):
                results.append({"path": path, "status": "error", "message": f"Parent missing: {parent}"})
                return {"status": "error", "message": f"Parent missing for {path}", "results": results}
            if stype == "folder":
                r = self.create_folder(parent, name, title=title)
            else:
                template = step.get("template")
                if not template:
                    results.append({"path": path, "status": "error", "message": "template required for page"})
                    return {"status": "error", "message": "Missing template", "results": results}
                r = self.create_page(parent, name, title, template, step.get("resourceType"))
            results.append({**r, "requested_type": stype})
            if r.get("status") != "success":
                return {"status": "error", "message": r.get("message"), "results": results}
        final = self.inspect_page_path(target)
        return {
            "status": "success" if final.get("target_exists") else "partial",
            "target_path": target,
            "results": results,
            "inspection": final,
            "message": "Page path created successfully" if final.get("target_exists") else "Finished with issues",
        }
