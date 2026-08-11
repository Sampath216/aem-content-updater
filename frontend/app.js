// Configuration
const API_BASE = "http://127.0.0.1:8001";

// Global state
let accessToken = null;
let currentUser = null;
let selectedComponentPath = null;
let currentFields = {};

// ========== LOGIN ==========
async function login() {
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const messageEl = document.getElementById("login-message");

  messageEl.textContent = "Logging in...";
  messageEl.className = "message";

  try {
    const formData = new URLSearchParams();
    formData.append("username", username);
    formData.append("password", password);

    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "Login failed");
    }

    accessToken = data.access_token;
    currentUser = data.full_name || data.username;

    // Show the main app
    document.getElementById("login-section").classList.add("hidden");
    document.getElementById("app-section").classList.remove("hidden");
    document.getElementById("logged-user").textContent = currentUser;

    messageEl.textContent = "";
  } catch (error) {
    messageEl.textContent = error.message;
    messageEl.className = "message error";
  }
}

function logout() {
  accessToken = null;
  currentUser = null;
  selectedComponentPath = null;

  document.getElementById("login-section").classList.remove("hidden");
  document.getElementById("app-section").classList.add("hidden");
  document.getElementById("components-card").style.display = "none";
  document.getElementById("fields-card").style.display = "none";
}

