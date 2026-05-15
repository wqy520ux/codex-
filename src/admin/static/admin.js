// Admin panel — vanilla JS controller.
//
// The whole UI is plain DOM. We deliberately avoid a framework so the
// admin bundle has zero build step and the file you see is the file
// the browser runs.
//
// API surface:
//   GET  /admin/api/status
//   GET  /admin/api/config           (secrets masked)
//   GET  /admin/api/config/raw       (secrets in clear, for edit forms)
//   GET  /admin/api/preset_providers
//   PUT  /admin/api/providers/:name
//   DEL  /admin/api/providers/:name
//   PUT  /admin/api/model_mappings/:alias
//   DEL  /admin/api/model_mappings/:alias
//   PATCH /admin/api/settings
//   POST /admin/api/providers/:name/test

const state = {
  config: null,        // raw config (with secrets) – for edit forms
  configMasked: null,  // masked snapshot – for display
  presets: [],
};

// ---------- helpers --------------------------------------------------------

function $(sel, root = document) {
  return root.querySelector(sel);
}
function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function toast(message, kind = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.className = kind;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  // If admin_key is configured we still need it on these requests
  // because the auth middleware enforces it for any non-/healthz path.
  // The page is loaded over the same port; we read the user's token
  // from a localStorage slot that the user can populate via the URL
  // hash (#key=...) on first load.
  const stored = localStorage.getItem("adminKey");
  if (stored) {
    opts.headers["Authorization"] = `Bearer ${stored}`;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      (parsed && parsed.error && parsed.error.message) ||
      (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function fmtDuration(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

// ---------- admin_key bootstrap -------------------------------------------

function bootstrapAdminKey() {
  // Allow the user to seed `localStorage.adminKey` via `#key=...`
  // hash on first load (user pastes it once and the URL is cleaned).
  const hash = window.location.hash;
  if (hash && hash.startsWith("#key=")) {
    localStorage.setItem("adminKey", decodeURIComponent(hash.slice(5)));
    history.replaceState(null, "", window.location.pathname);
  }
}

// ---------- tabs -----------------------------------------------------------

function setupTabs() {
  $$(".tab-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      activateTab(a.dataset.tab);
    });
  });
  activateTab("dashboard");
}

function activateTab(name) {
  $$(".tab-panel").forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
  });
  $$(".tab-link").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === name);
  });
  if (name === "dashboard") refreshStatus();
  if (name === "providers") refreshProviders();
  if (name === "mappings") refreshMappings();
  if (name === "settings") refreshSettings();
}

// ---------- dashboard ------------------------------------------------------

async function refreshStatus() {
  try {
    const status = await api("GET", "/admin/api/status");
    $("#dash-listening").textContent = status.listening_on;
    $("#dash-uptime").textContent = fmtDuration(status.uptime_ms);
    $("#dash-providers-count").textContent = String(status.providers_count);
    $("#dash-mappings-count").textContent = String(status.mappings_count);
    $("#dash-admin-key-status").textContent = status.admin_key_configured
      ? "admin_key 已配置（远程访问需 Bearer 鉴权）"
      : "admin_key 未配置（仅 127.0.0.1/::1 回环可访问）";
    $("#status-line").textContent = `运行中 · ${status.listening_on}`;

    const tbody = $("#recent-table tbody");
    tbody.innerHTML = "";
    for (const r of status.recent_requests) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtTime(r.ts)}</td>
        <td>${r.method ?? "—"}</td>
        <td><code>${r.path ?? "—"}</code></td>
        <td>${r.status ?? "—"}</td>
        <td>${r.latency_ms ?? "—"}</td>
        <td>${r.model ?? "—"}</td>
        <td>${r.provider ?? "—"}</td>
        <td>${r.stream ? "✓" : ""}</td>
      `;
      tbody.appendChild(tr);
    }
    if (status.recent_requests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8"><em>暂无请求</em></td></tr>`;
    }

    const cfg = state.configMasked;
    if (cfg) {
      const port = cfg.listen?.port ?? "11434";
      const host = cfg.listen?.host ?? "127.0.0.1";
      const firstAlias = (cfg.model_mappings && cfg.model_mappings[0]?.alias) || "gpt-4o";
      $("#codex-snippet").textContent =
        `export OPENAI_BASE_URL=http://${host}:${port}/v1\n` +
        `export OPENAI_API_KEY=${status.admin_key_configured ? "<your admin_key>" : "any-string"}\n` +
        `codex --model ${firstAlias}`;
    }
  } catch (err) {
    $("#status-line").textContent = `错误：${err.message}`;
    toast(`刷新状态失败：${err.message}`, "error");
  }
}

// ---------- providers ------------------------------------------------------

