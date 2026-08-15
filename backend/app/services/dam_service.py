"""
AEM DAM folder + asset upload service.

Phase 1: check path, create missing folders (page + desktop/mobile/tablet)
Phase 2: upload assets from local Desktop/Mobile/Tablet folders

Box/SSO is NOT implemented yet — local folders only.
Does not modify component/dialog/excel logic.
"""
from __future__ import annotations

import os
import re
import mimetypes
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from backend.app.services.aem_client import AEMClient

# Standard responsive breakpoints used under each page DAM folder
BREAKPOINTS = ("desktop", "mobile", "tablet")

# Max file size per breakpoint (bytes). +5 KB tolerance included.
# desktop < 300 KB, tablet < 200 KB, mobile < 100 KB (each +5 KB allowed)
SIZE_LIMITS_BYTES = {
    "desktop": (300 + 5) * 1024,  # 305 KB
    "tablet": (200 + 5) * 1024,   # 205 KB
    "mobile": (100 + 5) * 1024,   # 105 KB
}
SIZE_RECOMMENDED_KB = {
    "desktop": 300,
    "tablet": 200,
    "mobile": 100,
}

# Local folder name aliases → canonical breakpoint
LOCAL_BREAKPOINT_ALIASES = {
    "desktop": "desktop",
    "desk": "desktop",
    "d": "desktop",
    "mobile": "mobile",
    "mob": "mobile",
    "m": "mobile",
    "tablet": "tablet",
    "tab": "tablet",
    "t": "tablet",
}


def normalize_dam_path(path: str) -> str:
    """Normalize user input to absolute DAM path without trailing slash."""
    p = (path or "").strip().replace("\\", "/")
    if not p:
        raise ValueError("DAM path is required")
    if not p.startswith("/"):
        p = "/" + p
    p = re.sub(r"/+", "/", p).rstrip("/")
    if not p.startswith("/content/dam"):
        raise ValueError(
            "DAM path must start with /content/dam "
            "(example: /content/dam/us/we-retail/men)"
        )
    return p


def adobe_asset_name(original_filename: str) -> str:
    """
    Adobe-style asset node name (dynamic — no project-specific rules):
    - keep extension
    - lowercase
    - spaces → hyphens
    - strip unsafe characters
    - collapse multiple hyphens
    """
    name = Path(original_filename).name.strip()
    if not name:
        raise ValueError("Empty file name")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    stem = stem.strip().lower()
    stem = stem.replace(" ", "-").replace("_", "-")
    stem = re.sub(r"[^a-z0-9.\-]", "-", stem)
    stem = re.sub(r"-{2,}", "-", stem).strip("-.")
    if not stem:
        stem = "asset"
    return f"{stem}{ext}"




# Adobe DAM: every asset under /content/dam is dam:Asset (not different primaryTypes per extension).
# Mime type + metadata distinguish image / video / pdf / json / etc.
# Folder nodes: sling:OrderedFolder
# Asset binary lives at jcr:content/renditions/original (nt:file / nt:resource)

EXTRA_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".css": "text/css",
    ".js": "application/javascript",
    ".html": "text/html",
    ".htm": "text/html",
}


