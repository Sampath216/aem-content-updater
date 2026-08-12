import requests
from requests.auth import HTTPBasicAuth
from backend.app.core.config import get_settings
import logging
from backend.app.models.audit import SessionLocal, AuditLog
from datetime import datetime
import copy

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


class AEMClient:
    """
    Enterprise AEM Client – Generic Effective-Dialog Discovery Engine.

    Pipeline:
        1. Resolve effective dialog (inheritance + basic resource merger)
        2. Discover COMPLETE tree (never drop nodes)
        3. Expand granite include nodes dynamically
        4. Classify every node (FIELD / TAB / MULTIFIELD / INCLUDE / UNKNOWN …)
        5. Build structured authorable result with full provenance

    Zero hardcoding of component names, field names, tab names, paths,
    or closed widget allow-lists. Unknown nodes are always preserved.
    """

    def __init__(self):
        self.base_url = settings.AEM_BASE_URL.rstrip("/")
        self.auth = HTTPBasicAuth(settings.AEM_USERNAME, settings.AEM_PASSWORD)
        self.timeout = settings.REQUEST_TIMEOUT
        self.session = requests.Session()
        self.session.auth = self.auth
        # cache for included trees to avoid repeated HTTP calls
        self._include_cache = {}

    # =========================================================================
    # Connectivity
    # =========================================================================

    def is_reachable(self) -> dict:
        try:
            url = f"{self.base_url}/libs/granite/core/content/login.html"
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code == 200:
                return {
                    "status": "success",
                    "message": "Successfully connected to AEM",
                    "aem_url": self.base_url,
                    "status_code": response.status_code
                }
            return {
                "status": "error",
                "message": f"AEM responded with status code {response.status_code}",
                "aem_url": self.base_url,
                "status_code": response.status_code
            }
        except requests.exceptions.ConnectionError:
            return {"status": "error", "message": "Cannot connect to AEM. Is it running?", "aem_url": self.base_url}
        except requests.exceptions.Timeout:
            return {"status": "error", "message": "Connection to AEM timed out", "aem_url": self.base_url}
        except Exception as e:
            return {"status": "error", "message": f"Unexpected error: {str(e)}", "aem_url": self.base_url}

    # =========================================================================
    # Component discovery on a page
    # =========================================================================

    def get_components(self, page_path: str, max_depth: int = 4) -> dict:
        try:
            components = []

            def walk(current_path: str, current_depth: int):
                if current_depth > max_depth:
                    return
                url = f"{self.base_url}{current_path}.1.json"
                try:
                    response = self.session.get(url, timeout=self.timeout)
                except Exception:
                    return
                if response.status_code != 200:
                    return
                try:
                    node = response.json()
                except Exception:
                    return
                if not isinstance(node, dict):
                    return

                resource_type = node.get("sling:resourceType")
                if resource_type and resource_type not in ["cq/Page", "cq/PageContent"]:
                    title = resource_type.split("/")[-1]
                    components.append({
                        "path": current_path,
                        "resourceType": resource_type,
                        "title": title
                    })

                for key, value in node.items():
                    if key.startswith(("jcr:", "cq:", "sling:", "nt:")):
                        continue
                    if isinstance(value, dict) or value == {}:
                        walk(f"{current_path}/{key}", current_depth + 1)

            start_path = f"{page_path.rstrip('/')}/jcr:content"
            walk(start_path, 1)

            return {
                "status": "success",
                "page_path": page_path,
                "component_count": len(components),
                "components": components
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": page_path}

    # =========================================================================
    # Resource-type & dialog helpers
    # =========================================================================

    def _resolve_component_definition(self, resource_type: str) -> str | None:
        if not resource_type:
            return None
        for base in ["/apps/", "/libs/"]:
            path = f"{base}{resource_type}"
            try:
                url = f"{self.base_url}{path}.json"
                resp = self.session.get(url, timeout=5)
                if resp.status_code == 200:
                    return path
            except Exception:
                continue
        return None

    def _get_super_type(self, component_def_path: str) -> str | None:
        try:
            url = f"{self.base_url}{component_def_path}.json"
            resp = self.session.get(url, timeout=5)
            if resp.status_code == 200:
                return resp.json().get("sling:resourceSuperType")
        except Exception:
            pass
        return None

    def _find_dialog_path(self, component_def_path: str) -> str | None:
        for name in ["cq:dialog", "_cq_dialog"]:
            dialog_path = f"{component_def_path}/{name}"
            try:
                url = f"{self.base_url}{dialog_path}.json"
                resp = self.session.get(url, timeout=5)
                if resp.status_code == 200:
                    return dialog_path
            except Exception:
                continue
        return None

    def _load_dialog_tree(self, dialog_path: str) -> dict | None:
        try:
            url = f"{self.base_url}{dialog_path}.infinity.json"
            resp = self.session.get(url, timeout=12)
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            logger.warning(f"Failed to load dialog {dialog_path}: {e}")
        return None

    def _load_repository_path(self, path: str) -> dict | None:
        """
        Dynamically load any repository path (used for include expansion).
        Tries the path as given, then common overlay fallbacks.
        No hardcoded project or component paths.
        """
        if not path:
            return None
        path = path.strip()
        if path in self._include_cache:
            return self._include_cache[path]

        candidates = [path]
        # Dynamic fallbacks for /mnt/overlay/ → real locations
        if path.startswith("/mnt/overlay/"):
            rest = path[len("/mnt/overlay/"):]
            candidates.extend([f"/apps/{rest}", f"/libs/{rest}"])
        elif path.startswith("/mnt/overlay"):
            rest = path[len("/mnt/overlay"):].lstrip("/")
            candidates.extend([f"/apps/{rest}", f"/libs/{rest}"])

        for candidate in candidates:
            for suffix in (".infinity.json", ".json"):
                try:
                    url = f"{self.base_url}{candidate}{suffix}"
                    resp = self.session.get(url, timeout=10)
                    if resp.status_code == 200:
                        data = resp.json()
                        if isinstance(data, dict):
                            self._include_cache[path] = data
                            return data
                except Exception:
                    continue
        try:
            logger.info(f"Could not load include path: {path}")
        except Exception:
            pass
        self._include_cache[path] = None
        return None

    # =========================================================================
    # Effective dialog merge
    # =========================================================================

    def _merge_dialog_trees(self, parent: dict, child: dict) -> dict:
        if not isinstance(parent, dict):
            parent = {}
        if not isinstance(child, dict):
            return copy.deepcopy(parent)

        if self._as_bool(child.get("sling:hideResource")):
            return {}

        merged = copy.deepcopy(parent)

        hide_children = child.get("sling:hideChildren")
        if hide_children:
            if isinstance(hide_children, str):
                hide_list = [c.strip() for c in hide_children.split(",")]
            elif isinstance(hide_children, list):
                hide_list = hide_children
            else:
                hide_list = []
            for name in hide_list:
                merged.pop(name, None)

        for key, child_value in child.items():
            if key in ("sling:hideResource", "sling:hideChildren"):
                continue
            if key.startswith("jcr:"):
                merged[key] = child_value
                continue

            if key in merged and isinstance(merged[key], dict) and isinstance(child_value, dict):
                merged[key] = self._merge_dialog_trees(merged[key], child_value)
            else:
                if isinstance(child_value, dict) and self._as_bool(child_value.get("sling:hideResource")):
                    merged.pop(key, None)
                else:
                    merged[key] = copy.deepcopy(child_value)
        return merged

    def _build_dialog_chain(self, resource_type: str) -> dict:
        result = {
            "component_definition": None,
            "inheritance_chain": [],
            "dialogs": []
        }
        visited = set()
        current = resource_type

        while current and current not in visited:
            visited.add(current)
            result["inheritance_chain"].append(current)

            comp_def = self._resolve_component_definition(current)
            if not comp_def:
                break
            if result["component_definition"] is None:
                result["component_definition"] = comp_def

            dialog_path = self._find_dialog_path(comp_def)
            if dialog_path:
                tree = self._load_dialog_tree(dialog_path)
                if tree is not None:
                    result["dialogs"].append({
                        "resourceType": current,
                        "component_definition": comp_def,
                        "dialog_path": dialog_path,
                        "tree": tree
                    })

            current = self._get_super_type(comp_def)
        return result

    def _build_effective_dialog_tree(self, dialogs: list) -> tuple:
        if not dialogs:
            return None, None
        ordered = list(reversed(dialogs))
        effective = copy.deepcopy(ordered[0]["tree"])
        primary_path = ordered[0]["dialog_path"]
        for d in ordered[1:]:
            effective = self._merge_dialog_trees(effective, d["tree"])
            primary_path = d["dialog_path"]
        return effective, primary_path

    # =========================================================================
    # PHASE 1 – COMPLETE DISCOVERY + INCLUDE EXPANSION
    # =========================================================================

    def _is_include_node(self, node: dict) -> bool:
        """Detect include purely from resourceType – no hardcoding of paths."""
        rt = (node.get("sling:resourceType") or node.get("resourceType") or "").lower()
        if not rt:
            return False
        # granite coral/foundation include, or any */include widget
        if "include" not in rt:
            return False
        return True

    def _discover_tree(self, node: dict, path: str, name: str = "", depth: int = 0) -> dict | None:
        """
        Recursively build intermediate representation of EVERY node.
        When an include is found, load the target path and expand its children.
        Never drops nodes. depth guard prevents infinite include loops.
        """
        if not isinstance(node, dict) or depth > 25:
            return None

        props = {}
        children = []

        # Expand include dynamically
        if self._is_include_node(node):
            include_path = node.get("path") or (node.get("properties") or {}).get("path")
            if include_path:
                included = self._load_repository_path(include_path)
                if included and isinstance(included, dict):
                    # The included content becomes children of this include node
                    for k, v in included.items():
                        if isinstance(v, dict):
                            child_path = f"{path}/[include:{include_path}]/{k}"
                            child = self._discover_tree(v, child_path, k, depth + 1)
                            if child:
                                children.append(child)
                        else:
                            if not str(k).startswith("jcr:primaryType"):
                                props[k] = v
                    props["__include_path"] = include_path
                    props["__include_resolved"] = True
                else:
                    props["__include_path"] = include_path
                    props["__include_resolved"] = False

        for k, v in node.items():
            if k == "path" and self._is_include_node(node):
                # already handled
                props[k] = v
                continue
            if isinstance(v, dict):
                child_path = f"{path}/{k}" if path else k
                child = self._discover_tree(v, child_path, k, depth + 1)
                if child:
                    children.append(child)
            else:
                if not str(k).startswith("jcr:primaryType"):
                    props[k] = v

        return {
            "path": path,
            "name": name or (path.split("/")[-1] if path else ""),
            "resourceType": node.get("sling:resourceType"),
            "properties": props,
            "children": children
        }

    # =========================================================================
    # PHASE 2 – CLASSIFICATION (never deletes)
    # =========================================================================

    def _classify_node(self, node: dict) -> str:
        rt = (node.get("resourceType") or "").lower()
        props = node.get("properties") or {}
        name = (node.get("name") or "").lower()

        if self._is_include_node({"sling:resourceType": node.get("resourceType")}):
            return "INCLUDE"

        if any(x in rt for x in ("/tabs", "foundation/tabs", "coral/foundation/tabs")):
            return "TAB_CONTAINER"
        if name == "tabs" and not rt:
            return "TAB_CONTAINER"

        if any(x in rt for x in (
            "/container", "foundation/container", "coral/foundation/container",
            "/fieldset", "/fixedcolumns", "/columns", "/accordion", "/well"
        )):
            return "CONTAINER"

        if "multifield" in rt:
            return "MULTIFIELD"

        if self._looks_like_field(rt, props):
            return "FIELD"

        # Individual tab item: named child under a tabs container, or has title + structure
        child_names = [c.get("name") for c in node.get("children", [])]
        if "items" in child_names or props.get("jcr:title") or props.get("title"):
            # likely a tab panel (basic, advanced, listSettings, image, text, actions, ...)
            if name and name not in ("content", "items", "columns", "column", "cq:dialog"):
                if not self._looks_like_field(rt, props) and "multifield" not in rt:
                    return "TAB"

        if name in ("content", "items", "columns", "column") and not self._looks_like_field(rt, props):
            return "STRUCTURAL"

        if rt:
            return "UNKNOWN"
        return "STRUCTURAL"

    def _looks_like_field(self, rt: str, props: dict) -> bool:
        """Heuristic enrichment only – never used to drop nodes."""
        name_prop = str(props.get("name", ""))
        if name_prop.startswith("./") or (name_prop.startswith("/") and not name_prop.startswith("/mnt")):
            return True
        if any(x in (rt or "") for x in (
            "/form/", "form/textfield", "form/textarea", "form/pathfield",
            "form/select", "form/checkbox", "form/numberfield", "form/datepicker",
            "form/fileupload", "form/hidden", "form/password", "form/radiogroup",
            "form/switch", "form/colorfield", "form/autocomplete", "form/tagfield",
            "pagefield", "richtext", "fileupload", "pathfield", "tagfield",
            "xffield", "form/hidden"
        )):
            return True
        return False

    def _classify_tree(self, node: dict) -> dict:
        if not node:
            return node
        node["classification"] = self._classify_node(node)
        for child in node.get("children", []):
            self._classify_tree(child)
        return node

    # =========================================================================
    # PHASE 3 – BUILD AUTHORABLE STRUCTURE
    # =========================================================================

    def _normalize_name(self, name) -> str:
        if not name:
            return ""
        name = str(name).strip()
        if name.startswith("./"):
            name = name[2:]
        return name

    def _extract_select_options(self, node: dict) -> list:
        """
        Dynamically read select/radio options from dialog structure.
        1) Static items under the select node
        2) Re-load items from repository if path is known
        3) Try datasource only when it exposes static children (no hardcoded lists)
        """
        options = []

        def read_option(n):
            if not n or not isinstance(n, dict):
                return None
            # Support both our intermediate tree and raw AEM json
            props = n.get("properties") if "properties" in n and isinstance(n.get("properties"), dict) else n
            if not isinstance(props, dict):
                props = {}
            rt = (n.get("resourceType") or n.get("sling:resourceType") or props.get("sling:resourceType") or "").lower()
            name = (n.get("name") or "").lower()
            if "datasource" in rt or name == "datasource":
                return None
            if name in ("items", "granite:data", "datasource"):
                return None
            text = props.get("text") or props.get("jcr:title") or props.get("title") or props.get("fieldLabel")
            value = props.get("value")
            if value is None or value == "":
                # node name is often the value (h1, h2, ...)
                value = n.get("name") if n.get("name") not in (None, "items") else props.get("text")
            if text is None or text == "":
                text = value
            if value is None and text is None:
                return None
            if value is None:
                value = text
            if text is None:
                text = value
            # skip pure structural
            if str(value).lower() in ("items", "datasource") and str(text).lower() in ("items", "datasource"):
                return None
            return {"text": str(text), "value": str(value)}

        def collect_from_children(children):
            found = []
            if not children:
                return found
            for c in children:
                if not isinstance(c, dict):
                    continue
                name = (c.get("name") or "").lower()
                rt = (c.get("resourceType") or "").lower()
                if name == "items" or name.endswith("/items"):
                    found.extend(collect_from_children(c.get("children") or []))
                    continue
                if "datasource" in rt or name == "datasource":
                    # try children of datasource (rare static case)
                    found.extend(collect_from_children(c.get("children") or []))
                    continue
                opt = read_option(c)
                if opt:
                    found.append(opt)
                else:
                    # nested
                    found.extend(collect_from_children(c.get("children") or []))
            return found

        # From intermediate tree children
        options.extend(collect_from_children(node.get("children") or []))

        # If empty, re-fetch items from AEM using field path (dynamic, no hardcoding)
        if not options:
            field_path = node.get("path") or ""
            if field_path and not field_path.startswith("[include"):
                for suffix in ("/items", ""):
                    try:
                        url = f"{self.base_url}{field_path}{suffix}.infinity.json"
                        resp = self.session.get(url, timeout=8)
                        if resp.status_code != 200:
                            continue
                        raw = resp.json()
                        if not isinstance(raw, dict):
                            continue
                        # raw AEM json: keys are child names
                        # if we loaded .../items, each child is an option
                        # if we loaded the field itself, look under items
                        source = raw.get("items", raw) if suffix == "" else raw
                        if not isinstance(source, dict):
                            continue
                        for k, v in source.items():
                            if k.startswith(("jcr:", "sling:", "cq:", "nt:", "granite:")):
                                continue
                            if k == "datasource":
                                continue
                            if not isinstance(v, dict):
                                continue
                            # build option from raw node
                            fake = {"name": k, "properties": v, "resourceType": v.get("sling:resourceType")}
                            opt = read_option(fake)
                            if opt:
                                options.append(opt)
                        if options:
                            break
                    except Exception:
                        continue

        # dedupe by value, preserve order
        seen = set()
        unique = []
        for o in options:
            if o["value"] in seen:
                continue
            seen.add(o["value"])
            unique.append(o)
        return unique

    def _build_field_record(self, node: dict, tab_context: str = None) -> dict:
        props = node.get("properties") or {}
        raw_name = props.get("name", "")
        name = self._normalize_name(raw_name)
        rt = node.get("resourceType") or ""
        type_name = rt.split("/")[-1] if rt else "unknown"
        disabled = self._as_bool(props.get("disabled"))
        read_only = (
            self._as_bool(props.get("readOnly"))
            or self._as_bool(props.get("renderReadOnly"))
            or disabled
        )
        hidden = self._as_bool(props.get("hidden")) or self._as_bool(props.get("hide"))
        # Create-only fields (common on page dialogs) — not editable when page already exists
        show_on_create = (
            self._as_bool(props.get("cq:showOnCreate"))
            or self._as_bool(props.get("showOnCreate"))
        )
        hide_on_edit = (
            self._as_bool(props.get("cq:hideOnEdit"))
            or self._as_bool(props.get("hideOnEdit"))
        )
        record = {
            "name": name,
            "label": (
                props.get("fieldLabel")
                or props.get("jcr:title")
                or props.get("title")
                or props.get("text")
                or node.get("name")
            ),
            "type": type_name,
            "resourceType": rt,
            "path": node.get("path"),
            "tab": tab_context,
            "required": self._as_bool(props.get("required")),
            "hidden": hidden,
            "readOnly": read_only,
            "disabled": disabled,
            "renderReadOnly": self._as_bool(props.get("renderReadOnly")),
            "showOnCreate": show_on_create,
            "hideOnEdit": hide_on_edit,
            "cq:hideOnEdit": hide_on_edit,
            "cq:showOnCreate": show_on_create,
            "properties": {
                k: v for k, v in props.items()
                if k not in ("name", "fieldLabel", "jcr:title", "title", "text",
                             "required", "hidden", "readOnly", "__include_path", "__include_resolved")
            }
        }
        for cfg in ("fileReferenceParameter", "fileNameParameter", "emptyText", "multiple"):
            if cfg in props:
                record[cfg] = self._normalize_name(props[cfg]) if cfg.endswith("Parameter") else props[cfg]

        # Extract dropdown/radio options dynamically from dialog tree
        rt_l = rt.lower()
        if any(x in rt_l for x in ("/select", "form/select", "radiogroup", "form/radio", "dropdown")):
            opts = self._extract_select_options(node)
            if opts:
                record["options"] = opts
                record["type"] = "select" if "radio" not in rt_l else "radiogroup"

        return record

    def _collect_under(self, node: dict, tab_context: str = None) -> dict:
        out = {"fields": [], "multifields": [], "unknowns": [], "includes": []}
        if not node:
            return out
        cls = node.get("classification")

        if cls == "FIELD":
            out["fields"].append(self._build_field_record(node, tab_context))
        elif cls == "MULTIFIELD":
            props = node.get("properties") or {}
            mf = {
                "type": "multifield",
                "name": self._normalize_name(props.get("name")),
                "label": props.get("fieldLabel") or props.get("jcr:title") or props.get("title") or node.get("name"),
                "path": node.get("path"),
                "resourceType": node.get("resourceType"),
                "tab": tab_context,
                "itemFields": []
            }
            for child in node.get("children", []):
                sub = self._collect_under(child, tab_context)
                mf["itemFields"].extend(sub["fields"])
            out["multifields"].append(mf)
        elif cls == "INCLUDE":
            out["includes"].append({
                "classification": "INCLUDE",
                "path": node.get("path"),
                "name": node.get("name"),
                "includePath": (node.get("properties") or {}).get("__include_path") or (node.get("properties") or {}).get("path"),
                "resolved": (node.get("properties") or {}).get("__include_resolved", False)
            })
            for child in node.get("children", []):
                sub = self._collect_under(child, tab_context)
                out["fields"].extend(sub["fields"])
                out["multifields"].extend(sub["multifields"])
                out["unknowns"].extend(sub["unknowns"])
                out["includes"].extend(sub["includes"])
        elif cls == "UNKNOWN":
            out["unknowns"].append({
                "classification": "UNKNOWN",
                "path": node.get("path"),
                "name": node.get("name"),
                "resourceType": node.get("resourceType"),
                "properties": node.get("properties") or {},
                "tab": tab_context
            })
            for child in node.get("children", []):
                sub = self._collect_under(child, tab_context)
                out["fields"].extend(sub["fields"])
                out["multifields"].extend(sub["multifields"])
                out["unknowns"].extend(sub["unknowns"])
                out["includes"].extend(sub["includes"])
        else:
            for child in node.get("children", []):
                sub = self._collect_under(child, tab_context)
                out["fields"].extend(sub["fields"])
                out["multifields"].extend(sub["multifields"])
                out["unknowns"].extend(sub["unknowns"])
                out["includes"].extend(sub["includes"])
        return out

    def _extract_authorable(self, node: dict) -> dict:
        result = {
            "tabs": [],
            "fields": [],
            "multifields": [],
            "unknowns": [],
            "includes": []
        }

        def walk(n: dict, current_tab: str = None):
            if not n:
                return
            cls = n.get("classification")
            props = n.get("properties") or {}

            if cls in ("TAB", "TAB_CONTAINER"):
                # Prefer individual child tab panels over the container itself
                child_tabs = []
                leftover_children = []
                for child in n.get("children", []):
                    child_cls = child.get("classification")
                    child_name = (child.get("name") or "").lower()
                    child_props = child.get("properties") or {}
                    # items node under tabs holds the actual tab panels
                    if child_name == "items":
                        for panel in child.get("children", []):
                            panel_cls = panel.get("classification")
                            panel_props = panel.get("properties") or {}
                            panel_name = panel.get("name") or ""
                            # include nodes that represent tabs (basic, advanced, ...)
                            is_panel = (
                                panel_cls in ("TAB", "INCLUDE")
                                or panel_props.get("jcr:title")
                                or panel_props.get("title")
                                or panel_name not in ("", "items", "content", "columns", "column")
                            )
                            if is_panel:
                                child_tabs.append(panel)
                            else:
                                leftover_children.append(panel)
                    elif child_cls in ("TAB", "INCLUDE") or child_props.get("jcr:title") or child_props.get("title"):
                        child_tabs.append(child)
                    else:
                        leftover_children.append(child)

                if child_tabs:
                    for panel in child_tabs:
                        panel_props = panel.get("properties") or {}
                        # Title: jcr:title > title > include path last segment > node name
                        sub_title = (
                            panel_props.get("jcr:title")
                            or panel_props.get("title")
                            or panel.get("name")
                            or "Tab"
                        )
                        # Humanize common technical names
                        if sub_title and sub_title == panel.get("name"):
                            sub_title = sub_title.replace("_", " ").replace("-", " ").strip()
                            if sub_title:
                                sub_title = sub_title[0].upper() + sub_title[1:]
                        sub_tab = {
                            "type": "tab",
                            "name": panel.get("name"),
                            "title": sub_title,
                            "path": panel.get("path"),
                            "resourceType": panel.get("resourceType"),
                            "fields": [],
                            "multifields": [],
                            "unknowns": [],
                            "includes": []
                        }
                        for gc in panel.get("children", []):
                            sub = self._collect_under(gc, sub_title)
                            sub_tab["fields"].extend(sub["fields"])
                            sub_tab["multifields"].extend(sub["multifields"])
                            sub_tab["unknowns"].extend(sub["unknowns"])
                            sub_tab["includes"].extend(sub["includes"])
                        # Also collect from the panel itself if it is INCLUDE (children already expanded)
                        if panel.get("classification") == "INCLUDE":
                            sub = self._collect_under(panel, sub_title)
                            # avoid double-counting: only add if we didn't walk children already
                            if not panel.get("children"):
                                sub_tab["fields"].extend(sub["fields"])
                                sub_tab["multifields"].extend(sub["multifields"])
                        if sub_tab["fields"] or sub_tab["multifields"]:
                            result["tabs"].append(sub_tab)
                            result["fields"].extend(sub_tab["fields"])
                            result["multifields"].extend(sub_tab["multifields"])
                            result["unknowns"].extend(sub_tab["unknowns"])
                            result["includes"].extend(sub_tab["includes"])
                    # leftover structural content without a named tab
                    if leftover_children:
                        for child in leftover_children:
                            sub = self._collect_under(child, None)
                            result["fields"].extend(sub["fields"])
                            result["multifields"].extend(sub["multifields"])
                            result["unknowns"].extend(sub["unknowns"])
                            result["includes"].extend(sub["includes"])
                    return

                # Fallback: single tab from this node
                tab_title = props.get("jcr:title") or props.get("title") or n.get("name")
                if tab_title and str(tab_title).lower() == "tabs":
                    tab_title = "Properties"
                tab_entry = {
                    "type": "tab",
                    "name": n.get("name"),
                    "title": tab_title,
                    "path": n.get("path"),
                    "resourceType": n.get("resourceType"),
                    "fields": [],
                    "multifields": [],
                    "unknowns": [],
                    "includes": []
                }
                for child in n.get("children", []):
                    sub = self._collect_under(child, tab_title)
                    tab_entry["fields"].extend(sub["fields"])
                    tab_entry["multifields"].extend(sub["multifields"])
                    tab_entry["unknowns"].extend(sub["unknowns"])
                    tab_entry["includes"].extend(sub["includes"])
                if tab_entry["fields"] or tab_entry["multifields"]:
                    result["tabs"].append(tab_entry)
                    result["fields"].extend(tab_entry["fields"])
                    result["multifields"].extend(tab_entry["multifields"])
                    result["unknowns"].extend(tab_entry["unknowns"])
                    result["includes"].extend(tab_entry["includes"])
                return

            if cls == "MULTIFIELD":
                sub = self._collect_under(n, current_tab)
                result["multifields"].extend(sub["multifields"])
                return

            if cls == "FIELD":
                result["fields"].append(self._build_field_record(n, current_tab))
                return

            if cls == "INCLUDE":
                sub = self._collect_under(n, current_tab)
                result["fields"].extend(sub["fields"])
                result["multifields"].extend(sub["multifields"])
                result["unknowns"].extend(sub["unknowns"])
                result["includes"].extend(sub["includes"])
                return

            if cls == "UNKNOWN":
                result["unknowns"].append({
                    "classification": "UNKNOWN",
                    "path": n.get("path"),
                    "name": n.get("name"),
                    "resourceType": n.get("resourceType"),
                    "properties": props,
                    "tab": current_tab
                })
                for child in n.get("children", []):
                    walk(child, current_tab)
                return

            for child in n.get("children", []):
                walk(child, current_tab)

        walk(node)
        return result

    # =========================================================================
    # Public resolution
    # =========================================================================



    def _as_bool(self, value) -> bool:
        """Parse AEM/Java-style booleans dynamically."""
        if value is True:
            return True
        if value is False or value is None:
            return False
        s = str(value).strip().lower()
        return s in ("true", "{boolean}true", "1", "yes")

    def _is_authorable_field(self, field: dict, editing_existing: bool = True) -> bool:
        """
        Dynamic check — NEVER hardcode field names.

        AEM dialog visibility (from foundation page dialog patterns):
          cq:hideOnEdit = true  → hide when editing existing content
              (e.g. pagename / Name — create only)
          cq:showOnCreate = true WITHOUT hideOnEdit → field still appears on edit
              (e.g. pagetitle / Page Title — must NOT be dropped)
          renderReadOnly = true → still shown in dialog (may display read-only);
              do NOT drop from discovery

        Rule for edit context: drop only if hidden, disabled, or cq:hideOnEdit.
        """
        if not field:
            return False
        name = (field.get("name") or "").strip()
        if not name:
            return False
        if "@TypeHint" in name or name.endswith("@TypeHint"):
            return False
        if self._as_bool(field.get("hidden")):
            return False
        if self._as_bool(field.get("disabled")):
            return False
        # ONLY hideOnEdit removes field while editing — not showOnCreate alone
        if editing_existing:
            if self._as_bool(field.get("hideOnEdit")) or self._as_bool(field.get("cq:hideOnEdit")):
                return False
        return True


    def validate_properties_for_update(
        self,
        component_path: str,
        properties: dict,
        editing_existing: bool = True,
    ) -> dict:
        """
        Field validation for every proposed update (UI or Excel bulk).

        Dynamic rules — no hardcoded field/component names:
          1. Field must exist on the effective dialog (storage name).
          2. Field must pass authorable checks (not hidden/disabled/cq:hideOnEdit).
          3. Unchanged values are reported as skipped (not errors).

        Returns:
          {
            status, allowed: {name: value}, rejected: [{name, reason}],
            skipped: [{name, reason}], allowed_names: [...]
          }
        """
        if not properties:
            return {
                "status": "error",
                "message": "No properties provided",
                "allowed": {},
                "rejected": [],
                "skipped": [],
                "allowed_names": [],
            }

        current = self.get_component_fields(component_path)
        if current.get("status") != "success":
            return {
                "status": "error",
                "message": current.get("message") or "Could not read component/dialog",
                "allowed": {},
                "rejected": [],
                "skipped": [],
                "allowed_names": [],
            }

        field_meta = current.get("field_meta") or {}
        old_fields = current.get("fields") or {}

        # Build allow map from dialog field_meta + fields (authorable only)
        allow_map = {}  # lower -> canonical name
        meta_by_name = {}
        for name, meta in field_meta.items():
            if not name:
                continue
            if isinstance(meta, dict) and not self._is_authorable_field(meta, editing_existing):
                continue
            allow_map[str(name).lower()] = str(name)
            meta_by_name[str(name)] = meta if isinstance(meta, dict) else {}
            if isinstance(meta, dict):
                for key in ("storageName", "fileReferenceParameter", "name"):
                    v = meta.get(key)
                    if v:
                        allow_map[str(v).lower()] = str(v)
                        meta_by_name[str(v)] = meta

        for name in old_fields.keys():
            if not name:
                continue
            meta = field_meta.get(name) or {}
            if meta and not self._is_authorable_field(meta, editing_existing):
                continue
            allow_map[str(name).lower()] = str(name)
            if name not in meta_by_name:
                meta_by_name[str(name)] = meta if isinstance(meta, dict) else {}

        allowed = {}
        rejected = []
        skipped = []

        def values_equal(a, b):
            if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
                return str(a) == str(b)
            return str(a if a is not None else "") == str(b if b is not None else "")

        for key, value in properties.items():
            key_s = str(key)
            matched = allow_map.get(key_s.lower())
            if matched is None:
                rejected.append({
                    "name": key_s,
                    "reason": "not_in_effective_dialog",
                    "message": (
                        f"Field '{key_s}' is not an authorable field on the effective dialog. "
                        "It will not be written to the repository."
                    ),
                })
                continue

            meta = meta_by_name.get(matched) or field_meta.get(matched) or {}
            if meta and not self._is_authorable_field(meta, editing_existing):
                reason = "not_authorable"
                if self._as_bool(meta.get("hideOnEdit")) or self._as_bool(meta.get("cq:hideOnEdit")):
                    reason = "cq_hide_on_edit"
                elif self._as_bool(meta.get("disabled")):
                    reason = "disabled"
                elif self._as_bool(meta.get("hidden")):
                    reason = "hidden"
                rejected.append({
                    "name": key_s,
                    "mapped_to": matched,
                    "reason": reason,
                    "message": f"Field '{matched}' is not editable in the current dialog context ({reason}).",
                })
                continue

            if values_equal(old_fields.get(matched), value):
                skipped.append({
                    "name": matched,
                    "reason": "unchanged",
                    "message": f"Field '{matched}' already has this value.",
                })
                continue

            allowed[matched] = value

        status = "success"
        if rejected and not allowed:
            status = "error"
        elif rejected:
            status = "partial"

        return {
            "status": status,
            "component_path": component_path,
            "resourceType": current.get("resourceType"),
            "allowed": allowed,
            "rejected": rejected,
            "skipped": skipped,
            "allowed_names": sorted(set(allow_map.values())),
            "message": (
                f"Valid: {len(allowed)}, rejected: {len(rejected)}, skipped: {len(skipped)}"
            ),
        }

    def _merge_tab_fields(self, tabs: list) -> list:
        """
        Do NOT merge tabs together.
        Only merge duplicate field names *within* each tab (e.g. two selects
        both named 'type' so their options combine). Tab structure stays intact.
        """
        out = []
        for tab in tabs or []:
            t = dict(tab)
            t["fields"] = self._merge_fields_by_name(tab.get("fields") or [])
            out.append(t)
        return out

    def _merge_fields_by_name(self, fields: list) -> list:
        """Merge fields that share a storage name; combine select options."""
        seen = {}
        result = []
        for f in fields or []:
            if not self._is_authorable_field(f):
                continue
            n = f.get("name")
            if not n:
                continue
            if n not in seen:
                # copy so we can mutate options safely
                merged = dict(f)
                if merged.get("options"):
                    merged["options"] = list(merged["options"])
                seen[n] = merged
                result.append(merged)
            else:
                existing = seen[n]
                new_opts = f.get("options") or []
                if new_opts:
                    old_opts = existing.get("options") or []
                    if not old_opts:
                        existing["options"] = list(new_opts)
                        if f.get("type"):
                            existing["type"] = f.get("type")
                    else:
                        have = {o.get("value") for o in old_opts}
                        for o in new_opts:
                            if o.get("value") not in have:
                                old_opts.append(o)
                                have.add(o.get("value"))
                        existing["options"] = old_opts
        return result

    def get_dialog_fields_for_resource_type(self, resource_type: str) -> dict:
        self._include_cache = {}  # fresh per resolution
        chain = self._build_dialog_chain(resource_type)

        if not chain["dialogs"]:
            return {
                "status": "warning",
                "message": "No cq:dialog found in the inheritance chain",
                "resolution": chain,
                "fields": [],
                "tabs": [],
                "multifields": [],
                "unknowns": [],
                "includes": []
            }

        effective_tree, primary_dialog_path = self._build_effective_dialog_tree(chain["dialogs"])
        if effective_tree is None:
            return {
                "status": "error",
                "message": "Could not build effective dialog tree",
                "resolution": chain,
                "fields": [],
                "tabs": [],
                "multifields": [],
                "unknowns": [],
                "includes": []
            }

        discovered = self._discover_tree(effective_tree, primary_dialog_path or "", "cq:dialog")
        classified = self._classify_tree(discovered)
        authorable = self._extract_authorable(classified)

        # Deduplicate by name; MERGE options when the same field appears
        # multiple times (e.g. Title type: datasource select + defaulttypes select)
        # Skip non-authorable (hidden / disabled / cq:hideOnEdit) dynamically — every field
        seen = {}
        unique_fields = []
        for f in authorable["fields"]:
            if not self._is_authorable_field(f):
                continue
            n = f.get("name")
            if not n:
                continue
            if n not in seen:
                seen[n] = f
                unique_fields.append(f)
            else:
                existing = seen[n]
                # Merge options from later occurrences (static lists often live here)
                new_opts = f.get("options") or []
                if new_opts:
                    old_opts = existing.get("options") or []
                    if not old_opts:
                        existing["options"] = list(new_opts)
                        if f.get("type"):
                            existing["type"] = f.get("type")
                    else:
                        have = {o.get("value") for o in old_opts}
                        for o in new_opts:
                            if o.get("value") not in have:
                                old_opts.append(o)
                                have.add(o.get("value"))
                        existing["options"] = old_opts
                if new_opts and not (existing.get("options")):
                    existing["path"] = f.get("path") or existing.get("path")

        return {
            "status": "success",
            "resolution": {
                "component_definition": chain["component_definition"],
                "inheritance_chain": chain["inheritance_chain"],
                "dialogs_found": [
                    {"resourceType": d["resourceType"], "dialog_path": d["dialog_path"]}
                    for d in chain["dialogs"]
                ],
                "effective_dialog_path": primary_dialog_path,
                "resolution_strategy": "effective-dialog-merge + include-expansion + full-discovery + classification"
            },
            "fields": self._merge_fields_by_name(unique_fields),
            "tabs": self._merge_tab_fields(authorable["tabs"]),
            "multifields": authorable["multifields"],
            "unknowns": authorable["unknowns"],
            "includes": authorable.get("includes", []),
            "diagnostics": {
                "field_count": len(unique_fields),
                "tab_count": len(authorable["tabs"]),
                "multifield_count": len(authorable["multifields"]),
                "unknown_count": len(authorable["unknowns"]),
                "include_count": len(authorable.get("includes", []))
            }
        }

    def diagnose_component_dialog(self, component_path: str) -> dict:
        try:
            url = f"{self.base_url}{component_path}.json"
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code != 200:
                return {
                    "status": "error",
                    "message": f"Cannot read component: {response.status_code}",
                    "componentPath": component_path
                }

            data = response.json()
            resource_type = data.get("sling:resourceType", "")
            dialog_result = self.get_dialog_fields_for_resource_type(resource_type)
            resolution = dialog_result.get("resolution", {})

            return {
                "status": "success",
                "componentPath": component_path,
                "resourceType": resource_type,
                "componentDefinition": resolution.get("component_definition"),
                "inheritanceChain": resolution.get("inheritance_chain", []),
                "dialogsFound": resolution.get("dialogs_found", []),
                "effectiveDialog": resolution.get("effective_dialog_path"),
                "resolutionStrategy": resolution.get("resolution_strategy"),
                "fieldCount": dialog_result.get("diagnostics", {}).get("field_count", 0),
                "tabCount": dialog_result.get("diagnostics", {}).get("tab_count", 0),
                "multifieldCount": dialog_result.get("diagnostics", {}).get("multifield_count", 0),
                "unknownCount": dialog_result.get("diagnostics", {}).get("unknown_count", 0),
                "includeCount": dialog_result.get("diagnostics", {}).get("include_count", 0),
                "fields": dialog_result.get("fields", []),
                "tabs": dialog_result.get("tabs", []),
                "multifields": dialog_result.get("multifields", []),
                "unknowns": dialog_result.get("unknowns", []),
                "includes": dialog_result.get("includes", []),
                "diagnostics": dialog_result.get("diagnostics", {})
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "componentPath": component_path}



    def _extract_multifield_values(self, data: dict, mf: dict) -> tuple:
        """
        Resolve multifield storage name and current values from component instance.
        Supports:
          - simple multi-value lists
          - composite items (link+text, path, etc.) as list of dicts
        Returns (storage_name, values, label)
        values is either [str, ...] or [{field: val, ...}, ...]
        """
        item_fields = mf.get("itemFields") or []
        item_names = [it.get("name") for it in item_fields if it.get("name")]

        storage = (mf.get("name") or "").strip()
        if not storage or storage.lower() in ("multi", "multifield", "field", "actions"):
            # prefer explicit name from mf, else common composite parent names from path
            p = mf.get("path") or ""
            # .../actions/field or .../actions
            for part in reversed(p.split("/")):
                if part and part not in ("items", "multi", "field", "well", "columns", "column", "content"):
                    if part not in ("cq:dialog",):
                        storage = part
                        break
            if not storage or storage.lower() in ("multi", "field"):
                storage = "actions" if "action" in p.lower() else (item_names[0] if item_names else "pages")

        # Teaser actions: storage is usually "actions"
        if "action" in (mf.get("path") or "").lower() and storage.lower() in ("multi", "field", "items"):
            storage = "actions"

        label = mf.get("label") or storage or "Items"
        if str(label).lower() in ("multi", "multifield", "field"):
            label = storage

        def item_to_value(node):
            if node is None:
                return None
            if isinstance(node, str):
                return node if node else None
            if isinstance(node, (int, float, bool)):
                return str(node)
            if isinstance(node, dict):
                # composite: pick item field values
                row = {}
                for n in item_names:
                    if n in node and node[n] not in (None, ""):
                        row[n] = node[n]
                if row:
                    return row
                # fallback preferred keys
                for pref in ("path", "link", "linkURL", "url", "page", "text", "jcr:title", "value"):
                    if pref in node and node[pref] not in (None, ""):
                        if item_names:
                            # map first scalar to first item field
                            return {item_names[0]: node[pref]}
                        return str(node[pref])
                for k, v in node.items():
                    if k.startswith(("jcr:", "sling:", "cq:", "nt:")):
                        continue
                    if isinstance(v, str) and v:
                        return {k: v} if item_names else v
                return None
            return None

        def collect_from(raw):
            values = []
            if raw is None:
                return values
            if isinstance(raw, list):
                for item in raw:
                    v = item_to_value(item)
                    if v is not None:
                        values.append(v)
                return values
            if isinstance(raw, dict):
                # item0, item1, or uuid keys
                keys = [k for k in raw.keys() if not k.startswith(("jcr:", "sling:", "cq:", "nt:"))]
                # sort item0, item1 naturally
                def sort_key(k):
                    if k.startswith("item") and k[4:].isdigit():
                        return (0, int(k[4:]))
                    return (1, k)
                for k in sorted(keys, key=sort_key):
                    v = item_to_value(raw[k])
                    if v is not None:
                        values.append(v)
                return values
            if isinstance(raw, str) and raw:
                return [raw]
            return values

        values = collect_from(data.get(storage) if storage else None)

        # deep component json
        if not values:
            try:
                # already may have full data; try alternate keys
                for alt in ("actions", "pages", "links", storage):
                    if alt and alt in data:
                        values = collect_from(data.get(alt))
                        if values:
                            storage = alt
                            break
            except Exception:
                pass

        return storage or "items", values, label



    def _infer_showhide_group_from_path(self, path: str) -> str | None:
        """Dynamic: setXxx / showXxx path segments → group name (any project)."""
        if not path:
            return None
        import re
        m = re.search(r"/set([A-Za-z][A-Za-z0-9]*)/", path)
        if m:
            name = m.group(1)
            return name[0].lower() + name[1:]
        m = re.search(r"/show([A-Za-z][A-Za-z0-9]*)/", path, re.I)
        if m:
            name = m.group(1)
            return name[0].lower() + name[1:]
        return None

    def get_allowed_field_names(self, component_path: str) -> dict:
        """Strict allow-list from effective dialog authorable fields only."""
        result = self.get_component_fields(component_path)
        if result.get("status") != "success":
            return {}
        allowed = {}
        for name, meta in (result.get("field_meta") or {}).items():
            if not name:
                continue
            if isinstance(meta, dict) and not self._is_authorable_field(meta):
                continue
            allowed[str(name).lower()] = str(name)
            if isinstance(meta, dict):
                for key in ("storageName", "fileReferenceParameter", "name"):
                    v = meta.get(key)
                    if v:
                        allowed[str(v).lower()] = str(v)
        for f in (result.get("fields") or {}):
            meta = (result.get("field_meta") or {}).get(f)
            if meta and isinstance(meta, dict) and not self._is_authorable_field(meta):
                continue
            if f:
                allowed[str(f).lower()] = str(f)
        for mf in result.get("multifields") or []:
            n = mf.get("name")
            if n:
                allowed[str(n).lower()] = str(n)
        return allowed

    def get_component_fields(self, component_path: str) -> dict:
        try:
            url = f"{self.base_url}{component_path}.json"
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code != 200:
                return {
                    "status": "error",
                    "message": f"Could not read component. Status code: {response.status_code}",
                    "path": component_path
                }

            data = response.json()
            resource_type = data.get("sling:resourceType", "")
            dialog_result = self.get_dialog_fields_for_resource_type(resource_type)

            fields = {}
            field_meta = {}

            if dialog_result.get("status") == "success":
                for f in dialog_result.get("fields", []):
                    name = f.get("name")
                    if not name:
                        continue
                    if not self._is_authorable_field(f):
                        continue
                    if f.get("fileReferenceParameter"):
                        storage = f["fileReferenceParameter"]
                        val = data.get(storage, "")
                        fields[storage] = "" if val is None else val
                        field_meta[storage] = {**f, "storageName": storage, "dialogName": name}
                    else:
                        val = data.get(name, "")
                        fields[name] = "" if val is None else val
                        field_meta[name] = f

                for mf in dialog_result.get("multifields", []):
                    storage, values, label = self._extract_multifield_values(data, mf)
                    # Also fetch deeper .infinity if values empty (child structure)
                    if not values and storage:
                        try:
                            deep_url = f"{self.base_url}{component_path}.infinity.json"
                            deep_resp = self.session.get(deep_url, timeout=10)
                            if deep_resp.status_code == 200:
                                deep_data = deep_resp.json()
                                storage2, values2, label2 = self._extract_multifield_values(deep_data, mf)
                                if values2:
                                    storage, values, label = storage2, values2, label2
                        except Exception:
                            pass
                    fields[storage] = values
                    field_meta[storage] = {
                        "name": storage,
                        "label": label,
                        "type": "multifield",
                        "path": mf.get("path"),
                        "itemFields": mf.get("itemFields", []),
                        "showhideGroup": self._infer_showhide_group_from_path(mf.get("path") or ""),
                    }
                    # Update multifield entry name/label for frontend
                    mf["name"] = storage
                    mf["label"] = label
                    mf["currentValues"] = values

            return {
                "status": "success",
                "component_path": component_path,
                "resourceType": resource_type,
                "field_count": len(fields),
                "fields": fields,
                "field_meta": field_meta,
                "tabs": dialog_result.get("tabs", []),
                "multifields": dialog_result.get("multifields", []),
                "unknowns": dialog_result.get("unknowns", []),
                "includes": dialog_result.get("includes", []),
                "dialog_resolution": dialog_result.get("resolution", {})
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": component_path}

    def update_component(self, component_path: str, properties: dict, performed_by: str = "system") -> dict:
        db = SessionLocal()
        try:
            if not properties:
                return {"status": "error", "message": "No properties provided to update"}

            current = self.get_component_fields(component_path)
            if current.get("status") != "success":
                return {"status": "error", "message": f"Could not read component: {current.get('message')}"}

            old_fields = current.get("fields", {})
            field_meta = current.get("field_meta") or {}

            # Central field validation (dialog + cq:hideOnEdit + etc.) — every field
            validation = self.validate_properties_for_update(
                component_path, properties, editing_existing=True
            )
            valid_props = validation.get("allowed") or {}
            rejected = validation.get("rejected") or []
            skipped = validation.get("skipped") or []

            if rejected and not valid_props:
                return {
                    "status": "error",
                    "message": validation.get("message") or "All fields rejected by dialog validation",
                    "rejected": rejected,
                    "skipped": skipped,
                    "allowed_names": validation.get("allowed_names") or [],
                }

            if rejected:
                # Refuse partial write of unknown fields — safer for enterprise
                return {
                    "status": "error",
                    "message": (
                        "Update blocked: some fields failed dialog validation. "
                        "Fix or remove rejected fields and retry. "
                        + validation.get("message", "")
                    ),
                    "rejected": rejected,
                    "skipped": skipped,
                    "would_update": list(valid_props.keys()),
                    "allowed_names": validation.get("allowed_names") or [],
                }

            if not valid_props:
                return {
                    "status": "success",
                    "message": "No actual changes detected (all values already match)",
                    "updated_properties": [],
                    "skipped": skipped,
                }

            url = f"{self.base_url}{component_path}"
            # Build Sling POST — support simple values and multifield lists dynamically
            post_data = []
            for k, v in valid_props.items():
                if isinstance(v, list):
                    # Multifield: send as repeated ./key or composite ./key/itemN/sub
                    meta = field_meta.get(k) or {}
                    item_fields = meta.get("itemFields") or []
                    item_names = [it.get("name") for it in item_fields if it.get("name")]
                    for i, item in enumerate(v):
                        if isinstance(item, dict):
                            for sub_k, sub_v in item.items():
                                post_data.append((f"./{k}/item{i}/{sub_k}", sub_v))
                        elif item_names and len(item_names) == 1:
                            post_data.append((f"./{k}/item{i}/{item_names[0]}", item))
                        else:
                            post_data.append((f"./{k}", item))
                elif isinstance(v, dict):
                    for sub_k, sub_v in v.items():
                        post_data.append((f"./{k}/{sub_k}", sub_v))
                else:
                    post_data.append((f"./{k}", v if v is not None else ""))

            response = self.session.post(url, data=post_data, timeout=self.timeout)
            success = response.status_code in (200, 201)
            message = "Component updated successfully" if success else f"Update failed. Status code: {response.status_code}"

            for key, new_value in valid_props.items():
                audit_entry = AuditLog(
                    timestamp=datetime.utcnow(),
                    component_path=component_path,
                    property_name=key,
                    old_value=str(old_fields.get(key)) if old_fields.get(key) is not None else None,
                    new_value=str(new_value),
                    success=success,
                    message=message,
                    performed_by=performed_by
                )
                db.add(audit_entry)
            db.commit()

            if success:
                return {
                    "status": "success",
                    "message": message,
                    "component_path": component_path,
                    "updated_properties": list(valid_props.keys()),
                    "status_code": response.status_code
                }
            return {
                "status": "error",
                "message": message,
                "component_path": component_path,
                "response_text": response.text[:500]
            }
        except Exception as e:
            db.rollback()
            return {"status": "error", "message": str(e), "component_path": component_path}
        finally:
            db.close()

    def get_page_properties_fields(self, page_path: str) -> dict:
        """
        Page Properties – same generic dialog engine on jcr:content.
        Includes across Basic/Advanced/... tabs are expanded dynamically.
        """
        component_path = f"{page_path.rstrip('/')}/jcr:content"
        result = self.get_component_fields(component_path)
        if result.get("status") != "success":
            return result
        # Ensure resourceType is present for debugging
        result["page_path"] = page_path.rstrip("/")
        result["is_page_properties"] = True
        return result