async function loadConfig() {
  const [masked, raw, presets] = await Promise.all([
    api("GET", "/admin/api/config"),
    api("GET", "/admin/api/config/raw"),
    api("GET", "/admin/api/preset_providers"),
  ]);
  state.configMasked = masked.config;
  state.config = raw;
  state.presets = presets.presets || [];
}

async function refreshProviders() {
  try {
    await loadConfig();
    const tbody = $("#providers-table tbody");
    tbody.innerHTML = "";
    for (const p of state.config.providers) {
      const tr = document.createElement("tr");
      const caps = [];
      if (p.capabilities?.vision) caps.push("vision");
      if (p.capabilities?.reasoning) caps.push("reasoning");
      tr.innerHTML = `
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td><code>${escapeHtml(p.base_url)}</code></td>
        <td>${(p.models || []).map(escapeHtml).join(", ")}</td>
        <td>${caps.join(", ") || "—"}</td>
        <td>
          <div class="row-actions">
            <button class="tiny" data-act="edit" data-name="${escapeAttr(p.name)}">编辑</button>
            <button class="tiny secondary" data-act="test" data-name="${escapeAttr(p.name)}">测试连接</button>
            <button class="tiny contrast" data-act="del" data-name="${escapeAttr(p.name)}">删除</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
    if (state.config.providers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5"><em>暂无 Provider，点右上"新增"或选择预设导入</em></td></tr>`;
    }

    // Wire row actions. Use the `onclick` property (single slot) so
    // each `refreshProviders()` rebind cleanly replaces the previous
    // listener — `addEventListener({once: true})` would die after the
    // first click and addEventListener without `once` would stack
    // duplicate handlers.
    tbody.onclick = onProvidersClick;

    // Populate preset picker
    const picker = $("#preset-picker");
    picker.innerHTML = `<option value="">— 从预设导入 —</option>` +
      state.presets
        .map(
          (p) =>
            `<option value="${escapeAttr(p.suggestedName)}">${escapeHtml(p.label || p.suggestedName)}</option>`,
        )
        .join("");
  } catch (err) {
    toast(`加载 Providers 失败：${err.message}`, "error");
  }
}

function onProvidersClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const name = btn.dataset.name;
  if (btn.dataset.act === "edit") openProviderDialog(name);
  if (btn.dataset.act === "del") deleteProvider(name);
  if (btn.dataset.act === "test") testProvider(name);
}

function openProviderDialog(name) {
  const dlg = $("#dlg-provider");
  const form = $("#form-provider");
  form.reset();
  if (name) {
    const p = state.config.providers.find((x) => x.name === name);
    if (!p) {
      toast(`Provider ${name} 不存在`, "error");
      return;
    }
    $("#dlg-provider-title").textContent = `编辑 Provider · ${name}`;
    form._orig_name.value = name;
    form.name.value = p.name;
    form.base_url.value = p.base_url;
    form.api_key.value = p.api_key;
    form.models.value = (p.models || []).join(", ");
    form.cap_vision.checked = !!p.capabilities?.vision;
    form.cap_reasoning.checked = !!p.capabilities?.reasoning;
    form.reasoning_param_name.value = p.reasoning_param_name ?? "";
    form.timeout_ms.value = p.timeout_ms ?? "";
    form.max_retries.value = p.max_retries ?? "";
    form.max_connections.value = p.max_connections ?? "";
  } else {
    $("#dlg-provider-title").textContent = "新增 Provider";
    form._orig_name.value = "";
  }
  dlg.showModal();
}

