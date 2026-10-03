// [autopilot-fork] 自动驾驶面板 + 模板行 —— 推荐卡/模板卡（标准卡片，可拖进泳道直接建目标）+ 全局目标/全局提示词 + 行执行 ▶/⏸ + 归档行。
// 工厂作用域组件；自取数据（/api/dsh-graph-autopilot/*），不侵入看板数据流。
// 拖拽协议：卡片 onDragStart 记 apDragPick（工厂作用域），看板泳道落点 onDrop 调 apAdoptIntoLane(target)。
//   target = 版本 slug（落进该版本）| "standalone"（独立目标）| null（草稿/backlog）
// ⚠️ 落点侧必须**无条件挂载** onDragOver/onDrop（不能只在看板自身拖拽状态 anyDrag 为真时才挂）——
//   推荐/模板卡的拖拽不经过看板的 React drag state，条件挂载会让落点根本不存在（曾致「拖上去没反应」）。
let apDragPick = null; // {kind:"rec"|"tpl", idx}
let apPanelWorkspace = null;
let apNoticeSink = null; // AutopilotPanel 挂载时注册：给协议函数（非 React 上下文）回显结果
function apDragStart(kind, idx) { apDragPick = { kind, idx }; }
function apDragEnd() { apDragPick = null; }
function apNotify(text) { try { apNoticeSink && apNoticeSink(text); } catch { /* 面板未挂载 */ } }
function apAdoptIntoLane(target) {
  const pick = apDragPick;
  apDragPick = null;
  if (!pick || !apPanelWorkspace) return;
  const isTpl = pick.kind === "tpl";
  const payload = isTpl
    ? { workspace: apPanelWorkspace, template: pick.idx, version: target === undefined ? null : target }
    : { workspace: apPanelWorkspace, picks: [pick.idx], version: target === undefined ? null : target };
  apNotify("… 正在按" + (isTpl ? "模板" : "推荐") + "建目标");
  fetch("/api/dsh-graph-autopilot/" + (isTpl ? "template-apply" : "adopt"), {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { apNotify("❌ 建目标失败：" + (d?.error ?? "未知错误")); return; }
      const names = (d?.created ?? []).map((c) => `${c.id} ${c.title}`).join("、");
      apNotify("✅ 已建目标：" + (names || "—") + (payload.version ? "（" + payload.version + "）" : "（草稿）"));
      window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: d }));
    })
    .catch((e) => apNotify("❌ 网络错误：" + (e?.message ?? e)));
}

