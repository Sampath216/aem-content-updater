# Paste into main.py (with other imports + routes)

from backend.app.services.template_history_service import (
    list_templates,
    save_template,
    get_template,
    mark_used,
    delete_template,
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

# UPDATE existing api_generate_excel_template — after you build selections, BEFORE returning file:
#
#     name = payload.get("name") or f"Template {datetime.utcnow().strftime('%Y%m%d_%H%M')}"
#     save_template(name, selections, include_seo=include_seo, source="dictionary")
#     content = generate_template(selections, include_seo=include_seo)
#
