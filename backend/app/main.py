from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Body, Depends, HTTPException, status, UploadFile, File
from fastapi.security import OAuth2PasswordRequestForm
from typing import Dict, Any, List, Optional
from datetime import timedelta, datetime
from sqlalchemy.orm import Session
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import io

from backend.app.core.config import get_settings
from backend.app.services.aem_client import AEMClient
from backend.app.services.excel_service import ExcelTemplateService
from backend.app.services.excel_processor import ExcelProcessor
from backend.app.services.component_catalog import ComponentCatalog
from backend.app.models.audit import SessionLocal, AuditLog
from backend.app.models.user import User
from backend.app.core.auth import (
    get_db, authenticate_user, create_access_token,
    get_current_user, get_password_hash, ACCESS_TOKEN_EXPIRE_MINUTES
)
from backend.app.services.dictionary_service import (
    load_dictionary,
    list_components,
    update_field_aliases,
    upsert_component,
    sync_from_catalog_fields,
)
from backend.app.services.excel_template_service import generate_template
settings = get_settings()
from backend.app.services.excel_template_service import generate_template
from backend.app.services.excel_bulk_service import preview_excel, apply_excel
from backend.app.services.template_history_service import (
    list_templates,
    save_template,
    get_template,
    mark_used,
    delete_template,
)





app = FastAPI(
    title=settings.APP_NAME,
    description="Enterprise tool to discover and update AEM components",
    version=settings.APP_VERSION
)



# ========== AUTHENTICATION ==========


@app.post("/api/auth/login")
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
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
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(
            status_code=400, detail="Username already registered")

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



# Ensure a blank line between decorators to avoid stray variable errors

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



# Allow the frontend to talk to the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)




class ComponentSelection(BaseModel):
    resourceType: str
    label: Optional[str] = None



class TemplateRequest(BaseModel):
    components: List[ComponentSelection]



@app.post("/api/template/generate")
def generate_excel_template(
    request: TemplateRequest,
    current_user: User = Depends(get_current_user)
):
    service = ExcelTemplateService()
    excel_file = service.generate_template(
        [comp.dict() for comp in request.components]
    )
    return StreamingResponse(
        excel_file,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": "attachment; filename=AEM_Content_Template.xlsx"
        }
    )



