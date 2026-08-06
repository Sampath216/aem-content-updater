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
            # We hit a lightweight endpoint that exists on every AEM instance
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
            return {
                "status": "error",
                "message": "Cannot connect to AEM. Is it running?",
                "aem_url": self.base_url
            }
        except requests.exceptions.Timeout:
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
            return {
                "status": "error",
                "message": str(e),
                "path": page_path
            }