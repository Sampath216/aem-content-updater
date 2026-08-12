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


// ========== FIELD DICTIONARY + TEMPLATE GENERATOR UI ==========

function ensureToolbarButtons() {
  let bar = document.getElementById("tool-extra-actions");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "tool-extra-actions";
    bar.style.cssText = "display:flex; gap:10px; flex-wrap:wrap; margin:12px 0;";
    const host =
      document.getElementById("page-path-card") ||
      document.getElementById("components-card") ||
      document.querySelector("main") ||
      document.body;
    host.parentNode.insertBefore(bar, host.nextSibling);
  }
  if (!document.getElementById("btn-open-dictionary")) {
    const b1 = document.createElement("button");
    b1.id = "btn-open-dictionary";
    b1.type = "button";
    b1.textContent = "Open Dictionary";
    b1.className = "btn";
    b1.style.cssText = "padding:8px 14px; border-radius:6px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; font-weight:500;";
    b1.onclick = openDictionaryModal;
    bar.appendChild(b1);
  }
  if (!document.getElementById("btn-create-template")) {
    const b2 = document.createElement("button");
    b2.id = "btn-create-template";
    b2.type = "button";
    b2.textContent = "Create Excel Template";
    b2.className = "btn";
    b2.style.cssText = "padding:8px 14px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-weight:500;";
    b2.onclick = openTemplateModal;
    bar.appendChild(b2);
  }
}

function ensureModalRoot() {
  let root = document.getElementById("modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "modal-root";
    document.body.appendChild(root);
  }
  return root;
}

function closeModal() {
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
}

function showModalShell(title, bodyHtml, footerHtml) {
  const root = ensureModalRoot();
  root.innerHTML = `
    <div id="modal-backdrop" style="position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;">
      <div style="background:#fff;border-radius:12px;max-width:960px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.2);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e2e8f0;">
          <h3 style="margin:0;font-size:16px;color:#0f172a;">${title}</h3>
          <button type="button" onclick="closeModal()" style="border:none;background:transparent;font-size:20px;cursor:pointer;line-height:1;">×</button>
        </div>
        <div id="modal-body" style="padding:16px 18px;overflow:auto;flex:1;">${bodyHtml}</div>
        <div id="modal-footer" style="padding:12px 18px;border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">${footerHtml || ""}</div>
      </div>
    </div>`;
}

// ----- Dictionary -----
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
      Select components and fields for the template. Each component appears <strong>once</strong> —
      use the <strong>Instance</strong> column in Excel when the same component appears multiple times on a page.
    </p>`;

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

  try {
    const res = await fetch(`${API_BASE}/api/excel/generate-template`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ include_seo: false, selections }),
    });
    if (!res.ok) {
      let msg = "Template generation failed";
      try {
        const err = await res.json();
        msg = err.message || err.detail || msg;
      } catch (_) {}
      throw new Error(msg);
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

// Boot extra toolbar when DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureToolbarButtons);
} else {
  ensureToolbarButtons();
}
