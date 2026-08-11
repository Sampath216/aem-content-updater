import json
import os
from datetime import datetime
from typing import List, Dict, Any
from backend.app.services.aem_client import AEMClient

CATALOG_FILE = "backend/component_catalog.json"

class ComponentCatalog:

    def __init__(self):
        self.catalog = self._load()

    def _load(self) -> Dict:
        if os.path.exists(CATALOG_FILE):
            try:
                with open(CATALOG_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return {"components": {}}
        return {"components": {}}

    def _save(self):
        os.makedirs(os.path.dirname(CATALOG_FILE), exist_ok=True)
        with open(CATALOG_FILE, "w", encoding="utf-8") as f:
            json.dump(self.catalog, f, indent=2, ensure_ascii=False)

    def update_from_page(self, page_path: str) -> Dict[str, Any]:
        """
        Load all components from a page and update the catalog.
        If the same resourceType has different fields → create a new version.
        """
        aem = AEMClient()
        result = aem.get_components(page_path)

        if result.get("status") != "success":
            return {"status": "error", "message": result.get("message", "Could not load components")}

        updated = []
        new_versions = []

        for comp in result.get("components", []):
            resource_type = comp["resourceType"]
            comp_path = comp["path"]

            # Get exact dialog fields
            fields_result = aem.get_component_fields(comp_path)
            if fields_result.get("status") != "success":
                continue

            current_fields = sorted(list(fields_result.get("fields", {}).keys()))

            # Check if this resourceType already exists in catalog
            if resource_type not in self.catalog["components"]:
                # Brand new component
                self.catalog["components"][resource_type] = {
                    "versions": [
                        {
                            "version": "v1",
                            "fields": current_fields,
                            "first_seen": datetime.utcnow().isoformat(),
                            "last_seen": datetime.utcnow().isoformat(),
                            "seen_on_pages": [page_path]
                        }
                    ]
                }
                updated.append(f"{resource_type} (v1) - new")
            else:
                # Check if any existing version has exactly the same fields
                versions = self.catalog["components"][resource_type]["versions"]
                matched = False

                for v in versions:
                    if sorted(v["fields"]) == current_fields:
                        # Same fields → just update last_seen
                        v["last_seen"] = datetime.utcnow().isoformat()
                        if page_path not in v["seen_on_pages"]:
                            v["seen_on_pages"].append(page_path)
                        matched = True
                        updated.append(f"{resource_type} ({v['version']}) - updated")
                        break

                if not matched:
                    # Different fields → create new version
                    new_version_number = f"v{len(versions) + 1}"
                    versions.append({
                        "version": new_version_number,
                        "fields": current_fields,
                        "first_seen": datetime.utcnow().isoformat(),
                        "last_seen": datetime.utcnow().isoformat(),
                        "seen_on_pages": [page_path]
                    })
                    new_versions.append(f"{resource_type} ({new_version_number})")
                    updated.append(f"{resource_type} ({new_version_number}) - new version")

        self._save()

        return {
            "status": "success",
            "message": f"Catalog updated. {len(updated)} components processed.",
            "updated": updated,
            "new_versions": new_versions,
            "total_components_in_catalog": len(self.catalog["components"])
        }

    def get_all(self) -> Dict:
        return self.catalog

    def get_component_versions(self, resource_type: str) -> List[Dict]:
        return self.catalog.get("components", {}).get(resource_type, {}).get("versions", [])