// ========== LOAD COMPONENTS ==========
async function loadComponents() {
  const pagePath = document.getElementById("page-path").value.trim();
  const messageEl = document.getElementById("page-message");
  const listEl = document.getElementById("components-list");

  if (!pagePath) {
    messageEl.textContent = "Please enter a page path";
    messageEl.className = "message error";
    return;
  }

  messageEl.textContent = "Loading components...";
  messageEl.className = "message";
  listEl.innerHTML = "";

  try {
    const response = await fetch(
      `${API_BASE}/api/aem/components?page_path=${encodeURIComponent(pagePath)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.detail || data.message || "Failed to load components",
      );
    }

    if (data.status !== "success") {
      throw new Error(data.message || "Failed to load components");
    }

    messageEl.textContent = `Found ${data.component_count} components`;
    messageEl.className = "message success";

    document.getElementById("components-card").style.display = "block";
    document.getElementById("fields-card").style.display = "none";

    // Render the list - ALWAYS show component name from resourceType
    data.components.forEach((comp) => {
      const div = document.createElement("div");
      div.className = "component-item";
      div.dataset.path = comp.path;

      // Extract clean component name from resourceType
      // Example: weretail/components/content/title → title
      let componentName = comp.resourceType.split("/").pop() || "unknown";

      let displayTitle = componentName;
      let badge = `<span class="badge">COMPONENT</span>`;

      // Special case only for Page
      if (
        comp.resourceType.includes("structure/page") ||
        comp.resourceType === "cq/Page" ||
        comp.resourceType.endsWith("/page")
      ) {
        displayTitle = "Page Properties";
        badge = `<span class="badge page">PAGE</span>`;
      }

      div.innerHTML = `
                <strong>${displayTitle}</strong>
                <div class="resource-type">${comp.resourceType}</div>
                <div class="path">${comp.path}</div>
                ${badge}
            `;

      div.onclick = () => selectComponent(comp.path, div);
      listEl.appendChild(div);
    });
    // Populate the filter dropdown with unique component names
    const filterSelect = document.getElementById("component-filter");
    filterSelect.innerHTML = `<option value="all">All Components</option>`;

    const uniqueNames = new Set();
    data.components.forEach((comp) => {
      let name = comp.resourceType.split("/").pop() || "unknown";
      if (
        comp.resourceType.includes("structure/page") ||
        comp.resourceType === "cq/Page" ||
        comp.resourceType.endsWith("/page")
      ) {
        name = "Page Properties";
      }
      uniqueNames.add(name);
    });

    // Sort alphabetically for better UX
    Array.from(uniqueNames)
      .sort()
      .forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        filterSelect.appendChild(option);
      });
  } catch (error) {
    messageEl.textContent = error.message;
    messageEl.className = "message error";
  }
}

// ========== SELECT COMPONENT + LOAD FIELDS ==========
async function selectComponent(componentPath, clickedElement) {
  selectedComponentPath = componentPath;

  // Remove previous selection
  document.querySelectorAll(".component-item").forEach((el) => {
    el.classList.remove("selected");
  });

  // Highlight the clicked one
  if (clickedElement) {
    clickedElement.classList.add("selected");
  }

  const formEl = document.getElementById("fields-form");
  const pathEl = document.getElementById("selected-component-path");
  const messageEl = document.getElementById("save-message");

  pathEl.textContent = componentPath;
  formEl.innerHTML = "Loading fields...";
  messageEl.textContent = "";
  document.getElementById("fields-card").style.display = "block";

  try {
    const response = await fetch(
      `${API_BASE}/api/aem/component/fields?component_path=${encodeURIComponent(componentPath)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const data = await response.json();

    if (!response.ok || data.status !== "success") {
      throw new Error(data.detail || data.message || "Failed to load fields");
    }

        currentFields = data.fields;
    formEl.innerHTML = "";

    // Preferred display order for better CA experience
    const preferredOrder = [
      // Title / Heading
      "jcr:title", "title", "heading", "pageTitle", "navTitle", "subtitle",
      // Description
      "jcr:description", "description", "text",
      // Button related (keep together)
      "buttonLabel", "buttonText", "buttonLinkTo", "linkTo", "linkURL", "link",
      // Image
      "fileReference", "image", "alt", "altText",
      // Others
      "useFullWidth", "fullWidth", "type", "cq:panelTitle"
    ];

    // Sort fields: preferred order first, then the rest
    const sortedKeys = Object.keys(data.fields).sort((a, b) => {
      const aIdx = preferredOrder.findIndex(p => p.toLowerCase() === a.toLowerCase());
      const bIdx = preferredOrder.findIndex(p => p.toLowerCase() === b.toLowerCase());

      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });

    for (const key of sortedKeys) {
      const value = data.fields[key];
      const row = document.createElement("div");
      row.className = "field-row";

      const isBoolean =
        value === true || value === false ||
        value === "true" || value === "false" ||
        key.toLowerCase().includes("fullwidth") ||
        key.toLowerCase().includes("enabled") ||
        key.toLowerCase().includes("hide") ||
        key.toLowerCase().includes("show");

      let inputHtml = "";

      if (isBoolean) {
        const current = (value === true || value === "true") ? "true" : "false";
        inputHtml = `
          <select id="field-${key}" style="flex:1; padding:9px 12px; border:1px solid #d0d5dd; border-radius:6px; font-size:14px;">
            <option value="true" ${current === "true" ? "selected" : ""}>true</option>
            <option value="false" ${current === "false" ? "selected" : ""}>false</option>
          </select>
        `;
      } else {
        inputHtml = `<input type="text" id="field-${key}" value="${value !== null && value !== undefined ? value : ''}">`;
      }

      // Friendlier labels for Content Authors
      let displayLabel = key;
      if (key === "buttonLinkTo") displayLabel = "Button Link To";
      if (key === "buttonLabel") displayLabel = "Button Label";
      if (key === "linkTo") displayLabel = "Link To";
      if (key === "fileReference") displayLabel = "Image / File Reference";
      if (key === "useFullWidth") displayLabel = "Use Full Width";
      if (key === "jcr:title") displayLabel = "Title (jcr:title)";
      if (key === "jcr:description") displayLabel = "Description (jcr:description)";

      row.innerHTML = `
        <label title="${key}">${displayLabel}</label>
        ${inputHtml}
      `;
      formEl.appendChild(row);
    }

    if (Object.keys(data.fields).length === 0) {
      formEl.innerHTML = "<p>No editable fields found for this component.</p>";
    }
  } catch (error) {
    formEl.innerHTML = `<p class="message error">${error.message}</p>`;
  }
}

// ========== SAVE CHANGES ==========
async function saveChanges() {
  if (!selectedComponentPath) return;

  const messageEl = document.getElementById("save-message");
  messageEl.textContent = "Saving...";
  messageEl.className = "message";

  // Collect changed values
  const properties = {};
  for (const key of Object.keys(currentFields)) {
    const input = document.getElementById(`field-${key}`);
    if (input) {
      const newValue = input.value;
      // Only send if changed
      if (String(newValue) !== String(currentFields[key] ?? "")) {
        properties[key] = newValue;
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    messageEl.textContent = "No changes detected";
    messageEl.className = "message";
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE}/api/aem/component/update?component_path=${encodeURIComponent(selectedComponentPath)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(properties),
      },
    );

    const data = await response.json();

    if (!response.ok || data.status !== "success") {
      throw new Error(data.detail || data.message || "Update failed");
    }

    messageEl.textContent = "Changes saved successfully!";
    messageEl.className = "message success";

    // Refresh the fields so old values are updated
    selectComponent(selectedComponentPath);
  } catch (error) {
    messageEl.textContent = error.message;
    messageEl.className = "message error";
  }
}
// ========== FILTER COMPONENTS ==========
function filterComponents() {
  const filterValue = document.getElementById("component-filter").value;
  const items = document.querySelectorAll(".component-item");

  items.forEach((item) => {
    const name = item.querySelector("strong").textContent.trim().toLowerCase();

    if (filterValue === "all" || name === filterValue.toLowerCase()) {
      item.style.display = "block";
    } else {
      item.style.display = "none";
    }
  });
}
// ========== EXCEL BULK UPDATE ==========
let lastExcelFile = null;

async function previewExcel() {
    const fileInput = document.getElementById("excel-file");
    const messageEl = document.getElementById("excel-message");
    const previewEl = document.getElementById("excel-preview");
    const applyBtn = document.getElementById("apply-btn");

    if (!fileInput.files || fileInput.files.length === 0) {
        messageEl.textContent = "Please select an Excel file first";
        messageEl.className = "message error";
        return;
    }

    const file = fileInput.files[0];
    lastExcelFile = file;

    messageEl.textContent = "Generating preview...";
    messageEl.className = "message";
    previewEl.style.display = "none";
    applyBtn.style.display = "none";

    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch(`${API_BASE}/api/excel/preview`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`
            },
            body: formData
        });

        const data = await response.json();

        if (!response.ok || data.status !== "success") {
            throw new Error(data.message || data.detail || "Preview failed");
        }

        messageEl.textContent = `Preview ready – ${data.summary.total_seo_rows} SEO rows, ${data.summary.total_component_rows} component rows`;
        messageEl.className = "message success";

        // Build preview HTML
        let html = `<h3 style="margin-bottom:12px;">Preview of Changes</h3>`;

        if (data.seo_updates && data.seo_updates.length > 0) {
            html += `<h4>SEO / Page Properties (${data.seo_updates.length})</h4>`;
            html += `<div style="max-height:260px; overflow:auto; border:1px solid #eee; border-radius:6px; padding:10px; margin-bottom:15px;">`;
            data.seo_updates.forEach(item => {
                html += `<div style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #f0f0f0;">
                    <strong>${item.page_path}</strong><br>`;
                for (const [k, v] of Object.entries(item.properties)) {
                    html += `<span style="font-size:12px; color:#555;">${k}: <b>${v}</b></span><br>`;
                }
                html += `</div>`;
            });
            html += `</div>`;
        }

        if (data.component_updates && data.component_updates.length > 0) {
            html += `<h4>Component Updates (${data.component_updates.length})</h4>`;
            html += `<div style="max-height:300px; overflow:auto; border:1px solid #eee; border-radius:6px; padding:10px;">`;
            data.component_updates.forEach(item => {
                html += `<div style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #f0f0f0;">
                    <strong>${item.component_name}</strong> (Instance ${item.instance}) on <code>${item.page_path}</code><br>`;
                for (const [k, v] of Object.entries(item.properties)) {
                    html += `<span style="font-size:12px; color:#555;">${k}: <b>${v}</b></span><br>`;
                }
                html += `</div>`;
            });
            html += `</div>`;
        }

        previewEl.innerHTML = html;
        previewEl.style.display = "block";
        applyBtn.style.display = "inline-block";

    } catch (error) {
        messageEl.textContent = error.message;
        messageEl.className = "message error";
    }
}

async function applyExcel() {
    if (!lastExcelFile) {
        alert("Please preview the Excel first");
        return;
    }

    if (!confirm("Are you sure you want to apply all these changes to AEM?\n\nThis action cannot be undone easily.")) {
        return;
    }

    const messageEl = document.getElementById("excel-message");
    const previewEl = document.getElementById("excel-preview");

    messageEl.textContent = "Applying changes... Please wait...";
    messageEl.className = "message";

    const formData = new FormData();
    formData.append("file", lastExcelFile);

    try {
        const response = await fetch(`${API_BASE}/api/excel/apply`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`
            },
            body: formData
        });

        const data = await response.json();

        // Safer handling
        if (!response.ok) {
            throw new Error(data.detail || data.message || "Apply failed with server error");
        }

        if (data.status !== "success") {
            throw new Error(data.message || "Apply failed");
        }

        const res = data.results || {};
        const successCount = res.success_count || 0;
        const errorCount = res.error_count || 0;
        const skippedCount = res.skipped_count || 0;

        messageEl.textContent = `Completed – Success: ${successCount}, Errors: ${errorCount}, Skipped: ${skippedCount}`;
        messageEl.className = errorCount > 0 ? "message error" : "message success";

        // Build detailed report
        let html = `<h3 style="margin-bottom:12px;">Detailed Results</h3>`;
        html += `<p><strong>Success:</strong> ${successCount} &nbsp;|&nbsp; <strong>Errors:</strong> ${errorCount} &nbsp;|&nbsp; <strong>Skipped:</strong> ${skippedCount}</p>`;

        // SEO Results
        if (res.seo_results && res.seo_results.length > 0) {
            html += `<h4 style="margin-top:18px;">SEO / Page Properties</h4>`;
            html += `<div style="max-height:300px; overflow:auto; border:1px solid #eee; border-radius:6px; padding:12px;">`;

            res.seo_results.forEach(r => {
                const hasError = r.errors && r.errors.length > 0;
                const icon = hasError ? "❌" : (r.updated_fields && r.updated_fields.length > 0 ? "✅" : "⏭️");

                html += `<div style="margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f0f0f0;">
                    <strong>${icon} ${r.page_path}</strong><br>`;

                if (r.updated_fields && r.updated_fields.length > 0) {
                    html += `<span style="color:#2e7d32; font-size:13px;">Updated: ${r.updated_fields.join(", ")}</span><br>`;
                }
                if (r.skipped_fields && r.skipped_fields.length > 0) {
                    html += `<span style="color:#f57c00; font-size:13px;">Skipped: ${r.skipped_fields.join(", ")}</span><br>`;
                }
                if (r.errors && r.errors.length > 0) {
                    html += `<span style="color:#c62828; font-size:13px;">Errors: ${r.errors.join(" | ")}</span><br>`;
                }
                html += `</div>`;
            });
            html += `</div>`;
        }

        // Component Results
        if (res.component_results && res.component_results.length > 0) {
            html += `<h4 style="margin-top:18px;">Component Updates</h4>`;
            html += `<div style="max-height:300px; overflow:auto; border:1px solid #eee; border-radius:6px; padding:12px;">`;

            res.component_results.forEach(r => {
                const hasError = r.errors && r.errors.length > 0;
                const icon = hasError ? "❌" : (r.updated_fields && r.updated_fields.length > 0 ? "✅" : "⏭️");

                html += `<div style="margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #f0f0f0;">
                    <strong>${icon} ${r.component_name} (Instance ${r.instance})</strong> on <code>${r.page_path}</code><br>`;

                if (r.component_path) {
                    html += `<span style="font-size:12px; color:#666;">Path: ${r.component_path}</span><br>`;
                }
                if (r.updated_fields && r.updated_fields.length > 0) {
                    html += `<span style="color:#2e7d32; font-size:13px;">Updated: ${r.updated_fields.join(", ")}</span><br>`;
                }
                if (r.skipped_fields && r.skipped_fields.length > 0) {
                    html += `<span style="color:#f57c00; font-size:13px;">Skipped: ${r.skipped_fields.join(", ")}</span><br>`;
                }
                if (r.errors && r.errors.length > 0) {
                    html += `<span style="color:#c62828; font-size:13px;">Errors: ${r.errors.join(" | ")}</span><br>`;
                }
                html += `</div>`;
            });
            html += `</div>`;
        }

        previewEl.innerHTML = html;

    } catch (error) {
        messageEl.textContent = error.message;
        messageEl.className = "message error";
        console.error("Apply error:", error);
    }
}

