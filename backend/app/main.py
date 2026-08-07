from fastapi import FastAPI
from backend.app.core.config import get_settings
from backend.app.services.aem_client import AEMClient
from fastapi import FastAPI, Body
from typing import Dict, Any

settings = get_settings()

app = FastAPI(
    title=settings.APP_NAME,
    description="Enterprise tool to discover and update AEM components",
    version=settings.APP_VERSION
)

@app.get("/")
def home():
    return {
        "message": f"{settings.APP_NAME} is running successfully!",
        "status": "healthy",
        "version": settings.APP_VERSION,
        "debug_mode": settings.DEBUG
    }

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION
    }

@app.get("/api/aem/status")
def aem_status():
    """
    Check if we can successfully connect to AEM
    """
    client = AEMClient()
    return client.is_reachable()
@app.get("/api/aem/components")
def get_page_components(page_path: str):
    """
    Discover all components on a given AEM page.
    Example: /api/aem/components?page_path=/content/we-retail/us/en
    """
    client = AEMClient()
    return client.get_components(page_path)
@app.get("/api/aem/component/fields")
def get_component_fields(component_path: str):
    """
    Get all editable fields of a selected component.
    Example: /api/aem/component/fields?component_path=/content/we-retail/us/en/men/jcr:content/root/hero_image
    """
    client = AEMClient()
    return client.get_component_fields(component_path)
@app.post("/api/aem/component/update")
def update_component(
    component_path: str,
    properties: Dict[str, Any] = Body(...)
):
    """
    Update properties of a component.
    Example body:
    {
      "fileReference": "/content/dam/we-retail/en/activities/climbing/new-image.jpg",
      "useFullWidth": "false"
    }
    """
    client = AEMClient()
    return client.update_component(component_path, properties)