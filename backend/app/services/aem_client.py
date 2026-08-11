import requests
from requests.auth import HTTPBasicAuth
from backend.app.core.config import get_settings
import logging
from backend.app.models.audit import SessionLocal, AuditLog
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


class AEMClient:
    """
    Professional client to communicate with Adobe Experience Manager.
    Includes Effective Dialog Resolution Engine that follows
    sling:resourceSuperType inheritance and discovers fields from
    the complete inheritance chain (project + Core Components).
    """

    def __init__(self):
        self.base_url = settings.AEM_BASE_URL.rstrip("/")
        self.auth = HTTPBasicAuth(settings.AEM_USERNAME, settings.AEM_PASSWORD)
        self.timeout = settings.REQUEST_TIMEOUT
        self.session = requests.Session()
        self.session.auth = self.auth

    # -------------------------------------------------------------------------
    # Connectivity
    # -------------------------------------------------------------------------

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
            else:
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

    # -------------------------------------------------------------------------
    # Component Discovery on a Page
    # -------------------------------------------------------------------------

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

    # -------------------------------------------------------------------------
    # Resource Type + Inheritance Resolution
    # -------------------------------------------------------------------------

    def _resolve_component_definition(self, resource_type: str) -> str | None:
        """Resolve resourceType to actual repository path (/apps or /libs)."""
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
        """Read sling:resourceSuperType from a component definition."""
        try:
            url = f"{self.base_url}{component_def_path}.json"
            resp = self.session.get(url, timeout=5)
            if resp.status_code == 200:
                return resp.json().get("sling:resourceSuperType")
        except Exception:
            pass
        return None

    def _find_dialog_path(self, component_def_path: str) -> str | None:
        """Return cq:dialog or _cq_dialog path if it exists under the component."""
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

    def _build_inheritance_chain(self, resource_type: str) -> dict:
        """
        Build the complete resource type inheritance chain.
        Does NOT stop when a dialog is found.
        Returns:
        {
            "component_definition": "...",
            "inheritance_chain": ["child", "parent", "grandparent", ...],
            "dialogs": [
                {"resourceType": "...", "component_definition": "...", "dialog_path": "..."},
                ...
            ]
        }
        """
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

            dialog = self._find_dialog_path(comp_def)
            if dialog:
                result["dialogs"].append({
                    "resourceType": current,
                    "component_definition": comp_def,
                    "dialog_path": dialog
                })

            current = self._get_super_type(comp_def)

        return result

    # -------------------------------------------------------------------------
    # Field Identification & Parsing
    # -------------------------------------------------------------------------

    def _is_form_field(self, node: dict) -> bool:
        """
        Decide if a dialog node is a real authorable form field.
        Based on sling:resourceType of Granite / Coral / AEM authoring widgets.
        """
        rt = (node.get("sling:resourceType") or "").lower()
        if not rt:
            return False

        form_indicators = [
            # Standard Granite / Coral form fields
            "/form/textfield",
            "/form/textarea",
            "/form/pathfield",
            "/form/select",
            "/form/checkbox",
            "/form/numberfield",
            "/form/datepicker",
            "/form/hidden",
            "/form/password",
            "/form/radiogroup",
            "/form/switch",
            "/form/fileupload",
            "/form/colorfield",
            "/form/autocomplete",
            "/form/tagfield",
            "/form/pagefield",
            "pagefield",
            "/foundation/form/",
            "granite/ui/components/coral/foundation/form/",
            "granite/ui/components/foundation/form/",

            # AEM authoring specific (including fileupload used by Core Image)
            "cq/gui/components/authoring/dialog/fileupload",
            "cq/gui/components/authoring/dialog/richtext",
            "cq/gui/components/common/wcm/pathfield",
            "cq/gui/components/authoring/dialog/fileupload",
            "cq/gui/components/coral/common/form/",
            "dam/gui/coral/components/",
        ]

        return any(ind in rt for ind in form_indicators)

    def _normalize_field_name(self, name: str) -> str:
        if not name:
            return ""
        name = name.strip()
        if name.startswith("./"):
            name = name[2:]
        return name

    def _parse_dialog_fields(self, dialog_data: dict, source_info: dict, fields: list = None) -> list:
        """
        Recursively walk a dialog tree and collect real form fields.
        Attaches provenance and special configuration properties
        (fileReferenceParameter, fileNameParameter, etc.).
        """
        if fields is None:
            fields = []

        if not isinstance(dialog_data, dict):
            return fields

        # Real form field?
        if self._is_form_field(dialog_data):
            raw_name = dialog_data.get("name", "")
            name = self._normalize_field_name(raw_name)
            if name:
                field = {
                    "name": name,
                    "label": (
                        dialog_data.get("fieldLabel")
                        or dialog_data.get("title")
                        or dialog_data.get("text")
                        or name
                    ),
                    "type": (dialog_data.get("sling:resourceType") or "").split("/")[-1],
                    "required": str(dialog_data.get("required", "")).lower() in ("true", "true"),
                    "hidden": str(dialog_data.get("hidden", "")).lower() in ("true", "true"),
                    "readOnly": str(dialog_data.get("readOnly", "")).lower() in ("true", "true"),
                    # Provenance
                    "inheritedFrom": source_info.get("resourceType"),
                    "dialogPath": source_info.get("dialog_path"),
                    "componentDefinition": source_info.get("component_definition"),
                }

                # Important configuration mappings (must NOT become separate fields)
                if dialog_data.get("fileReferenceParameter"):
                    field["fileReferenceParameter"] = self._normalize_field_name(
                        dialog_data.get("fileReferenceParameter")
                    )
                if dialog_data.get("fileNameParameter"):
                    field["fileNameParameter"] = self._normalize_field_name(
                        dialog_data.get("fileNameParameter")
                    )
                if dialog_data.get("fileReference"):
                    field["fileReference"] = dialog_data.get("fileReference")

                # Avoid exact name duplicates (child wins because we process child first)
                if not any(f["name"] == name for f in fields):
                    fields.append(field)

            # Do not recurse into the internals of a field widget
            return fields

        # Structural node → recurse
        for key, value in dialog_data.items():
            if key.startswith(("jcr:", "sling:", "cq:")):
                continue
            if isinstance(value, dict):
                self._parse_dialog_fields(value, source_info, fields)

        return fields

    # -------------------------------------------------------------------------
    # Effective Dialog Resolution + Field Extraction
    # -------------------------------------------------------------------------

    def get_dialog_fields_for_resource_type(self, resource_type: str) -> dict:
        """
        Resolve the complete inheritance chain, collect dialogs from every level,
        and extract all authorable fields (child overrides parent by name).
        """
        chain = self._build_inheritance_chain(resource_type)

        if not chain["dialogs"]:
            return {
                "status": "warning",
                "message": "No cq:dialog found anywhere in the inheritance chain",
                "resolution": chain,
                "fields": []
            }

        all_fields = []
        # Process from child → parent so that child fields take precedence
        for dialog_info in chain["dialogs"]:
            try:
                url = f"{self.base_url}{dialog_info['dialog_path']}.infinity.json"
                resp = self.session.get(url, timeout=10)
                if resp.status_code != 200:
                    continue
                dialog_data = resp.json()
                self._parse_dialog_fields(dialog_data, dialog_info, all_fields)
            except Exception as e:
                logger.warning(f"Failed to load dialog {dialog_info['dialog_path']}: {e}")
                continue

        return {
            "status": "success",
            "resolution": {
                "component_definition": chain["component_definition"],
                "inheritance_chain": chain["inheritance_chain"],
                "dialogs_found": [
                    {
                        "resourceType": d["resourceType"],
                        "dialog_path": d["dialog_path"]
                    }
                    for d in chain["dialogs"]
                ]
            },
            "fields": all_fields
        }

    def diagnose_component_dialog(self, component_path: str) -> dict:
        """
        Full diagnostic of the effective dialog resolution for a component.
        Shows the complete inheritance chain and every dialog that was considered.
        """
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

            chain = self._build_inheritance_chain(resource_type)
            dialog_result = self.get_dialog_fields_for_resource_type(resource_type)

            return {
                "status": "success",
                "componentPath": component_path,
                "resourceType": resource_type,
                "componentDefinition": chain.get("component_definition"),
                "inheritanceChain": chain.get("inheritance_chain", []),
                "dialogsFound": [
                    {
                        "resourceType": d["resourceType"],
                        "dialog_path": d["dialog_path"]
                    }
                    for d in chain.get("dialogs", [])
                ],
                "fieldCount": len(dialog_result.get("fields", [])),
                "fields": dialog_result.get("fields", []),
                "diagnostics": []
            }

        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "componentPath": component_path
            }

    # -------------------------------------------------------------------------
    # Public API – Get fields + current values for a component
    # -------------------------------------------------------------------------

    def get_component_fields(self, component_path: str) -> dict:
        """
        Returns the exact authorable fields from the effective dialog(s)
        + their current values from the component instance.
        """
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
                    name = f["name"]
                    # Current value from the component instance
                    current_value = data.get(name, "")
                    if current_value is None:
                        current_value = ""

                    # Special handling for fileupload: the storage property
                    # is often fileReference, not the dialog name "file"
                    if f.get("fileReferenceParameter"):
                        ref_name = f["fileReferenceParameter"]
                        ref_value = data.get(ref_name, "")
                        if ref_value is None:
                            ref_value = ""
                        # Expose the storage property that authors actually care about
                        fields[ref_name] = ref_value
                        field_meta[ref_name] = {
                            **f,
                            "storageName": ref_name,
                            "dialogName": name
                        }
                    else:
                        fields[name] = current_value
                        field_meta[name] = f
            else:
                # Fallback (rare) – only simple authored values
                skip_keys = {
                    "jcr:primaryType", "jcr:created", "jcr:createdBy",
                    "jcr:lastModified", "jcr:lastModifiedBy", "jcr:mixinTypes",
                    "sling:resourceType", "cq:lastReplicated", "cq:lastReplicatedBy",
                    "cq:lastReplicationAction", "jcr:uuid", "cq:lastRolledout",
                    "cq:lastRolledoutBy"
                }
                for key, value in data.items():
                    if key in skip_keys:
                        continue
                    if isinstance(value, (str, int, float, bool)) or value is None:
                        fields[key] = value if value is not None else ""

            return {
                "status": "success",
                "component_path": component_path,
                "resourceType": resource_type,
                "field_count": len(fields),
                "fields": fields,
                "field_meta": field_meta,
                "dialog_resolution": dialog_result.get("resolution", {})
            }

        except Exception as e:
            return {"status": "error", "message": str(e), "path": component_path}

    # -------------------------------------------------------------------------
    # Strict Update (never creates new fields)
    # -------------------------------------------------------------------------

    def update_component(self, component_path: str, properties: dict, performed_by: str = "system") -> dict:
        """
        Strict update: Only fields that exist in the component dialog are allowed.
        Never creates new fields in CRXDE.
        """
        db = SessionLocal()
        try:
            if not properties:
                return {"status": "error", "message": "No properties provided to update"}

            current = self.get_component_fields(component_path)
            if current.get("status") != "success":
                return {
                    "status": "error",
                    "message": f"Could not read component: {current.get('message')}"
                }

            allowed_fields = {k.lower(): k for k in current.get("fields", {}).keys()}
            old_fields = current.get("fields", {})

            valid_props = {}
            rejected = []

            for key, value in properties.items():
                matched = allowed_fields.get(key.lower())
                if matched is None:
                    rejected.append(key)
                else:
                    old_val = old_fields.get(matched)
                    if str(old_val or "") != str(value or ""):
                        valid_props[matched] = value

            if rejected:
                return {
                    "status": "error",
                    "message": (
                        f"These fields do not exist in the component dialog and were rejected: "
                        f"{', '.join(rejected)}. Allowed fields: "
                        f"{', '.join(list(allowed_fields.values())[:15])}..."
                    )
                }

            if not valid_props:
                return {
                    "status": "success",
                    "message": "No actual changes detected (all values already match)",
                    "updated_properties": []
                }

            url = f"{self.base_url}{component_path}"
            data = {f"./{k}": v for k, v in valid_props.items()}

            response = self.session.post(url, data=data, timeout=self.timeout)
            success = response.status_code in [200, 201]
            message = "Component updated successfully" if success else f"Update failed. Status code: {response.status_code}"

            for key, new_value in valid_props.items():
                old_value = old_fields.get(key)
                audit_entry = AuditLog(
                    timestamp=datetime.utcnow(),
                    component_path=component_path,
                    property_name=key,
                    old_value=str(old_value) if old_value is not None else None,
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
            else:
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

    # -------------------------------------------------------------------------
    # Page Properties
    # -------------------------------------------------------------------------

    def get_page_properties_fields(self, page_path: str) -> dict:
        """
        Get all authorable fields for Page Properties using the same
        Effective Dialog Resolution Engine.
        """
        component_path = f"{page_path.rstrip('/')}/jcr:content"
        return self.get_component_fields(component_path)