def resolve_mime_type(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext in EXTRA_MIME_MAP:
        return EXTRA_MIME_MAP[ext]
    guessed = mimetypes.guess_type(filename)[0]
    return guessed or "application/octet-stream"


def is_size_checked_type(filename: str) -> bool:
    """Size limits apply to image-like assets used for breakpoints; large videos are reported but not hard-blocked by image limits unless configured."""
    mime = resolve_mime_type(filename)
    return mime.startswith("image/")

class DamService:
    def __init__(self, aem: Optional[AEMClient] = None):
        self.aem = aem or AEMClient()
        self.base_url = self.aem.base_url
        self.session = self.aem.session
        self.timeout = self.aem.timeout

    # -------------------------------------------------------------------------
    # Path existence
    # -------------------------------------------------------------------------
    def path_exists(self, path: str) -> bool:
        path = normalize_dam_path(path) if path.startswith("/content/dam") else path.rstrip("/")
        try:
            url = f"{self.base_url}{path}.json"
            r = self.session.get(url, timeout=self.timeout)
            return r.status_code == 200
        except Exception:
            return False

    def inspect_page_dam_path(self, page_dam_path: str) -> dict:
        """
        Check the page-level DAM path and breakpoint subfolders.
        Does not create anything.
        """
        base = normalize_dam_path(page_dam_path)
        base_exists = self.path_exists(base)
        breakpoints = {}
        for bp in BREAKPOINTS:
            bp_path = f"{base}/{bp}"
            breakpoints[bp] = {
                "path": bp_path,
                "exists": self.path_exists(bp_path) if base_exists else False,
            }

        missing = []
        if not base_exists:
            missing.append(base)
        for bp, info in breakpoints.items():
            if not info["exists"]:
                missing.append(info["path"])

        return {
            "status": "success",
            "page_dam_path": base,
            "base_exists": base_exists,
            "breakpoints": breakpoints,
            "all_ready": base_exists and all(b["exists"] for b in breakpoints.values()),
            "missing_paths": missing,
            "message": (
                "All folders exist — ready for upload"
                if base_exists and all(b["exists"] for b in breakpoints.values())
                else "Some folders are missing — confirm to create them"
            ),
        }

    # -------------------------------------------------------------------------
    # Folder creation (Sling POST)
    # -------------------------------------------------------------------------
    def _create_folder(self, parent_path: str, folder_name: str) -> dict:
        """
        Create one DAM folder under parent.

        Adobe / AEM convention under /content/dam:
          jcr:primaryType = sling:OrderedFolder
          jcr:content/jcr:primaryType = nt:unstructured
          jcr:content/jcr:title = <folder name>
        """
        parent_path = parent_path.rstrip("/")
        folder_name = folder_name.strip().strip("/")
        if not folder_name or "/" in folder_name:
            return {"status": "error", "message": f"Invalid folder name: {folder_name}"}

        # Adobe-style folder node name (lowercase, safe)
        safe_name = folder_name.strip().lower().replace(" ", "-")
        safe_name = re.sub(r"[^a-z0-9._\-]", "-", safe_name)
        safe_name = re.sub(r"-{2,}", "-", safe_name).strip("-")
        if not safe_name:
            return {"status": "error", "message": f"Invalid folder name after normalize: {folder_name}"}

        target = f"{parent_path}/{safe_name}"
        if self.path_exists(target):
            return {
                "status": "success",
                "path": target,
                "created": False,
                "message": "Already exists",
                "jcr:primaryType": "sling:OrderedFolder",
            }

        if parent_path not in ("", "/") and not self.path_exists(parent_path):
            return {
                "status": "error",
                "message": f"Parent does not exist: {parent_path}",
                "path": target,
            }

        url = f"{self.base_url}{parent_path}"
        # Match typical AEM DAM folder structure
        data = {
            f"{safe_name}/jcr:primaryType": "sling:OrderedFolder",
            f"{safe_name}/jcr:content/jcr:primaryType": "nt:unstructured",
            f"{safe_name}/jcr:content/jcr:title": folder_name,
        }
        try:
            r = self.session.post(url, data=data, timeout=self.timeout)
            if r.status_code in (200, 201) and self.path_exists(target):
                return {
                    "status": "success",
                    "path": target,
                    "created": True,
                    "status_code": r.status_code,
                    "jcr:primaryType": "sling:OrderedFolder",
                }
            # Fallback sling:Folder (still valid under DAM)
            data2 = {
                f"{safe_name}/jcr:primaryType": "sling:Folder",
                f"{safe_name}/jcr:content/jcr:primaryType": "nt:unstructured",
                f"{safe_name}/jcr:content/jcr:title": folder_name,
            }
            r2 = self.session.post(url, data=data2, timeout=self.timeout)
            if r2.status_code in (200, 201) and self.path_exists(target):
                return {
                    "status": "success",
                    "path": target,
                    "created": True,
                    "status_code": r2.status_code,
                    "jcr:primaryType": "sling:Folder",
                }
            return {
                "status": "error",
                "message": f"Create folder failed ({r.status_code}): {r.text[:300]}",
                "path": target,
            }
        except Exception as e:
            return {"status": "error", "message": str(e), "path": target}

    def ensure_path_tree(self, full_path: str) -> dict:
        """
        Create every missing segment under /content/dam dynamically.
        Example: /content/dam/us/we-retail/men
        """
        full_path = normalize_dam_path(full_path)
        parts = [p for p in full_path.split("/") if p]
        # parts like: content, dam, us, we-retail, men
        if len(parts) < 2 or parts[0] != "content" or parts[1] != "dam":
            return {"status": "error", "message": "Path must be under /content/dam"}

        created = []
        existing = []
        current = ""
        for part in parts:
            parent = current if current else ""
            current = f"{current}/{part}"
            if self.path_exists(current):
                existing.append(current)
                continue
            if not parent:
                return {"status": "error", "message": "Cannot create root"}
            result = self._create_folder(parent, part)
            if result.get("status") != "success":
                return {
                    "status": "error",
                    "message": result.get("message"),
                    "failed_at": current,
                    "created": created,
                    "existing": existing,
                }
            if result.get("created"):
                created.append(current)
            else:
                existing.append(current)

        return {
            "status": "success",
            "path": full_path,
            "created": created,
            "existing": existing,
            "message": f"Path ready: {full_path}",
        }

    def ensure_page_dam_structure(self, page_dam_path: str, confirm_create: bool = False) -> dict:
        """
        Ensure page path + desktop/mobile/tablet exist.
        If anything is missing and confirm_create is False → return plan only (no write).
        """
        inspection = self.inspect_page_dam_path(page_dam_path)
        if inspection.get("all_ready"):
            return {
                "status": "success",
                "action": "none",
                "message": "All DAM folders already exist",
                "inspection": inspection,
            }

        if not confirm_create:
            return {
                "status": "needs_confirmation",
                "action": "create_required",
                "message": (
                    "The following folders do not exist. "
                    "Call again with confirm_create=true to create them."
                ),
                "missing_paths": inspection.get("missing_paths"),
                "inspection": inspection,
            }

        base = inspection["page_dam_path"]
        steps = []

        # Create base path tree
        base_result = self.ensure_path_tree(base)
        steps.append({"step": "page_path", "result": base_result})
        if base_result.get("status") != "success":
            return {
                "status": "error",
                "message": base_result.get("message"),
                "steps": steps,
                "inspection": inspection,
            }

        # Create breakpoint folders
        for bp in BREAKPOINTS:
            r = self._create_folder(base, bp)
            steps.append({"step": f"breakpoint:{bp}", "result": r})
            if r.get("status") != "success":
                return {
                    "status": "error",
                    "message": r.get("message"),
                    "steps": steps,
                }

        final = self.inspect_page_dam_path(base)
        return {
            "status": "success" if final.get("all_ready") else "error",
            "action": "created",
            "message": "DAM folders created" if final.get("all_ready") else "Some folders still missing after create",
            "steps": steps,
            "inspection": final,
        }

    # -------------------------------------------------------------------------
    # Local scan + upload
    # -------------------------------------------------------------------------

    def check_file_size_for_breakpoint(self, breakpoint: str, size_bytes: int, filename: str = "") -> dict:
        """
        Image size rules (responsive):
          desktop < 300 KB (+5 KB), tablet < 200 KB (+5), mobile < 100 KB (+5)

        Non-image (video, pdf, json, ...): not blocked by image limits.
        Very large files (> 100 MB) blocked as safety default (AEM/network).
        """
        bp = (breakpoint or "").lower().strip()
        size_kb = round(size_bytes / 1024, 1)
        mime = resolve_mime_type(filename) if filename else ""

        # Safety cap for any file type (100 MB)
        HARD_MAX = 100 * 1024 * 1024
        if size_bytes > HARD_MAX:
            return {
                "allowed": False,
                "breakpoint": bp,
                "size_bytes": size_bytes,
                "size_kb": size_kb,
                "message": f"File is {size_kb} KB — exceeds 100 MB safety limit. Upload blocked.",
            }

        # Non-images: allow (correct dam:Asset + mime still applied on upload)
        if filename and not is_size_checked_type(filename):
            return {
                "allowed": True,
                "breakpoint": bp,
                "size_bytes": size_bytes,
                "size_kb": size_kb,
                "mime": mime,
                "message": f"OK (non-image: {mime or 'unknown'})",
            }

        limit = SIZE_LIMITS_BYTES.get(bp)
        recommended = SIZE_RECOMMENDED_KB.get(bp)
        if limit is None:
            return {
                "allowed": False,
                "message": f"Unknown breakpoint '{breakpoint}' — expected desktop/mobile/tablet",
            }
        if size_bytes > limit:
            return {
                "allowed": False,
                "breakpoint": bp,
                "size_bytes": size_bytes,
                "size_kb": size_kb,
                "limit_kb": limit / 1024,
                "recommended_kb": recommended,
                "mime": mime,
                "message": (
                    f"{bp} image is {size_kb} KB — max allowed is {limit/1024:.0f} KB "
                    f"(recommended < {recommended} KB, +5 KB tolerance). Upload blocked."
                ),
            }
        return {
            "allowed": True,
            "breakpoint": bp,
            "size_bytes": size_bytes,
            "size_kb": size_kb,
            "limit_kb": limit / 1024,
            "recommended_kb": recommended,
            "mime": mime,
            "message": "OK",
        }

    def scan_local_page_folder(self, local_page_folder: str) -> dict:
        """
        Scan local folder in either mode:

        A) Breakpoint mode (preferred when present):
             men/Desktop|Mobile|Tablet/*.jpg

        B) Flat mode — files directly under page folder (no breakpoint dirs):
             men/*.jpg  → upload under DAM page path (no desktop/mobile/tablet)
        """
        root = Path(local_page_folder)
        if not root.exists():
            return {
                "status": "error",
                "message": f"Local path does not exist: {local_page_folder}",
                "local_page_folder": local_page_folder,
                "exists": False,
            }
        if not root.is_dir():
            return {
                "status": "error",
                "message": f"Local path is not a folder: {local_page_folder}",
                "local_page_folder": local_page_folder,
                "exists": True,
                "is_dir": False,
            }

        found = {bp: [] for bp in BREAKPOINTS}
        flat_files = []
        unmatched_dirs = []
        breakpoint_dirs_found = 0

        for child in sorted(root.iterdir()):
            if child.is_dir():
                key = LOCAL_BREAKPOINT_ALIASES.get(child.name.strip().lower())
                if not key:
                    unmatched_dirs.append(child.name)
                    continue
                breakpoint_dirs_found += 1
                for f in sorted(child.iterdir()):
                    if f.is_file() and not f.name.startswith("."):
                        size_b = f.stat().st_size
                        size_check = self.check_file_size_for_breakpoint(key, size_b, f.name)
                        found[key].append({
                            "local_path": str(f.resolve()),
                            "original_name": f.name,
                            "dam_name": adobe_asset_name(f.name),
                            "size_bytes": size_b,
                            "size_kb": round(size_b / 1024, 1),
                            "content_type": resolve_mime_type(f.name),
                            "size_allowed": bool(size_check.get("allowed")),
                            "size_message": size_check.get("message"),
                        })
            elif child.is_file() and not child.name.startswith("."):
                size_b = child.stat().st_size
                # Flat files use desktop size rule as default gate
                size_check = self.check_file_size_for_breakpoint("desktop", size_b, child.name)
                flat_files.append({
                    "local_path": str(child.resolve()),
                    "original_name": child.name,
                    "dam_name": adobe_asset_name(child.name),
                    "size_bytes": size_b,
                    "size_kb": round(size_b / 1024, 1),
                    "content_type": resolve_mime_type(child.name),
                    "size_allowed": bool(size_check.get("allowed")),
                    "size_message": size_check.get("message"),
                    "breakpoint": None,
                })

        bp_total = sum(len(v) for v in found.values())
        mode = "breakpoints" if breakpoint_dirs_found > 0 else ("flat" if flat_files else "empty")

        if mode == "breakpoints":
            total = bp_total
            oversized = [
                item for bp in BREAKPOINTS for item in found[bp] if not item.get("size_allowed")
            ]
            msg = f"Breakpoint mode: {total} file(s) in Desktop/Mobile/Tablet"
        elif mode == "flat":
            total = len(flat_files)
            oversized = [item for item in flat_files if not item.get("size_allowed")]
            msg = f"Flat mode: {total} file(s) directly under page folder (no breakpoint DAM subfolders)"
        else:
            total = 0
            oversized = []
            msg = "No asset files found (no breakpoint folders and no files in page folder)"

        status = "success" if total > 0 else "error"
        if status == "error" and mode == "empty":
            msg = (
                f"No assets found under {root}. "
                "Expected Desktop/Mobile/Tablet subfolders OR files directly in this folder."
            )

        return {
            "status": status,
            "exists": True,
            "local_page_folder": str(root.resolve()),
            "mode": mode,
            "breakpoints": found,
            "flat_files": flat_files,
            "total_files": total,
            "oversized_count": len(oversized),
            "oversized": oversized,
            "unmatched_dirs": unmatched_dirs,
            "size_rules_kb": SIZE_RECOMMENDED_KB,
            "message": msg + (f" — {len(oversized)} over size limit" if oversized else ""),
        }


    def _is_dam_asset(self, asset_path: str) -> bool:
        """True only if node is a real dam:Asset (visible in Assets UI)."""
        try:
            url = f"{self.base_url}{asset_path}.json"
            r = self.session.get(url, timeout=self.timeout)
            if r.status_code != 200:
                return False
            data = r.json()
            pt = str(data.get("jcr:primaryType") or "")
            return pt == "dam:Asset"
        except Exception:
            return False

    def upload_file(self, dam_folder_path: str, local_file: str, dam_name: Optional[str] = None) -> dict:
        """
        Upload as a real AEM DAM asset (dam:Asset) so it appears in Assets UI.

        Preferred order:
          1) Assets HTTP API  /api/assets/...
          2) {folder}.createasset.html
          3) Sling POST building dam:Asset + original rendition

        Verifies jcr:primaryType == dam:Asset after upload.
        """
        dam_folder_path = dam_folder_path.rstrip("/")
        if not self.path_exists(dam_folder_path):
            return {"status": "error", "message": f"DAM folder does not exist: {dam_folder_path}"}

        path = Path(local_file)
        if not path.is_file():
            return {"status": "error", "message": f"Local file not found: {local_file}"}

        node_name = adobe_asset_name(dam_name or path.name)
        asset_path = f"{dam_folder_path}/{node_name}"
        content_type = resolve_mime_type(path.name)
        attempts = []

        if self._is_dam_asset(asset_path):
            return {
                "status": "skipped",
                "message": "DAM asset already exists (not overwritten)",
                "dam_path": asset_path,
                "dam_name": node_name,
            }

        # If a broken nt:file sits at this path, remove it so we can create dam:Asset
        if self.path_exists(asset_path) and not self._is_dam_asset(asset_path):
            try:
                del_url = f"{self.base_url}{asset_path}"
                self.session.request(
                    "POST",
                    del_url,
                    data={":operation": "delete"},
                    timeout=self.timeout,
                )
                attempts.append({"strategy": "delete-stale-nt-file", "status_code": "done"})
            except Exception as e:
                attempts.append({"strategy": "delete-stale-nt-file", "error": str(e)})

        try:
            # --- 1) Assets HTTP API (best for Touch UI visibility) ---
            # /content/dam/we-retail/en/men/desktop/file.jpg
            # → /api/assets/we-retail/en/men/desktop/file.jpg
            api_rel = asset_path
            if api_rel.startswith("/content/dam/"):
                api_rel = api_rel[len("/content/dam/"):]
            elif api_rel.startswith("/content/dam"):
                api_rel = api_rel[len("/content/dam"):].lstrip("/")
            url_api = f"{self.base_url}/api/assets/{api_rel}"
            with open(path, "rb") as fh:
                r_api = self.session.post(
                    url_api,
                    data=fh.read(),
                    headers={
                        "Content-Type": content_type,
                        "Accept": "application/json",
                    },
                    timeout=max(self.timeout, 180),
                )
            attempts.append({"strategy": "api/assets", "status_code": r_api.status_code, "body": r_api.text[:120]})
            if r_api.status_code in (200, 201, 202) and self._is_dam_asset(asset_path):
                return {
                    "status": "success",
                    "message": "Uploaded via Assets HTTP API", "jcr:primaryType": "dam:Asset",
                    "dam_path": asset_path,
                    "dam_name": node_name,
                    "status_code": r_api.status_code,
                    "strategy": "api/assets",
                }

            # --- 2) createasset.html ---
            url_ca = f"{self.base_url}{dam_folder_path}.createasset.html"
            with open(path, "rb") as fh:
                r_ca = self.session.post(
                    url_ca,
                    files={"file": (node_name, fh, content_type)},
                    data={"fileName": node_name},
                    timeout=max(self.timeout, 180),
                )
            attempts.append({"strategy": "createasset.html", "status_code": r_ca.status_code})
            if r_ca.status_code in (200, 201) and self._is_dam_asset(asset_path):
                return {
                    "status": "success",
                    "message": "Uploaded via createasset.html (dam:Asset)",
                    "dam_path": asset_path,
                    "dam_name": node_name,
                    "status_code": r_ca.status_code,
                    "strategy": "createasset.html",
                }

            # --- 3) Sling POST: create dam:Asset + original rendition binary ---
            url_asset = f"{self.base_url}{asset_path}"
            with open(path, "rb") as fh:
                files = {
                    "jcr:content/renditions/original": (node_name, fh, content_type),
                }
                data = {
                    "jcr:primaryType": "dam:Asset",
                    "jcr:content/jcr:primaryType": "dam:AssetContent",
                    "jcr:content/jcr:mimeType": content_type,
                    "jcr:content/renditions/jcr:primaryType": "nt:folder",
                    "jcr:content/renditions/original/jcr:primaryType": "nt:file",
                    "jcr:content/renditions/original/jcr:content/jcr:mimeType": content_type,
                }
                r3 = self.session.post(url_asset, files=files, data=data, timeout=max(self.timeout, 180))
            attempts.append({"strategy": "sling-dam:Asset", "status_code": r3.status_code})
            if r3.status_code in (200, 201) and self._is_dam_asset(asset_path):
                return {
                    "status": "success",
                    "message": "Uploaded via Sling dam:Asset structure",
                    "dam_path": asset_path,
                    "dam_name": node_name,
                    "status_code": r3.status_code,
                    "strategy": "sling-dam:Asset",
                }

            if self._is_dam_asset(asset_path):
                return {
                    "status": "success",
                    "message": "dam:Asset present after upload",
                    "dam_path": asset_path,
                    "dam_name": node_name,
                    "attempts": attempts,
                }

            # Still only nt:file?
            if self.path_exists(asset_path):
                return {
                    "status": "error",
                    "message": (
                        "Node exists but is NOT dam:Asset — Assets UI will not show it. "
                        "Delete the nt:file node in CRXDE and retry after updating dam_service."
                    ),
                    "dam_path": asset_path,
                    "dam_name": node_name,
                    "attempts": attempts,
                }

            return {
                "status": "error",
                "message": "All DAM asset upload strategies failed",
                "dam_path": asset_path,
                "dam_name": node_name,
                "attempts": attempts,
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "dam_path": asset_path,
                "dam_name": node_name,
                "attempts": attempts,
            }


    def ensure_folder_path(self, dam_path: str, confirm_create: bool = False) -> dict:
        """Ensure a single DAM folder path exists (no breakpoint children)."""
        dam_path = normalize_dam_path(dam_path)
        if self.path_exists(dam_path):
            return {"status": "success", "path": dam_path, "created": False}
        if not confirm_create:
            return {
                "status": "needs_confirmation",
                "message": f"DAM path missing: {dam_path}. Set confirm_create_folders=true to create.",
                "path": dam_path,
            }
        # create segments under /content/dam
        parts = [p for p in dam_path.split("/") if p]
        if parts[:2] != ["content", "dam"]:
            return {"status": "error", "message": "Path must be under /content/dam"}
        cur = ""
        created = []
        for p in parts:
            cur = f"{cur}/{p}"
            if self.path_exists(cur):
                continue
            parent = cur.rsplit("/", 1)[0]
            name = cur.rsplit("/", 1)[-1]
            data = {
                f"{name}/jcr:primaryType": "sling:OrderedFolder",
                f"{name}/jcr:content/jcr:primaryType": "nt:unstructured",
                f"{name}/jcr:content/jcr:title": name,
            }
            try:
                r = self.session.post(f"{self.base_url}{parent}", data=data, timeout=self.timeout)
                if r.status_code not in (200, 201) or not self.path_exists(cur):
                    return {"status": "error", "message": f"Failed creating {cur}", "status_code": r.status_code}
                created.append(cur)
            except Exception as e:
                return {"status": "error", "message": str(e), "path": cur}
        return {"status": "success", "path": dam_path, "created": True, "created_paths": created}

    def upload_from_local(
        self,
        page_dam_path: str,
        local_page_folder: str,
        confirm_create_folders: bool = False,
        overwrite: bool = False,
    ) -> dict:
        """
        Upload from local page folder.
        - Breakpoint mode: ensure desktop/mobile/tablet under DAM page path
        - Flat mode: ensure only page DAM folder; upload files directly under it
        Never creates DAM folders if local path is missing / empty.
        """
        scan = self.scan_local_page_folder(local_page_folder)
        if scan.get("status") != "success":
            return {
                "status": "error",
                "message": scan.get("message") or "Local scan failed",
                "scan": scan,
            }

        base = normalize_dam_path(page_dam_path)
        mode = scan.get("mode") or "breakpoints"

        # Folder setup
        if mode == "flat":
            # Only ensure page folder path (no breakpoint children)
            ensure = self.ensure_folder_path(base, confirm_create=confirm_create_folders)
            if ensure.get("status") == "needs_confirmation":
                return ensure
            if ensure.get("status") not in ("success", None) and not self.path_exists(base):
                # try ensure_page without breakpoints if method differs
                pass
        else:
            ensure = self.ensure_page_dam_structure(page_dam_path, confirm_create=confirm_create_folders)
            if ensure.get("status") == "needs_confirmation":
                return ensure
            if ensure.get("status") != "success" and not ensure.get("inspection", {}).get("all_ready"):
                if not all(self.path_exists(f"{base}/{bp}") for bp in BREAKPOINTS):
                    return {
                        "status": "error",
                        "message": "DAM breakpoint folders not ready",
                        "folder_setup": ensure,
                        "scan": scan,
                    }

        results = []
        success = skipped = errors = rejected_size = 0

        def process_item(item, dam_folder, bp_label):
            nonlocal success, skipped, errors, rejected_size
            bp_for_size = bp_label or "desktop"
            size_check = self.check_file_size_for_breakpoint(
                bp_for_size,
                item.get("size_bytes") or 0,
                item.get("original_name") or item.get("dam_name") or "",
            )
            if not size_check.get("allowed"):
                results.append({
                    "breakpoint": bp_label,
                    "status": "rejected_size",
                    "local_path": item["local_path"],
                    "dam_name": item["dam_name"],
                    "size_kb": size_check.get("size_kb"),
                    "limit_kb": size_check.get("limit_kb"),
                    "message": size_check.get("message"),
                })
                rejected_size += 1
                errors += 1
                return
            target = f"{dam_folder}/{item['dam_name']}"
            if not overwrite and self.path_exists(target):
                results.append({
                    "breakpoint": bp_label,
                    "status": "skipped",
                    "local_path": item["local_path"],
                    "dam_name": item["dam_name"],
                    "dam_path": target,
                    "message": "Already exists",
                })
                skipped += 1
                return
            up = self.upload_file(dam_folder, item["local_path"], item["dam_name"])
            up["breakpoint"] = bp_label
            up["local_path"] = item["local_path"]
            up["size_kb"] = item.get("size_kb")
            results.append(up)
            if up.get("status") == "success":
                success += 1
            elif up.get("status") == "skipped":
                skipped += 1
            else:
                errors += 1

        if mode == "flat":
            if not self.path_exists(base):
                # create only the page folder path
                ensure2 = self.ensure_folder_path(base, confirm_create=True) if confirm_create_folders else None
                if not self.path_exists(base):
                    return {
                        "status": "error",
                        "message": f"DAM page folder missing and could not create: {base}",
                        "folder_setup": ensure2,
                        "scan": scan,
                    }
            for item in scan.get("flat_files") or []:
                process_item(item, base, None)
        else:
            for bp in BREAKPOINTS:
                dam_folder = f"{base}/{bp}"
                for item in scan.get("breakpoints", {}).get(bp) or []:
                    process_item(item, dam_folder, bp)

        return {
            "status": "success" if errors == 0 else "partial",
            "page_dam_path": base,
            "mode": mode,
            "local_page_folder": scan.get("local_page_folder"),
            "summary": {
                "success": success,
                "skipped": skipped,
                "rejected_size": rejected_size,
                "errors": errors,
                "total": success + skipped + errors,
            },
            "size_rules_kb": SIZE_RECOMMENDED_KB,
            "folder_setup": ensure if mode != "flat" else {"mode": "flat", "path": base},
            "scan_message": scan.get("message"),
            "results": results,
        }

