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
    """

    def __init__(self):
        self.base_url = settings.AEM_BASE_URL.rstrip("/")
        self.auth = HTTPBasicAuth(settings.AEM_USERNAME, settings.AEM_PASSWORD)
        self.timeout = settings.REQUEST_TIMEOUT
        self.session = requests.Session()
        self.session.auth = self.auth

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

    def get_component_fields(self, component_path: str) -> dict:
        """
        Returns authored values + empty dialog fields so CA can fill them.
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

            # Properties that should never be shown to Content Authors
            skip_keys = {
                "jcr:primaryType", "jcr:created", "jcr:createdBy",
                "jcr:lastModified", "jcr:lastModifiedBy", "jcr:mixinTypes",
                "sling:resourceType", "cq:lastReplicated", "cq:lastReplicatedBy",
                "cq:lastReplicationAction", "jcr:uuid", "cq:lastRolledout",
                "cq:lastRolledoutBy", "cq:isCancelledForChildren",
                "cq:isContainer", "jcr:language", "cq:name", "cq:parentPath",
                "cq:template", "cq:allowedTemplates", "sling:alias"
            }

            fields = {}

            # 1. Currently authored simple values
            for key, value in data.items():
                if key in skip_keys:
                    continue
                if isinstance(value, (str, int, float, bool)) or value is None:
                    fields[key] = value

            # 2. Discover dialog fields (including empty ones)
            dialog_fields = self._get_dialog_fields(resource_type)
            for name in dialog_fields:
                clean = name.lstrip("./")
                if clean and clean not in fields and clean not in skip_keys:
                    fields[clean] = ""
            # Force common fields for well-known components (temporary safety net)
            resource_type_lower = resource_type.lower() if resource_type else ""
            if "title" in resource_type_lower:
                for forced in ["jcr:title", "type", "link", "linkURL", "linkTo"]:
                    if forced not in fields:
                        fields[forced] = ""
            return {
                "status": "success",
                "component_path": component_path,
                "resourceType": resource_type,
                "field_count": len(fields),
                "fields": fields
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": component_path}

    def _get_dialog_fields(self, resource_type: str) -> list:
        """
        Discover dialog fields carefully.
        Prefer the component's own dialog.
        Only fall back to one level of sling:resourceSuperType if needed.
        """
        if not resource_type:
            return []

        field_names = set()

        def collect_from_dialog(base_path: str) -> int:
            """Returns how many fields were found"""
            count_before = len(field_names)
            possible = [
                f"{base_path}/cq:dialog",
                f"{base_path}/_cq_dialog",
                f"{base_path}/dialog",
            ]
            for dialog_path in possible:
                for selector in [".infinity.json", ".5.json", ".3.json"]:
                    try:
                        url = f"{self.base_url}{dialog_path}{selector}"
                        response = self.session.get(url, timeout=7)
                        if response.status_code == 200:
                            self._extract_field_names(response.json(), field_names)
                            break
                    except Exception:
                        continue
            return len(field_names) - count_before

        # 1. Try the component's own dialog first (most important)
        found = collect_from_dialog(f"/apps/{resource_type}")
        if found == 0:
            found = collect_from_dialog(f"/libs/{resource_type}")

        # 2. Only if we found very few fields, look at one level of super type
        if found < 3:
            try:
                for base in ["/apps/", "/libs/"]:
                    url = f"{self.base_url}{base}{resource_type}.json"
                    response = self.session.get(url, timeout=5)
                    if response.status_code == 200:
                        data = response.json()
                        super_type = data.get("sling:resourceSuperType")
                        if super_type:
                            collect_from_dialog(f"/apps/{super_type}")
                            collect_from_dialog(f"/libs/{super_type}")
                        break
            except Exception:
                pass

        return list(field_names)
    
        def resolve_super_type(current_resource_type: str):
            """Follow the sling:resourceSuperType chain"""
            if not current_resource_type or current_resource_type in visited:
                return
            visited.add(current_resource_type)

            # 1. Try the component's own dialog first
            collect_from_dialog(f"/apps/{current_resource_type}")
            collect_from_dialog(f"/libs/{current_resource_type}")

            # 2. Read the component node to find sling:resourceSuperType
            for base in ["/apps/", "/libs/"]:
                try:
                    url = f"{self.base_url}{base}{current_resource_type}.json"
                    response = self.session.get(url, timeout=6)
                    if response.status_code == 200:
                        data = response.json()
                        super_type = data.get("sling:resourceSuperType")
                        if super_type and super_type not in visited:
                            resolve_super_type(super_type)
                        break
                except Exception:
                    continue

        # Start the discovery
        resolve_super_type(resource_type)

        return list(field_names)

    def _extract_field_names(self, node, field_names: set):
        """
        Recursively collect every 'name' property from the dialog structure.
        """
        if not isinstance(node, dict):
            return

        name = node.get("name")
        if isinstance(name, str) and name.strip():
            clean = name.strip().lstrip("./")
            if clean and not clean.startswith(("jcr:", "sling:", "cq:", "nt:")):
                field_names.add(clean)

        for key, value in node.items():
            if isinstance(value, dict):
                self._extract_field_names(value, field_names)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        self._extract_field_names(item, field_names)

    def update_component(self, component_path: str, properties: dict, performed_by: str = "system") -> dict:
        """
        Strict update: Only fields that exist in the component dialog are allowed.
        Never creates new fields in CRXDE.
        """
        db = SessionLocal()
        try:
            if not properties:
                return {"status": "error", "message": "No properties provided to update"}

            # 1. Get current fields + dialog fields (allowed list)
            current = self.get_component_fields(component_path)
            if current.get("status") != "success":
                return {
                    "status": "error",
                    "message": f"Could not read component: {current.get('message')}"
                }

            allowed_fields = {
                k.lower(): k for k in current.get("fields", {}).keys()}
            old_fields = current.get("fields", {})

            # 2. Validate every incoming property
            valid_props = {}
            rejected = []

            for key, value in properties.items():
                matched = allowed_fields.get(key.lower())
                if matched is None:
                    rejected.append(key)
                else:
                    # Only include if value is actually different
                    old_val = old_fields.get(matched)
                    if str(old_val or "") != str(value or ""):
                        valid_props[matched] = value

            if rejected:
                return {
                    "status": "error",
                    "message": f"These fields do not exist in the component dialog and were rejected: {', '.join(rejected)}. Allowed fields: {', '.join(list(allowed_fields.values())[:15])}..."
                }

            if not valid_props:
                return {
                    "status": "success",
                    "message": "No actual changes detected (all values already match)",
                    "updated_properties": []
                }

            # 3. Perform the update only with validated fields
            url = f"{self.base_url}{component_path}"
            data = {f"./{k}": v for k, v in valid_props.items()}

            response = self.session.post(url, data=data, timeout=self.timeout)
            success = response.status_code in [200, 201]
            message = "Component updated successfully" if success else f"Update failed. Status code: {response.status_code}"

            # 4. Audit log
            for key, new_value in valid_props.items():
                old_value = old_fields.get(key)
                audit_entry = AuditLog(
                    timestamp=datetime.utcnow(),
                    component_path=component_path,
                    property_name=key,
                    old_value=str(
                        old_value) if old_value is not None else None,
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

    def get_page_properties_fields(self, page_path: str) -> dict:
        """
        Get all possible fields for Page Properties (authored + dialog fields).
        """
        component_path = f"{page_path.rstrip('/')}/jcr:content"

        # First get whatever is currently on the node + dialog of the page component
        result = self.get_component_fields(component_path)

        if result.get("status") != "success":
            return result

        # Also force discovery from the structure page component dialog
        extra_fields = self._get_dialog_fields(
            "weretail/components/structure/page")

        fields = result.get("fields", {})
        for f in extra_fields:
            clean = f.lstrip("./")
            if clean and clean not in fields:
                fields[clean] = ""

        # Common page property fields that should always be available
        always_available = [
            "jcr:title", "jcr:description", "pageTitle",
            "cq:canonicalUrl", "keywords", "metaTitle", "metaDescription",
            "navTitle", "subtitle", "hideInNav"
        ]
        for f in always_available:
            if f not in fields:
                fields[f] = ""

        result["fields"] = fields
        result["field_count"] = len(fields)
        return result
