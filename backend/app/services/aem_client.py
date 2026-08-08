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
        Try multiple common dialog locations and extract field names.
        """
        if not resource_type:
            return []

        possible_paths = [
            f"/apps/{resource_type}/cq:dialog",
            f"/apps/{resource_type}/_cq_dialog",
            f"/apps/{resource_type}/dialog",
            f"/libs/{resource_type}/cq:dialog",
            f"/libs/{resource_type}/_cq_dialog",
            f"/libs/{resource_type}/dialog",
        ]

        field_names = set()

        for dialog_path in possible_paths:
            for selector in [".infinity.json", ".6.json", ".4.json", ".2.json"]:
                try:
                    url = f"{self.base_url}{dialog_path}{selector}"
                    response = self.session.get(url, timeout=8)
                    if response.status_code == 200:
                        dialog_data = response.json()
                        self._extract_field_names(dialog_data, field_names)
                        if field_names:
                            return list(field_names)
                except Exception:
                    continue

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
        db = SessionLocal()
        try:
            if not properties:
                return {"status": "error", "message": "No properties provided to update"}

            current = self.get_component_fields(component_path)
            old_fields = current.get("fields", {}) if current.get("status") == "success" else {}

            url = f"{self.base_url}{component_path}"
            data = {f"./{key}": value for key, value in properties.items()}

            response = self.session.post(url, data=data, timeout=self.timeout)

            success = response.status_code in [200, 201]
            message = "Component updated successfully" if success else f"Update failed. Status code: {response.status_code}"

            for key, new_value in properties.items():
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
                    "updated_properties": list(properties.keys()),
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