"""
AEM Content Updater - MCP Server (stdio transport)
Runs locally so it can talk to local AEM.
"""

import sys
import os

# Ensure project root is on path (so "backend.app..." imports work)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
from mcp.server.fastmcp import FastMCP
from backend.app.services.aem_client import AEMClient

mcp = FastMCP(
    "AEM Content Updater",
    instructions="Tools to discover AEM components, read dialog fields, and safely update content on the local AEM author instance. Updates should be audited by the underlying service.",
)

@mcp.tool()
def aem_status() -> dict:
    """Check whether the local AEM author instance is reachable."""
    client = AEMClient()
    return client.is_reachable()


@mcp.tool()
def list_page_components(page_path: str) -> dict:
    """
    List all components on an AEM page.
    page_path example: /content/we-retail/us/en
    """
    client = AEMClient()
    return client.get_components(page_path)


@mcp.tool()
def get_component_fields(component_path: str) -> dict:
    """
    Get effective dialog fields and current values for one component.
    component_path example: /content/we-retail/us/en/jcr:content/root/title
    """
    client = AEMClient()
    return client.get_component_fields(component_path)


@mcp.tool()
def update_component(component_path: str, properties: dict) -> dict:
    """
    Safely update allowed properties on a component.
    Only fields that exist on the real dialog should be sent.
    Example properties: {"jcr:title": "New Title"}
    """
    client = AEMClient()
    return client.update_component(
        component_path=component_path,
        properties=properties,
        performed_by="mcp-agent",
    )


@mcp.tool()
def diagnose_component(component_path: str) -> dict:
    """Diagnose the component dialog (inheritance, includes, issues)."""
    client = AEMClient()
    return client.diagnose_component_dialog(component_path)


if __name__ == "__main__":
    mcp.run(transport="stdio")