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

    for (const [key, value] of Object.entries(data.fields)) {
      const row = document.createElement("div");
      row.className = "field-row";

      // Detect boolean values
      const isBoolean =
        value === true ||
        value === false ||
        value === "true" ||
        value === "false" ||
        key.toLowerCase().includes("fullwidth") ||
        key.toLowerCase().includes("enabled") ||
        key.toLowerCase().includes("hide") ||
        key.toLowerCase().includes("show");

      let inputHtml = "";

      if (isBoolean) {
        // Create a dropdown for true/false
        const current = value === true || value === "true" ? "true" : "false";
        inputHtml = `
                    <select id="field-${key}" style="flex:1; padding:9px 12px; border:1px solid #d0d5dd; border-radius:6px; font-size:14px;">
                        <option value="true" ${current === "true" ? "selected" : ""}>true</option>
                        <option value="false" ${current === "false" ? "selected" : ""}>false</option>
                    </select>
                `;
      } else {
        // Normal text input
        inputHtml = `<input type="text" id="field-${key}" value="${value !== null && value !== undefined ? value : ""}">`;
      }

      row.innerHTML = `
                <label>${key}</label>
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
