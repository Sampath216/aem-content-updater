# AEM Content Updater

Enterprise tool to discover AEM component dialogs and update content safely — one component at a time or in bulk via Excel.

## What it does

- Connects to an AEM author instance
- Lists components on a page
- Loads **only fields that exist on the real component dialog** (inheritance + includes)
- Lets authors edit values in a web UI (tabs, dropdowns, checkboxes, multifields)
- Maintains a **Field Dictionary** (dialog field ↔ CA-friendly labels)
- Generates **Excel templates** from selected components/fields
- Supports **bulk preview and apply** from Excel (with validation and audit)

## Tech stack

| Layer | Technology |
|--------|------------|
| API | Python 3, FastAPI, Uvicorn |
| AEM access | HTTP (Sling / JCR JSON + form POST) |
| Auth | JWT (login), password hashing |
| Database | SQLite (users + audit log) via SQLAlchemy |
| Excel | openpyxl |
| Frontend | HTML / CSS / JavaScript (static) |

## Project layout (typical)

```text
aem-content-updater/
  backend/
    app/
      main.py                 # API routes
      core/                   # config, auth
      models/                 # user, audit
      services/
        aem_client.py         # AEM dialog discovery + updates
        dictionary_service.py # CA label dictionary
        excel_template_service.py
        excel_processor.py    # bulk Excel parse
        component_catalog.py
        field_dictionary.json
  frontend/                   # UI (index.html, app.js, styles)
  venv/
```

## Run (Windows)

From the project root, with venv active:

```bat
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8001
```

- API docs: http://127.0.0.1:8001/docs  
- Open the frontend HTML in the browser (point API base URL to port 8001)

Configure AEM base URL and credentials in app settings (e.g. `backend/app/core/config`).

## Safety rules

1. **Dialog is source of truth** — unknown Excel/UI fields are never written to CRX.
2. Updates are audited (who, path, property, old/new value).
3. Bulk apply should always use **Preview** before **Apply**.

## Main API groups

- `/api/auth/*` — login / register  
- `/api/aem/components` — list components on a page  
- `/api/aem/component/fields` — effective dialog fields + values  
- `/api/aem/component/update` — update allowed fields only  
- `/api/dictionary/*` — CA label dictionary  
- `/api/excel/generate-template` — download template  
- `/api/excel/preview` / `/api/excel/apply` — bulk flow  
- `/api/catalog/*` — stored component catalog  
- `/api/audit/logs` — audit trail  

## License / internal use

Internal enterprise tool — align with your organisation’s AEM and security policies before production use.