@app.post("/api/excel/preview")
async def preview_excel_updates(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not file.filename.endswith((".xlsx", ".xls")):
        return {"status": "error", "message": "Please upload a valid Excel file (.xlsx)"}
    content = await file.read()
    return preview_excel(content)




@app.post("/api/excel/apply")
async def apply_excel_updates(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not file.filename.endswith((".xlsx", ".xls")):
        return {"status": "error", "message": "Please upload a valid Excel file (.xlsx)"}
    content = await file.read()
    return apply_excel(
        content,
        performed_by=current_user.full_name or current_user.username,
    )


@app.post("/api/catalog/update-from-page")
def update_catalog_from_page(
    page_path: str,
    current_user: User = Depends(get_current_user)
):
    """
    Scan a page and update the Component Catalog
    (stores components + exact dialog fields + versions).
    """
    catalog = ComponentCatalog()
    return catalog.update_from_page(page_path)


@app.get("/api/catalog/list")
def list_catalog(
    current_user: User = Depends(get_current_user)
):
    """
    Return the full Component Catalog.
    """
    catalog = ComponentCatalog()
    data = catalog.get_all()
    return {
        "status": "success",
        "total_components": len(data.get("components", {})),
        "components": data.get("components", {})
    }
    
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, Protection
from openpyxl.utils import get_column_letter
from io import BytesIO
from pydantic import BaseModel
from typing import List, Optional

class FieldSelection(BaseModel):
    resourceType: str
    version: str
    fields: List[str]          # exact field names to include
    label: Optional[str] = None

class TemplateFromCatalogRequest(BaseModel):
    selections: List[FieldSelection]

@app.post("/api/catalog/generate-template")
def generate_template_from_catalog(
    request: TemplateFromCatalogRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Generate Excel template using exact dialog field names
    from the Component Catalog. Header row is protected.
    """
    wb = Workbook()

    # Styles
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    thin_border = Border(
        left=Side(style='thin'), right=Side(style='thin'),
        top=Side(style='thin'), bottom=Side(style='thin')
    )

    # Instructions sheet
    ws_inst = wb.active
    ws_inst.title = "Instructions"
    ws_inst["A1"] = "AEM Content Updater – Generated Template"
    ws_inst["A1"].font = Font(bold=True, size=16, color="1F4E79")
    ws_inst["A3"] = "Important Rules"
    ws_inst["A3"].font = Font(bold=True, size=12)
    ws_inst["A4"] = "1. Do NOT change the header row (field names). They are locked."
    ws_inst["A5"] = "2. Only fill data rows. Leave a cell empty if you do not want to change that field."
    ws_inst["A6"] = "3. Page Path must start with /content/"
    ws_inst["A7"] = "4. Instance column: use 1, 2, 3... for multiple instances of the same component on a page."
    ws_inst["A8"] = "5. Upload this file in the tool and always review the Preview before applying."
    ws_inst.column_dimensions["A"].width = 90

    # Create one sheet per selected component
    for sel in request.selections:
        # Sheet name max 31 characters
        sheet_name = (sel.label or sel.resourceType.split("/")[-1])[:31]
        ws = wb.create_sheet(title=sheet_name)

        # Headers: Page Path | Instance | + selected fields
        headers = ["Page Path", "Instance"] + sel.fields

        for col, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=header)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center", wrap_text=True)
            cell.border = thin_border
            # Protect header cell
            cell.protection = Protection(locked=True)

        # Add a few empty data rows
        for row in range(2, 8):
            for col in range(1, len(headers) + 1):
                cell = ws.cell(row=row, column=col, value="")
                cell.border = thin_border
                cell.protection = Protection(locked=False)

        # Set column widths
        ws.column_dimensions["A"].width = 40
        ws.column_dimensions["B"].width = 12
        for col in range(3, len(headers) + 1):
            ws.column_dimensions[get_column_letter(col)].width = 22

        # Protect the sheet (header locked, data editable)
        ws.protection.sheet = True
        ws.protection.password = "aem"

    # Remove default empty sheet if it exists
    if "Sheet" in wb.sheetnames:
        del wb["Sheet"]

    output = BytesIO()
    wb.save(output)
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=AEM_Template_From_Catalog.xlsx"}
    )

@app.get("/api/aem/component/diagnose")
def diagnose_component(
    component_path: str,
    current_user: User = Depends(get_current_user)
):
    client = AEMClient()
    return client.diagnose_component_dialog(component_path)

@app.get("/api/dictionary")
def api_get_dictionary(current_user: User = Depends(get_current_user)):
    data = load_dictionary()
    return {
        "status": "success",
        "components": list_components(data),
        "raw": data,
    }


@app.put("/api/dictionary/field")
def api_update_dictionary_field(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Body: {
      "resourceType": "weretail/components/content/title",
      "field_name": "jcr:title",
      "ca_labels": ["Title", "Heading", "Title Text"]
    }
    """
    rt = payload.get("resourceType")
    fn = payload.get("field_name")
    labels = payload.get("ca_labels") or []
    if not rt or not fn:
        return {"status": "error", "message": "resourceType and field_name are required"}
    return update_field_aliases(rt, fn, labels)


@app.post("/api/dictionary/component")
def api_upsert_dictionary_component(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Body: {
      "resourceType": "...",
      "label": "Hero Image",
      "fields": { "heading": ["Heading", "Hero Heading"] }
    }
    """
    rt = payload.get("resourceType")
    if not rt:
        return {"status": "error", "message": "resourceType is required"}
    return upsert_component(rt, payload.get("label") or rt, payload.get("fields") or {})


@app.post("/api/dictionary/sync-from-fields")
def api_sync_dictionary(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Sync field names discovered from dialog into dictionary (does not wipe aliases).
    Body: { "resourceType", "label", "field_names": ["a","b"] }
    """
    return sync_from_catalog_fields(
        payload.get("resourceType") or "",
        payload.get("label") or "",
        payload.get("field_names") or [],
    )


@app.post("/api/excel/generate-template")
@app.post("/api/excel/generate-template")
def api_generate_excel_template(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Body: {
      "include_seo": true,
      "selections": [
        { "resourceType": "...", "label": "Title", "fields": ["jcr:title", "type"] }
      ]
    }
    Returns xlsx file download.
    """
    selections = payload.get("selections") or []
    include_seo = payload.get("include_seo", True)
    if not selections and not include_seo:
        return {"status": "error", "message": "Select at least one component or SEO"}
    # --- ADDED CODE START ---
    name = payload.get("name") or f"Template {datetime.utcnow().strftime('%Y%m%d_%H%M')}"
    save_template(name, selections, include_seo=include_seo, source="dictionary")
    content = generate_template(selections, include_seo=include_seo)
    # --- ADDED CODE END ---
    filename = f"AEM_Update_Template_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/templates/history")
def api_list_template_history(current_user: User = Depends(get_current_user)):
    return {"status": "success", "templates": list_templates()}


@app.delete("/api/templates/history/{template_id}")
def api_delete_template_history(template_id: str, current_user: User = Depends(get_current_user)):
    return delete_template(template_id)


@app.post("/api/templates/history/{template_id}/download")
def api_download_previous_template(template_id: str, current_user: User = Depends(get_current_user)):
    tpl = get_template(template_id)
    if not tpl:
        return {"status": "error", "message": "Template not found"}
    mark_used(template_id)
    selections = tpl.get("selections") or []
    include_seo = bool(tpl.get("include_seo"))
    content = generate_template(selections, include_seo=include_seo)
    filename = f"{(tpl.get('name') or 'AEM_Template').replace(' ', '_')}.xlsx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


