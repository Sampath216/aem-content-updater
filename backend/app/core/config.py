from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    # Application
    APP_NAME: str = "AEM Content Updater"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # Server
    HOST: str = "127.0.0.1"
    PORT: int = 8001

    # AEM Connection (we will fill these later)
    AEM_BASE_URL: str = "http://localhost:8080"
    AEM_USERNAME: str = "admin"
    AEM_PASSWORD: str = "admin"

    # Security
    MAX_RECURSION_DEPTH: int = 5          # for referral paths
    REQUEST_TIMEOUT: int = 30             # seconds

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True

@lru_cache()
def get_settings() -> Settings:
    return Settings()