function AutopilotPanel(props) {
  const workspace = props?.workspace ?? null;
  apPanelWorkspace = workspace;
  const [st, setSt] = React.useState(null);
  const [versions, setVersions] = React.useState([]);
  const [goalText, setGoalText] = React.useState("");
  const [promptText, setPromptText] = React.useState("");
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [picked, setPicked] = React.useState({});
  const [runVersion, setRunVersion] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [showArch, setShowArch] = React.useState(false);
  // 拖拽协议（模块作用域函数）在 React 之外执行 → 结果回显走这个注册出口
  apNoticeSink = setMsg;
  React.useEffect(() => () => { if (apNoticeSink === setMsg) apNoticeSink = null; }, []);

  const load = React.useCallback(() => {
    if (!workspace) return;
    fetch("/api/dsh-graph-autopilot/state?workspace=" + encodeURIComponent(workspace), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.ok) return;
        setSt(d);
        setGoalText(d.state?.globalGoal?.text ?? "");
        setPromptText(d.state?.globalPrompt ?? "");
      })
      .catch(() => {});
    fetch("/api/dsh-graph/board?workspace=" + encodeURIComponent(workspace), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const vs = [];
        try { for (const v of (d.versions ?? [])) vs.push(v?.name ?? v?.id ?? v); } catch { /* 形状防御 */ }
        setVersions(vs.filter((x) => typeof x === "string" && x));
      })
      .catch(() => {});
  }, [workspace]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const h = () => load();
    window.addEventListener("autopilot:adopted", h);
    return () => window.removeEventListener("autopilot:adopted", h);
  }, [load]);

  const running = !!(st?.runner && !st.runner.paused);
  React.useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, st?.runner?.current, (st?.runner?.pending ?? []).length, load]);

  const post = (path, body) => {
    setBusy(path);
    return fetch("/api/dsh-graph-autopilot/" + path, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, ...(body ?? {}) }),
    })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) setMsg("❌ " + (data.error ?? "请求失败"));
        else setMsg("");
        return data;
      })
      .catch((e) => { setMsg("❌ " + (e?.message ?? "网络错误")); return null; })
      .finally(() => setBusy(""));
  };

  if (!workspace) return null;

  const btn = { borderRadius: 6, padding: "3px 9px", fontSize: 12, cursor: "pointer", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.12))", color: "inherit", whiteSpace: "nowrap" };
  const btnPrimary = { ...btn, background: "var(--dsw-alias-button-primary-fill, rgba(76,141,255,.9))", color: "#fff", borderColor: "transparent" };
  const chip = { fontSize: 11, borderRadius: 5, padding: "1px 6px", background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))", color: "var(--dsw-alias-label-secondary, inherit)" };
  const input = { flex: 1, minWidth: 160, borderRadius: 6, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "transparent", color: "inherit", padding: "3px 8px", fontSize: 12 };
  const runner = st?.runner ?? null;
  const recs = st?.recommendations ?? [];
  const pickedIdxs = Object.keys(picked).filter((k) => picked[k]).map(Number);
  // 推荐卡类型 → 粗左边框色（与看板卡片视觉约定一致）
  const typeColor = { feature: "#4c8dff", bug: "#e05a5a", task: "#3ecf8e", improvement: "#b07cff", patch: "#e0a53a", chore: "#8a8f98" };

  return h("div", {
    "data-autopilot-panel": "",
    style: { display: "flex", flexDirection: "column", gap: 8, margin: "14px 0 10px", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", background: "var(--dsw-alias-fill-tsp-primary, rgba(128,128,128,.06))", fontSize: 12 },
  },
    // —— 推荐行（标准卡片，可拖进泳道） ——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "💡 推荐"),
      h("button", { style: btn, disabled: !!busy, onClick: () => post("scan", {}).then(load) }, busy === "scan" ? "扫描中…" : "扫描推荐"),
      h("span", { style: chip }, recs.length + " 条"),
      h("span", { style: { opacity: 0.65 } }, "把卡片拖到任意泳道即可建目标执行；或勾选后批量采纳"),
      pickedIdxs.length > 0 && h("button", { style: btn, disabled: !!busy, onClick: () => post("adopt", { picks: pickedIdxs, version: null }).then(() => { setPicked({}); load(); }) }, "采纳所选 → backlog"),
      pickedIdxs.length > 0 && versions.length > 0 && h(React.Fragment, null,
        h("select", { style: input, value: runVersion, onChange: (e) => setRunVersion(e.target.value) },
          h("option", { value: "" }, "选择版本…"),
          versions.map((v) => h("option", { key: v, value: v }, v)),
        ),
        h("button", { style: btnPrimary, disabled: !!busy || !runVersion, onClick: () => post("adopt", { picks: pickedIdxs, version: runVersion, run: true }).then(() => { setPicked({}); load(); }) }, "采纳并 ▶ 自动执行"),
      ),
    ),
    recs.length > 0 && h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 } },
      recs.map((r, i) => h("div", {
        key: i,
        draggable: true,
        title: "拖到泳道即建目标；松手即采纳",
        onDragStart: (e) => { try { e.dataTransfer.setData("text/plain", "autopilot-rec:" + (i + 1)); e.dataTransfer.effectAllowed = "copy"; } catch { /* 旧引擎 */ } apDragStart("rec", i + 1); },
        onDragEnd: () => apDragEnd(),
        style: {
          background: "var(--dsw-alias-bg-card, rgba(24,26,32,.85))", borderRadius: 8, padding: "8px 10px",
          border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
          borderLeft: "3px solid " + (typeColor[r.type] ?? "#4c8dff"),
          cursor: "grab", display: "flex", flexDirection: "column", gap: 4,
        },
      },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          h("input", { type: "checkbox", checked: !!picked[i + 1], onClick: (e) => e.stopPropagation(), onChange: (e) => setPicked((p) => ({ ...p, [i + 1]: e.target.checked })) }),
          h("b", { style: { fontSize: 12 } }, r.title),
          h("span", { style: chip }, r.type),
        ),
        h("div", { style: { opacity: 0.72, fontSize: 11 } }, r.description),
        Array.isArray(r.criteria) && r.criteria.length > 0 && h("div", { style: { opacity: 0.55, fontSize: 11 } }, "判据: " + r.criteria.slice(0, 2).join(" / ") + (r.criteria.length > 2 ? " …" : "")),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 2 } },
          h("span", { style: { opacity: 0.5, fontSize: 11 } }, "来源: " + (r.reason ?? "")),
          h("span", { style: { flex: 1 } }),
          h("button", { style: { ...btn, fontSize: 11, padding: "2px 7px" }, disabled: !!busy, onClick: (e) => { e.stopPropagation(); post("adopt", { picks: [i + 1], version: null }).then(load); } }, "采纳"),
        ),
      )),
    ),
    // —— 全局目标 + 全局提示词 ——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "🎯 全局目标"),
      h("input", { style: input, value: goalText, placeholder: "输入全局目标：推荐与持续检查以此为核心", onChange: (e) => setGoalText(e.target.value) }),
      h("button", { style: btnPrimary, disabled: !!busy, onClick: () => post("global-goal", { text: goalText }).then(load) }, busy === "global-goal" ? "…" : "保存"),
      h("button", { style: btn, onClick: () => setPromptOpen(!promptOpen) }, promptOpen ? "收起全局提示词" : "全局提示词"),
    ),
    promptOpen && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "0 0 0 14px" } },
      h("textarea", {
        style: { ...input, minWidth: 0, height: 64, resize: "vertical", fontFamily: "inherit" },
        value: promptText,
        placeholder: "全局提示词：设置后所有子 AI（执行/推荐/检查）都必须遵循；可随时修改，立即对后续派发生效。空保存=清除。",
        onChange: (e) => setPromptText(e.target.value),
      }),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("button", { style: btnPrimary, disabled: !!busy, onClick: () => post("global-prompt", { text: promptText }).then(load) }, busy === "global-prompt" ? "…" : "保存全局提示词"),
        h("span", { style: chip }, st?.state?.autoPreset ? "自动选预设：开" : "自动选预设：关"),
      ),
    ),
    // —— 行执行（每版本 ▶）——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "▶ 行执行"),
      runner
        ? h("button", { style: { ...btn, color: "#e05a5a" }, disabled: !!busy, onClick: () => post("stop", {}).then(load) }, "⏸ 中断本行")
        : null,
      runner && h("span", { style: chip }, `执行中: ${runner.version} · 当前 ${runner.current ?? "—"} · 待办 ${(runner.pending ?? []).length} · 完成 ${(runner.done ?? []).length}${(runner.failed ?? []).length ? " · 失败 " + runner.failed.length : ""}${runner.paused ? " · ⏸ " + runner.paused : ""}`),
      !runner && versions.map((v) => h("button", { key: v, style: btn, disabled: !!busy, title: `自动驾驶 ${v}：逐目标 收集→执行→评审→交付`, onClick: () => post("run", { version: v }).then(load) }, "▶ " + v)),
      !runner && versions.length === 0 && h("span", { style: { opacity: 0.6 } }, "暂无版本泳道"),
    ),
    // —— 归档行 ——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "🗄 归档"),
      (st?.delivered ?? []).map((g) => h("span", { key: g.id, style: { display: "inline-flex", gap: 4, alignItems: "center" } },
        h("span", { style: chip }, g.id + " " + g.title),
        h("button", { style: btn, disabled: !!busy, title: "归档该已交付目标", onClick: () => post("archive", { goal: g.id }).then(load) }, "归档"),
      )),
      (st?.delivered ?? []).length === 0 && h("span", { style: { opacity: 0.6 } }, "暂无待归档的已交付目标"),
      (st?.archived ?? []).length > 0 && h("button", { style: btn, onClick: () => setShowArch(!showArch) }, `已归档 ${st.archived.length}`),
    ),
    showArch && h("div", { style: { display: "flex", flexDirection: "column", gap: 2, padding: "2px 0 0 14px", opacity: 0.8 } },
      (st?.archived ?? []).map((g, i) => h("span", { key: i, style: chip }, `${g.id} ${g.title} · ${g.from}`)),
    ),
    msg && h("div", { style: { color: "#e05a5a" } }, msg),
  );
}
// ---------------------------------------------------------------------------
// 模板行（看板最底部一行）：可复用目标蓝图 —— 卡片直接拖到任意泳道即按模板建目标
// ---------------------------------------------------------------------------
const AP_TEMPLATE_TYPES = ["feature", "bug", "task", "improvement", "patch", "chore"];

