// Configuration
const API_BASE = "http://127.0.0.1:8001";

// New page load / refresh always starts a fresh bulk session (not stored in localStorage)
function newBulkSessionId() {
  return "bs-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
let bulkSessionId = newBulkSessionId();

function bulkSessionHeaders(extra) {
  const h = Object.assign({}, extra || {});
  h["X-Bulk-Session-Id"] = bulkSessionId;
  if (typeof accessToken !== "undefined" && accessToken) {
    h["Authorization"] = "Bearer " + accessToken;
  }
  return h;
}



function ensureModalDom() {
  let overlay = document.getElementById("aem-modal-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "aem-modal-overlay";
  overlay.style.cssText = "display:none;position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:9999;align-items:center;justify-content:center;padding:16px;";
  overlay.innerHTML = `
    <div id="aem-modal-panel" style="background:#fff;border-radius:12px;max-width:920px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,0.2);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #e2e8f0;position:sticky;top:0;background:#fff;z-index:1;">
        <h2 id="modal-title" style="margin:0;font-size:18px;color:#0f172a;">Dialog</h2>
        <button type="button" onclick="closeModal()" style="border:none;background:transparent;font-size:22px;cursor:pointer;line-height:1;color:#64748b;">×</button>
      </div>
      <div id="modal-body" style="padding:16px 18px;"></div>
      <div id="modal-footer" style="padding:12px 18px;border-top:1px solid #e2e8f0;display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:#fff;"></div>
    </div>`;
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function showModalShell(title, bodyHtml, footerHtml) {
  const overlay = ensureModalDom();
  const t = document.getElementById("modal-title");
  const b = document.getElementById("modal-body");
  const f = document.getElementById("modal-footer");
  if (t) t.textContent = title || "Dialog";
  if (b) b.innerHTML = bodyHtml || "";
  if (f) f.innerHTML = footerHtml || "";
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const overlay = document.getElementById("aem-modal-overlay");
  if (overlay) overlay.style.display = "none";
  document.body.style.overflow = "";
}


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


// ========== CHILD COMPONENT EDITOR (nested — parent stays visible) ==========
// Matches AEM: child dialog saves independently; parent dialog saves parent fields.
let childEditorParentPath = null;

async function openChildComponentEditor(childPath, titleHint) {
  if (!accessToken || !childPath) return;
  childEditorParentPath = selectedComponentPath;

  // Overlay
  let overlay = document.getElementById("child-editor-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "child-editor-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:10050;display:flex;align-items:stretch;justify-content:flex-end;";
    const panel = document.createElement("div");
    panel.id = "child-editor-panel";
    panel.style.cssText = "width:min(520px,100%);max-width:100%;height:100%;background:#fff;box-shadow:-8px 0 24px rgba(0,0,0,0.15);display:flex;flex-direction:column;";
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:15px;color:#0f172a;">Child component</div>
          <div id="child-editor-path" style="font-size:11px;color:#64748b;word-break:break-all;margin-top:4px;"></div>
        </div>
        <button type="button" id="child-editor-close" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">Close</button>
      </div>
      <div id="child-editor-body" style="flex:1;overflow:auto;padding:16px;"></div>
      <div style="padding:12px 16px;border-top:1px solid #e2e8f0;display:flex;gap:8px;justify-content:flex-end;background:#f8fafc;">
        <span id="child-editor-msg" style="flex:1;font-size:12px;color:#64748b;align-self:center;"></span>
        <button type="button" id="child-editor-save" style="padding:10px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Save child</button>
      </div>`;
    overlay.appendChild(panel);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeChildComponentEditor();
    });
    document.body.appendChild(overlay);
    document.getElementById("child-editor-close").onclick = closeChildComponentEditor;
  }
  overlay.style.display = "flex";
  document.getElementById("child-editor-path").textContent = childPath + (titleHint ? " — " + titleHint : "");
  const body = document.getElementById("child-editor-body");
  body.innerHTML = "<p style='color:#64748b;font-size:13px;'>Loading child fields…</p>";
  document.getElementById("child-editor-msg").textContent = "";

  try {
    const response = await fetch(
      API_BASE + "/api/aem/component/fields?component_path=" + encodeURIComponent(childPath),
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    const data = await response.json();
    if (!response.ok || data.status !== "success") {
      throw new Error(data.message || data.detail || "Failed to load child fields");
    }
    const fields = data.fields || {};
    const fieldMeta = data.field_meta || {};
    body.innerHTML = "";
    body.dataset.childPath = childPath;

    // Simple field form (no nested children-editor recursion for clarity)
    const keys = Object.keys(fields).filter((k) => {
      const m = fieldMeta[k] || {};
      if ((m.editor || "").toLowerCase() === "childreneditor") return false;
      if ((m.type || "").toLowerCase() === "multifield") return false;
      return true;
    });
    if (!keys.length) {
      body.innerHTML = "<p style='color:#64748b;font-size:13px;'>No simple fields on this child (it may only be a layout container). Add components inside it in AEM, or open a content child.</p>";
    }
    keys.forEach((key) => {
      const meta = fieldMeta[key] || { label: key };
      const label = meta.label || key;
      const val = fields[key];
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:12px;";
      const lab = document.createElement("label");
      lab.style.cssText = "display:block;font-size:12px;font-weight:600;color:#334155;margin-bottom:4px;";
      lab.textContent = label;
      row.appendChild(lab);
      if ((meta.type || "").toLowerCase().includes("checkbox") || val === true || val === false || val === "true" || val === "false") {
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.id = "child-field-" + key;
        inp.checked = val === true || val === "true";
        row.appendChild(inp);
      } else if (meta.options && meta.options.length) {
        const sel = document.createElement("select");
        sel.id = "child-field-" + key;
        sel.style.cssText = "width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "—";
        sel.appendChild(empty);
        meta.options.forEach((o) => {
          const opt = document.createElement("option");
          opt.value = o.value != null ? String(o.value) : "";
          opt.textContent = o.text || o.label || opt.value;
          if (String(val) === opt.value) opt.selected = true;
          sel.appendChild(opt);
        });
        row.appendChild(sel);
      } else {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.id = "child-field-" + key;
        inp.value = val != null ? String(val) : "";
        inp.style.cssText = "width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;";
        row.appendChild(inp);
      }
      body.appendChild(row);
    });

    document.getElementById("child-editor-save").onclick = async function () {
      const msg = document.getElementById("child-editor-msg");
      msg.textContent = "Saving child…";
      const props = {};
      keys.forEach((key) => {
        const el = document.getElementById("child-field-" + key);
        if (!el) return;
        if (el.type === "checkbox") props[key] = el.checked ? "true" : "false";
        else props[key] = el.value;
      });
      try {
        const res = await fetch(
          API_BASE + "/api/aem/component/update?component_path=" + encodeURIComponent(childPath),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(props),
          }
        );
        const out = await res.json();
        if (!res.ok || (out.status !== "success" && out.status !== "partial")) {
          throw new Error(out.message || out.detail || "Child save failed");
        }
        msg.style.color = "#15803d";
        msg.textContent = "Child saved (independent of parent — same as AEM).";
      } catch (err) {
        msg.style.color = "#b91c1c";
        msg.textContent = err.message || String(err);
      }
    };
  } catch (e) {
    body.innerHTML = "<p style='color:#b91c1c;'>" + (e.message || String(e)) + "</p>";
  }
}

function closeChildComponentEditor() {
  const overlay = document.getElementById("child-editor-overlay");
  if (overlay) overlay.style.display = "none";
  // Parent Tabs component remains selected — reload parent fields so Active Item list stays fresh
  if (childEditorParentPath && typeof selectComponent === "function") {
    const parent = childEditorParentPath;
    childEditorParentPath = null;
    selectComponent(parent, null);
  }
}

window.openChildComponentEditor = openChildComponentEditor;
window.closeChildComponentEditor = closeChildComponentEditor;


// ========== SELECT COMPONENT + LOAD FIELDS ==========
// Holds multifield runtime state: { fieldKey: [ "val1", "val2", ... ] }
let multifieldState = {};

async function selectComponent(componentPath, clickedElement) {
  selectedComponentPath = componentPath;
  multifieldState = {};

  document.querySelectorAll(".component-item").forEach((el) => {
    el.classList.remove("selected");
  });
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
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await response.json();
    if (!response.ok || data.status !== "success") {
      throw new Error(data.detail || data.message || "Failed to load fields");
    }

    currentFields = data.fields || {};
    const fieldMeta = data.field_meta || {};
    const tabs = data.tabs || [];
    const topMultifields = data.multifields || [];
    formEl.innerHTML = "";

    // ---------- helpers ----------
    function isCheckboxField(key, meta, value) {
      const t = (meta.type || meta.resourceType || "").toLowerCase();
      if (t.includes("checkbox") || t.includes("switch")) return true;
      if (value === true || value === false) return true;
      if (value === "true" || value === "false") {
        const k = key.toLowerCase();
        if (k.includes("enable") || k.includes("hide") || k.includes("show") ||
            k.includes("fullwidth") || k.includes("frompage") || k.includes("redirect") ||
            k.includes("root") || k.includes("inherit")) return true;
      }
      return false;
    }

    function isSelectField(meta) {
      const t = (meta.type || meta.resourceType || "").toLowerCase();
      return t.includes("select") || t.includes("dropdown");
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    /** Infer show/hide group from dialog path (setChildren → children, setStatic → static, ...) */
    function inferShowHideGroup(path) {
      if (!path) return null;
      const m = String(path).match(/\/set([A-Za-z]+)\//);
      if (!m) return null;
      const name = m[1]; // Children, Static, Search, Tags
      return name.charAt(0).toLowerCase() + name.slice(1); // children, static, ...
    }

    function renderFieldControl(container, key, value, meta) {
      meta = meta || {};
      const label = meta.label || key;
      const row = document.createElement("div");
      row.className = "field-row";
      row.style.cssText = "display:flex; align-items:flex-start; gap:12px; margin-bottom:14px; min-height:36px;";
      row.dataset.fieldKey = key;
      if (meta.path) {
        const grp = inferShowHideGroup(meta.path);
        if (grp) row.dataset.showhideGroup = grp;
      }
      // also check properties for showhidetargetvalue
      if (meta.properties && meta.properties.showhidetargetvalue) {
        row.dataset.showhideGroup = String(meta.properties.showhidetargetvalue);
      }

      const labelEl = document.createElement("label");
      labelEl.style.cssText = "min-width:180px; max-width:180px; font-size:13px; color:#333; padding-top:8px; line-height:1.3;";
      labelEl.title = key;
      labelEl.textContent = label;

      const controlWrap = document.createElement("div");
      controlWrap.style.cssText = "flex:1; display:flex; align-items:center; min-height:36px;";

      if (isCheckboxField(key, meta, value)) {
        // AEM-style: checkbox aligned in the control column (same column as text inputs)
        const checked = value === true || value === "true" || value === "on";
        controlWrap.innerHTML = `
          <input type="checkbox" id="field-${escapeHtml(key)}" ${checked ? "checked" : ""}
            style="width:18px; height:18px; cursor:pointer; margin:0;">`;
        row.appendChild(labelEl);
        row.appendChild(controlWrap);
      } else if ((meta.options && meta.options.length) || isSelectField(meta)) {
        // Real dropdown from dialog options (Match, Order By, listFrom, etc.)
        const sel = document.createElement("select");
        sel.id = "field-" + key;
        sel.style.cssText = "flex:1; width:100%; padding:9px 12px; border:1px solid #d0d5dd; border-radius:6px; font-size:14px; box-sizing:border-box; background:#fff;";
        const current = value != null ? String(value) : "";
        const opts = meta.options && meta.options.length ? meta.options : [];
        // empty option
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = meta.emptyText || "— Select —";
        sel.appendChild(empty);
        opts.forEach(o => {
          const opt = document.createElement("option");
          opt.value = o.value != null ? String(o.value) : "";
          opt.textContent = o.text != null ? String(o.text) : opt.value;
          if (opt.value === current) opt.selected = true;
          sel.appendChild(opt);
        });
        // if current not in options, still show it
        if (current && !opts.some(o => String(o.value) === current)) {
          const opt = document.createElement("option");
          opt.value = current;
          opt.textContent = current;
          opt.selected = true;
          sel.appendChild(opt);
        }
        // showhide controller?
        const gclass = (meta.properties && (meta.properties["granite:class"] || meta.properties.granite_class || "")) || "";
        if (String(gclass).toLowerCase().includes("showhide")) {
          sel.dataset.showhideController = "1";
          sel.dataset.currentValue = current;
          row.dataset.isShowhideController = "1";
        }
        controlWrap.appendChild(sel);
        row.appendChild(labelEl);
        row.appendChild(controlWrap);
      } else if ((meta.type || "").toLowerCase().includes("radio")) {
        const current = value != null ? String(value) : "";
        const opts = meta.options || [];
        const group = document.createElement("div");
        group.style.cssText = "display:flex; flex-direction:column; gap:6px;";
        opts.forEach((o, i) => {
          const id = `field-${key}-${i}`;
          const lab = document.createElement("label");
          lab.style.cssText = "display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;";
          lab.innerHTML = `<input type="radio" name="field-${escapeHtml(key)}" id="${id}" value="${escapeHtml(o.value)}" ${String(o.value)===current?"checked":""}> <span>${escapeHtml(o.text)}</span>`;
          group.appendChild(lab);
        });
        // hidden carrier for save
        const hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.id = "field-" + key;
        hidden.value = current;
        group.querySelectorAll("input[type=radio]").forEach(r => {
          r.onchange = () => { hidden.value = r.value; };
        });
        controlWrap.appendChild(group);
        controlWrap.appendChild(hidden);
        row.appendChild(labelEl);
        row.appendChild(controlWrap);
      } else {
        const safeVal = escapeHtml(value);
        controlWrap.innerHTML = `<input type="text" id="field-${escapeHtml(key)}" value="${safeVal}"
          style="flex:1; width:100%; padding:9px 12px; border:1px solid #d0d5dd; border-radius:6px; font-size:14px; box-sizing:border-box;">`;
        row.appendChild(labelEl);
        row.appendChild(controlWrap);
      }
      container.appendChild(row);
    }

    function applyShowHide(root) {
      // Collect groups discovered from field paths (fully dynamic)
      const groupSet = new Set();
      root.querySelectorAll("[data-showhide-group]").forEach(el => {
        if (el.dataset.showhideGroup) groupSet.add(el.dataset.showhideGroup);
      });

      // Friendly labels derived from group id only (no component hardcoding)
      function labelFor(g) {
        const map = {
          children: "Child pages",
          static: "Fixed list",
          search: "Search",
          tags: "Tags"
        };
        if (map[g]) return map[g];
        // generic: capitalize
        return g.charAt(0).toUpperCase() + g.slice(1).replace(/([A-Z])/g, " $1");
      }

      const controllers = root.querySelectorAll("select[data-showhide-controller], [data-is-showhide-controller='1'] select");
      controllers.forEach(sel => {
        const current = sel.dataset.currentValue || sel.value || "";
        // Build options from discovered groups
        const groups = Array.from(groupSet);
        if (current && !groups.includes(current)) groups.unshift(current);
        if (groups.length === 0 && current) groups.push(current);

        sel.innerHTML = "";
        groups.forEach(g => {
          const opt = document.createElement("option");
          opt.value = g;
          opt.textContent = labelFor(g);
          if (g === current) opt.selected = true;
          sel.appendChild(opt);
        });
        if (!sel.value && groups.length) sel.value = groups[0];

        const run = () => {
          const val = sel.value;
          root.querySelectorAll(".field-row[data-showhide-group]").forEach(row => {
            row.style.display = (row.dataset.showhideGroup === val) ? "flex" : "none";
          });
          root.querySelectorAll(".multifield-wrap[data-showhide-group]").forEach(w => {
            w.style.display = (w.dataset.showhideGroup === val) ? "block" : "none";
          });
        };
        sel.onchange = run;
        run();
      });
    }

    function normalizeMultifieldValues(raw) {
      if (raw == null || raw === "") return [];
      if (Array.isArray(raw)) {
        return raw.map(v => {
          if (v && typeof v === "object") {
            // composite item – take first string-ish value or JSON
            const vals = Object.values(v).filter(x => typeof x === "string" || typeof x === "number");
            return vals.length ? String(vals[0]) : JSON.stringify(v);
          }
          return String(v);
        });
      }
      if (typeof raw === "string") return raw ? [raw] : [];
      return [String(raw)];
    }


    function renderChildrenEditorList(container, mfKey, mfLabel, currentValue, helpText) {
      const wrap = document.createElement("div");
      wrap.className = "multifield-wrap children-editor-wrap";
      wrap.style.cssText = "margin:14px 0 18px 0; padding:14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;";

      const title = document.createElement("div");
      title.style.cssText = "font-weight:600; font-size:13px; margin-bottom:6px; color:#1e293b;";
      title.textContent = mfLabel || "Items";
      wrap.appendChild(title);

      const help = document.createElement("p");
      help.style.cssText = "margin:0 0 12px; font-size:12px; color:#64748b; line-height:1.4;";
      help.textContent = helpText || (
        "Each row is a child component (not a free path field). Edit the title here. " +
        "Open that child in the component list to author its own fields."
      );
      wrap.appendChild(help);

      const listEl = document.createElement("div");
      wrap.appendChild(listEl);

      let rows = [];
      if (Array.isArray(currentValue)) {
        rows = currentValue.map((v) => (v && typeof v === "object" ? Object.assign({}, v) : { "cq:panelTitle": String(v) }));
      }
      multifieldState[mfKey] = rows;

      (multifieldState[mfKey] || []).forEach((row, idx) => {
        const line = document.createElement("div");
        line.style.cssText = "display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; padding:10px; background:#fff; border:1px solid #e2e8f0; border-radius:8px;";

        const titleInp = document.createElement("input");
        titleInp.type = "text";
        titleInp.value = row["cq:panelTitle"] || row.title || "";
        titleInp.placeholder = "Title";
        titleInp.title = "Panel / item title (authorable)";
        titleInp.style.cssText = "flex:1; min-width:140px; padding:8px 10px; border:1px solid #cbd5e1; border-radius:6px; font-size:13px;";
        titleInp.oninput = function () { multifieldState[mfKey][idx]["cq:panelTitle"] = titleInp.value; };
        line.appendChild(titleInp);

        const node = row.nodeName || "";
        const nodeBadge = document.createElement("span");
        nodeBadge.textContent = node || "—";
        nodeBadge.title = "Child node name (identity, not content)";
        nodeBadge.style.cssText = "font-size:11px; color:#475569; background:#f1f5f9; padding:6px 8px; border-radius:6px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        line.appendChild(nodeBadge);

        const rt = row["sling:resourceType"] || "";
        const rtBadge = document.createElement("span");
        rtBadge.textContent = rt ? rt.split("/").slice(-2).join("/") : "component";
        rtBadge.title = "Nested component — author separately:\n" + rt;
        rtBadge.style.cssText = "font-size:11px; color:#1e40af; background:#dbeafe; padding:6px 8px; border-radius:6px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:Consolas,monospace;";
        line.appendChild(rtBadge);

        const parentPath = (document.getElementById("selected-component-path") || {}).textContent || "";
        if (parentPath && node) {
          const full = parentPath.replace(/\/+$/, "") + "/" + node;
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.textContent = "Open";
          openBtn.title = "Edit this child component in a panel (parent stays open)\n" + full;
          openBtn.style.cssText = "padding:6px 12px; font-size:12px; font-weight:600; border:none; background:#2563eb; color:#fff; border-radius:6px; cursor:pointer;";
          openBtn.onclick = function () {
            if (typeof openChildComponentEditor === "function") {
              openChildComponentEditor(full, row["cq:panelTitle"] || node);
            }
          };
          line.appendChild(openBtn);
        }
        listEl.appendChild(line);
      });

      if (!(multifieldState[mfKey] || []).length) {
        const empty = document.createElement("p");
        empty.style.cssText = "font-size:12px; color:#94a3b8; margin:0;";
        empty.textContent = "No child components yet.";
        listEl.appendChild(empty);
      }
      container.appendChild(wrap);
    }

    function renderMultifield(container, mfKey, mfLabel, itemFields, currentValue, metaPath, mfMeta) {
      mfMeta = mfMeta || {};
      if (String(mfMeta.editor || "").toLowerCase() === "childreneditor") {
        renderChildrenEditorList(container, mfKey, mfLabel, currentValue, mfMeta.help);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "multifield-wrap";
      wrap.style.cssText = "margin:14px 0 18px 0; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;";
      const grp = inferShowHideGroup(metaPath);
      if (grp) wrap.dataset.showhideGroup = grp;

      const title = document.createElement("div");
      title.style.cssText = "font-weight:600; font-size:13px; margin-bottom:10px; color:#1e293b;";
      title.textContent = mfLabel || mfKey || "Items";
      wrap.appendChild(title);

      const listEl = document.createElement("div");
      listEl.className = "multifield-list";
      listEl.dataset.mfKey = mfKey;
      wrap.appendChild(listEl);

      const cols = (itemFields && itemFields.length)
        ? itemFields.map(f => ({ name: f.name, label: f.label || f.name }))
        : [{ name: "value", label: "Value" }];

      // Normalize current values to array of row objects
      function normalizeRows(raw) {
        if (raw == null || raw === "") return [];
        const arr = Array.isArray(raw) ? raw : [raw];
        return arr.map(item => {
          if (item != null && typeof item === "object" && !Array.isArray(item)) {
            const row = {};
            cols.forEach(c => { row[c.name] = item[c.name] != null ? item[c.name] : ""; });
            // if object used different keys, copy first string values
            if (cols.every(c => !row[c.name])) {
              const vals = Object.values(item).filter(v => typeof v === "string");
              cols.forEach((c, i) => { row[c.name] = vals[i] || ""; });
            }
            return row;
          }
          const row = {};
          cols.forEach((c, i) => { row[c.name] = i === 0 ? String(item ?? "") : ""; });
          return row;
        });
      }

      multifieldState[mfKey] = normalizeRows(currentValue);

      function redraw() {
        listEl.innerHTML = "";
        multifieldState[mfKey].forEach((row, idx) => {
          const item = document.createElement("div");
          item.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;";
          cols.forEach(c => {
            const inp = document.createElement("input");
            inp.type = "text";
            inp.placeholder = c.label || c.name;
            inp.value = row[c.name] != null ? row[c.name] : "";
            inp.dataset.mfKey = mfKey;
            inp.dataset.mfIdx = String(idx);
            inp.dataset.mfCol = c.name;
            inp.style.cssText = "flex:1; min-width:120px; padding:8px 10px; border:1px solid #d0d5dd; border-radius:6px; font-size:13px;";
            inp.oninput = () => {
              multifieldState[mfKey][idx][c.name] = inp.value;
            };
            item.appendChild(inp);
          });
          const del = document.createElement("button");
          del.type = "button";
          del.title = "Remove";
          del.textContent = "🗑";
          del.style.cssText = "border:1px solid #e2e8f0; background:#fff; border-radius:6px; padding:6px 10px; cursor:pointer; color:#b91c1c;";
          del.onclick = () => {
            multifieldState[mfKey].splice(idx, 1);
            redraw();
          };
          item.appendChild(del);
          listEl.appendChild(item);
        });
      }

      redraw();

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = "Add";
      addBtn.style.cssText = "margin-top:4px; padding:7px 16px; border:1px solid #cbd5e1; background:#fff; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500;";
      addBtn.onclick = () => {
        const blank = {};
        cols.forEach(c => { blank[c.name] = ""; });
        multifieldState[mfKey].push(blank);
        redraw();
      };
      wrap.appendChild(addBtn);
      container.appendChild(wrap);
    }

    function renderFieldsInto(container, fieldsArr, multifieldsArr, renderedKeys) {
      (fieldsArr || []).forEach(f => {
        let key = f.name;
        if (!key) return;
        // fileupload → use storage param
        if (f.fileReferenceParameter) {
          key = f.fileReferenceParameter;
        }
        if (renderedKeys.has(key)) return;
        renderedKeys.add(key);
        const value = currentFields[key] ?? "";
        const meta = { ...f, label: f.label || key, type: f.type, resourceType: f.resourceType };
        renderFieldControl(container, key, value, meta);
      });

      (multifieldsArr || []).forEach(mf => {
        let mfKey = mf.name || mf.label || "multifield";
        if (mfKey.toLowerCase() === "multi" || mfKey.toLowerCase() === "multifield") {
          const it = (mf.itemFields || []).find(f => f.name);
          if (it) mfKey = it.name;
        }
        if (renderedKeys.has(mfKey)) return;
        renderedKeys.add(mfKey);
        const currentVal = mf.currentValues || currentFields[mfKey] || [];
        const label = (mf.label && mf.label.toLowerCase() !== "multi") ? mf.label : (mfKey === "pages" ? "Pages (Fixed List)" : mfKey);
        renderMultifield(container, mfKey, label, mf.itemFields || [], currentVal, mf.path, mf);
      });
    }

    // ---------- interactive tabs ----------
    // Keep every dialog tab (Items + Properties) even if Properties has no authorable fields yet
    let tabsWithContent = (tabs || []).filter(t => t && (t.title || t.name));
    if (!tabsWithContent.length) {
      tabsWithContent = tabs.filter(t =>
        (t.fields && t.fields.length) || (t.multifields && t.multifields.length)
      );
    }

    const renderedKeys = new Set();

    if (tabsWithContent.length > 1) {
      // Tab bar
      const tabBar = document.createElement("div");
      tabBar.style.cssText = "display:flex; gap:0; border-bottom:2px solid #e2e8f0; margin-bottom:16px; flex-wrap:wrap;";
      formEl.appendChild(tabBar);

      const panelsWrap = document.createElement("div");
      formEl.appendChild(panelsWrap);

      tabsWithContent.forEach((tab, idx) => {
        let tabTitle = tab.title || tab.name || `Tab ${idx + 1}`;
        if (String(tabTitle).toLowerCase() === "tabs") {
          tabTitle = `Section ${idx + 1}`;
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = tabTitle;
        btn.dataset.tabIdx = String(idx);
        btn.style.cssText = `
          padding:10px 18px; border:none; background:transparent; cursor:pointer;
          font-size:13px; font-weight:500; color:#64748b; border-bottom:2px solid transparent;
          margin-bottom:-2px;`;
        tabBar.appendChild(btn);

        const panel = document.createElement("div");
        panel.dataset.tabPanel = String(idx);
        panel.style.display = idx === 0 ? "block" : "none";
        panelsWrap.appendChild(panel);

        const beforeCount = panel.children.length;
        renderFieldsInto(panel, tab.fields, tab.multifields, renderedKeys);
        if (!panel.children.length) {
          const empty = document.createElement("p");
          empty.style.cssText = "font-size:13px;color:#64748b;margin:8px 0;";
          empty.textContent = "No authorable fields on this tab (technical/hidden fields only). Use Items for child components.";
          panel.appendChild(empty);
        }

        btn.onclick = () => {
          tabBar.querySelectorAll("button").forEach(b => {
            b.style.color = "#64748b";
            b.style.borderBottomColor = "transparent";
            b.style.fontWeight = "500";
          });
          btn.style.color = "#2563eb";
          btn.style.borderBottomColor = "#2563eb";
          btn.style.fontWeight = "600";
          panelsWrap.querySelectorAll("[data-tab-panel]").forEach(p => {
            p.style.display = p.dataset.tabPanel === String(idx) ? "block" : "none";
          });
        };

        if (idx === 0) {
          btn.style.color = "#2563eb";
          btn.style.borderBottomColor = "#2563eb";
          btn.style.fontWeight = "600";
        }
      });
    } else if (tabsWithContent.length === 1) {
      const tab = tabsWithContent[0];
      renderFieldsInto(formEl, tab.fields, tab.multifields, renderedKeys);
    }

    // Top-level multifields not nested in tabs
    topMultifields.forEach(mf => {
      let mfKey = mf.name || mf.label || "multifield";
      if (mfKey.toLowerCase() === "multi" || mfKey.toLowerCase() === "multifield") {
        const it = (mf.itemFields || []).find(f => f.name);
        if (it) mfKey = it.name;
      }
      if (renderedKeys.has(mfKey)) return;
      renderedKeys.add(mfKey);
      const currentVal = mf.currentValues || currentFields[mfKey] || [];
      const label = (mf.label && mf.label.toLowerCase() !== "multi") ? mf.label : (mfKey === "pages" ? "Pages (Fixed List)" : mfKey);
      renderMultifield(formEl, mfKey, label, mf.itemFields || [], currentVal, mf.path, mf);
    });

    // Remaining flat fields
    for (const [key, value] of Object.entries(currentFields)) {
      if (renderedKeys.has(key)) continue;
      if (multifieldState[key]) continue;
      const meta = fieldMeta[key] || { label: key };
      // skip empty technical keys
      if (!key || key.includes("@TypeHint")) continue;
      // Arrays / explicit multifield meta → multifield editor (Items, actions, …)
      const isMf = (meta.type || "").toLowerCase() === "multifield"
        || Array.isArray(value)
        || (value && typeof value === "object" && !Array.isArray(value) && meta.itemFields);
      if (isMf) {
        const itemFields = meta.itemFields || [{ name: "value", label: "Value" }];
        renderMultifield(formEl, key, meta.label || key, itemFields, value, meta.path, meta);
        renderedKeys.add(key);
        continue;
      }
      renderFieldControl(formEl, key, value, meta);
      renderedKeys.add(key);
    }

    if (renderedKeys.size === 0 && Object.keys(currentFields).length === 0) {
      formEl.innerHTML = "<p>No editable fields found for this component.</p>";
    }

    // Wire dropdown → show/hide field groups (AEM cq-dialog-dropdown-showhide behaviour)
    applyShowHide(formEl);
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

  const properties = {};

  // Normal fields (text + checkbox)
  for (const key of Object.keys(currentFields)) {
    if (multifieldState.hasOwnProperty(key)) continue;
    const input = document.getElementById(`field-${key}`);
    if (!input) continue;
    let newValue;
    if (input.type === "checkbox") {
      newValue = input.checked ? "true" : "false";
    } else {
      newValue = input.value;
    }
    if (String(newValue) !== String(currentFields[key] ?? "")) {
      properties[key] = newValue;
    }
  }

  // Multifields – composite rows or simple strings
  for (const [mfKey, values] of Object.entries(multifieldState)) {
    const cleaned = (values || []).map(v => {
      if (v && typeof v === "object") {
        const row = {};
        Object.keys(v).forEach(k => {
          const s = String(v[k] ?? "").trim();
          if (s) row[k] = s;
        });
        return Object.keys(row).length ? row : null;
      }
      const s = String(v ?? "").trim();
      return s || null;
    }).filter(Boolean);
    const oldRaw = currentFields[mfKey];
    if (JSON.stringify(cleaned) !== JSON.stringify(oldRaw || [])) {
      properties[mfKey] = cleaned;
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

    messageEl.textContent = "Generating full bulk preview (Assets → Pages → Add → Update)...";
    messageEl.className = "message";
    previewEl.style.display = "none";
    if (applyBtn) applyBtn.style.display = "none";

    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch(`${API_BASE}/api/excel/bulk/preview`, {
            method: "POST",
            headers: bulkSessionHeaders(),
            body: formData
        });
        const data = await response.json();
        if (!response.ok || data.status === "error") {
            throw new Error(data.message || data.detail || "Preview failed");
        }

        messageEl.textContent = data.message || "Full bulk preview ready";
        messageEl.className = "message success";

        let html = `<h3 style="margin-bottom:12px;">Full Bulk Preview</h3>`;
        html += `<p style="font-size:13px;color:#64748b;">Order: Assets → Pages → Component Add → SEO/Update</p>`;

        // Assets
        const assets = data.assets || {};
        html += "<h4>1. Assets</h4>";
        if (assets.status === "skipped" || (!(assets.plans || []).length && !assets.summary)) {
            html += '<p style="color:#64748b;font-size:13px;">No Assets sheet — skipped for this batch (OK for existing-page updates).</p>';
        } else if (assets.summary) {
            html += "<p>Planned uploads: " + (assets.summary.total_planned_uploads || 0) +
              ", rejected size: " + (assets.summary.total_rejected_size || 0) + "</p>";
        } else {
            html += "<p>" + (assets.message || assets.status || "") + "</p>";
        }
        (assets.plans || []).forEach((p) => {
          if (p.errors && p.errors.length) {
            html += '<div style="color:#b91c1c;font-size:13px;">✗ Row ' + (p.excel_row || "") +
              ": " + p.errors.join("; ") + "</div>";
          }
        });

        // Recommendations (DAM alignment etc.)
        const recs = data.recommendations || [];
        if (recs.length) {
          html += "<h4 style=\"color:#c2410c\">Recommendations — fix in Excel and re-upload</h4>";
          recs.forEach((r) => {
            html += '<div style="font-size:13px;margin:6px 0;padding:8px 10px;background:#fff7ed;border-left:4px solid #f97316;border-radius:4px;">' +
              (r.message || "") +
              (r.suggested_dam_paths ? "<br><code style=\"font-size:11px\">" + r.suggested_dam_paths.join(" · ") + "</code>" : "") +
              "</div>";
          });
        }

        // Session delta (re-upload after last apply)
        const delta = data.session_delta || {};
        if (delta.mode === "delta" && (delta.changed || []).length) {
          html += "<h4 style=\"color:#1d4ed8\">Changes since last apply (this session)</h4>";
          html += "<p style=\"font-size:13px;\">" + (delta.message || "") + " — highlighted fields only need re-apply.</p>";
          (delta.changed || []).forEach((c) => {
            html += '<div style="font-size:12px;margin:6px 0;padding:8px;background:#eff6ff;border-left:4px solid #3b82f6;border-radius:4px;">';
            html += "<strong>" + (c.change_type || "") + "</strong> " + (c.page_path || "") + " · " + (c.component || "");
            if (c.field_diffs) {
              html += "<ul style=\"margin:4px 0 0 16px;\">";
              Object.keys(c.field_diffs).forEach((fk) => {
                const d = c.field_diffs[fk];
                html += "<li><code>" + fk + "</code>: <span style=\"color:#94a3b8\">" + (d.from != null ? d.from : "∅") +
                  "</span> → <strong style=\"color:#1d4ed8\">" + (d.to != null ? d.to : "∅") + "</strong></li>";
              });
              html += "</ul>";
            }
            html += "</div>";
          });
        } else if (delta.mode === "unchanged") {
          html += "<p style=\"font-size:13px;color:#64748b;\">No field changes vs last apply in this session.</p>";
        } else if (delta.mode === "full") {
          html += "<p style=\"font-size:12px;color:#64748b;\">Full preview (no prior apply snapshot in this session).</p>";
        }

        // Pages
        const pages = data.pages || {};
        html += `<h4>2. Pages</h4>`;
        if (pages.status === "skipped" || (!(pages.plans || []).length && !pages.summary)) {
            html += `<p style="color:#64748b;font-size:13px;">No Pages sheet — skipped (existing pages must already exist).</p>`;
        } else if (pages.summary) {
            html += `<p>Will create: ${pages.summary.will_create || 0}, exists: ${pages.summary.exists || 0}, blocked: ${pages.summary.blocked || 0}</p>`;
        }
        (pages.plans || []).forEach((p) => {
            html += `<div style="font-size:13px;margin:4px 0;"><code>${p.page_path || ""}</code> → <strong>${p.action || ""}</strong>`;
            if (p.errors && p.errors.length) html += ` <span style="color:#c62828;">${p.errors.join("; ")}</span>`;
            html += `</div>`;
        });

        // Add
        const adds = data.components_add || {};
        const addSum = adds.summary || {};
        html += "<h4>3. Components Add</h4>";
        html += "<p>Total: " + ((adds.rows || []).length) +
          " · OK: " + (addSum.ok != null ? addSum.ok : "?") +
          " · Blocked: " + (addSum.blocked != null ? addSum.blocked : "0") + "</p>";
        if (!(adds.rows || []).length) {
          html += '<p style="font-size:12px;color:#64748b;">No Add sheets in this Excel (nothing new to create).</p>';
        }
        (adds.rows || []).forEach((r) => {
          const bad = r.errors && r.errors.length;
          const color = bad ? "#b91c1c" : "#15803d";
          const bg = bad ? "#fef2f2" : "#f0fdf4";
          const props = r.properties || {};
          const propPreview = Object.keys(props).slice(0, 5).map(function (k) {
            return k + "=" + String(props[k]).slice(0, 48);
          }).join(", ");
          html += '<div style="font-size:13px;margin:6px 0;padding:8px 10px;border-radius:6px;background:' + bg + ';color:' + color + ';">';
          if (bad) {
            html += "✗ Cannot add: <strong>" + (r.component || "") + "</strong> on <code>" + (r.page_path || "") + "</code>";
          } else {
            html += "✓ Will <strong>ADD new instance</strong>: <strong>" + (r.component || "") + "</strong> → <code>" + (r.page_path || "") + "</code>";
          }
          if (r.page_status) {
            html += ' <span style="color:#64748b;font-size:12px;">[page: ' + r.page_status + "]</span>";
          }
          if (propPreview) {
            html += '<div style="font-size:11px;color:#475569;margin-top:4px;">Fields: ' + propPreview + "</div>";
          }
          if (bad) html += '<div style="font-size:12px;margin-top:4px;">' + r.errors.join("; ") + "</div>";
          if (r.warnings && r.warnings.length) {
            html += '<div style="font-size:12px;color:#c2410c;margin-top:4px;">' + r.warnings.join("; ") + "</div>";
          }
          html += "</div>";
        });



        // Updates
        const updates = data.updates || {};
        const summary = updates.summary || {};
        const seoN = summary.total_seo_rows != null ? summary.total_seo_rows : ((updates.seo_updates || []).length || 0);
        const compN = summary.total_component_rows != null ? summary.total_component_rows : ((updates.component_updates || []).length || 0);
        html += "<h4>4. SEO / Component Updates</h4>";
        html += "<p style=\"font-size:12px;color:#475569;\">Sheets <em>without</em> the word Add (e.g. Title, button) = update existing components by Instance. SEO sheet = page properties.</p>";
        html += "<p>SEO rows: " + seoN + ", Component update rows: " + compN + "</p>";
        if (!seoN && !compN) {
          html += '<p style="font-size:12px;color:#64748b;">No Update / SEO sheets in this Excel.</p>';
        }
        (updates.seo_updates || []).forEach((u) => {
          const bad = u.errors && u.errors.length;
          const pending = !bad && u.page_status === "will_create_in_batch";
          const props = u.properties || {};
          const propPreview = Object.keys(props).slice(0, 5).map(function (k) {
            return k + "=" + String(props[k]).slice(0, 40);
          }).join(", ");
          const bg = bad ? "#fef2f2" : "#eff6ff";
          const color = bad ? "#b91c1c" : "#1d4ed8";
          html += '<div style="font-size:13px;margin:6px 0;padding:8px 10px;border-radius:6px;background:' + bg + ';color:' + color + ';">';
          if (bad) {
            html += "✗ SEO blocked: <code>" + (u.page_path || "") + "</code>";
          } else if (pending) {
            html += "✓ Will <strong>UPDATE SEO / page properties</strong> after page is created: <code>" + (u.page_path || "") + "</code>";
          } else {
            html += "✓ Will <strong>UPDATE SEO / page properties</strong>: <code>" + (u.page_path || "") + "</code>";
          }
          if (u.page_status) html += ' <span style="color:#64748b;font-size:12px;">[page: ' + u.page_status + "]</span>";
          if (propPreview) html += '<div style="font-size:11px;color:#475569;margin-top:4px;">Fields: ' + propPreview + "</div>";
          if (bad) html += '<div style="font-size:12px;">' + u.errors.join("; ") + "</div>";
          if (u.warnings && u.warnings.length) html += '<div style="font-size:12px;color:#c2410c;">' + u.warnings.join("; ") + "</div>";
          html += "</div>";
        });
        (updates.component_updates || []).forEach((u) => {
          const bad = u.errors && u.errors.length;
          const props = u.properties || {};
          const propPreview = Object.keys(props).slice(0, 5).map(function (k) {
            return k + "=" + String(props[k]).slice(0, 40);
          }).join(", ");
          const name = u.component_name || u.resourceType || "component";
          html += '<div style="font-size:13px;margin:6px 0;padding:8px 10px;border-radius:6px;background:' + (bad ? "#fef2f2" : "#eff6ff") + ';color:' + (bad ? "#b91c1c" : "#1d4ed8") + ';">';
          html += (bad ? "✗ " : "✓ Will <strong>UPDATE</strong>: ") + "<strong>" + name + "</strong> instance " + (u.instance || 1) + " on <code>" + (u.page_path || "") + "</code>";
          if (propPreview) html += '<div style="font-size:11px;color:#475569;margin-top:4px;">Fields: ' + propPreview + "</div>";
          if (bad) html += '<div style="font-size:12px;">' + u.errors.join("; ") + "</div>";
          html += "</div>";
        });

        previewEl.innerHTML = html;
        previewEl.style.display = "block";
        if (applyBtn) applyBtn.style.display = "inline-block";
    } catch (e) {
        messageEl.textContent = e.message || String(e);
        messageEl.className = "message error";
        console.error(e);
    }
}


async function applyExcel() {
    const messageEl = document.getElementById("excel-message");
    const previewEl = document.getElementById("excel-preview");
    if (!lastExcelFile) {
        messageEl.textContent = "Please preview an Excel file first";
        messageEl.className = "message error";
        return;
    }
    if (!confirm("Run FULL bulk apply?\n1) Assets  2) Pages  3) Add components  4) SEO/Update")) return;

    messageEl.textContent = "Running full bulk apply...";
    messageEl.className = "message";

    const steps = [
        { id: "assets", label: "1. Assets upload", endpoint: "/api/excel/assets/apply" },
        { id: "pages", label: "2. Page creation", endpoint: "/api/excel/pages/apply" },
        { id: "add", label: "3. Component add", endpoint: "/api/excel/components-add/apply" },
        { id: "update", label: "4. SEO / component update", endpoint: "/api/excel/apply" },
        { id: "validate", label: "5. Validation report", endpoint: "/api/excel/bulk/validate" },
    ];

    function renderProgress(state) {
        let html = '<h3 style="margin-bottom:14px;">Bulk Apply Progress</h3>';
        html += '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">';
        steps.forEach((s) => {
            const st = state[s.id] || { status: "pending" };
            let color = "#94a3b8", bg = "#f8fafc", icon = "○", border = "#e2e8f0";
            if (st.status === "running") { color = "#2563eb"; bg = "#eff6ff"; icon = "…"; border = "#93c5fd"; }
            if (st.status === "success") { color = "#15803d"; bg = "#f0fdf4"; icon = "✓"; border = "#86efac"; }
            if (st.status === "partial") { color = "#c2410c"; bg = "#fff7ed"; icon = "!"; border = "#fdba74"; }
            if (st.status === "error") { color = "#b91c1c"; bg = "#fef2f2"; icon = "✗"; border = "#fca5a5"; }
            if (st.status === "skipped") { color = "#64748b"; bg = "#f1f5f9"; icon = "–"; border = "#cbd5e1"; }
            html += '<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:8px;border:1px solid ' + border + ';background:' + bg + ';">';
            html += '<div style="width:28px;height:28px;border-radius:50%;background:' + color + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">' + icon + '</div>';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-weight:600;color:#0f172a;">' + s.label + '</div>';
            html += '<div style="font-size:12px;color:' + color + ';margin-top:2px;">' + (st.message || st.status) + '</div>';
            if (st.detail) {
                html += '<pre style="margin:8px 0 0;font-size:11px;max-height:120px;overflow:auto;background:rgba(255,255,255,0.7);padding:8px;border-radius:6px;">' + escapeDict(typeof st.detail === "string" ? st.detail : JSON.stringify(st.detail, null, 2)) + '</pre>';
            }
            html += '</div></div>';
        });
        html += '</div>';
        if (state.summaryHtml) html += state.summaryHtml;
        previewEl.innerHTML = html;
        previewEl.style.display = "block";
    }

    const state = {};
    steps.forEach((s) => { state[s.id] = { status: "pending", message: "Waiting..." }; });
    renderProgress(state);

    async function runStep(step) {
        state[step.id] = { status: "running", message: "In progress..." };
        renderProgress(state);
        if (!lastExcelFile) {
            const data = { status: "error", message: "No Excel file in session" };
            state[step.id] = { status: "error", message: data.message, detail: data };
            renderProgress(state);
            return data;
        }
        const formData = new FormData();
        formData.append("file", lastExcelFile);
        // Validation can take longer on large batches — hard timeout so UI never sticks on "In progress"
        const timeoutMs = step.id === "validate" ? 180000 : 120000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let data = {};
        let response;
        try {
            response = await fetch(API_BASE + step.endpoint, {
                method: "POST",
                headers: bulkSessionHeaders(),
                body: formData,
                signal: controller.signal,
            });
            try { data = await response.json(); } catch (_) { data = { status: "error", message: "Invalid JSON from server" }; }
        } catch (e) {
            const msg = (e && e.name === "AbortError")
                ? ("Timed out after " + (timeoutMs / 1000) + "s — try a smaller batch or check AEM is running")
                : (e.message || String(e));
            data = { status: "error", message: msg };
            state[step.id] = { status: "error", message: msg, detail: data };
            renderProgress(state);
            clearTimeout(timer);
            return data;
        }
        clearTimeout(timer);
        // Empty Assets/Pages sheets in existing-page Excel = intentional skip (not failure)
        if (data.status === "skipped") {
            state[step.id] = {
                status: "skipped",
                message: data.message || "Skipped — not in this Excel",
                detail: data,
            };
            renderProgress(state);
            return data;
        }
        if (!response.ok || data.status === "error") {
            state[step.id] = {
                status: "error",
                message: data.message || data.detail || "Failed",
                detail: data,
            };
            renderProgress(state);
            return data;
        }
        let st = "success";
        if (data.status === "partial") st = "partial";
        if (data.status === "error" || data.status === "failed") st = "error";
        if (data.status === "skipped") st = "skipped";
        if (data.status === "passed" || data.status === "success") st = (st === "error" ? "error" : "success");
        if (data.status === "passed") st = "success";
        // Assets: any row errors → not full success
        if (step.id === "assets" && data.results) {
            const bad = (data.results || []).filter((r) => r.status === "error" || (r.errors && r.errors.length) || (r.upload && r.upload.status === "error"));
            if (bad.length) st = bad.length === data.results.length ? "error" : "partial";
        }
        if (step.id === "validate") {
            if (data.status === "failed" || (data.summary && data.summary.fail > 0)) st = "error";
            else if (data.summary && data.summary.warn > 0) st = "partial";
        }
        state[step.id] = {
            status: st,
            message: data.message || (st === "success" ? "Completed" : "Completed with issues"),
            detail: data,
        };
        renderProgress(state);
        return data;
    }

    try {
        const assetsRes = await runStep(steps[0]);
        const pagesRes = await runStep(steps[1]);
        const addRes = await runStep(steps[2]);
        const updateRes = await runStep(steps[3]);
        // Step 5 — always run validation (even if earlier steps partial)
        const validateRes = await runStep(steps[4]);

        // Summary (only after validation)
        let ok = 0, partial = 0, err = 0;
        steps.forEach((s) => {
            const st = state[s.id].status;
            if (st === "success") ok++;
            else if (st === "partial") partial++;
            else if (st === "error") err++;
        });
        const val = (state.validate && state.validate.detail) || {};
        const hl = val.high_level || {};
        let summaryColor = err === 0 && partial === 0 && val.status !== "failed" ? "#15803d" : (ok > 0 ? "#c2410c" : "#b91c1c");
        window.__lastValidationReport = val;

        function tickRow(label, block) {
          if (!block) {
            return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="color:#94a3b8;">○</span> ' + label + ' <span style="color:#94a3b8;font-size:12px;">n/a</span></div>';
          }
          const fail = block.fail || 0;
          const pass = block.pass || 0;
          const warn = block.warn || 0;
          let icon = "✓", color = "#15803d", note = "OK";
          if (fail > 0 && pass === 0) { icon = "✗"; color = "#b91c1c"; note = fail + " failed"; }
          else if (fail > 0) { icon = "!"; color = "#c2410c"; note = pass + " ok, " + fail + " failed"; }
          else if (warn > 0) { icon = "!"; color = "#c2410c"; note = "OK with " + warn + " warning(s)"; }
          else { note = pass + " check(s) passed"; }
          return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="color:' + color + ';font-weight:700;font-size:16px;">' + icon + '</span> <span style="font-weight:500;">' + label + '</span> <span style="color:' + color + ';font-size:12px;">' + note + '</span></div>';
        }

        state.summaryHtml =
          '<style>.val-report-btn{padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#0f172a;transition:background .15s,border-color .15s,color .15s;}.val-report-btn:hover{background:#eff6ff;border-color:#3b82f6;color:#1d4ed8;}.val-report-btn-primary{background:#1e3a5f;border-color:#1e3a5f;color:#fff;}.val-report-btn-primary:hover{background:#2563eb;border-color:#2563eb;color:#fff;}</style>' +
          '<div style="padding:14px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;">' +
          '<div style="font-weight:700;color:' + summaryColor + ';margin-bottom:8px;">High-level validation</div>' +
          '<div style="font-size:13px;line-height:1.5;">' +
          '<div style="margin-bottom:6px;color:#64748b;">Pipeline — OK: ' + ok + ' · Partial: ' + partial + ' · Failed: ' + err + '</div>' +
          tickRow("Asset paths validated", hl.assets) +
          tickRow("Pages created / present", hl.pages) +
          tickRow("Components added", hl.components) +
          tickRow("Component field data matched", hl.components) +
          tickRow("SEO / page properties updated", hl.seo) +
          (val.message ? '<div style="margin-top:8px;font-size:12px;color:#475569;">' + val.message + '</div>' : '') +
          '</div>' +
          '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button type="button" class="val-report-btn val-report-btn-primary" onclick="showDetailedValidationReport()">View detailed report</button>' +
          '<button type="button" class="val-report-btn" onclick="downloadValidationReportExcel()">Download Excel report</button>' +
          '<button type="button" class="val-report-btn" onclick="downloadValidationReport()">Download JSON report</button>' +
          '</div></div>';
        renderProgress(state);
        messageEl.textContent = err === 0 ? "Bulk apply finished" : "Bulk apply finished with errors — see steps below";
        messageEl.className = err === 0 ? "message success" : "message error";
        // Save session snapshot for next delta preview
        try {
          const fd = new FormData();
          fd.append("file", lastExcelFile);
          await fetch(API_BASE + "/api/excel/bulk/session/mark-applied", {
            method: "POST",
            headers: bulkSessionHeaders(),
            body: fd,
          });
        } catch (_) {}
    } catch (e) {
        messageEl.textContent = e.message || String(e);
        messageEl.className = "message error";
        console.error(e);
    }
}


async function openDictionaryModal() {
  if (!accessToken) {
    alert("Please login first");
    return;
  }
  showModalShell("Field Dictionary", "<p>Loading...</p>", "");
  try {
    const res = await fetch(`${API_BASE}/api/dictionary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok || data.status !== "success") {
      throw new Error(data.message || data.detail || "Failed to load dictionary");
    }
    renderDictionaryUI(data.components || []);
  } catch (e) {
    document.getElementById("modal-body").innerHTML = `<p class="message error">${e.message}</p>`;
  }
}

function renderDictionaryUI(components) {
  let html = `
    <div style="margin:0 0 14px;padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;color:#1e3a5f;line-height:1.5;">
      <strong>How to add CA labels</strong><br>
      • <strong>Left column is locked</strong> — dialog field names come from AEM (do not change them).<br>
      • <strong>Right column</strong> — type names CA uses in Excel, separated by commas.<br>
      &nbsp;&nbsp;Example: <code>Title, Meta Title, Heading</code><br>
      • First name is the default Excel column header. Matching is case-insensitive.<br>
      • Click <strong>Save</strong> on each row you change. Saved labels are used for template generation.
    </div>
    <div style="margin-bottom:10px;">
      <input id="dict-filter" type="text" placeholder="Filter component or field..."
        style="width:100%;padding:8px 10px;border:1px solid #d0d5dd;border-radius:6px;"
        oninput="filterDictionaryRows(this.value)">
    </div>`;

  if (!components.length) {
    html += `<p>No components in dictionary yet. Load components on a page in the tool — then use Sync, or add manually after catalog save.</p>`;
  }

  components.forEach((comp, ci) => {
    html += `
      <div class="dict-comp" data-comp-idx="${ci}" style="margin-bottom:18px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <div style="background:#f8fafc;padding:10px 12px;font-weight:600;font-size:13px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <span>${escapeDict(comp.label || comp.resourceType)}</span>
          <span style="font-weight:400;color:#64748b;font-size:12px;">${escapeDict(comp.resourceType)}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#f1f5f9;text-align:left;">
              <th style="padding:8px 10px;width:28%;">Dialog field (locked)</th>
              <th style="padding:8px 10px;">CA labels — add usable names with commas</th>
              <th style="padding:8px 10px;width:90px;"></th>
            </tr>
          </thead>
          <tbody>`;
    (comp.fields || []).forEach((f, fi) => {
      const labels = (f.ca_labels || []).join(", ");
      html += `
            <tr class="dict-row" data-search="${escapeDict((comp.label + " " + comp.resourceType + " " + f.field_name + " " + labels).toLowerCase())}">
              <td style="padding:8px 10px;border-top:1px solid #e2e8f0;vertical-align:middle;font-family:ui-monospace,monospace;font-size:12px;">${escapeDict(f.field_name)}</td>
              <td style="padding:8px 10px;border-top:1px solid #e2e8f0;">
                <input type="text" class="dict-aliases"
                  data-rt="${escapeDict(comp.resourceType)}"
                  data-fn="${escapeDict(f.field_name)}"
                  value="${escapeDict(labels)}"
                  style="width:100%;padding:7px 9px;border:1px solid #d0d5dd;border-radius:6px;">
              </td>
              <td style="padding:8px 10px;border-top:1px solid #e2e8f0;">
                <button type="button" onclick="saveDictionaryRow(this)"
                  style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;">Save</button>
              </td>
            </tr>`;
    });
    html += `</tbody></table></div>`;
  });

  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("modal-footer").innerHTML = `
    <button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">Close</button>
  `;
}

function escapeDict(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function filterDictionaryRows(q) {
  const query = (q || "").toLowerCase().trim();
  document.querySelectorAll(".dict-row").forEach((row) => {
    const hay = row.getAttribute("data-search") || "";
    row.style.display = !query || hay.includes(query) ? "" : "none";
  });
}

async function saveDictionaryRow(btn) {
  const input = btn.closest("tr").querySelector(".dict-aliases");
  const rt = input.getAttribute("data-rt");
  const fn = input.getAttribute("data-fn");
  const ca_labels = input.value.split(",").map((x) => x.trim()).filter(Boolean);
  btn.textContent = "Saving...";
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/dictionary/field`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resourceType: rt, field_name: fn, ca_labels }),
    });
    const data = await res.json();
    if (!res.ok || data.status !== "success") {
      throw new Error(data.message || data.detail || "Save failed");
    }
    btn.textContent = "Saved";
    setTimeout(() => {
      btn.textContent = "Save";
      btn.disabled = false;
    }, 800);
  } catch (e) {
    alert(e.message);
    btn.textContent = "Save";
    btn.disabled = false;
  }
}

// ----- Template generator -----
function fieldNameSet(comp) {
  const names = (comp.fields || []).map((f) => (f.field_name || f.name || "").trim()).filter(Boolean);
  return names.sort().join("|");
}

function isPagePropertiesLike(c) {
  const rt = (c.resourceType || c.resource_type || "").toLowerCase();
  const lab = (c.label || "").toLowerCase();
  if (rt === "page_properties") return true;
  if (lab.includes("page properties") || lab.includes("page properties / seo")) return true;
  if (rt.endsWith("/structure/page") || rt.includes("/structure/page")) return true;
  if (rt === "cq:page" || rt.endsWith("/page") && rt.includes("structure")) return true;
  return false;
}

function isTechnicalFieldName(fn) {
  const n = (fn || "").toLowerCase();
  if (!n) return true;
  if (n.includes("@typehint")) return true;
  if (n.startsWith("cq:lastmodified")) return true;
  if (n === "cq:lastmodifiedby") return true;
  return false;
}

function dedupeTemplateComponents(components) {
  const byRt = {};
  (components || []).forEach((c) => {
    const rt = c.resourceType || c.resource_type;
    if (!rt) return;
    if (!byRt[rt]) byRt[rt] = c;
  });
  let list = Object.values(byRt);

  // Merge ALL page-properties-like entries into one CA-facing item
  const pageMerged = {
    resourceType: "page_properties",
    label: "Page Properties / SEO",
    fields: [],
  };
  const fieldMap = {};
  list.forEach((c) => {
    if (!isPagePropertiesLike(c)) return;
    (c.fields || []).forEach((f) => {
      const fn = f.field_name || f.name;
      if (!fn || isTechnicalFieldName(fn)) return;
      if (!fieldMap[fn]) {
        fieldMap[fn] = {
          field_name: fn,
          ca_labels: f.ca_labels && f.ca_labels.length ? f.ca_labels : [f.preferred || fn],
        };
      }
    });
  });
  // Prefer dictionary order-friendly labels for common SEO fields
  pageMerged.fields = Object.values(fieldMap);

  list = list.filter((c) => !isPagePropertiesLike(c));
  if (pageMerged.fields.length) {
    list.unshift(pageMerged);
  }

  // Same dialog field signature → keep one (prefer non-core)
  const bySignature = {};
  list.forEach((c) => {
    if (c.resourceType === "page_properties") {
      bySignature["__page_properties__"] = c;
      return;
    }
    const sig = fieldNameSet(c);
    if (!sig) {
      bySignature[c.resourceType] = c;
      return;
    }
    if (!bySignature[sig]) {
      bySignature[sig] = c;
      return;
    }
    const existing = bySignature[sig];
    const existingIsCore = (existing.resourceType || "").startsWith("core/");
    const currentIsCore = (c.resourceType || "").startsWith("core/");
    if (existingIsCore && !currentIsCore) bySignature[sig] = c;
  });

  const out = Object.values(bySignature);
  out.sort((a, b) => {
    const ap = a.resourceType === "page_properties" ? 0 : 1;
    const bp = b.resourceType === "page_properties" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return String(a.label || a.resourceType).localeCompare(String(b.label || b.resourceType));
  });
  return out;
}

async function openTemplateModal() {
  if (!accessToken) {
    alert("Please login first");
    return;
  }
  showModalShell("Create Excel Template", "<p>Loading components...</p>", "");
  try {
    let components = await loadTemplateComponentPool();
    renderTemplateUI(components);
  } catch (e) {
    document.getElementById("modal-body").innerHTML = `<p class="message error">${e.message}</p>`;
  }
}

/** Dictionary + catalog + optional prior discover cache */
async function loadTemplateComponentPool() {
  const res = await fetch(`${API_BASE}/api/dictionary`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    throw new Error(data.message || data.detail || "Failed to load components");
  }
  let components = data.components || [];

  try {
    const catRes = await fetch(`${API_BASE}/api/catalog/list`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (catRes.ok) {
      const cat = await catRes.json();
      const map = {};
      components.forEach((c) => { map[c.resourceType] = c; });
      const raw = cat.components || {};
      const list = Array.isArray(raw) ? raw : Object.keys(raw).map((rt) => {
        const entry = raw[rt] || {};
        const versions = entry.versions || [];
        const fields = (versions[0] && versions[0].fields) || entry.fields || [];
        return {
          resourceType: rt,
          label: entry.label || rt.split("/").pop(),
          fields: (Array.isArray(fields) ? fields : []).map((f) =>
            typeof f === "string"
              ? { field_name: f, ca_labels: [f] }
              : { field_name: f.name || f.field_name, ca_labels: [f.label || f.name || f.field_name] }
          ),
        };
      });
      list.forEach((c) => {
        if (!c.resourceType) return;
        if (!map[c.resourceType]) map[c.resourceType] = c;
      });
      components = Object.values(map);
    }
  } catch (_) { /* catalog optional */ }

  return dedupeTemplateComponents(components);
}

/**
 * Load ALL allowed / project components from AEM (not only previously used ones),
 * sync dialog field labels into dictionary, refresh template UI.
 */
async function discoverComponentsForTemplate() {
  if (!accessToken) {
    alert("Please login first");
    return;
  }
  const pathEl = document.getElementById("tpl-discover-page");
  const pagePath = ((pathEl && pathEl.value) || "").trim();
  const statusEl = document.getElementById("tpl-discover-status");
  if (statusEl) {
    statusEl.textContent = "Discovering components from AEM (policy + /apps scan) and syncing dictionary…";
    statusEl.style.color = "#2563eb";
  }
  try {
    const q = new URLSearchParams();
    if (pagePath) q.set("page_path", pagePath);
    q.set("sync_dictionary", "true");
    q.set("include_apps_scan", "true");
    const res = await fetch(`${API_BASE}/api/components/discover?` + q.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Discover failed");
    }
    // Prefer discovered list (has fields); merge with dictionary pool for page_properties etc.
    let discovered = data.components || [];
    let pool = [];
    try {
      pool = await loadTemplateComponentPool();
    } catch (_) {}
    const map = {};
    pool.forEach((c) => { if (c.resourceType) map[c.resourceType] = c; });
    discovered.forEach((c) => {
      if (!c.resourceType) return;
      // Discovered wins for field lists when non-empty
      const prev = map[c.resourceType];
      if (!prev || (c.fields && c.fields.length >= (prev.fields || []).length)) {
        map[c.resourceType] = c;
      }
    });
    const components = dedupeTemplateComponents(Object.values(map));
    renderTemplateUI(components);
    if (statusEl) {
      statusEl.textContent = data.message || ("Loaded " + components.length + " components. Dictionary updated.");
      statusEl.style.color = "#15803d";
    } else {
      alert(data.message || "Components discovered");
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = e.message || String(e);
      statusEl.style.color = "#b91c1c";
    } else {
      alert(e.message || String(e));
    }
  }
}
window.discoverComponentsForTemplate = discoverComponentsForTemplate;

function onNestedChildChange(parentCi) {
  const any = document.querySelectorAll('.tpl-nested-child[data-parent-ci="' + parentCi + '"]:checked').length > 0;
  const addEl = document.querySelector('.tpl-comp-add[data-ci="' + parentCi + '"]');
  const compCheck = document.querySelector('.tpl-comp-check[data-ci="' + parentCi + '"]');
  if (any) {
    if (compCheck && !compCheck.checked) {
      compCheck.checked = true;
      if (typeof toggleTplComp === "function") toggleTplComp(parentCi, true);
    }
    if (addEl) addEl.checked = true;
    const mode = document.getElementById("tpl-mode-opts-" + parentCi);
    if (mode) mode.style.display = "inline-flex";
  }
}
window.onNestedChildChange = onNestedChildChange;

/** When a page template is chosen, only show components allowed for that structure (via reference page). */
async function filterTplComponentsByTemplate() {
  const sel = document.getElementById("tpl-default-template");
  const ref = document.getElementById("tpl-discover-page");
  const statusEl = document.getElementById("tpl-discover-status");
  const templateName = ((sel && sel.value) || "").trim();
  let all = window.__tplComponentsAll || window.__tplComponents || [];
  if (!window.__tplComponentsAll && window.__tplComponents) {
    window.__tplComponentsAll = window.__tplComponents.slice();
    all = window.__tplComponentsAll;
  }
  if (!templateName) {
    // No template selected → show all discovered/dictionary components
    renderTemplateUI(all);
    if (statusEl) {
      statusEl.textContent = "No template filter — showing all components.";
      statusEl.style.color = "#64748b";
    }
    return;
  }
  const pagePath = ((ref && ref.value) || "").trim();
  if (!pagePath) {
    if (statusEl) {
      statusEl.textContent = "Enter a reference page path (same template/site), then pick the template to filter allowed components.";
      statusEl.style.color = "#b45309";
    }
    return;
  }
  if (!accessToken) return;
  try {
    if (statusEl) {
      statusEl.textContent = "Filtering components allowed for this template/page…";
      statusEl.style.color = "#2563eb";
    }
    const res = await fetch(
      API_BASE + "/api/page/allowed-components?page_path=" + encodeURIComponent(pagePath),
      { headers: { Authorization: "Bearer " + accessToken } }
    );
    const data = await res.json();
    const allowed = data.allowed_resource_types || (data.allowed_for_ca || []).map((x) => x.resourceType);
    const allowedSet = new Set((allowed || []).map((x) => String(x).toLowerCase()));
    const friendly = {};
    (data.allowed_for_ca || []).forEach((x) => {
      if (x.resourceType) friendly[String(x.resourceType).toLowerCase()] = x.name;
    });
    if (!allowedSet.size) {
      // keep all but warn
      renderTemplateUI(all);
      if (statusEl) {
        statusEl.textContent = "No policy list returned — showing all components. Use Discover on a page that uses this template.";
        statusEl.style.color = "#b45309";
      }
      return;
    }
    const filtered = all.filter((c) => {
      const rt = (c.resourceType || "").toLowerCase();
      if (rt === "page_properties") return true;
      if (allowedSet.has(rt)) return true;
      // leaf match
      const leaf = rt.split("/").pop();
      for (const a of allowedSet) {
        if (a.endsWith("/" + leaf) || a.split("/").pop() === leaf) return true;
      }
      return false;
    });
    renderTemplateUI(filtered.length ? filtered : all);
    if (statusEl) {
      statusEl.textContent = filtered.length
        ? ("Showing " + filtered.length + " component(s) allowed for this page/template (of " + all.length + ").")
        : "Filter matched none — showing all.";
      statusEl.style.color = "#15803d";
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = e.message || String(e);
      statusEl.style.color = "#b91c1c";
    }
  }
}
window.filterTplComponentsByTemplate = filterTplComponentsByTemplate;



function renderTemplateUI(components) {
  let html = `
    <p style="margin:0 0 12px;font-size:13px;color:#64748b;">
      Choose bulk sheets and components. <strong>Add</strong> sheets create new components on a page;
      sheets without "Add" are for <strong>updating</strong> components already on the page.
      Use the <strong>Instance</strong> column in update sheets when the same component appears multiple times.
    </p>
    <div style="margin:0 0 14px;padding:12px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;">
      <div style="font-weight:600;font-size:13px;color:#1e3a5f;margin-bottom:6px;">Load all project components from AEM</div>
      <p style="margin:0 0 8px;font-size:12px;color:#475569;line-height:1.4;">
        The list below starts from components already in the dictionary/catalog (pages you opened before).
        To load <strong>all</strong> components allowed for the project/template (not only ones already used),
        enter a reference page path (same template/site) and click Discover. Field labels are synced into the dictionary automatically.
      </p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <input id="tpl-discover-page" type="text" placeholder="Reference page e.g. /content/we-retail/us/en/men"
          style="flex:1;min-width:220px;padding:8px 10px;border:1px solid #93c5fd;border-radius:6px;font-size:13px;" />
        <button type="button" onclick="discoverComponentsForTemplate()"
          style="padding:8px 14px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
          Discover from AEM + sync dictionary
        </button>
      </div>
      <p id="tpl-discover-status" style="margin:8px 0 0;font-size:12px;color:#64748b;"></p>
    </div>
    <div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#0f172a;">Include in Excel</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" id="tpl-include-assets" checked /> Assets sheet (Source Path → Target DAM path)
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" id="tpl-include-pages" checked onchange="onTplIncludePagesChange()" /> Pages sheet (create pages)
      </label>
      <div id="tpl-pages-options" style="margin:4px 0 8px 24px;">
        <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px;">Default template name for Pages sheet</label>
        <select id="tpl-default-template" onchange="filterTplComponentsByTemplate()" style="width:100%;max-width:360px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
          <option value="">All components (no template filter)</option>
        </select>
        <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">CA can still change Create (Y/N) and Template Name in Excel later. Pick a template + reference page to list only allowed components; leave empty for all.</p>
      </div>
      <p id="tpl-mode-hint" style="margin:8px 0 0;font-size:12px;color:#334155;line-height:1.45;">
        <strong>Per component:</strong> After you tick a component on the left, choose <em>Add</em> and/or <em>Update</em> for that component only.
        New pages → Add defaults on. Existing pages → Update defaults on. Page Properties / SEO still come from the list below.
      </p>
      <p style="margin:6px 0 0;font-size:12px;color:#64748b;">
        Page Properties / SEO comes only from the selection under <strong>Components &amp; fields</strong> below.
      </p>
    </div>
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#0f172a;">Components & fields</div>`;

  if (!components.length) {
    html += `<p>No components yet. Use <strong>Discover from AEM + sync dictionary</strong> above (recommended), or open a page in the tool first.</p>`;
  }

  components.forEach((comp, ci) => {
    const isPageProps = (comp.resourceType || "") === "page_properties";
    html += `
      <div class="tpl-comp" style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f8fafc;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:180px;">
            <input type="checkbox" class="tpl-comp-check" data-ci="${ci}" onchange="toggleTplComp(${ci}, this.checked)">
            <strong style="font-size:13px;">${escapeDict(comp.label || comp.resourceType)}</strong>
            <span style="font-size:11px;color:#64748b;">${escapeDict(comp.resourceType)}</span>
          </label>
          <span id="tpl-mode-opts-${ci}" style="display:none;align-items:center;gap:12px;font-size:12px;">
            ${isPageProps ? "" : `
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" class="tpl-comp-add" data-ci="${ci}"> Add
            </label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;" class="tpl-comp-upd-label">
              <input type="checkbox" class="tpl-comp-update" data-ci="${ci}"> Update
            </label>`}
          </span>
        </div>
        <div id="tpl-fields-${ci}" style="display:none;padding:8px 12px 12px;border-top:1px solid #e2e8f0;">
          <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:6px;margin-bottom:8px;">
            <input type="checkbox" class="tpl-select-all" data-ci="${ci}" onchange="toggleAllTplFields(${ci}, this.checked)" checked>
            Select all fields
          </label>
          <div style="display:flex;flex-wrap:wrap;gap:8px 14px;">`;
    (comp.fields || []).forEach((f) => {
      const fn = f.field_name;
      const lab = (f.ca_labels && f.ca_labels[0]) || fn;
      html += `
            <label style="font-size:12px;display:flex;align-items:center;gap:6px;min-width:180px;">
              <input type="checkbox" class="tpl-field-check" data-ci="${ci}" data-fn="${escapeDict(fn)}" checked
                onchange="syncSelectAllCheckbox(${ci})">
              <span title="${escapeDict(fn)}">${escapeDict(lab)}</span>
            </label>`;
    });
    html += `</div>`;
    // Dynamic "Add under {Parent}" — one checkbox per container parent (Tabs, Accordion, custom…)
    // Disabled until that parent component is selected in the list
    const parents = [];
    components.forEach((p, pi) => {
      if (pi === ci) return;
      const isParent = !!(p.supportsChildren
        || (p.resourceType || "").toLowerCase().match(/tabs|accordion|carousel/)
        || (p.fields || []).some((f) => {
          const n = (f.field_name || f || "").toString().toLowerCase();
          return n === "items" || n === "activeitem";
        }));
      if (isParent) {
        parents.push({ pi, label: p.label || p.resourceType || "Parent", rt: p.resourceType || "" });
      }
    });
    if (parents.length && (comp.resourceType || "") !== "page_properties") {
      html += `<div class="tpl-under-parents" data-ci="${ci}" style="margin-top:10px;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
        <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:6px;">Place under parent container (optional)</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px 14px;">`;
      parents.forEach((p) => {
        html += `
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;">
            <input type="checkbox" class="tpl-add-under" data-child-ci="${ci}" data-parent-ci="${p.pi}"
              data-parent-label="${escapeDict(p.label)}" data-parent-rt="${escapeDict(p.rt)}"
              disabled onchange="onAddUnderChange()">
            <span style="color:#94a3b8;" class="tpl-add-under-label" data-parent-ci="${p.pi}">Add under ${escapeDict(p.label)}</span>
          </label>`;
      });
      html += `</div>
        <p style="margin:6px 0 0;font-size:10px;color:#94a3b8;">Enabled only when that parent is selected above. Excel gets sheet: ParentName_ChildName with this component’s fields.</p>
      </div>`;
    }
    html += `</div></div>`;
  });

  if (!window.__tplComponentsAll || window.__tplComponentsAll.length < components.length) {
    window.__tplComponentsAll = components.slice();
  }
  window.__tplComponents = components;

  document.getElementById("modal-body").innerHTML = html;
  loadTplTemplates();
  onTplIncludePagesChange();
  syncAddUnderEnabled();
  document.getElementById("modal-footer").innerHTML = `
    <button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">Cancel</button>
    <button type="button" onclick="previewExcelTemplate()" style="padding:8px 14px;border:1px solid #2563eb;border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-weight:500;">Preview</button>
    <button type="button" onclick="generateExcelTemplate()" style="padding:8px 16px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-weight:500;">Create Template</button>
  `;
}


/** Enable "Add under {Parent}" only when that parent component checkbox is checked */
function syncAddUnderEnabled() {
  document.querySelectorAll(".tpl-add-under").forEach((box) => {
    const parentCi = box.getAttribute("data-parent-ci");
    const parentCheck = document.querySelector('.tpl-comp-check[data-ci="' + parentCi + '"]');
    const on = !!(parentCheck && parentCheck.checked);
    box.disabled = !on;
    if (!on) box.checked = false;
    const lab = box.parentElement && box.parentElement.querySelector(".tpl-add-under-label");
    if (lab) lab.style.color = on ? "#0f172a" : "#94a3b8";
  });
}
function onAddUnderChange() {
  // If CA ticks "Add under Parent", ensure child component is selected + Add mode + fields visible
  document.querySelectorAll(".tpl-add-under:checked").forEach((box) => {
    const childCi = box.getAttribute("data-child-ci");
    const cb = document.querySelector('.tpl-comp-check[data-ci="' + childCi + '"]');
    if (cb && !cb.checked) {
      cb.checked = true;
      if (typeof toggleTplComp === "function") toggleTplComp(parseInt(childCi, 10), true);
    }
    const addEl = document.querySelector('.tpl-comp-add[data-ci="' + childCi + '"]');
    // Child under parent is nested add — parent Add is enough; child sheet is Parent_Child
    if (addEl) addEl.checked = false; // not top-level Add; nested sheet instead
    const mode = document.getElementById("tpl-mode-opts-" + childCi);
    if (mode) mode.style.display = "inline-flex";
  });
}
window.syncAddUnderEnabled = syncAddUnderEnabled;
window.onAddUnderChange = onAddUnderChange;

function collectTemplateSelections() {
  const components = window.__tplComponents || [];
  const selections = [];
  const newPage = isTplNewPageMode();

  // Map parentCi -> list of children with their selected fields (from "Add under Parent" checkboxes)
  const underMap = {};
  document.querySelectorAll(".tpl-add-under:checked").forEach((box) => {
    if (box.disabled) return;
    const parentCi = parseInt(box.getAttribute("data-parent-ci"), 10);
    const childCi = parseInt(box.getAttribute("data-child-ci"), 10);
    const child = components[childCi];
    if (!child) return;
    const childFields = [];
    document.querySelectorAll('.tpl-field-check[data-ci="' + childCi + '"]:checked').forEach((f) => {
      childFields.push(f.getAttribute("data-fn"));
    });
    // If no fields ticked yet, take all fields of child
    if (!childFields.length) {
      (child.fields || []).forEach((f) => {
        const fn = f.field_name || f;
        if (fn) childFields.push(fn);
      });
    }
    underMap[parentCi] = underMap[parentCi] || [];
    underMap[parentCi].push({
      resourceType: child.resourceType || box.getAttribute("data-rt") || "",
      label: child.label || child.resourceType || "Child",
      fields: childFields,
    });
  });

  document.querySelectorAll(".tpl-comp-check:checked").forEach((cb) => {
    const ci = parseInt(cb.getAttribute("data-ci"), 10);
    const comp = components[ci];
    if (!comp) return;
    const fields = [];
    document.querySelectorAll('.tpl-field-check[data-ci="' + ci + '"]:checked').forEach((f) => {
      fields.push(f.getAttribute("data-fn"));
    });
    const nested = underMap[ci] || [];
    // Skip pure children that are only "under parent" (not top-level add/update)
    const isOnlyUnder = document.querySelectorAll('.tpl-add-under[data-child-ci="' + ci + '"]:checked:not(:disabled)').length > 0;
    const addEl = document.querySelector('.tpl-comp-add[data-ci="' + ci + '"]');
    const updEl = document.querySelector('.tpl-comp-update[data-ci="' + ci + '"]');
    let include_add = !!(addEl && addEl.checked);
    let include_update = !!(updEl && updEl.checked);
    if (isOnlyUnder && !include_add && !include_update && !nested.length) {
      // Child only appears on Parent_Child sheets via parent's nested list — skip top-level sheet
      return;
    }
    if (!fields.length && !nested.length) return;
    if (!fields.length && nested.length) {
      fields.push("activeItem");
      fields.push("items");
    }
    const isPP = (comp.resourceType || "") === "page_properties";
    if (nested.length) include_add = true;
    if (newPage) {
      include_add = isPP ? false : (include_add || nested.length > 0 || !isOnlyUnder);
      include_update = false;
    }
    if (isPP) {
      include_add = false;
      include_update = false;
    }
    selections.push({
      resourceType: comp.resourceType,
      label: comp.label || comp.resourceType,
      fields,
      include_add: include_add,
      include_update: include_update,
      nested_children: nested,
      supportsChildren: nested.length > 0 || !!(comp.supportsChildren),
    });
  });
  return selections;
}

function preferredLabelForField(comp, fieldName) {
  const f = (comp.fields || []).find((x) => x.field_name === fieldName);
  if (f && f.ca_labels && f.ca_labels.length) return f.ca_labels[0];
  if (f && f.preferred) return f.preferred;
  return fieldName;
}

async function previewExcelTemplate() {
  const selections = collectTemplateSelections();
  if (!selections.length) {
    alert("Select at least one component with fields, and tick Add and/or Update on that component.");
    return;
  }
  if (!accessToken) {
    alert("Please log in first.");
    return;
  }

  const include_assets = !!(document.getElementById("tpl-include-assets") || {}).checked;
  const include_pages = !!(document.getElementById("tpl-include-pages") || {}).checked;
  const include_components_add = selections.some((s) => s.include_add);
  const include_components_update = !include_pages && selections.some((s) => s.include_update);
  const include_seo = selections.some((s) => s.resourceType === "page_properties");
  const default_template_name = ((document.getElementById("tpl-default-template") || {}).value || "Content Page").trim();

  const body = document.getElementById("modal-body");
  let prev = document.getElementById("tpl-preview-box");
  if (!prev) {
    prev = document.createElement("div");
    prev.id = "tpl-preview-box";
    prev.style.cssText = "margin-bottom:14px;padding:12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;";
    body.insertBefore(prev, body.firstChild);
  }
  prev.innerHTML = '<p style="font-size:13px;color:#64748b;">Loading preview from the same engine as Create Template…</p>';

  try {
    const res = await fetch(API_BASE + "/api/excel/preview-template-structure", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
      },
      body: JSON.stringify({
        selections,
        include_seo,
        include_assets,
        include_pages,
        include_components_add,
        include_components_update,
        default_template_name,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Preview failed");
    }
    const sheets = data.sheets || [];
    if (!sheets.length) {
      prev.innerHTML = '<p style="color:#b91c1c;font-size:13px;">No sheets generated. Tick Add and/or Update on selected components.</p>';
      return;
    }

    prev.innerHTML =
      '<div style="font-size:13px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;">' +
      "<strong>Excel preview</strong>" +
      '<span style="font-size:12px;color:#64748b;">Built by the same generator as the download file</span></div>' +
      '<div id="xlsx-preview-tabs" style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:2px solid #e2e8f0;"></div>' +
      '<div id="xlsx-preview-sheets" style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;overflow:auto;max-height:360px;background:#fff;"></div>' +
      '<p style="color:#64748b;font-size:12px;margin:10px 0 0;">Sheet count: ' +
      sheets.length +
      " — Add sheets and Update sheets appear here automatically when selected.</p></div>";

    const tabsEl = prev.querySelector("#xlsx-preview-tabs");
    const sheetsEl = prev.querySelector("#xlsx-preview-sheets");

    sheets.forEach((sh, idx) => {
      const name = sh.name || "Sheet";
      const headers = sh.headers || [];
      const tabBtn = document.createElement("button");
      tabBtn.type = "button";
      tabBtn.textContent = name;
      tabBtn.dataset.sheetIdx = String(idx);
      tabBtn.style.cssText =
        "padding:8px 14px;border:none;cursor:pointer;font-size:12px;font-weight:500;" +
        "background:transparent;color:#64748b;border-bottom:2px solid transparent;margin-bottom:-2px;";
      tabsEl.appendChild(tabBtn);

      const sheet = document.createElement("div");
      sheet.dataset.sheetIdx = String(idx);
      sheet.style.display = idx === 0 ? "block" : "none";

      let table =
        '<table style="border-collapse:collapse;width:max-content;min-width:100%;font-size:12px;"><thead><tr>';
      headers.forEach((h) => {
        table +=
          '<th style="background:#1e3a5f;color:#fff;font-weight:600;text-align:left;padding:8px 12px;border:1px solid #0f2744;white-space:nowrap;">' +
          escapeDict(String(h)) +
          "</th>";
      });
      table += "</tr></thead><tbody>";
      for (let r = 0; r < 4; r++) {
        table += "<tr>";
        headers.forEach(() => {
          table +=
            '<td style="padding:8px 12px;border:1px solid #e2e8f0;min-width:100px;height:30px;background:' +
            (r % 2 === 0 ? "#fff" : "#f8fafc") +
            ';"></td>';
        });
        table += "</tr>";
      }
      table += "</tbody></table>";
      sheet.innerHTML = table;
      sheetsEl.appendChild(sheet);

      tabBtn.onclick = function () {
        tabsEl.querySelectorAll("button").forEach((b) => {
          b.style.color = "#64748b";
          b.style.borderBottomColor = "transparent";
          b.style.fontWeight = "500";
        });
        tabBtn.style.color = "#2563eb";
        tabBtn.style.borderBottomColor = "#2563eb";
        tabBtn.style.fontWeight = "600";
        sheetsEl.querySelectorAll("[data-sheet-idx]").forEach((s) => {
          s.style.display = s.dataset.sheetIdx === String(idx) ? "block" : "none";
        });
      };
      if (idx === 0) {
        tabBtn.style.color = "#2563eb";
        tabBtn.style.borderBottomColor = "#2563eb";
        tabBtn.style.fontWeight = "600";
      }
    });
    prev.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    prev.innerHTML = '<p style="color:#b91c1c;font-size:13px;">' + escapeDict(e.message || String(e)) + "</p>";
  }
}


function toggleTplComp(ci, checked) {
  setTimeout(syncAddUnderEnabled, 0);
  const box = document.getElementById("tpl-fields-" + ci);
  if (box) box.style.display = checked ? "block" : "none";
  const mode = document.getElementById("tpl-mode-opts-" + ci);
  if (mode) mode.style.display = checked ? "inline-flex" : "none";
  if (checked) applyDefaultAddUpdateForComp(ci);
  else {
    const a = document.querySelector('.tpl-comp-add[data-ci="' + ci + '"]');
    const u = document.querySelector('.tpl-comp-update[data-ci="' + ci + '"]');
    if (a) a.checked = false;
    if (u) u.checked = false;
  }
}

function toggleAllTplFields(ci, on) {
  document.querySelectorAll(`.tpl-field-check[data-ci="${ci}"]`).forEach((cb) => {
    cb.checked = on;
  });
  const all = document.querySelector(`.tpl-select-all[data-ci="${ci}"]`);
  if (all) all.checked = on;
}

function syncSelectAllCheckbox(ci) {
  const fields = document.querySelectorAll(`.tpl-field-check[data-ci="${ci}"]`);
  const all = document.querySelector(`.tpl-select-all[data-ci="${ci}"]`);
  if (!all || !fields.length) return;
  const checkedCount = Array.from(fields).filter((cb) => cb.checked).length;
  all.checked = checkedCount === fields.length;
  all.indeterminate = checkedCount > 0 && checkedCount < fields.length;
}

async function generateExcelTemplate() {
  const selections = collectTemplateSelections();
  if (!selections.length) {
    alert("Select at least one component with fields. Use Preview first if you want to review.");
    return;
  }

  const defaultName = "Template " + new Date().toISOString().slice(0, 16).replace("T", " ");
  const name = prompt("Name this template for reuse later:", defaultName);
  if (name === null) return; // cancelled

  try {
    const include_assets = !!(document.getElementById("tpl-include-assets") || {}).checked;
    const include_pages = !!(document.getElementById("tpl-include-pages") || {}).checked;
    // Per-component flags live on selections[]; derive aggregates for API
    const include_components_add = selections.some((s) => s.include_add);
    const include_components_update = !include_pages && selections.some((s) => s.include_update);
    const default_template_name = ((document.getElementById("tpl-default-template") || {}).value || "Content Page").trim();
    // SEO sheet only if page_properties is among selections (with fields)
    const include_seo = selections.some(
      (s) => (s.resourceType || "") === "page_properties" || (s.label || "").toLowerCase().includes("page properties")
    );

    const res = await fetch(`${API_BASE}/api/excel/generate-template`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selections,
        name: name || defaultName,
        include_seo,
        include_assets,
        include_pages,
        include_components_add,
        include_components_update,
        default_template_name,
        template_parent_path: "/content/we-retail/us/en",
        allowed_components_page_path: "/content/we-retail/us/en/men",
      }),
    });
    if (!res.ok) {
      let msg = "Template generation failed";
      try {
        const err = await res.json();
        msg = err.message || err.detail || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const err = await res.json();
      throw new Error(err.message || err.detail || "Template generation failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `AEM_Update_Template.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeModal();
  } catch (e) {
    alert(e.message);
  }
}


function ensureToolbarButtons() {
  // Enterprise toolbar: Dictionary, Create Template, Previous Templates, Catalog sync
  let bar = document.getElementById("aem-tools-toolbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "aem-tools-toolbar";
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;align-items:center;";
    // Prefer near bulk update section
    const bulk =
      document.getElementById("excel-file")?.closest(".card, section, .panel, div") ||
      document.getElementById("excel-message")?.parentElement ||
      document.querySelector("main") ||
      document.body;
    const anchor = document.getElementById("excel-file");
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(bar, anchor);
    } else if (bulk) {
      bulk.insertBefore(bar, bulk.firstChild);
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }
  const buttons = [
    { id: "btn-open-dictionary", label: "Open Dictionary", onClick: "openDictionaryModal()" },
    { id: "btn-create-template", label: "Create Excel Template", onClick: "openTemplateModal()" },
    { id: "btn-load-prev-templates", label: "Previous Excel Templates", onClick: "loadPreviousTemplates()" },
    { id: "btn-clear-bulk-session", label: "Clear bulk session", onClick: "clearBulkSession()" },
    { id: "btn-audit-log", label: "Audit Log", onClick: "openAuditLogModal()" },
  ];
  buttons.forEach((b) => {
    if (document.getElementById(b.id)) return;
    const btn = document.createElement("button");
    btn.id = b.id;
    btn.type = "button";
    btn.textContent = b.label;
    btn.setAttribute("onclick", b.onClick);
    btn.style.cssText = "padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:500;color:#0f172a;";
    btn.onmouseover = function () { this.style.background = "#f1f5f9"; };
    btn.onmouseout = function () { this.style.background = "#fff"; };
    bar.appendChild(btn);
  });
  // catalog message host
  if (!document.getElementById("catalog-message")) {
    const m = document.createElement("div");
    m.id = "catalog-message";
    m.style.cssText = "width:100%;font-size:12px;color:#64748b;margin-top:4px;";
    bar.appendChild(m);
  }
  try { wirePreviousTemplateButtons(); } catch (_) {}
  if (!document.getElementById("catalog-list")) {
    const list = document.createElement("div");
    list.id = "catalog-list";
    list.style.cssText = "width:100%;margin-top:8px;";
    bar.appendChild(list);
  }
}

// Boot extra toolbar when DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureToolbarButtons);
} else {
  ensureToolbarButtons();
}




// ========== PREVIOUSLY USED TEMPLATES ==========

function ensurePreviousTemplatesPanel() {
  // Visible host used by BOTH toolbar and bulk-section "Load Previous Templates" buttons
  let panel = document.getElementById("previous-templates-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "previous-templates-panel";
    panel.style.cssText = "margin:16px 0;padding:14px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;";
    // Prefer bulk update card / catalog area, else near toolbar, else body
    const bulk =
      document.getElementById("bulk-update-section") ||
      document.getElementById("excel-bulk-section") ||
      document.querySelector("[data-section='bulk']") ||
      Array.from(document.querySelectorAll("h2,h3")).find((el) =>
        /bulk excel|bulk update|excel update/i.test(el.textContent || "")
      );
    if (bulk) {
      const parent = bulk.closest(".card") || bulk.parentElement || bulk;
      parent.appendChild(panel);
    } else {
      const tb = document.getElementById("enterprise-toolbar") || document.body;
      tb.appendChild(panel);
    }
  }
  let msg = document.getElementById("catalog-message");
  if (!msg) {
    msg = document.createElement("div");
    msg.id = "catalog-message";
    msg.className = "message";
    msg.style.cssText = "margin-bottom:10px;font-size:13px;";
    panel.insertBefore(msg, panel.firstChild);
  }
  let list = document.getElementById("catalog-list");
  if (!list) {
    list = document.createElement("div");
    list.id = "catalog-list";
    list.style.cssText = "margin-top:8px;";
    panel.appendChild(list);
  }
  return { panel, msg, list };
}

async function loadPreviousTemplates() {
  const { panel, msg, list } = ensurePreviousTemplatesPanel();
  const setMsg = (t, ok) => {
    if (msg) {
      msg.textContent = t;
      msg.className = "message " + (ok ? "success" : "error");
      msg.style.color = ok ? "#15803d" : "#b91c1c";
    }
  };

  try {
    if (!accessToken) {
      setMsg("Please log in first to load previous templates.", false);
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    setMsg("Loading previous templates...", true);
    list.innerHTML = "<p style=\"color:#64748b;font-size:13px;\">Loading…</p>";
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const res = await fetch(`${API_BASE}/api/templates/history`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Failed to load templates");
    }

    const templates = data.templates || [];
    window.__previousTemplatesCache = {};
    templates.forEach((t) => { window.__previousTemplatesCache[t.id] = t; });
    let target = list;

    if (!templates.length) {
      target.innerHTML = `<p style="color:#64748b;font-size:13px;">
        No previous templates yet.<br>
        Use <strong>Create Excel Template</strong> to build a new one — it will appear here for reuse.
      </p>`;
      setMsg("No previous templates saved yet.", true);
      return;
    }

    let html = `<p style="font-size:13px;color:#64748b;margin-bottom:10px;">
      Previously used templates (most used first). Select one to download again.
    </p>`;

    templates.forEach((t) => {
      const labels = (t.summary && t.summary.labels) ? t.summary.labels.join(", ") : "";
      const used = t.use_count || 1;
      const last = (t.last_used || t.created_at || "").replace("T", " ").slice(0, 19);
      const safeId = String(t.id || "").replace(/'/g, "");
      html += `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:8px;background:#f8fafc;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;">
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:600;">${escapeDict(t.name || t.id)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">
            Used <strong>${used}</strong> time(s) · Last: ${escapeDict(last)}
          </div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px;">${escapeDict(labels)}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" onclick="previewPreviousTemplate('${safeId}')"
            style="padding:8px 12px;background:#fff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:6px;cursor:pointer;font-size:13px;">
            Preview
          </button>
          <button type="button" onclick="editPreviousTemplate('${safeId}')"
            style="padding:8px 12px;background:#fff;color:#0f766e;border:1px solid #99f6e4;border-radius:6px;cursor:pointer;font-size:13px;">
            Edit
          </button>
          <button type="button" onclick="reusePreviousTemplate('${safeId}')"
            style="padding:8px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">
            Generate
          </button>
          <button type="button" onclick="deletePreviousTemplate('${safeId}')"
            style="padding:8px 12px;background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;cursor:pointer;font-size:13px;">
            Delete
          </button>
        </div>
      </div>`;
    });

    target.innerHTML = html;
    setMsg(`Loaded ${templates.length} previous template(s).`, true);
  } catch (e) {
    setMsg(e.message || String(e), false);
    console.error(e);
  }
}

async function reusePreviousTemplate(templateId) {
  try {
    const res = await fetch(`${API_BASE}/api/templates/history/${encodeURIComponent(templateId)}/download`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || err.detail || "Download failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AEM_Update_Template.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    loadPreviousTemplates();
  } catch (e) {
    alert(e.message || String(e));
  }
}

async function deletePreviousTemplate(templateId) {
  if (!confirm("Delete this previous template?")) return;
  try {
    const res = await fetch(`${API_BASE}/api/templates/history/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") throw new Error(data.message || "Delete failed");
    loadPreviousTemplates();
  } catch (e) {
    alert(e.message || String(e));
  }
}


window.__previousTemplatesCache = window.__previousTemplatesCache || {};

async function fetchTemplateById(templateId) {
  // Prefer cache from last list load
  if (window.__previousTemplatesCache[templateId]) {
    return window.__previousTemplatesCache[templateId];
  }
  const res = await fetch(`${API_BASE}/api/templates/history`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const data = await res.json();
  const templates = data.templates || [];
  templates.forEach((t) => { window.__previousTemplatesCache[t.id] = t; });
  return window.__previousTemplatesCache[templateId] || null;
}

async function previewPreviousTemplate(templateId) {
  try {
    const t = await fetchTemplateById(templateId);
    if (!t) throw new Error("Template not found");

    const selections = t.selections || [];
    let html = `<div style="font-size:13px;">
      <div style="margin-bottom:10px;">
        <strong>${escapeDict(t.name || t.id)}</strong>
        <div style="color:#64748b;font-size:12px;margin-top:4px;">
          Used ${t.use_count || 1} time(s)
          ${t.include_seo ? " · includes Page Properties/SEO" : ""}
        </div>
      </div>`;

    if (!selections.length) {
      html += `<p style="color:#64748b;">No components stored in this template.</p>`;
    } else {
      selections.forEach((sel) => {
        const fields = sel.fields || [];
        html += `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;">
          <div style="font-weight:600;">${escapeDict(sel.label || sel.resourceType)}</div>
          <div style="font-size:12px;color:#94a3b8;margin:2px 0 6px;">${escapeDict(sel.resourceType || "")}</div>
          <div style="font-size:12px;color:#334155;"><strong>Fields (${fields.length}):</strong> ${escapeDict(fields.join(", "))}</div>
        </div>`;
      });
    }
    html += `</div>`;

    // Reuse modal if available
    let modal = document.getElementById("app-modal");
    if (!modal) {
      alert("Template: " + (t.name || t.id) + "\n\n" + selections.map(s => (s.label || s.resourceType) + ": " + (s.fields || []).join(", ")).join("\n"));
      return;
    }
    document.getElementById("modal-title").textContent = "Template preview";
    document.getElementById("modal-body").innerHTML = html;
    const footer = document.getElementById("modal-footer");
    if (footer) {
      footer.innerHTML = `
        <button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;">Close</button>
        <button type="button" onclick="closeModal(); editPreviousTemplate('${String(templateId).replace(/'/g, "")}')"
          style="padding:8px 14px;border:1px solid #99f6e4;border-radius:6px;background:#fff;color:#0f766e;cursor:pointer;">Edit</button>
        <button type="button" onclick="closeModal(); reusePreviousTemplate('${String(templateId).replace(/'/g, "")}')"
          style="padding:8px 14px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;">Generate</button>`;
    }
    modal.style.display = "flex";
  } catch (e) {
    alert(e.message || String(e));
  }
}

async function editPreviousTemplate(templateId) {
  try {
    const t = await fetchTemplateById(templateId);
    if (!t) throw new Error("Template not found");

    // Open the normal Create Excel Template modal, then pre-select fields from this template
    if (typeof openTemplateModal === "function") {
      await openTemplateModal();
    } else {
      alert("Create Excel Template UI is not available.");
      return;
    }

    // Wait a tick for UI render
    setTimeout(() => {
      const selections = t.selections || [];
      const byRt = {};
      selections.forEach((s) => { byRt[s.resourceType] = s; });

      document.querySelectorAll(".tpl-comp, [data-resource-type], .tpl-component-block").forEach((box) => {
        // try several attribute patterns used in template UI
      });

      // Preferred structure from our template modal: elements with data-rt on component blocks
      document.querySelectorAll("[data-rt]").forEach((box) => {
        const rt = box.getAttribute("data-rt");
        const sel = byRt[rt];
        if (!sel) return;
        const fieldsWanted = new Set(sel.fields || []);
        const compCb = box.querySelector(".tpl-comp-check, .tpl-component-cb, input.tpl-comp-cb");
        if (compCb) {
          compCb.checked = true;
          compCb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        box.querySelectorAll(".tpl-field-check, .tpl-field-cb").forEach((fcb) => {
          const val = fcb.value || fcb.getAttribute("data-field") || "";
          if (fieldsWanted.has(val)) {
            fcb.checked = true;
          }
        });
      });

      // Also match by resourceType text in dictionary template UI
      if (window.__tplComponents) {
        // expand field panels for matching resource types
        document.querySelectorAll(".tpl-field-check").forEach((fcb) => {
          const ci = fcb.getAttribute("data-ci");
          const comps = window.__tplComponents || [];
          const comp = comps[Number(ci)];
          if (!comp) return;
          const sel = byRt[comp.resourceType];
          if (!sel) return;
          const fieldsWanted = new Set(sel.fields || []);
          if (fieldsWanted.has(fcb.value)) {
            fcb.checked = true;
            // ensure parent component checked
            const parentAll = document.querySelector(`.tpl-select-all[data-ci="${ci}"]`);
            const parentComp = document.querySelector(`.tpl-comp-check[data-ci="${ci}"]`) ||
              document.querySelector(`input[data-ci="${ci}"].tpl-comp-cb`);
            // mark component section visible
            const fieldBox = document.getElementById(`tpl-fields-${ci}`);
            if (fieldBox) fieldBox.style.display = "block";
          }
        });
        // check component-level checkboxes when any field selected
        (window.__tplComponents || []).forEach((comp, ci) => {
          if (!byRt[comp.resourceType]) return;
          const any = document.querySelector(`.tpl-field-check[data-ci="${ci}"]:checked`);
          const block = document.querySelector(`[data-ci-block="${ci}"]`) || document.getElementById(`tpl-comp-${ci}`);
          const enable = document.querySelector(`.tpl-comp-enable[data-ci="${ci}"]`);
          if (enable) {
            enable.checked = true;
            enable.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const fieldsPanel = document.getElementById(`tpl-fields-${ci}`);
          if (fieldsPanel) fieldsPanel.style.display = "block";
          (byRt[comp.resourceType].fields || []).forEach((fn) => {
            document.querySelectorAll(`.tpl-field-check[data-ci="${ci}"]`).forEach((fcb) => {
              if (fcb.value === fn) fcb.checked = true;
            });
          });
        });
      }

      // Store base template id so generate can offer "save as new"
      window.__editingTemplateId = templateId;
      window.__editingTemplateName = t.name || "";

      const title = document.getElementById("modal-title");
      if (title) title.textContent = "Edit template (save as new from Create Template)";
      alert("Template loaded into the editor. Add/remove components and fields, then click Create Template to save a new template and download.");
    }, 400);
  } catch (e) {
    alert(e.message || String(e));
  }
}

async function loadComponentCatalog() {
  return loadPreviousTemplates();
}

function wirePreviousTemplateButtons() {
  document.querySelectorAll("button").forEach((btn) => {
    const t = (btn.textContent || "").trim();
    const id = (btn.id || "").toLowerCase();
    if (
      id === "btn-load-prev-templates" ||
      id === "btn-load-previous-templates" ||
      t === "Load Component Catalog" ||
      t.includes("Load Component Catalog") ||
      t.includes("Previous Templates") ||
      t.includes("Load Previous Templates") ||
      t.includes("Previous Excel Templates")
    ) {
      btn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        loadPreviousTemplates();
      };
      if (t.includes("Load Component Catalog")) {
        btn.textContent = "Load Previous Templates";
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wirePreviousTemplateButtons();
  // Re-wire after short delay in case HTML buttons are injected later
  setTimeout(wirePreviousTemplateButtons, 500);
  setTimeout(wirePreviousTemplateButtons, 1500);
});


// ========== COLLAPSIBLE SECTIONS (enterprise chevron) ==========
// Only for major page sections — does NOT change component field panels.

function ensureSectionChevron(header) {
  if (header.querySelector(".section-chevron")) return;
  const chev = document.createElement("span");
  chev.className = "section-chevron";
  chev.setAttribute("aria-hidden", "true");
  chev.style.cssText = [
    "margin-left:auto",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:28px",
    "height:28px",
    "border-radius:6px",
    "background:#f1f5f9",
    "color:#475569",
    "font-size:12px",
    "transition:transform 0.2s ease, background 0.2s ease",
    "flex-shrink:0",
  ].join(";");
  chev.textContent = "▼";
  header.appendChild(chev);
}

function setSectionOpen(section, body, open) {
  body.style.display = open ? "" : "none";
  section.classList.toggle("is-collapsed", !open);
  section.classList.toggle("is-expanded", open);
  const chev = section.querySelector(".section-chevron");
  if (chev) {
    chev.textContent = open ? "▼" : "▶";
    chev.style.transform = open ? "rotate(0deg)" : "rotate(0deg)";
    chev.style.background = open ? "#e0e7ff" : "#f1f5f9";
    chev.style.color = open ? "#3730a3" : "#475569";
  }
  section.setAttribute("data-section-open", open ? "true" : "false");
}

function makeSectionCollapsible(section, options = {}) {
  if (!section || section.dataset.collapsibleBound === "1") return;
  section.dataset.collapsibleBound = "1";

  // Prefer explicit body; else everything after the first heading
  let body = section.querySelector(":scope > .section-body, :scope > .card-body, :scope > .collapsible-body");
  let header = section.querySelector(":scope > .section-header, :scope > .card-header, :scope > .collapsible-header");

  if (!header) {
    header = section.querySelector(":scope > h2, :scope > h3, :scope > h4");
  }
  if (!header) return;

  if (!body) {
    body = document.createElement("div");
    body.className = "section-body collapsible-body";
    const toMove = [];
    let afterHeader = false;
    Array.from(section.childNodes).forEach((node) => {
      if (node === header) {
        afterHeader = true;
        return;
      }
      if (afterHeader) toMove.push(node);
    });
    toMove.forEach((n) => body.appendChild(n));
    section.appendChild(body);
  }

  // Header layout for chevron
  if (getComputedStyle(header).display !== "flex") {
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "10px";
    header.style.flexWrap = "wrap";
  }
  header.style.cursor = "pointer";
  header.style.userSelect = "none";
  ensureSectionChevron(header);

  const startOpen = options.defaultOpen !== false;
  setSectionOpen(section, body, startOpen);

  header.addEventListener("click", (e) => {
    // Don't toggle when clicking real controls inside header
    if (e.target.closest("button, a, input, select, textarea, label")) return;
    const open = section.getAttribute("data-section-open") === "true";
    setSectionOpen(section, body, !open);
  });
}

function initCollapsibleSections() {
  const candidates = new Set();

  // Explicit class
  document.querySelectorAll(".collapsible-section, [data-collapsible='true']").forEach((el) => candidates.add(el));

  // Common card wrappers under app
  const app = document.getElementById("app-section");
  if (app) {
    app.querySelectorAll(":scope > .card, :scope > section, :scope > .panel").forEach((el) => candidates.add(el));
  }

  // Heuristic: section that contains Previous Templates / Bulk Update / Dictionary tools
  document.querySelectorAll("div, section").forEach((el) => {
    const h = el.querySelector(":scope > h2, :scope > h3");
    if (!h) return;
    const t = (h.textContent || "").toLowerCase();
    if (
      t.includes("previous template") ||
      t.includes("from catalog") ||
      t.includes("bulk update") ||
      t.includes("excel template") ||
      t.includes("dictionary") ||
      t.includes("create excel")
    ) {
      // only direct section containers, not nested tiny divs
      if (el.children.length >= 2) candidates.add(el);
    }
  });

  candidates.forEach((section) => {
    // Skip login / tiny
    if (section.id === "login-section") return;
    if (section.querySelector(".component-item")) return; // don't wrap component list card oddly - still ok to collapse whole card
    makeSectionCollapsible(section, { defaultOpen: true });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCollapsibleSections);
} else {
  setTimeout(initCollapsibleSections, 0);
}


// ========== PAGE CREATION (path → plan → folder/page + template → create) ==========

let __pagePlanData = null;

function ensurePageCreateSection() {
  if (document.getElementById("page-create-card")) return;

  const card = document.createElement("div");
  card.id = "page-create-card";
  card.className = "card collapsible-section";
  card.setAttribute("data-collapsible", "true");
  card.style.cssText = "margin:16px 0;padding:18px 20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(0,0,0,.04);";
  card.innerHTML = `
    <div class="section-header" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <h3 style="margin:0;font-size:16px;font-weight:600;color:#0f172a;">Page Creation</h3>
    </div>
    <div class="section-body">
      <p style="margin:0 0 12px;font-size:13px;color:#64748b;">
        Enter the full target page path. The tool will show missing parents — choose <strong>Folder</strong> or <strong>Page</strong> (with template) for each, then create.
      </p>
      <label style="font-size:13px;font-weight:500;display:block;margin-bottom:4px;">Target page path</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <input id="page-create-path" type="text" placeholder="/content/we-retail/us/en/men/test"
          style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;" />
        <button type="button" onclick="loadPageCreatePlan()"
          style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
          Get Plan
        </button>
      </div>
      <p id="page-create-message" class="message" style="font-size:13px;margin:8px 0;"></p>
      <div id="page-create-plan" style="display:none;"></div>
    </div>
  `;

  const host =
    document.getElementById("app-section") ||
    document.getElementById("page-path-card")?.parentElement ||
    document.body;
  // Insert after bulk update / catalog if present, else append
  const after =
    document.getElementById("catalog-list")?.closest(".card") ||
    document.querySelector("[id*='excel']") ||
    null;
  if (after && after.parentElement) {
    after.parentElement.insertBefore(card, after.nextSibling);
  } else {
    host.appendChild(card);
  }
}

function setPageCreateMsg(text, ok) {
  const el = document.getElementById("page-create-message");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#15803d" : "#b91c1c";
}

async function loadPageCreatePlan() {
  ensurePageCreateSection();
  const pathInput = document.getElementById("page-create-path");
  const planEl = document.getElementById("page-create-plan");
  const target = (pathInput?.value || "").trim();
  if (!target) {
    setPageCreateMsg("Enter a target page path (e.g. /content/we-retail/us/en/men/test)", false);
    return;
  }
  if (!accessToken) {
    setPageCreateMsg("Please login first", false);
    return;
  }

  setPageCreateMsg("Loading plan...", true);
  planEl.style.display = "none";
  planEl.innerHTML = "";

  try {
    const res = await fetch(`${API_BASE}/api/page/plan`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target_path: target }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Plan failed");
    }

    __pagePlanData = data;

    if (data.action === "none" || data.inspection?.all_ready) {
      setPageCreateMsg("Entire path already exists — nothing to create.", true);
      planEl.style.display = "block";
      planEl.innerHTML = `<p style="font-size:13px;color:#64748b;">Path is ready: <code>${escapeDict(data.target_path || target)}</code></p>`;
      return;
    }

    const plan = data.plan || [];
    let html = `<div style="margin-top:8px;">`;
    html += `<p style="font-size:13px;color:#64748b;margin-bottom:10px;">${escapeDict(data.message || "")}</p>`;

    plan.forEach((step, idx) => {
      if (step.action === "exists") {
        html += `
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;">
            <div style="font-size:13px;">
              <span style="color:#15803d;font-weight:600;">Exists</span>
              <code style="margin-left:8px;">${escapeDict(step.path)}</code>
              <span style="color:#94a3b8;font-size:12px;margin-left:6px;">(${escapeDict(step.kind || "node")})</span>
            </div>
          </div>`;
        return;
      }

      const isTarget = !!step.is_target_page;
      const templates = step.templates || [];
      const choices = step.choices || (isTarget ? ["page"] : ["page", "folder"]);
      const defaultType = isTarget ? "page" : (choices.includes("folder") ? "folder" : "page");

      html += `
        <div class="page-plan-step" data-idx="${idx}" data-path="${escapeDict(step.path)}"
          data-parent="${escapeDict(step.parent_path || "")}" data-segment="${escapeDict(step.segment || "")}"
          style="border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:10px;background:#f8fbff;">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;">
            Create: <code>${escapeDict(step.path)}</code>
            ${isTarget ? '<span style="margin-left:8px;font-size:11px;background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:99px;">Target page</span>' : ""}
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${escapeDict(step.message || "")}</div>
          <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:8px;">
            <span style="font-size:12px;font-weight:500;">Type:</span>
            ${choices.map((c) => `
              <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="radio" name="page-type-${idx}" value="${c}"
                  ${c === defaultType ? "checked" : ""}
                  onchange="onPagePlanTypeChange(${idx})">
                ${c === "page" ? "Page" : "Folder"}
              </label>`).join("")}
          </div>
          <div id="page-plan-title-${idx}" style="margin-bottom:8px;">
            <label style="font-size:12px;display:block;margin-bottom:4px;">Title</label>
            <input type="text" class="page-plan-title" data-idx="${idx}"
              value="${escapeDict((step.segment || "").replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()))}"
              style="width:100%;max-width:360px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;" />
          </div>
          <div id="page-plan-template-${idx}" style="display:${defaultType === "page" ? "block" : "none"};">
            <label style="font-size:12px;display:block;margin-bottom:4px;">Template ${isTarget ? "(required)" : ""}</label>
            <select class="page-plan-template" data-idx="${idx}"
              style="width:100%;max-width:480px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
              <option value="">— Select template —</option>
              ${templates.map((t) => `
                <option value="${escapeDict(t.path)}">${escapeDict(t.title || t.name || t.path)} (${escapeDict(t.path)})</option>
              `).join("")}
            </select>
            ${templates.length ? "" : `<p style="font-size:12px;color:#b45309;margin:6px 0 0;">No templates listed for parent. Check parent exists and has allowed templates.</p>`}
          </div>
        </div>`;
    });

    html += `
      <button type="button" onclick="executePageCreate()"
        style="margin-top:8px;padding:10px 16px;background:#0f766e;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
        Create path
      </button>
    </div>`;

    planEl.innerHTML = html;
    planEl.style.display = "block";
    setPageCreateMsg(`Plan ready — ${plan.filter((p) => p.action === "create").length} segment(s) to create.`, true);
  } catch (e) {
    setPageCreateMsg(e.message || String(e), false);
    console.error(e);
  }
}

function onPagePlanTypeChange(idx) {
  const radios = document.querySelectorAll(`input[name="page-type-${idx}"]`);
  let type = "page";
  radios.forEach((r) => { if (r.checked) type = r.value; });
  const tplBox = document.getElementById(`page-plan-template-${idx}`);
  if (tplBox) tplBox.style.display = type === "page" ? "block" : "none";
}

async function executePageCreate() {
  const pathInput = document.getElementById("page-create-path");
  const target = (pathInput?.value || "").trim();
  if (!target || !__pagePlanData) {
    setPageCreateMsg("Load a plan first", false);
    return;
  }

  const steps = [];
  const rows = document.querySelectorAll(".page-plan-step");
  for (const row of rows) {
    const idx = row.getAttribute("data-idx");
    const path = row.getAttribute("data-path");
    let type = "page";
    row.querySelectorAll(`input[name="page-type-${idx}"]`).forEach((r) => {
      if (r.checked) type = r.value;
    });
    const titleEl = row.querySelector(`.page-plan-title[data-idx="${idx}"]`);
    const title = (titleEl?.value || "").trim();
    const tplEl = row.querySelector(`.page-plan-template[data-idx="${idx}"]`);
    const template = (tplEl?.value || "").trim();

    if (type === "page" && !template) {
      setPageCreateMsg(`Select a template for: ${path}`, false);
      return;
    }
    steps.push({
      path,
      type,
      title: title || undefined,
      template: type === "page" ? template : undefined,
    });
  }

  if (!steps.length) {
    setPageCreateMsg("Nothing to create", true);
    return;
  }

  setPageCreateMsg("Creating...", true);
  try {
    const res = await fetch(`${API_BASE}/api/page/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_path: target,
        steps,
        default_title: steps[steps.length - 1]?.title,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Create failed");
    }

    let detail = (data.results || [])
      .map((r) => `${r.status === "success" || r.created ? "✅" : r.status === "skipped" ? "⏭️" : "❌"} ${r.path || ""} ${r.message || r.kind || ""}`)
      .join("\n");

    setPageCreateMsg(data.message || "Done", data.status === "success");
    const planEl = document.getElementById("page-create-plan");
    if (planEl) {
      planEl.innerHTML =
        `<pre style="font-size:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;white-space:pre-wrap;">${escapeDict(detail || JSON.stringify(data, null, 2))}</pre>` +
        `<button type="button" onclick="loadPageCreatePlan()" style="margin-top:10px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;">Refresh plan</button>`;
    }
  } catch (e) {
    setPageCreateMsg(e.message || String(e), false);
    console.error(e);
  }
}

// Mount section after login / on load
function bootPageCreateUI() {
  try {
    ensurePageCreateSection();
  } catch (e) {
    console.warn(e);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootPageCreateUI);
} else {
  setTimeout(bootPageCreateUI, 50);
}


// ========== DAM ASSET UPLOAD (local → AEM DAM) ==========

function ensureDamUploadSection() {
  if (document.getElementById("dam-upload-card")) return;

  const card = document.createElement("div");
  card.id = "dam-upload-card";
  card.className = "card collapsible-section";
  card.setAttribute("data-collapsible", "true");
  card.style.cssText = "margin:16px 0;padding:18px 20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(0,0,0,.04);";
  card.innerHTML = `
    <div class="section-header" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <h3 style="margin:0;font-size:16px;font-weight:600;color:#0f172a;">DAM Asset Upload</h3>
    </div>
    <div class="section-body">
      <p style="margin:0 0 12px;font-size:13px;color:#64748b;">
        Upload images from a local page folder (<strong>Desktop / Mobile / Tablet</strong>) into AEM DAM.
        Folders are created under the page DAM path when confirmed. Size limits: Desktop &lt;300KB, Tablet &lt;200KB, Mobile &lt;100KB (+5KB tolerance).
      </p>
      <label style="font-size:13px;font-weight:500;display:block;margin-bottom:4px;">DAM page path</label>
      <input id="dam-page-path" type="text" placeholder="/content/dam/we-retail/en/men"
        style="width:100%;max-width:520px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:10px;" />
      <label style="font-size:13px;font-weight:500;display:block;margin-bottom:4px;">Local page folder</label>
      <input id="dam-local-folder" type="text" placeholder="C:/Users/.../test-assets/men"
        style="width:100%;max-width:520px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;margin-bottom:12px;" />
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
        <button type="button" onclick="damInspect()" style="padding:8px 14px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;cursor:pointer;font-weight:500;">Inspect DAM folders</button>
        <button type="button" onclick="damEnsureFolders()" style="padding:8px 14px;background:#fff;border:1px solid #99f6e4;color:#0f766e;border-radius:8px;cursor:pointer;font-weight:500;">Create folders</button>
        <button type="button" onclick="damScanLocal()" style="padding:8px 14px;background:#fff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:8px;cursor:pointer;font-weight:500;">Scan local</button>
        <button type="button" onclick="damUploadLocal()" style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">Upload to DAM</button>
      </div>
      <p id="dam-message" style="font-size:13px;margin:8px 0;"></p>
      <div id="dam-result" style="display:none;margin-top:8px;"></div>
    </div>
  `;

  const host = document.getElementById("app-section") || document.body;
  const pageCard = document.getElementById("page-create-card");
  if (pageCard && pageCard.parentElement) {
    pageCard.parentElement.insertBefore(card, pageCard);
  } else {
    host.appendChild(card);
  }
}

function setDamMsg(text, ok) {
  const el = document.getElementById("dam-message");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#15803d" : "#b91c1c";
}

function showDamResult(obj) {
  const box = document.getElementById("dam-result");
  if (!box) return;
  box.style.display = "block";
  box.innerHTML = `<pre style="font-size:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;overflow:auto;max-height:360px;white-space:pre-wrap;">${escapeDict(JSON.stringify(obj, null, 2))}</pre>`;
}

async function damInspect() {
  ensureDamUploadSection();
  if (!accessToken) return setDamMsg("Please login first", false);
  const pageDamPath = (document.getElementById("dam-page-path")?.value || "").trim();
  if (!pageDamPath) return setDamMsg("Enter DAM page path", false);
  setDamMsg("Inspecting...", true);
  try {
    const res = await fetch(`${API_BASE}/api/dam/inspect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ page_dam_path: pageDamPath }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") throw new Error(data.message || data.detail || "Inspect failed");
    setDamMsg(data.message || "Inspect done", true);
    showDamResult(data);
  } catch (e) {
    setDamMsg(e.message || String(e), false);
  }
}

async function damEnsureFolders() {
  if (!accessToken) return setDamMsg("Please login first", false);
  const pageDamPath = (document.getElementById("dam-page-path")?.value || "").trim();
  if (!pageDamPath) return setDamMsg("Enter DAM page path", false);
  if (!confirm("Create missing DAM folders (including desktop/mobile/tablet) under:\n" + pageDamPath + "?")) return;
  setDamMsg("Creating folders...", true);
  try {
    const res = await fetch(`${API_BASE}/api/dam/ensure-folders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ page_dam_path: pageDamPath, confirm_create: true }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") throw new Error(data.message || data.detail || "Create folders failed");
    setDamMsg(data.message || "Folders ready", data.status === "success" || data.status === "needs_confirmation");
    showDamResult(data);
  } catch (e) {
    setDamMsg(e.message || String(e), false);
  }
}

async function damScanLocal() {
  if (!accessToken) return setDamMsg("Please login first", false);
  const local = (document.getElementById("dam-local-folder")?.value || "").trim();
  if (!local) return setDamMsg("Enter local page folder path", false);
  setDamMsg("Scanning local folder...", true);
  try {
    const res = await fetch(`${API_BASE}/api/dam/scan-local`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ local_page_folder: local }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") throw new Error(data.message || data.detail || "Scan failed");
    setDamMsg(data.message || "Scan done", true);
    showDamResult(data);
  } catch (e) {
    setDamMsg(e.message || String(e), false);
  }
}

async function damUploadLocal() {
  if (!accessToken) return setDamMsg("Please login first", false);
  const pageDamPath = (document.getElementById("dam-page-path")?.value || "").trim();
  const local = (document.getElementById("dam-local-folder")?.value || "").trim();
  if (!pageDamPath || !local) return setDamMsg("DAM path and local folder are required", false);
  if (!confirm("Upload assets to DAM?\n" + pageDamPath + "\nfrom\n" + local)) return;
  setDamMsg("Uploading (may take a while)...", true);
  try {
    const res = await fetch(`${API_BASE}/api/dam/upload-local`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        page_dam_path: pageDamPath,
        local_page_folder: local,
        confirm_create_folders: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") throw new Error(data.message || data.detail || "Upload failed");
    const s = data.summary || {};
    setDamMsg(
      `Upload finished — success: ${s.success || 0}, skipped: ${s.skipped || 0}, rejected size: ${s.rejected_size || 0}, errors: ${s.errors || 0}`,
      data.status === "success" || data.status === "partial"
    );
    showDamResult(data);
  } catch (e) {
    setDamMsg(e.message || String(e), false);
  }
}

function bootDamUploadUI() {
  try { ensureDamUploadSection(); } catch (e) { console.warn(e); }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDamUploadUI);
} else {
  setTimeout(bootDamUploadUI, 60);
}


/* onTplIncludePagesChange replaced below */


async function loadTplTemplates() {
  const sel = document.getElementById("tpl-default-template");
  if (!sel || !accessToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/page/templates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parent_path: "/content/we-retail/us/en" }),
    });
    const data = await res.json();
    const templates = (data.templates || []).filter(
      (t) => !t["jcr:primaryType"] || t["jcr:primaryType"] === "cq:Template"
    );
    sel.innerHTML = "";
    if (!templates.length) {
      sel.innerHTML = '<option value="Content Page">Content Page</option>';
      return;
    }
    templates.forEach((t) => {
      const title = t.title || t.name || t.path;
      const opt = document.createElement("option");
      opt.value = title;
      opt.textContent = title;
      if ((t.name || "").toLowerCase() === "content-page" || (title || "").toLowerCase() === "content page") {
        opt.selected = true;
      }
      sel.appendChild(opt);
    });
  } catch (e) {
    sel.innerHTML = '<option value="Content Page">Content Page</option>';
  }
}



function showDetailedValidationReport() {
  const val = window.__lastValidationReport;
  if (!val || !val.detailed) {
    alert("No validation report available. Run Apply Changes first.");
    return;
  }
  const sections = val.detailed;
  let html = '<div style="max-height:70vh;overflow:auto;text-align:left;">';
  html += '<h3 style="margin-top:0;">Detailed validation report</h3>';
  html += '<p style="font-size:13px;color:#64748b;">Excel is source of truth. Every check below is pin-level.</p>';
  ["assets", "pages", "components", "seo"].forEach((key) => {
    const items = sections[key] || [];
    html += '<h4 style="margin:16px 0 8px;text-transform:uppercase;font-size:12px;letter-spacing:0.04em;color:#475569;">' + key + ' (' + items.length + ')</h4>';
    items.forEach((it) => {
      const c = it.severity === "pass" ? "#15803d" : (it.severity === "warn" ? "#c2410c" : "#b91c1c");
      html += '<div style="border:1px solid #e2e8f0;border-left:4px solid ' + c + ';padding:8px 10px;margin-bottom:6px;border-radius:6px;font-size:12px;">';
      html += '<div style="font-weight:600;color:' + c + ';">' + (it.severity || "").toUpperCase() + " — " + (it.message || "") + "</div>";
      if (it.page_path) html += '<div>Page: <code>' + it.page_path + '</code></div>';
      if (it.dam_path) html += '<div>DAM: <code>' + it.dam_path + '</code></div>';
      if (it.component_path) html += '<div>Component: <code>' + it.component_path + '</code></div>';
      if (it.size_kb != null) html += '<div>Size: ' + it.size_kb + ' KB</div>';
      if (it.field_checks && it.field_checks.length) {
        html += '<table style="width:100%;margin-top:6px;border-collapse:collapse;font-size:11px;">';
        html += '<tr style="background:#f8fafc;"><th style="text-align:left;padding:4px;">Field</th><th style="text-align:left;padding:4px;">Expected</th><th style="text-align:left;padding:4px;">Actual</th><th style="text-align:left;padding:4px;">OK</th></tr>';
        it.field_checks.forEach((fc) => {
          html += '<tr><td style="padding:4px;border-top:1px solid #eee;">' + (fc.field || "") + '</td>';
          html += '<td style="padding:4px;border-top:1px solid #eee;">' + (fc.expected != null ? fc.expected : "") + '</td>';
          html += '<td style="padding:4px;border-top:1px solid #eee;">' + (fc.actual != null ? fc.actual : "—") + '</td>';
          html += '<td style="padding:4px;border-top:1px solid #eee;color:' + (fc.ok ? "#15803d" : "#b91c1c") + ';">' + (fc.ok ? "✓" : "✗") + '</td></tr>';
        });
        html += '</table>';
      }
      html += '</div>';
    });
  });
  html += '</div>';
  if (typeof showModalShell === "function") {
    showModalShell("Validation report", html, "");
  } else {
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
    } else {
      alert("Detailed report ready — allow popups or use Download JSON.");
    }
  }
}



async function downloadValidationReportExcel() {
  try {
    if (!accessToken) {
      alert("Please log in first.");
      return;
    }
    if (!lastExcelFile) {
      alert("No Excel file in session. Run Preview/Apply with an Excel file first.");
      return;
    }
    const formData = new FormData();
    formData.append("file", lastExcelFile);
    const res = await fetch(API_BASE + "/api/excel/bulk/validate/export?format=xlsx", {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken },
      body: formData,
    });
    if (!res.ok) {
      let msg = "Excel export failed (HTTP " + res.status + ")";
      try {
        const err = await res.json();
        msg = err.message || err.detail || msg;
      } catch (_) {
        try { msg = await res.text(); } catch (__) {}
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    // Guard: API may have returned JSON error with 200 in rare cases
    if ((blob.type || "").includes("application/json")) {
      const text = await blob.text();
      throw new Error(text.slice(0, 200) || "Export returned JSON, not Excel");
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AEM_Bulk_Validation_Report.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    alert(e.message || String(e));
  }
}

function downloadValidationReport() {
  const val = window.__lastValidationReport;
  if (!val) {
    alert("No validation report available. Run Apply Changes first.");
    return;
  }
  const blob = new Blob([JSON.stringify(val, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "AEM_Bulk_Validation_Report.json";
  a.click();
  URL.revokeObjectURL(url);
}


async function clearBulkSession() {
  if (!accessToken) return;
  if (!confirm("Clear bulk session on this page?\n\n• Next Preview will be a full baseline (not a delta of previous apply).\n• Use this when you want a new bulk run without reloading the page.\n\nTip: Reloading the page also starts a fresh session automatically.")) return;
  try {
    await fetch(API_BASE + "/api/excel/bulk/session/clear", {
      method: "POST",
      headers: bulkSessionHeaders(),
    });
    // Rotate client id so this page continues with a brand-new session
    bulkSessionId = newBulkSessionId();
    alert("Bulk session cleared. Next Preview is a full baseline (same as after a page reload).");
  } catch (e) {
    alert(e.message || String(e));
  }
}


function isTplNewPageMode() {
  const cb = document.getElementById("tpl-include-pages");
  return !!(cb && cb.checked);
}

function applyDefaultAddUpdateForComp(ci) {
  const a = document.querySelector('.tpl-comp-add[data-ci="' + ci + '"]');
  const u = document.querySelector('.tpl-comp-update[data-ci="' + ci + '"]');
  if (!a && !u) return; // page properties
  if (isTplNewPageMode()) {
    if (a) a.checked = true;
    if (u) u.checked = false;
  } else {
    if (a) a.checked = false;
    if (u) u.checked = true;
  }
}

function onTplIncludePagesChange() {
  const box = document.getElementById("tpl-pages-options");
  const cb = document.getElementById("tpl-include-pages");
  const modeHint = document.getElementById("tpl-mode-hint");
  if (box && cb) box.style.display = cb.checked ? "block" : "none";
  // Re-apply defaults only for currently selected components
  document.querySelectorAll(".tpl-comp-check:checked").forEach((el) => {
    const ci = el.getAttribute("data-ci");
    applyDefaultAddUpdateForComp(ci);
  });
  // Hide Update option styling in new-page mode (still can force if needed - user asked default only)
  document.querySelectorAll(".tpl-comp-upd-label").forEach((lab) => {
    lab.style.opacity = cb && cb.checked ? "0.45" : "1";
  });
  if (modeHint) {
    if (cb && cb.checked) {
      modeHint.innerHTML = "<strong>Mode: New pages.</strong> For each selected component, <em>Add</em> is checked by default (Update off). Template gets only Add sheets for those components.";
    } else {
      modeHint.innerHTML = "<strong>Mode: Existing pages.</strong> For each selected component, <em>Update</em> is checked by default. Tick <em>Add</em> only if you also need new instances. Tick both if you need both sheets.";
    }
  }
}



function friendlyAuditField(name) {
  const map = {
    "__page_create__": "Page created",
    "__page_folder__": "Page folder",
    "__dam_folder__": "DAM folder",
    "__dam_upload__": "DAM asset upload",
    "__component_add__": "Component added",
    "__bulk__": "Bulk operation",
  };
  if (!name) return "—";
  if (map[name]) return map[name];
  return name;
}

// ========== AUDIT LOG (frontend) ==========
async function openAuditLogModal() {
  if (!accessToken) {
    alert("Please log in to view the audit log.");
    return;
  }
  showModalShell(
    "Audit Log",
    '<p style="color:#64748b;font-size:13px;">Loading recent changes…</p>',
    '<button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">Close</button>'
  );
  await loadAuditLogIntoModal(100);
}

async function loadAuditLogIntoModal(limit) {
  limit = limit || 100;
  const body = document.getElementById("modal-body");
  const footer = document.getElementById("modal-footer");
  if (!body) return;
  try {
    const res = await fetch(API_BASE + "/api/audit/logs?limit=" + encodeURIComponent(limit), {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data.message || data.detail || "Failed to load audit log");
    }
    const logs = data.logs || [];
    let html = "";
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">';
    html += '<label style="font-size:13px;color:#475569;">Show last ';
    html += '<select id="audit-limit" onchange="loadAuditLogIntoModal(parseInt(this.value,10))" style="margin:0 6px;padding:4px 8px;border-radius:6px;border:1px solid #cbd5e1;">';
    [50, 100, 200, 500].forEach(function (n) {
      html += '<option value="' + n + '"' + (n === limit ? " selected" : "") + ">" + n + "</option>";
    });
    html += "</select> entries</label>";
    html += '<button type="button" onclick="loadAuditLogIntoModal(parseInt((document.getElementById(\'audit-limit\')||{}).value||100,10))" style="padding:6px 12px;border:1px solid #93c5fd;border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-size:13px;">Refresh</button>';
    html += '<span style="font-size:12px;color:#64748b;">' + logs.length + " record(s)</span>";
    html += "</div>";

    if (!logs.length) {
      html += '<p style="color:#64748b;font-size:13px;">No audit entries yet. Updates from the tool (single field or bulk) will appear here with the logged-in user.</p>';
    } else {
      html += '<div style="overflow:auto;max-height:60vh;border:1px solid #e2e8f0;border-radius:8px;">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += "<thead><tr style=\"background:#1e3a5f;color:#fff;text-align:left;\">";
      ["When", "User", "Path", "Field", "Old", "New", "OK", "Message"].forEach(function (h) {
        html += '<th style="padding:8px 10px;position:sticky;top:0;background:#1e3a5f;">' + h + "</th>";
      });
      html += "</tr></thead><tbody>";
      logs.forEach(function (log, i) {
        const bg = i % 2 ? "#f8fafc" : "#fff";
        const ok = log.success === true || log.success === 1 || log.success === "true";
        const when = (log.timestamp || "").replace("T", " ").slice(0, 19);
        function cell(v, max) {
          const s = v == null ? "" : String(v);
          const short = s.length > (max || 60) ? s.slice(0, max || 60) + "…" : s;
          return short.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
        html += '<tr style="background:' + bg + ';">';
        html += '<td style="padding:6px 10px;white-space:nowrap;color:#475569;">' + cell(when, 20) + "</td>";
        html += '<td style="padding:6px 10px;font-weight:600;">' + cell(log.performed_by || "—", 24) + "</td>";
        html += '<td style="padding:6px 10px;font-family:Consolas,monospace;font-size:11px;" title="' + cell(log.component_path, 500) + '">' + cell(log.component_path, 48) + "</td>";
        html += '<td style="padding:6px 10px;">' + cell(friendlyAuditField(log.property_name), 40) + "</td>";
        html += '<td style="padding:6px 10px;color:#64748b;" title="' + cell(log.old_value, 500) + '">' + cell(log.old_value, 28) + "</td>";
        html += '<td style="padding:6px 10px;color:#15803d;" title="' + cell(log.new_value, 500) + '">' + cell(log.new_value, 28) + "</td>";
        html += '<td style="padding:6px 10px;text-align:center;font-weight:700;color:' + (ok ? "#15803d" : "#b91c1c") + ';">' + (ok ? "✓" : "✗") + "</td>";
        html += '<td style="padding:6px 10px;color:#64748b;" title="' + cell(log.message, 500) + '">' + cell(log.message, 40) + "</td>";
        html += "</tr>";
      });
      html += "</tbody></table></div>";
    }
    body.innerHTML = html;
    if (footer) {
      footer.innerHTML =
        '<button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">Close</button>';
    }
  } catch (e) {
    body.innerHTML = '<p style="color:#b91c1c;">' + (e.message || String(e)) + "</p>";
  }
}

window.openAuditLogModal = openAuditLogModal;
window.loadAuditLogIntoModal = loadAuditLogIntoModal;
