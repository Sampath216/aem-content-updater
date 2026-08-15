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


    function renderMultifield(container, mfKey, mfLabel, itemFields, currentValue, metaPath) {
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
        renderMultifield(container, mfKey, label, mf.itemFields || [], currentVal, mf.path);
      });
    }

    // ---------- interactive tabs ----------
    const tabsWithContent = tabs.filter(t =>
      (t.fields && t.fields.length) || (t.multifields && t.multifields.length)
    );

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

        renderFieldsInto(panel, tab.fields, tab.multifields, renderedKeys);

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
      renderMultifield(formEl, mfKey, label, mf.itemFields || [], currentVal, mf.path);
    });

    // Remaining flat fields
    for (const [key, value] of Object.entries(currentFields)) {
      if (renderedKeys.has(key)) continue;
      if (multifieldState[key]) continue;
      const meta = fieldMeta[key] || { label: key };
      // skip empty technical keys
      if (!key || key.includes("@TypeHint")) continue;
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
        if (assets.summary) {
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
        if (pages.summary) {
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
        (adds.rows || []).forEach((r) => {
          const bad = r.errors && r.errors.length;
          const color = bad ? "#b91c1c" : "#15803d";
          html += '<div style="font-size:13px;margin:4px 0;color:' + color + ';">';
          html += (bad ? "✗ " : "✓ ") + "<code>" + (r.page_path || "") + "</code> + " + (r.component || "");
          if (r.page_status) html += " <span style=\"color:#64748b\">[" + r.page_status + "]</span>";
          if (bad) html += "<br><span style=\"font-size:12px\">" + r.errors.join("; ") + "</span>";
          if (r.warnings && r.warnings.length) html += "<br><span style=\"font-size:12px;color:#c2410c\">" + r.warnings.join("; ") + "</span>";
          html += "</div>";
        });

        // Updates
        const updates = data.updates || {};
        const summary = updates.summary || {};
        const seoN = summary.total_seo_rows != null ? summary.total_seo_rows : ((updates.seo_updates || []).length || 0);
        const compN = summary.total_component_rows != null ? summary.total_component_rows : ((updates.component_updates || []).length || 0);
        html += "<h4>4. SEO / Component Updates</h4>";
        html += "<p>SEO rows: " + seoN + ", Component rows: " + compN + "</p>";
        const summaryJson = escapeDict(JSON.stringify({
            assets_summary: assets.summary,
            pages_summary: pages.summary,
            add_count: (adds.rows || []).length,
            updates_summary: summary
        }, null, 2));
        html += '<pre style="font-size:11px;max-height:200px;overflow:auto;background:#f8fafc;padding:8px;border-radius:6px;">' + summaryJson + "</pre>";

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
        const formData = new FormData();
        formData.append("file", lastExcelFile);
        const response = await fetch(API_BASE + step.endpoint, {
            method: "POST",
            headers: { Authorization: "Bearer " + accessToken },
            body: formData,
        });
        let data = {};
        try { data = await response.json(); } catch (_) { data = { status: "error", message: "Invalid response" }; }
        if (!response.ok || data.status === "error") {
            state[step.id] = {
                status: "error",
                message: data.message || data.detail || "Failed",
                detail: data,
            };
            return data;
        }
        let st = "success";
        if (data.status === "partial") st = "partial";
        if (data.status === "error" || data.status === "failed") st = "error";
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
    const res = await fetch(`${API_BASE}/api/dictionary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok || data.status !== "success") {
      throw new Error(data.message || data.detail || "Failed to load components");
    }
    let components = data.components || [];

    // Optional catalog merge by resourceType only
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

    components = dedupeTemplateComponents(components);
    renderTemplateUI(components);
  } catch (e) {
    document.getElementById("modal-body").innerHTML = `<p class="message error">${e.message}</p>`;
  }
}

function renderTemplateUI(components) {
  let html = `
    <p style="margin:0 0 12px;font-size:13px;color:#64748b;">
      Choose bulk sheets and components. <strong>Add</strong> sheets create new components on a page;
      sheets without "Add" are for <strong>updating</strong> components already on the page.
      Use the <strong>Instance</strong> column in update sheets when the same component appears multiple times.
    </p>
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
        <select id="tpl-default-template" style="width:100%;max-width:360px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;">
          <option value="">Loading templates...</option>
        </select>
        <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">CA can still change Create (Y/N) and Template Name in Excel later.</p>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="tpl-include-add" checked /> Components <strong>Add</strong> sheets (new components on a page)
      </label>
      <p id="tpl-mode-hint" style="margin:8px 0 0;font-size:12px;color:#334155;line-height:1.45;">
        <strong>Mode:</strong> Tick <em>Pages</em> for new-page work (components = Add sheets). Leave Pages unticked for update-only templates (Instance column).
      </p>
      <p style="margin:6px 0 0;font-size:12px;color:#64748b;">
        Page Properties / SEO comes only from the selection under <strong>Components &amp; fields</strong> below.
      </p>
    </div>
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#0f172a;">Components & fields</div>`;

  if (!components.length) {
    html += `<p>No components available. Open pages in the tool so components are stored in the dictionary/catalog first.</p>`;
  }

  components.forEach((comp, ci) => {
    html += `
      <div class="tpl-comp" style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;overflow:hidden;">
        <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f8fafc;cursor:pointer;">
          <input type="checkbox" class="tpl-comp-check" data-ci="${ci}" onchange="toggleTplComp(${ci}, this.checked)">
          <strong style="font-size:13px;">${escapeDict(comp.label || comp.resourceType)}</strong>
          <span style="font-size:11px;color:#64748b;">${escapeDict(comp.resourceType)}</span>
        </label>
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
    html += `</div></div></div>`;
  });

  window.__tplComponents = components;

  document.getElementById("modal-body").innerHTML = html;
  loadTplTemplates();
  onTplIncludePagesChange();
  document.getElementById("modal-footer").innerHTML = `
    <button type="button" onclick="closeModal()" style="padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;">Cancel</button>
    <button type="button" onclick="previewExcelTemplate()" style="padding:8px 14px;border:1px solid #2563eb;border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-weight:500;">Preview</button>
    <button type="button" onclick="generateExcelTemplate()" style="padding:8px 16px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-weight:500;">Create Template</button>
  `;
}

function collectTemplateSelections() {
  const components = window.__tplComponents || [];
  const selections = [];
  document.querySelectorAll(".tpl-comp-check:checked").forEach((cb) => {
    const ci = parseInt(cb.getAttribute("data-ci"), 10);
    const comp = components[ci];
    if (!comp) return;
    const fields = [];
    document.querySelectorAll(`.tpl-field-check[data-ci="${ci}"]:checked`).forEach((f) => {
      fields.push(f.getAttribute("data-fn"));
    });
    if (fields.length) {
      selections.push({
        resourceType: comp.resourceType,
        label: comp.label || comp.resourceType,
        fields,
      });
    }
  });
  return selections;
}

function preferredLabelForField(comp, fieldName) {
  const f = (comp.fields || []).find((x) => x.field_name === fieldName);
  if (f && f.ca_labels && f.ca_labels.length) return f.ca_labels[0];
  if (f && f.preferred) return f.preferred;
  return fieldName;
}

function previewExcelTemplate() {
  const selections = collectTemplateSelections();
  if (!selections.length) {
    alert("Select at least one component with fields");
    return;
  }
  const components = window.__tplComponents || [];

  // Excel-like preview: sheet tabs + grid
  let html = `
    <div style="font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;">
        <strong>Excel preview</strong>
        <span style="font-size:12px;color:#64748b;">Same layout as the file you will download</span>
      </div>
      <div id="xlsx-preview-tabs" style="display:flex;gap:4px;flex-wrap:wrap;border-bottom:2px solid #e2e8f0;margin-bottom:0;padding-bottom:0;"></div>
      <div id="xlsx-preview-sheets" style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;overflow:auto;max-height:360px;background:#fff;"></div>
      <p style="color:#64748b;font-size:12px;margin:10px 0 0;line-height:1.45;">
        <strong>How to fill:</strong> Checkbox = <code>true</code>/<code>false</code>.
        Dropdown = option value (e.g. <code>h1</code>).
        Multifield = items separated by <code>|</code>.
        Actions = <code>/path::Label | /path2::Label2</code>.
      </p>
    </div>`;

  const body = document.getElementById("modal-body");
  let prev = document.getElementById("tpl-preview-box");
  if (!prev) {
    prev = document.createElement("div");
    prev.id = "tpl-preview-box";
    prev.style.cssText = "margin-bottom:14px;padding:12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;";
    body.insertBefore(prev, body.firstChild);
  }
  prev.innerHTML = html;

  const tabsEl = prev.querySelector("#xlsx-preview-tabs");
  const sheetsEl = prev.querySelector("#xlsx-preview-sheets");

  selections.forEach((sel, idx) => {
    const comp = components.find((c) => c.resourceType === sel.resourceType) || {};
    const colHeaders = ["Page Path", "Instance"].concat(
      sel.fields.map((fn) => preferredLabelForField(comp, fn))
    );

    // Tab button
    const tabBtn = document.createElement("button");
    tabBtn.type = "button";
    tabBtn.textContent = sel.label || sel.resourceType;
    tabBtn.dataset.sheetIdx = String(idx);
    tabBtn.style.cssText = `
      padding:8px 14px;border:none;cursor:pointer;font-size:12px;font-weight:500;
      background:transparent;color:#64748b;border-bottom:2px solid transparent;margin-bottom:-2px;`;
    tabsEl.appendChild(tabBtn);

    // Sheet grid
    const sheet = document.createElement("div");
    sheet.dataset.sheetIdx = String(idx);
    sheet.style.display = idx === 0 ? "block" : "none";
    sheet.style.padding = "0";

    let table = `<table style="border-collapse:collapse;width:max-content;min-width:100%;font-size:12px;">
      <thead><tr>`;
    colHeaders.forEach((h) => {
      table += `<th style="
        background:#1e3a5f;color:#fff;font-weight:600;text-align:left;
        padding:8px 12px;border:1px solid #0f2744;white-space:nowrap;position:sticky;top:0;">${escapeDict(h)}</th>`;
    });
    table += `</tr></thead><tbody>`;

    // 5 empty data rows like Excel template
    for (let r = 0; r < 5; r++) {
      table += `<tr>`;
      colHeaders.forEach((h, c) => {
        // Instance only on first empty example row; CA fills 1,2,3... as needed
        const placeholder = (c === 1 && r === 0) ? "1" : "";
        table += `<td style="
          padding:8px 12px;border:1px solid #e2e8f0;min-width:110px;height:32px;
          background:${r % 2 === 0 ? "#fff" : "#f8fafc"};color:#94a3b8;">${placeholder}</td>`;
      });
      table += `</tr>`;
    }
    table += `</tbody></table>`;
    sheet.innerHTML = table;
    sheetsEl.appendChild(sheet);

    tabBtn.onclick = () => {
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
}


function toggleTplComp(ci, on) {
  const panel = document.getElementById(`tpl-fields-${ci}`);
  if (panel) panel.style.display = on ? "block" : "none";
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
    const include_components_add = !!(document.getElementById("tpl-include-add") || {}).checked;
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

async function loadPreviousTemplates() {
  const msg = document.getElementById("catalog-message");
  const setMsg = (t, ok) => {
    if (msg) {
      msg.textContent = t;
      msg.className = "message " + (ok ? "success" : "error");
    }
  };

  try {
    setMsg("Loading previous templates...", true);
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
    let target = document.getElementById("catalog-list");
    if (!target) {
      target = document.createElement("div");
      target.id = "catalog-list";
      target.style.cssText = "margin-top:14px;";
      const anchor = Array.from(document.querySelectorAll("h3,h2")).find(el =>
        /previous templates|from catalog|template from catalog/i.test(el.textContent || "")
      );
      if (anchor && anchor.parentElement) anchor.parentElement.appendChild(target);
      else document.body.appendChild(target);
    }

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

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("button").forEach((btn) => {
    const t = (btn.textContent || "").trim();
    if (
      t === "Load Component Catalog" ||
      t.includes("Load Component Catalog") ||
      t.includes("Previous Templates") ||
      t.includes("Load Previous Templates")
    ) {
      btn.onclick = function (e) {
        e.preventDefault();
        loadPreviousTemplates();
      };
      if (t.includes("Load Component Catalog")) {
        btn.textContent = "Load Previous Templates";
      }
    }
  });
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


function onTplIncludePagesChange() {
  const box = document.getElementById("tpl-pages-options");
  const cb = document.getElementById("tpl-include-pages");
  const addCb = document.getElementById("tpl-include-add");
  const modeHint = document.getElementById("tpl-mode-hint");
  if (box && cb) box.style.display = cb.checked ? "block" : "none";
  // New page flow → prefer Add sheets; updates belong in a separate template
  if (cb && cb.checked && addCb) {
    addCb.checked = true;
  }
  if (modeHint) {
    if (cb && cb.checked) {
      modeHint.innerHTML = "<strong>Mode: New pages.</strong> Selected components become <em>Add …</em> sheets only (no Instance / update sheets). For updates on existing pages, uncheck Pages and generate a second template.";
    } else {
      modeHint.innerHTML = "<strong>Mode: Update existing.</strong> Selected components become sheets with an <em>Instance</em> column. Use separate Add sheets only if you also tick Components Add.";
    }
  }
}

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
