import requests
from requests.auth import HTTPBasicAuth
from backend.app.core.config import get_settings
import logging

# Set up basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()

class AEMClient:
    """
    Professional client to communicate with Adobe Experience Manager.
    Handles authentication, timeouts, and basic error handling.
    """

    def __init__(self):
        # Initialize AEM connection settings
        self.base_url = settings.AEM_BASE_URL.rstrip("/")
        self.auth = HTTPBasicAuth(settings.AEM_USERNAME, settings.AEM_PASSWORD)
        self.timeout = settings.REQUEST_TIMEOUT
        self.session = requests.Session()
        self.session.auth = self.auth


    def is_reachable(self) -> dict:
        """
        Check if AEM is reachable and credentials are correct.
        Returns a clear status dictionary.
        """
        try:
            # Use a lightweight endpoint to test connectivity
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
            logger.error("Cannot connect to AEM. Is it running?")
            return {
                "status": "error",
                "message": "Cannot connect to AEM. Is it running?",
                "aem_url": self.base_url
            }
        except requests.exceptions.Timeout:
            logger.error("Connection to AEM timed out")
            return {
                "status": "error",
                "message": "Connection to AEM timed out",
                "aem_url": self.base_url
            }
        except Exception as e:
            logger.error(f"Unexpected error: {str(e)}")
            return {
                "status": "error",
                "message": f"Unexpected error: {str(e)}",
                "aem_url": self.base_url
            }


    def get_page_content(self, page_path: str) -> dict:
        """
        Fetch basic information about a page.
        Example path: /content/we-retail/us/en
        """
        try:
            # Request the page in JSON format (Sling default)
            url = f"{self.base_url}{page_path}.json"
            response = self.session.get(url, timeout=self.timeout)
            if response.status_code == 200:
                return {
                    "status": "success",
                    "path": page_path,
                    "data": response.json()
                }
            else:
                return {
                    "status": "error",
                    "message": f"Failed to fetch page. Status code: {response.status_code}",
                    "path": page_path,
                    "status_code": response.status_code
                }
        except Exception as e:
            logger.error(f"Error fetching page content for {page_path}: {str(e)}")
            return {
                "status": "error",
                "message": str(e),
                "path": page_path
            }



    def get_components(self, page_path: str, max_depth: int = 4) -> dict:
        """
        Discover components under a page using controlled depth (safer than infinity.json).
        Avoids the HTTP 300 problem that happens with large pages.
        """
        try:
            components = []

            def walk(current_path: str, current_depth: int):
                if current_depth > max_depth:
                    return

                # Request only one level at a time (.1.json is safe and fast)
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

                # Collect the component if it has a resourceType
                if resource_type and resource_type not in ["cq/Page", "cq/PageContent"]:
                    title = (
                        node.get("jcr:title")
                        or node.get("cq:panelTitle")
                        or node.get("text")
                        or resource_type.split("/")[-1]
                    )
                    components.append({
                        "path": current_path,
                        "resourceType": resource_type,
                        "title": title
                    })

                # Walk into child nodes
                for key, value in node.items():
                    if key.startswith("jcr:") or key.startswith("cq:") or key.startswith("sling:") or key.startswith("nt:"):
                        continue
                    if isinstance(value, dict) or value == {}:
                        child_path = f"{current_path}/{key}"
                        walk(child_path, current_depth + 1)

            # Start from the page's jcr:content (this is where components live)
            start_path = f"{page_path.rstrip('/')}/jcr:content"
            walk(start_path, 1)

            return {
                "status": "success",
                "page_path": page_path,
                "component_count": len(components),
                "components": components
            }
        except Exception as e:
            logger.error(f"Error discovering components for {page_path}: {str(e)}")
            return {
                "status": "error",
                "message": str(e),
                "path": page_path
            }

    def get_component_fields(self, component_path: str) -> dict:
        """
        Fetch all properties/fields of a specific component.
        Returns current values so the user can review and update them.
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
            
            # Clean the data – remove system properties that should not be edited
            fields = {}
            skip_keys = {
                "jcr:primaryType", "jcr:created", "jcr:createdBy", 
                "jcr:lastModified", "jcr:lastModifiedBy", "jcr:mixinTypes",
                "sling:resourceType", "cq:lastReplicated", "cq:lastReplicatedBy",
                "cq:lastReplicationAction", "jcr:uuid"
            }

            for key, value in data.items():
                if key in skip_keys:
                    continue
                # Keep only simple values for now (string, number, boolean)
                if isinstance(value, (str, int, float, bool)) or value is None:
                    fields[key] = value

            return {
                "status": "success",
                "component_path": component_path,
                "resourceType": data.get("sling:resourceType"),
                "field_count": len(fields),
                "fields": fields
            }

        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "path": component_path
            }
    def update_component(self, component_path: str, properties: dict) -> dict:
        """
        Update one or more properties of a component in AEM.
        Uses simple and reliable Sling POST (form data).
        """
        try:
            if not properties:
                return {
                    "status": "error",
                    "message": "No properties provided to update"
                }

            url = f"{self.base_url}{component_path}"

            # Prepare form data – this is the standard way
            data = {}
            for key, value in properties.items():
                # Using ./propertyName is the safest Sling convention
                data[f"./{key}"] = value

            response = self.session.post(
                url,
                data=data,
                timeout=self.timeout
            )

            if response.status_code in [200, 201]:
                return {
                    "status": "success",
                    "message": "Component updated successfully",
                    "component_path": component_path,
                    "updated_properties": list(properties.keys()),
                    "status_code": response.status_code
                }
            else:
                return {
                    "status": "error",
                    "message": f"Update failed. Status code: {response.status_code}",
                    "component_path": component_path,
                    "response_text": response.text[:500]
                }

        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "component_path": component_path
            }