from fastapi import FastAPI
from backend.app.core.config import get_settings
from backend.app.services.aem_client import AEMClient

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