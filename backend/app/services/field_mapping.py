"""
Friendly Excel labels → Real AEM dialog field names
This is the single source of truth for mapping.
"""

# Global mapping used by Excel processor
FIELD_MAPPING = {
    # ========== Page Properties / SEO ==========
    "title": "jcr:title",
    "meta title": "jcr:title",
    "page title": "pageTitle",
    "description": "jcr:description",
    "meta description": "jcr:description",
    "keywords": "keywords",
    "canonical url": "cq:canonicalUrl",
    "canonical": "cq:canonicalUrl",

    # ========== Hero Image (exact names from your dialog) ==========
    "heading": "heading",
    "title": "title",                    # important: Hero uses "title", not jcr:title
    "button label": "buttonLabel",
    "button link": "buttonLinkTo",
    "button link to": "buttonLinkTo",
    "link to": "buttonLinkTo",
    "full width": "useFullWidth",
    "use full width": "useFullWidth",
    "image": "fileReference",
    "image / file": "fileReference",
    "file reference": "fileReference",
    "image path": "fileReference",
    "file": "fileReference",

    # ========== Title Component ==========
    "title": "jcr:title",
    "type": "type",
    "link": "link",
    "link to": "link",
    "link url": "link",

    # ========== General / Button / Teaser ==========
    "link": "linkTo",
    "link url": "linkURL",
    "button text": "buttonLabel",
    "text": "text",
    "alt text": "alt",
    "alt": "alt",
}

def get_real_field_name(friendly_name: str) -> str:
    """
    Convert a friendly Excel column name to the real AEM field name.
    Case-insensitive.
    """
    if not friendly_name:
        return friendly_name

    key = friendly_name.lower().strip()
    return FIELD_MAPPING.get(key, friendly_name.strip())