function buildProviderPayload(form) {
  const num = (v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const body = {
    base_url: form.base_url.value.trim(),
    api_key: form.api_key.value,
    models: form.models.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    capabilities: {
      vision: !!form.cap_vision.checked,
      reasoning: !!form.cap_reasoning.checked,
    },
  };
  const rp = form.reasoning_param_name.value.trim();
  if (rp) body.reasoning_param_name = rp;
  const t = num(form.timeout_ms.value);
  if (t !== undefined) body.timeout_ms = t;
  const r = num(form.max_retries.value);
  if (r !== undefined) body.max_retries = r;
  const c = num(form.max_connections.value);
  if (c !== undefined) body.max_connections = c;
  return body;
}

async function submitProviderForm(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const newName = form.name.value.trim();
  const origName = form._orig_name.value.trim();
  const payload = buildProviderPayload(form);
  try {
    if (origName && origName !== newName) {
      // Rename: create new, then delete old. Persist op is atomic
      // per call so a failure here only leaves the old entry intact.
      await api("PUT", `/admin/api/providers/${encodeURIComponent(newName)}`, payload);
      await api("DELETE", `/admin/api/providers/${encodeURIComponent(origName)}`);
    } else {
      await api("PUT", `/admin/api/providers/${encodeURIComponent(newName)}`, payload);
    }
    $("#dlg-provider").close();
    toast(`已保存 Provider ${newName}`, "success");
    await refreshProviders();
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  }
}

async function deleteProvider(name) {
  if (!confirm(`确认删除 Provider "${name}"？`)) return;
  try {
    await api("DELETE", `/admin/api/providers/${encodeURIComponent(name)}`);
    toast(`已删除 ${name}`, "success");
    await refreshProviders();
  } catch (err) {
    toast(`删除失败：${err.message}`, "error");
  }
}

async function testProvider(name) {
  const dlg = $("#dlg-test");
  const result = $("#test-result");
  result.innerHTML = `<p>正在请求 <code>${escapeHtml(name)}</code> …</p>`;
  dlg.showModal();
  try {
    const r = await api("POST", `/admin/api/providers/${encodeURIComponent(name)}/test`);
    if (r.ok) {
      result.innerHTML = `
        <p class="test-ok">✓ 连接成功</p>
        <p class="test-line">HTTP ${r.status_code} · ${r.latency_ms}ms</p>
        <p class="test-line">样本: <code>${escapeHtml(r.sample || "(空)")}</code></p>
      `;
    } else {
      result.innerHTML = `
        <p class="test-fail">✗ 连接失败</p>
        <p class="test-line">类型: <code>${escapeHtml(r.error_type || "—")}</code></p>
        <p class="test-line">消息: <code>${escapeHtml(r.error_message || "—")}</code></p>
        <p class="test-line">耗时: ${r.latency_ms}ms</p>
      `;
    }
  } catch (err) {
    result.innerHTML = `<p class="test-fail">✗ ${escapeHtml(err.message)}</p>`;
  }
}

// preset import: copy preset fields into a new dialog
function importPreset(suggestedName) {
  if (!suggestedName) return;
  const preset = state.presets.find((p) => p.suggestedName === suggestedName);
  if (!preset) return;
  const dlg = $("#dlg-provider");
  const form = $("#form-provider");
  form.reset();
  $("#dlg-provider-title").textContent = `从预设新增 · ${preset.label || preset.suggestedName}`;
  form._orig_name.value = "";
  form.name.value = preset.suggestedName;
  form.base_url.value = preset.base_url || "";
  form.api_key.value = "";
  form.models.value = (preset.models || []).join(", ");
  form.cap_vision.checked = !!preset.capabilities?.vision;
  form.cap_reasoning.checked = !!preset.capabilities?.reasoning;
  form.reasoning_param_name.value = preset.reasoning_param_name ?? "";
  dlg.showModal();
}

// ---------- mappings -------------------------------------------------------

async function refreshMappings() {
  try {
    await loadConfig();
    const tbody = $("#mappings-table tbody");
    tbody.innerHTML = "";
    for (const m of state.config.model_mappings) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(m.alias)}</strong></td>
        <td>${escapeHtml(m.provider)}</td>
        <td><code>${escapeHtml(m.upstream_model)}</code></td>
        <td>
          <div class="row-actions">
            <button class="tiny" data-act="edit" data-alias="${escapeAttr(m.alias)}">编辑</button>
            <button class="tiny contrast" data-act="del" data-alias="${escapeAttr(m.alias)}">删除</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
    if (state.config.model_mappings.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><em>暂无映射</em></td></tr>`;
    }
    // Single-slot listener; see refreshProviders() for the same pattern.
    tbody.onclick = onMappingsClick;
  } catch (err) {
    toast(`加载映射失败：${err.message}`, "error");
  }
}

function onMappingsClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const alias = btn.dataset.alias;
  if (btn.dataset.act === "edit") openMappingDialog(alias);
  if (btn.dataset.act === "del") deleteMapping(alias);
}

function openMappingDialog(alias) {
  const dlg = $("#dlg-mapping");
  const form = $("#form-mapping");
  form.reset();
  // Repopulate provider <select> from current config
  const sel = form.provider;
  sel.innerHTML = state.config.providers
    .map((p) => `<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`)
    .join("");
  if (alias) {
    const m = state.config.model_mappings.find((x) => x.alias === alias);
    if (!m) {
      toast(`映射 ${alias} 不存在`, "error");
      return;
    }
    $("#dlg-mapping-title").textContent = `编辑映射 · ${alias}`;
    form._orig_alias.value = alias;
    form.alias.value = m.alias;
    sel.value = m.provider;
    form.upstream_model.value = m.upstream_model;
  } else {
    $("#dlg-mapping-title").textContent = "新增模型映射";
    form._orig_alias.value = "";
  }
  dlg.showModal();
}

async function submitMappingForm(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const newAlias = form.alias.value.trim();
  const origAlias = form._orig_alias.value.trim();
  const payload = {
    provider: form.provider.value,
    upstream_model: form.upstream_model.value.trim(),
  };
  try {
    if (origAlias && origAlias !== newAlias) {
      await api(
        "PUT",
        `/admin/api/model_mappings/${encodeURIComponent(newAlias)}`,
        payload,
      );
      await api(
        "DELETE",
        `/admin/api/model_mappings/${encodeURIComponent(origAlias)}`,
      );
    } else {
      await api(
        "PUT",
        `/admin/api/model_mappings/${encodeURIComponent(newAlias)}`,
        payload,
      );
    }
    $("#dlg-mapping").close();
    toast(`已保存映射 ${newAlias}`, "success");
    await refreshMappings();
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  }
}

async function deleteMapping(alias) {
  if (!confirm(`确认删除映射 "${alias}"？`)) return;
  try {
    await api(
      "DELETE",
      `/admin/api/model_mappings/${encodeURIComponent(alias)}`,
    );
    toast(`已删除映射 ${alias}`, "success");
    await refreshMappings();
  } catch (err) {
    toast(`删除失败：${err.message}`, "error");
  }
}

// ---------- settings -------------------------------------------------------

async function refreshSettings() {
  try {
    await loadConfig();
    const cfg = state.config;
    const f = $("#settings-form");
    f["listen.host"].value = cfg.listen?.host ?? "127.0.0.1";
    f["listen.port"].value = cfg.listen?.port ?? 11434;
    f["listen.max_concurrency"].value = cfg.listen?.max_concurrency ?? 64;
    f["log.level"].value = cfg.log?.level ?? "info";
    f["log.record_bodies"].checked = !!cfg.log?.record_bodies;
    f["log.record_dir"].value = cfg.log?.record_dir ?? "";
    f["default_model"].value = cfg.default_model ?? "";
    f["admin_key"].value = cfg.admin_key ?? "";
    const masked = await api("GET", "/admin/api/config");
    $("#yaml-preview").textContent = masked.yaml || "";
  } catch (err) {
    toast(`加载设置失败：${err.message}`, "error");
  }
}

async function submitSettingsForm(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const portStr = f["listen.port"].value;
  const concStr = f["listen.max_concurrency"].value;
  const payload = {
    listen: {
      host: f["listen.host"].value.trim(),
      ...(portStr ? { port: Number(portStr) } : {}),
      ...(concStr ? { max_concurrency: Number(concStr) } : {}),
    },
    log: {
      level: f["log.level"].value,
      record_bodies: !!f["log.record_bodies"].checked,
      record_dir: f["log.record_dir"].value.trim() || undefined,
    },
    default_model: f["default_model"].value.trim() || null,
    admin_key: f["admin_key"].value || null,
  };
  try {
    await api("PATCH", "/admin/api/settings", payload);
    toast("已保存设置（部分字段如 listen.port 需重启生效）", "success");
    if (payload.admin_key) {
      // Persist locally so subsequent admin requests carry the new
      // bearer header automatically.
      localStorage.setItem("adminKey", payload.admin_key);
    } else {
      localStorage.removeItem("adminKey");
    }
    await refreshSettings();
    await refreshStatus();
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  }
}

// ---------- escaping -------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---------- bootstrap ------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  bootstrapAdminKey();
  setupTabs();

  // Wire dialog close buttons (data-close-dialog="<id>")
  document.body.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close-dialog]");
    if (closer) {
      e.preventDefault();
      const id = closer.getAttribute("data-close-dialog");
      const dlg = document.getElementById(id);
      if (dlg && typeof dlg.close === "function") dlg.close();
    }
  });

  $("#btn-new-provider").addEventListener("click", () => openProviderDialog(null));
  $("#btn-new-mapping").addEventListener("click", () => openMappingDialog(null));
  $("#preset-picker").addEventListener("change", (e) => {
    importPreset(e.target.value);
    e.target.value = "";
  });
  $("#form-provider").addEventListener("submit", submitProviderForm);
  $("#form-mapping").addEventListener("submit", submitMappingForm);
  $("#settings-form").addEventListener("submit", submitSettingsForm);

  try {
    await loadConfig();
    await refreshStatus();
  } catch (err) {
    if (err.status === 401) {
      const k = prompt(
        "服务端配置了 admin_key。请输入用于浏览器访问的 admin_key：",
      );
      if (k) {
        localStorage.setItem("adminKey", k);
        location.reload();
      }
    } else {
      toast(`初始化失败：${err.message}`, "error");
    }
  }

  // Auto-refresh dashboard every 5s while it's the active tab.
  setInterval(() => {
    const dash = $("#tab-dashboard");
    if (!dash.hidden) refreshStatus();
  }, 5000);
});
