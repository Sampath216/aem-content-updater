"""
Component ADD — Adobe component model (dynamic).

COMPONENT (cq:Component under /apps or /libs):
  - componentGroup  → Components Browser group
  - componentGroup = .hidden → not selectable by authors
  - jcr:title → browser label
  - cq:dialog / cq:editConfig → authoring
  - cq:template → initial content when component is dropped (NOT a page template)

TEMPLATE uses templateGroup / status / cq:allowedTemplates — see page_service.
Do NOT put componentGroup on templates or project roots.

Allowed components for ADD:
  1) Container policy components list (when present)
  2) Sibling resourceTypes already on the grid
  3) Ancestor page component usage
  4) Catalog / dictionary (excluding componentGroup .hidden when known)
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

from backend.app.services.aem_client import AEMClient

LAYOUT_HINTS = (
    "responsivegrid",
    "wcm/foundation/components/responsivegrid",
    "parsys",
    "foundation/components/parsys",
    "container",
)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _safe_node_name(name: str) -> str:
    n = (name or "component").strip().lower().replace(" ", "_")
    n = re.sub(r"[^a-z0-9_\-]", "_", n)
    n = re.sub(r"_{2,}", "_", n).strip("_")
    return n or "component"


class ComponentAddService:
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

    # -------------------------------------------------------------------------
    # Container discovery
    # -------------------------------------------------------------------------
    def discover_containers(self, page_path: str) -> dict:
        page_path = page_path.rstrip("/")
        root = f"{page_path}/jcr:content"
        containers = []

        def walk(path: str, depth: int):
            if depth > 6:
                return
            try:
                r = self.session.get(f"{self.base_url}{path}.1.json", timeout=self.timeout)
                if r.status_code != 200:
                    return
                data = r.json()
            except Exception:
                return
            rt = str(data.get("sling:resourceType") or "")
            rt_l = rt.lower()
            if any(h in rt_l for h in LAYOUT_HINTS) or rt_l.endswith("/responsivegrid"):
                containers.append({"path": path, "resourceType": rt})
            for name in list(data.keys()):
                if name.startswith(("jcr:", "cq:", "sling:")):
                    continue
                walk(f"{path}/{name}", depth + 1)

        if not self.path_exists(root):
            return {
                "status": "error",
                "message": f"No jcr:content at {page_path}",
                "containers": [],
                "primary_container": None,
            }

        walk(root, 0)
        containers = sorted(
            containers, key=lambda c: (c["path"].count("/"), c["path"]), reverse=True
        )
        primary = containers[0] if containers else None
        return {
            "status": "success",
            "page_path": page_path,
            "containers": containers,
            "primary_container": primary,
            "message": (
                f"Primary container: {primary['path']}"
                if primary
                else "No layout container found"
            ),
        }

    # -------------------------------------------------------------------------
    # Allowed components (dynamic — policy / siblings / catalog)
    # -------------------------------------------------------------------------
    def _allowed_from_policy(self, container_path: str) -> List[str]:
        """
        Try cq:policy on container → policy components list under /conf.
        Structure varies by project; keep discovery defensive.
        """
        allowed: List[str] = []
        data = self._load_json(container_path)
        if not data:
            return allowed

        policy_ref = data.get("cq:policy") or data.get("cq:styleIds")
        # Also check jcr:content of container
        if not policy_ref:
            jc = self._load_json(f"{container_path}/jcr:content") or {}
            policy_ref = jc.get("cq:policy")

        candidates = []
        if isinstance(policy_ref, str) and policy_ref:
            # relative policy id often like "wcm/foundation/components/responsivegrid/policy_xyz"
            candidates.append(policy_ref)
            if not policy_ref.startswith("/"):
                # common conf roots
                for root in (
                    "/conf/we-retail/settings/wcm/policies",
                    "/conf/global/settings/wcm/policies",
                    "/conf",
                ):
                    candidates.append(f"{root}/{policy_ref}")

        for p in candidates:
            pol = self._load_json(p)
            if not pol:
                # try .infinity for nested
                try:
                    r = self.session.get(
                        f"{self.base_url}{p}.infinity.json", timeout=self.timeout
                    )
                    if r.status_code == 200:
                        pol = r.json()
                except Exception:
                    pol = None
            if not isinstance(pol, dict):
                continue
            comps = pol.get("components") or pol.get("cq:components")
            if isinstance(comps, str):
                allowed.append(comps)
            elif isinstance(comps, list):
                allowed.extend([str(c) for c in comps if c])
            # nested groups
            for key, val in pol.items():
                if isinstance(val, dict) and (
                    "components" in val or key in ("components", "cq:components")
                ):
                    inner = val.get("components") or val.get("cq:components")
                    if isinstance(inner, list):
                        allowed.extend([str(c) for c in inner if c])
                    elif isinstance(inner, str):
                        allowed.append(inner)

        return list(dict.fromkeys(allowed))

    def _allowed_from_siblings(self, container_path: str) -> List[str]:
        """Components already used in this container = safe allowed set."""
        found = []
        try:
            r = self.session.get(
                f"{self.base_url}{container_path}.1.json", timeout=self.timeout
            )
            if r.status_code != 200:
                return found
            data = r.json()
            for name, child in data.items():
                if name.startswith(("jcr:", "cq:", "sling:")):
                    continue
                if isinstance(child, dict) and child.get("sling:resourceType"):
                    found.append(str(child["sling:resourceType"]))
                else:
                    # child may be path stub — load
                    sub = self._load_json(f"{container_path}/{name}")
                    if sub and sub.get("sling:resourceType"):
                        found.append(str(sub["sling:resourceType"]))
        except Exception:
            pass
        return list(dict.fromkeys(found))

    def _allowed_from_ancestor_pages(self, page_path: str) -> List[str]:
        """Scan parent pages for component types already in use (project reality)."""
        found = []
        parts = [p for p in page_path.split("/") if p]
        # try current + parents under /content
        paths = []
        cur = ""
        for p in parts:
            cur = f"{cur}/{p}"
            if cur.startswith("/content") and cur.count("/") >= 3:
                paths.append(cur)
        paths = list(reversed(paths))[:5]
        for pp in paths:
            try:
                comps = self.aem.get_components(pp)
                if comps.get("status") != "success":
                    continue
                for c in comps.get("components") or []:
                    rt = c.get("resourceType")
                    if rt and "structure" not in str(rt) and "responsivegrid" not in str(rt):
                        found.append(str(rt))
            except Exception:
                continue
        return list(dict.fromkeys(found))

    def _allowed_from_catalog(self) -> List[dict]:
        try:
            from backend.app.services.component_catalog import ComponentCatalog

            data = ComponentCatalog().get_all()
            out = []
            for rt, meta in (data.get("components") or {}).items():
                label = rt.split("/")[-1]
                if isinstance(meta, dict):
                    label = meta.get("label") or meta.get("title") or label
                    # versions may hold fields
                out.append({"resourceType": rt, "label": label, "source": "catalog"})
            return out
        except Exception:
            return []

    def _allowed_from_dictionary(self) -> List[dict]:
        try:
            from backend.app.services.dictionary_service import load_dictionary

            data = load_dictionary()
            out = []
            for rt, meta in (data or {}).items():
                if rt in ("page_properties",) or not isinstance(meta, dict):
                    continue
                if "/" not in rt:
                    continue
                out.append({
                    "resourceType": rt,
                    "label": meta.get("label") or rt.split("/")[-1],
                    "source": "dictionary",
                })
            return out
        except Exception:
            return []

    def get_allowed_components(self, page_path: str, container_path: Optional[str] = None) -> dict:
        """
        Build allowed list for CA / validation.
        Priority sources merged (union), with provenance.
        """
        disc = self.discover_containers(page_path)
        container = container_path or (disc.get("primary_container") or {}).get("path")
        sources = {
            "policy": [],
            "siblings": [],
            "ancestors": [],
            "catalog": [],
            "dictionary": [],
        }
        if container:
            sources["policy"] = self._allowed_from_policy(container)
            sources["siblings"] = self._allowed_from_siblings(container)
        sources["ancestors"] = self._allowed_from_ancestor_pages(page_path)

        catalog = self._allowed_from_catalog()
        dictionary = self._allowed_from_dictionary()
        sources["catalog"] = [c["resourceType"] for c in catalog]
        sources["dictionary"] = [c["resourceType"] for c in dictionary]

        # Strict mode preference: policy if non-empty, else siblings+ancestors, else catalog+dictionary
        strict: List[str] = []
        strict_source = None
        if sources["policy"]:
            strict = list(sources["policy"])
            strict_source = "policy"
        elif sources["siblings"]:
            strict = list(dict.fromkeys(sources["siblings"] + sources["ancestors"]))
            strict_source = "siblings+ancestors"
        else:
            strict = list(
                dict.fromkeys(
                    sources["ancestors"] + sources["catalog"] + sources["dictionary"]
                )
            )
            strict_source = "ancestors+catalog+dictionary"

        # Friendly list for CA
        label_map = {}
        for c in catalog + dictionary:
            label_map[c["resourceType"]] = c.get("label") or c["resourceType"].split("/")[-1]
        for rt in sources["siblings"] + sources["ancestors"] + sources["policy"]:
            label_map.setdefault(rt, rt.split("/")[-1])

        friendly = [
            {"name": label_map.get(rt, rt.split("/")[-1]), "resourceType": rt}
            for rt in strict
        ]
        # de-dupe by resourceType
        seen = set()
        friendly_unique = []
        for f in friendly:
            if f["resourceType"] in seen:
                continue
            seen.add(f["resourceType"])
            friendly_unique.append(f)

        return {
            "status": "success",
            "page_path": page_path,
            "container_path": container,
            "strict_source": strict_source,
            "allowed_resource_types": strict,
            "allowed_for_ca": friendly_unique,
            "sources": sources,
            "message": (
                f"Allowed components from {strict_source} "
                f"({len(friendly_unique)} types)"
            ),
            "notes": [
                "componentGroup is on cq:Component (browser group); .hidden hides from authors.",
                "templateGroup/status/cq:allowedTemplates apply to page templates only — not components.",
                "cq:template on a component is initial content, not a page template.",

                "Only add components allowed for this container/policy when policy exists.",
                "If policy is empty, siblings on the page and ancestor pages guide allowed types.",
                "CA uses friendly names; tool maps to sling:resourceType.",
            ],
        }

    # -------------------------------------------------------------------------
    # Name → resourceType
    # -------------------------------------------------------------------------
    def resolve_resource_type(
        self, component_name: str, page_path: Optional[str] = None
    ) -> dict:
        """
        Map CA name (Title, Hero Image, heroimage) → sling:resourceType.
        Never require CA to know resourceType.
        """
        name = _norm(component_name)
        if not name:
            return {"status": "error", "message": "component name is required"}

        if "/" in component_name and "components" in component_name:
            return {
                "status": "success",
                "resourceType": component_name.strip(),
                "matched_by": "already_resource_type",
            }

        candidates = []

        # dictionary
        for item in self._allowed_from_dictionary():
            rt = item["resourceType"]
            label = _norm(item.get("label") or "")
            leaf = _norm(rt.split("/")[-1])
            if name == label or name == leaf or name in label or label in name:
                candidates.append((rt, "dictionary", 10 if name in (label, leaf) else 5))

        # catalog
        for item in self._allowed_from_catalog():
            rt = item["resourceType"]
            label = _norm(item.get("label") or "")
            leaf = _norm(rt.split("/")[-1])
            if name == label or name == leaf or name in label or leaf in name:
                candidates.append((rt, "catalog", 10 if name in (label, leaf) else 5))

        # page / ancestors
        if page_path:
            for rt in self._allowed_from_ancestor_pages(page_path):
                leaf = _norm(rt.split("/")[-1])
                if name == leaf or name in leaf or leaf in name:
                    candidates.append((rt, "page_scan", 8 if name == leaf else 4))

        if not candidates:
            return {
                "status": "error",
                "message": (
                    f"Cannot resolve component '{component_name}' to a resourceType. "
                    "Load the page in the tool once (catalog) or use a name from allowed list."
                ),
                "hint": "GET /api/page/allowed-components?page_path=...",
            }

        # highest score, prefer longer/more specific rt
        candidates.sort(key=lambda x: (x[2], len(x[0])), reverse=True)
        best = candidates[0]
        return {
            "status": "success",
            "resourceType": best[0],
            "matched_by": best[1],
            "component_name": component_name,
            "alternatives": [
                {"resourceType": c[0], "source": c[1]} for c in candidates[1:4]
            ],
        }

    def list_children(self, container_path: str) -> List[str]:
        try:
            r = self.session.get(
                f"{self.base_url}{container_path}.1.json", timeout=self.timeout
            )
            if r.status_code != 200:
                return []
            data = r.json()
            return [
                n
                for n in data.keys()
                if not n.startswith(("jcr:", "cq:", "sling:"))
            ]
        except Exception:
            return []

    def create_component(
        self,
        container_path: str,
        resource_type: str,
        node_name: Optional[str] = None,
        properties: Optional[Dict[str, Any]] = None,
        order_index: int = 1,
    ) -> dict:
        container_path = container_path.rstrip("/")
        if not self.path_exists(container_path):
            return {"status": "error", "message": f"Container does not exist: {container_path}"}

        rt = (resource_type or "").strip()
        if not rt:
            return {"status": "error", "message": "resourceType is required"}

        base = _safe_node_name(node_name or rt.split("/")[-1])
        existing = set(self.list_children(container_path))
        candidate = base
        if candidate in existing:
            candidate = f"{base}_{order_index}"
        n = 2
        while candidate in existing:
            candidate = f"{base}_{order_index}_{n}"
            n += 1

        target = f"{container_path}/{candidate}"
        props = properties or {}
        data = {
            f"{candidate}/jcr:primaryType": "nt:unstructured",
            f"{candidate}/sling:resourceType": rt,
        }
        for k, v in props.items():
            if v is None or str(v).strip() == "" or str(k).startswith("__"):
                continue
            data[f"{candidate}/{k}"] = v

        try:
            r = self.session.post(
                f"{self.base_url}{container_path}",
                data=data,
                timeout=self.timeout,
            )
            if r.status_code not in (200, 201) or not self.path_exists(target):
                return {
                    "status": "error",
                    "message": f"Create failed ({r.status_code}): {r.text[:250]}",
                    "path": target,
                }
            if props:
                try:
                    self.aem.update_component(
                        target, props, performed_by="component-add"
                    )
                except Exception:
                    pass
            return {
                "status": "success",
                "path": target,
                "node_name": candidate,
                "resourceType": rt,
                "container": container_path,
                "order": order_index,
                "created": True,
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": target}

    def plan_add(self, page_path: str, components: List[dict]) -> dict:
        """
        components items may use:
          - component / name / componentName  (CA friendly)
          - resourceType (optional)
          - properties
        """
        disc = self.discover_containers(page_path)
        if disc.get("status") != "success" or not disc.get("primary_container"):
            return {
                "status": "error",
                "message": disc.get("message") or "No container",
                "discovery": disc,
            }
        container = disc["primary_container"]["path"]
        allowed = self.get_allowed_components(page_path, container)
        allowed_set = set(allowed.get("allowed_resource_types") or [])

        plan = []
        errors = []
        for i, comp in enumerate(components):
            ca_name = (
                comp.get("component")
                or comp.get("componentName")
                or comp.get("name")
                or ""
            )
            rt = (comp.get("resourceType") or "").strip()
            resolution = None
            if not rt:
                resolution = self.resolve_resource_type(ca_name, page_path)
                if resolution.get("status") != "success":
                    errors.append(
                        f"Row {i+1}: {resolution.get('message')}"
                    )
                    plan.append({
                        "order": i + 1,
                        "action": "blocked",
                        "component_name": ca_name,
                        "error": resolution.get("message"),
                    })
                    continue
                rt = resolution["resourceType"]

            allowed_ok = True
            allow_msg = "ok"
            if allowed_set and rt not in allowed_set:
                # soft check: leaf match
                leaf = rt.split("/")[-1]
                if not any(leaf == a.split("/")[-1] for a in allowed_set):
                    allowed_ok = False
                    allow_msg = (
                        f"'{rt}' not in allowed set for this container "
                        f"(source={allowed.get('strict_source')})"
                    )

            entry = {
                "order": i + 1,
                "parent": container,
                "node_name": _safe_node_name(
                    ca_name or rt.split("/")[-1]
                ),
                "component_name": ca_name,
                "resourceType": rt,
                "resolution": resolution,
                "properties": comp.get("properties") or {},
                "action": "create_component" if allowed_ok else "blocked",
                "allowed": allowed_ok,
                "allow_message": allow_msg,
            }
            if not allowed_ok:
                errors.append(f"Row {i+1}: {allow_msg}")
            plan.append(entry)

        return {
            "status": "success" if not errors else "partial",
            "message": "Component ADD plan",
            "discovery": disc,
            "allowed": {
                "source": allowed.get("strict_source"),
                "count": len(allowed_set),
                "for_ca": allowed.get("allowed_for_ca"),
            },
            "plan": plan,
            "errors": errors,
        }

    def apply_add(self, page_path: str, components: List[dict]) -> dict:
        preview = self.plan_add(page_path, components)
        if preview.get("status") == "error":
            return preview

        disc = preview.get("discovery") or {}
        container = (disc.get("primary_container") or {}).get("path")
        if not container:
            return {"status": "error", "message": "No container", "preview": preview}

        results = []
        for item in preview.get("plan") or []:
            if item.get("action") != "create_component":
                results.append({
                    "status": "blocked",
                    "order": item.get("order"),
                    "message": item.get("error") or item.get("allow_message"),
                    "component_name": item.get("component_name"),
                })
                continue
            r = self.create_component(
                container_path=container,
                resource_type=item["resourceType"],
                node_name=item.get("node_name"),
                properties=item.get("properties") or {},
                order_index=item.get("order") or 1,
            )
            r["order"] = item.get("order")
            r["component_name"] = item.get("component_name")
            results.append(r)
            if r.get("status") != "success":
                return {
                    "status": "error",
                    "message": f"Stopped at order {item.get('order')}: {r.get('message')}",
                    "results": results,
                    "preview": preview,
                }

        ok = sum(1 for r in results if r.get("status") == "success")
        return {
            "status": "success",
            "message": f"Added {ok} component(s) in order",
            "results": results,
            "preview": preview,
        }