function TemplateLane(props) {
  const workspace = props?.workspace ?? null;
  if (workspace) apPanelWorkspace = workspace; // 保底：面板未挂载时模板拖拽也有 workspace
  const [items, setItems] = React.useState([]);
  const [form, setForm] = React.useState(null); // {id?, title, type, description, criteriaText}
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");

  const load = React.useCallback(() => {
    if (!workspace) return;
    fetch("/api/dsh-graph-autopilot/templates", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "list" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setItems(Array.isArray(d.templates) ? d.templates : []); })
      .catch(() => {});
  }, [workspace]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const h = () => load();
    window.addEventListener("autopilot:adopted", h);
    return () => window.removeEventListener("autopilot:adopted", h);
  }, [load]);

  const send = (body) => fetch("/api/dsh-graph-autopilot/templates", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace, ...body }),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d })));

  const save = () => {
    if (!form) return;
    const title = String(form.title ?? "").trim();
    if (!title) { setMsg("❌ 模板标题不能为空"); return; }
    setBusy(true); setMsg("");
    send({
      action: form.id ? "update" : "create",
      id: form.id ?? null,
      title,
      type: form.type,
      description: form.description,
      criteria: String(form.criteriaText ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    })
      .then(({ ok, d }) => {
        if (!ok) setMsg("❌ " + (d?.error ?? "保存失败"));
        else { setItems(Array.isArray(d.templates) ? d.templates : []); setForm(null); setMsg(""); }
      })
      .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
      .finally(() => setBusy(false));
  };

  const del = (id) => {
    setBusy(true);
    send({ action: "delete", id })
      .then(({ ok, d }) => {
        if (!ok) setMsg("❌ " + (d?.error ?? "删除失败"));
        else { setItems(Array.isArray(d.templates) ? d.templates : []); setMsg(""); }
      })
      .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
      .finally(() => setBusy(false));
  };

  const btn = { borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.12))", color: "inherit", whiteSpace: "nowrap" };
  const btnPrimary = { ...btn, background: "var(--dsw-alias-button-primary-fill, rgba(76,141,255,.9))", color: "#fff", borderColor: "transparent" };
  const chip = { fontSize: 11, borderRadius: 5, padding: "0 6px", background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))", color: "var(--dsw-alias-label-secondary, inherit)" };
  const input = { borderRadius: 6, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "transparent", color: "inherit", padding: "3px 8px", fontSize: 12, fontFamily: "inherit" };
  const labelBg = "rgba(128,128,128,.10)";

  const labelEl = h("div", {
    key: "tpl-lane-label",
    style: { padding: "8px 10px", borderRadius: 8, background: labelBg, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start", justifyContent: "center", minWidth: 0, ...(props?.fullWidth ? { gridColumn: "1 / -1" } : {}) },
  },
    h("span", { style: { fontWeight: 700, fontSize: 12 } }, "🧩 模板 · " + items.length),
    h("button", {
      style: btn, disabled: !!busy,
      title: "新建模板：填写标题/类型/描述/判据，之后拖到泳道即可复用",
      onClick: () => setForm((f) => f ?? { id: null, title: "", type: "task", description: "", criteriaText: "" }),
    }, "＋ 新建"),
  );

  const cards = items.length > 0
    ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 } },
      items.map((t) => h("div", {
        key: t.id,
        draggable: true,
        title: "拖到任意泳道/列即按模板建目标；模板保留可重复使用",
        onDragStart: (e) => {
          try { e.dataTransfer.setData("text/plain", "autopilot-tpl:" + t.id); e.dataTransfer.effectAllowed = "copy"; } catch { /* 旧引擎 */ }
          apDragStart("tpl", t.id);
        },
        onDragEnd: () => apDragEnd(),
        style: {
          background: "var(--dsw-alias-bg-card, rgba(24,26,32,.85))", borderRadius: 8, padding: "8px 10px",
          border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
          borderLeft: "3px solid #8a8f98", cursor: "grab", display: "flex", flexDirection: "column", gap: 4, fontSize: 12,
        },
      },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          h("b", { style: { fontSize: 12 } }, t.title),
          h("span", { style: chip }, t.type),
        ),
        t.description && h("div", { style: { opacity: 0.72, fontSize: 11 } }, t.description),
        Array.isArray(t.criteria) && t.criteria.length > 0 && h("div", { style: { opacity: 0.55, fontSize: 11 } }, "判据: " + t.criteria.slice(0, 2).join(" / ") + (t.criteria.length > 2 ? " …" : "")),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 2 } },
          h("span", { style: { flex: 1 } }),
          h("button", { style: btn, disabled: !!busy, onClick: () => setForm({ id: t.id, title: t.title, type: t.type, description: t.description, criteriaText: (t.criteria ?? []).join("\n") }) }, "✎ 编辑"),
          h("button", { style: btn, disabled: !!busy, onClick: () => del(t.id) }, "✕ 删除"),
        ),
      )))
    : h("div", { style: { opacity: 0.6, fontSize: 12, padding: "6px 0" } }, "暂无模板。点「＋ 新建」建一个可复用任务蓝图；建好后把卡片拖到上方任意泳道即可建目标执行。");

  const contentEl = h("div", {
    key: "tpl-lane-body",
    style: { gridColumn: props?.fullWidth ? "1 / -1" : "2 / -1", display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "8px 10px", borderRadius: 8, background: "rgba(128,128,128,.04)" },
  },
    form && h("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 8, border: "1px dashed var(--dsw-alias-border-secondary, rgba(128,128,128,.4))" } },
      h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        h("span", { style: { fontSize: 12, fontWeight: 700 } }, form.id ? "编辑模板" : "新建模板"),
        h("input", { style: { ...input, flex: 1, minWidth: 180 }, placeholder: "模板标题（必填）", value: form.title, onChange: (e) => setForm((f) => ({ ...f, title: e.target.value })) }),
        h("select", { style: input, value: form.type, onChange: (e) => setForm((f) => ({ ...f, type: e.target.value })) },
          AP_TEMPLATE_TYPES.map((t) => h("option", { key: t, value: t }, t))),
      ),
      h("textarea", { style: { ...input, height: 44, resize: "vertical" }, placeholder: "任务描述（会写进 goal.md）", value: form.description, onChange: (e) => setForm((f) => ({ ...f, description: e.target.value })) }),
      h("textarea", { style: { ...input, height: 44, resize: "vertical" }, placeholder: "验收判据，一行一条（建目标时自动写入并确认）", value: form.criteriaText, onChange: (e) => setForm((f) => ({ ...f, criteriaText: e.target.value })) }),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("button", { style: btnPrimary, disabled: !!busy, onClick: save }, busy ? "…" : "保存模板"),
        h("button", { style: btn, disabled: !!busy, onClick: () => { setForm(null); setMsg(""); } }, "取消"),
        msg && h("span", { style: { color: "#e05a5a", fontSize: 11 } }, msg),
      ),
    ),
    !form && msg && h("div", { style: { color: "#e05a5a", fontSize: 11 } }, msg),
    cards,
  );

  return h(React.Fragment, null, labelEl, contentEl);
}

>>>ESM-EXPORTS-START>>>
// 仅 node --test / 静态检查用；浏览器 bundle 由 build-client.sh 剥离本块。
export { AutopilotPanel, TemplateLane, apDragStart, apDragEnd, apAdoptIntoLane };
<<<ESM-EXPORTS-END<<<
