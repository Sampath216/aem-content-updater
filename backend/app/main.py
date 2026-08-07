from fastapi import FastAPI, Body, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from typing import Dict, Any
from datetime import timedelta
from sqlalchemy.orm import Session

from backend.app.core.config import get_settings
from backend.app.services.aem_client import AEMClient
from backend.app.models.audit import SessionLocal, AuditLog
from backend.app.models.user import User
from backend.app.core.auth import (
    get_db, authenticate_user, create_access_token,
    get_current_user, get_password_hash, ACCESS_TOKEN_EXPIRE_MINUTES
)

settings = get_settings()

app = FastAPI(
    title=settings.APP_NAME,
    description="Enterprise tool to discover and update AEM components",
    version=settings.APP_VERSION
)

# ========== AUTHENTICATION ==========

@app.post("/api/auth/login")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """
    Login with username and password.
    Returns a JWT token.
    """
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "username": user.username,
        "full_name": user.full_name
    }

@app.post("/api/auth/register")
def register_user(
    username: str = Body(...),
    password: str = Body(...),
    full_name: str = Body(None),
    db: Session = Depends(get_db)
):
    """
    Create a new user (for initial setup).
    In production this should be restricted.
    """
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already registered")

    hashed = get_password_hash(password)
    new_user = User(
        username=username,
        hashed_password=hashed,
        full_name=full_name or username
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return {
        "status": "success",
        "message": f"User '{username}' created successfully",
        "username": new_user.username
    }

# ========== PUBLIC ENDPOINTS ==========

@app.get("/")
def home():
    return {
        "message": f"{settings.APP_NAME} is running successfully!",
        "status": "healthy",
        "version": settings.APP_VERSION
    }

@app.get("/health")
def health_check():
    return {"status": "ok", "app": settings.APP_NAME}

@app.get("/api/aem/status")
def aem_status():
    client = AEMClient()
    return client.is_reachable()

# ========== PROTECTED ENDPOINTS (require login) ==========

@app.get("/api/aem/components")
def get_page_components(
    page_path: str,
    current_user: User = Depends(get_current_user)
):
    client = AEMClient()
    return client.get_components(page_path)

@app.get("/api/aem/component/fields")
def get_component_fields(
    component_path: str,
    current_user: User = Depends(get_current_user)
):
    client = AEMClient()
    return client.get_component_fields(component_path)

@app.post("/api/aem/component/update")
def update_component(
    component_path: str,
    properties: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user)
):
    """
    Update component – username is taken automatically from the logged-in user.
    """
    client = AEMClient()
    return client.update_component(
        component_path=component_path,
        properties=properties,
        performed_by=current_user.full_name or current_user.username
    )

@app.get("/api/audit/logs")
def get_audit_logs(
    limit: int = 50,
):
    db = SessionLocal()
    try:
        logs = (
            db.query(AuditLog)
            .order_by(AuditLog.timestamp.desc())
            .limit(limit)
            .all()
        )
        result = []
        for log in logs:
            result.append({
                "id": log.id,
                "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                "component_path": log.component_path,
                "property_name": log.property_name,
                "old_value": log.old_value,
                "new_value": log.new_value,
                "success": log.success,
                "message": log.message,
                "performed_by": log.performed_by
            })
        return {"status": "success", "count": len(result), "logs": result}
    finally:
        db.close()