// ========== COMPONENT CATALOG + TEMPLATE GENERATOR ==========
let catalogData = null;
let selectedCatalogItems = {};   // key = resourceType|version → {fields: Set}

async function loadCatalog() {
    const messageEl = document.getElementById("catalog-message");
    const listEl = document.getElementById("catalog-list");
    const genBtn = document.getElementById("generate-template-btn");

    messageEl.textContent = "Loading catalog...";
    messageEl.className = "message";
    listEl.innerHTML = "";
    genBtn.style.display = "none";
    selectedCatalogItems = {};

    try {
        const response = await fetch(`${API_BASE}/api/catalog/list`, {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
        const data = await response.json();

        if (!response.ok || data.status !== "success") {
            throw new Error(data.message || "Failed to load catalog");
        }

        catalogData = data.components;
        messageEl.textContent = `Catalog loaded – ${data.total_components} components`;
        messageEl.className = "message success";

        if (data.total_components === 0) {
            listEl.innerHTML = "<p>No components in catalog yet. Load a page first so components are stored.</p>";
            return;
        }

        let html = "";
        for (const [resourceType, info] of Object.entries(catalogData)) {
            const shortName = resourceType.split("/").pop();
            html += `<div style="border:1px solid #e0e0e0; border-radius:8px; padding:12px; margin-bottom:12px;">
                <strong style="font-size:15px;">${shortName}</strong>
                <div style="font-size:12px; color:#666; margin-bottom:8px;">${resourceType}</div>`;

            info.versions.forEach(v => {
                const key = `${resourceType}|${v.version}`;
                html += `<div style="margin-left:10px; margin-bottom:8px; padding:8px; background:#f8f9fa; border-radius:6px;">
                    <label style="font-weight:600;">
                        <input type="checkbox" onchange="toggleComponentSelection('${key}', this.checked)" style="margin-right:6px;">
                        ${v.version} (${v.fields.length} fields)
                    </label>
                    <button onclick="toggleFieldsView('${key}')" style="margin-left:10px; font-size:12px; padding:2px 8px;">Show / Hide Fields</button>
                    <div id="fields-${key.replace('|', '-')}" style="display:none; margin-top:8px; font-size:13px;">`;

                v.fields.forEach(f => {
                    html += `<label style="display:inline-block; margin:3px 8px 3px 0;">
                        <input type="checkbox" class="field-check" data-key="${key}" value="${f}" checked style="margin-right:3px;">
                        ${f}
                    </label>`;
                });

                html += `</div></div>`;
            });
            html += `</div>`;
        }

        listEl.innerHTML = html;
        genBtn.style.display = "inline-block";

    } catch (error) {
        messageEl.textContent = error.message;
        messageEl.className = "message error";
    }
}

function toggleFieldsView(key) {
    const id = "fields-" + key.replace("|", "-");
    const el = document.getElementById(id);
    if (el) {
        el.style.display = el.style.display === "none" ? "block" : "none";
    }
}

function toggleComponentSelection(key, checked) {
    if (checked) {
        selectedCatalogItems[key] = true;
    } else {
        delete selectedCatalogItems[key];
    }
}
async function generateTemplateFromCatalog() {
    const messageEl = document.getElementById("catalog-message");

    const selections = [];

    for (const key of Object.keys(selectedCatalogItems)) {
        const [resourceType, version] = key.split("|");
        const versionInfo = catalogData[resourceType].versions.find(v => v.version === version);
        if (!versionInfo) continue;

        // Collect checked fields
        const fieldChecks = document.querySelectorAll(`.field-check[data-key="${key}"]`);
        const selectedFields = [];
        fieldChecks.forEach(cb => {
            if (cb.checked) selectedFields.push(cb.value);
        });

        if (selectedFields.length === 0) continue;

        selections.push({
            resourceType: resourceType,
            version: version,
            fields: selectedFields,
            label: resourceType.split("/").pop()
        });
    }

    if (selections.length === 0) {
        messageEl.textContent = "Please select at least one component and some fields";
        messageEl.className = "message error";
        return;
    }

    messageEl.textContent = "Generating Excel template...";
    messageEl.className = "message";

    try {
        const response = await fetch(`${API_BASE}/api/catalog/generate-template`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ selections })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || err.detail || "Generation failed");
        }

        // Download the file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "AEM_Template_From_Catalog.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        messageEl.textContent = "Excel template downloaded successfully!";
        messageEl.className = "message success";

    } catch (error) {
        messageEl.textContent = error.message;
        messageEl.className = "message error";
    }
}