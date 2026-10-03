// [autopilot-fork] 自动驾驶面板 + 模板行 —— 推荐卡/模板卡（标准卡片，可拖进泳道直接建目标）+ 全局目标/全局提示词 + 执行状态行（启停在泳道行头 ▶/■）+ 归档行。
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
  const version = target === undefined ? null : target;
  // [v0.18] 从回收站拖出：恢复该目标并直接落到目标泳道
  if (pick.kind === "trash") {
    apNotify("… 正在从回收站恢复到 " + (version || "草稿"));
    fetch("/api/dsh-graph-autopilot/trash", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: apPanelWorkspace, action: "restore-goal", goal: pick.idx, version }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { apNotify("❌ 恢复失败：" + (d?.error ?? "未知错误")); return; }
        apNotify("✅ 已恢复并落到 " + (version || "草稿") + "：" + (d?.restored ?? ""));
        window.dispatchEvent(new CustomEvent("autopilot:trash-changed"));
        window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: d }));
      })
      .catch((e) => apNotify("❌ 网络错误：" + (e?.message ?? e)));
    return;
  }
  const isTpl = pick.kind === "tpl";
  const payload = isTpl
    ? { workspace: apPanelWorkspace, template: pick.idx, version }
    : { workspace: apPanelWorkspace, picks: [pick.idx], version };
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

// ---------------------------------------------------------------------------
// [v0.24] 行运行按钮：运行中的泳道按钮变绿并可点中断，附「运行中」提示
// ---------------------------------------------------------------------------
let apRunState = { version: null, paused: null };
const apRunSubs = new Set();
let apRunTimer = null;
function apRunEnsurePoll() {
  if (apRunTimer) return;
  apRunTimer = setInterval(() => {
    if (!apPanelWorkspace) return;
    fetch("/api/dsh-graph-autopilot/state?workspace=" + encodeURIComponent(apPanelWorkspace), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.ok) return;
        apRunState = { version: d.runner?.version ?? null, paused: d.runner?.paused ?? null };
        for (const s of apRunSubs) { try { s(apRunState); } catch { /* 订阅者已卸载 */ } }
      })
      .catch(() => {});
  }, 5000);
  if (apRunTimer.unref) apRunTimer.unref();
}

function LaneRunButton(props) {
  const version = props?.lane ? String(props.lane) : "";
  const label = props?.label ?? version;
  const [st, setSt] = React.useState(apRunState);
  React.useEffect(() => {
    apRunEnsurePoll();
    const s = (v) => setSt(v);
    apRunSubs.add(s);
    s(apRunState);
    return () => { apRunSubs.delete(s); };
  }, []);
  const running = !!version && st.version === version;
  // [v0.28] 问题(P1)：按钮只用图标——原「■ 运行中」文字太宽，绝对定位在行头右侧会盖住「后端/交互」等泳道标题。
  // 运行中=绿色「■」（title 说明点此中断），未运行=灰「▶」；padding 收窄为 "0 4px"。位置约定不变（right:34，旁边 right:6 是「＋」）。
  const base = { ...AP_ROW_BTN, position: "absolute", right: 34, top: 8, bottom: "auto", fontSize: 11, padding: "0 4px", lineHeight: 1.4 };
  return h("button", {
    style: running ? { ...base, background: "#2e9e5b", borderColor: "#2e9e5b", color: "#fff", fontWeight: 700 } : base,
    className: "dg-btn",
    "data-ap-run-btn": version,
    title: running ? "运行中：点此中断" : "自动驾驶本行：逐目标 收集→执行→评审→交付",
    onClick: (e) => { e.stopPropagation(); if (running) apStopLane(label); else apRunLane(version, label); },
  }, running ? "■" : "▶");
}

/** [v0.20] 行自带 ▶：直接在这个泳道行上启动自动驾驶（不用回面板） */
function apRunLane(version, label) {
  if (!version || !apPanelWorkspace) return;
  apNotify("▶ 正在启动「" + (label || version) + "」的自动驾驶…");
  fetch("/api/dsh-graph-autopilot/run", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: apPanelWorkspace, version }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { apNotify("❌ 启动失败：" + (d?.error ?? "未知错误")); return; }
      apNotify("✅ 已启动自动驾驶：" + (label || version));
      window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: d }));
    })
    .catch((e) => apNotify("❌ 网络错误：" + (e?.message ?? e)));
}

/** [v0.20] 行自带 ⏸：中断本行自动驾驶 */
function apStopLane(label) {
  if (!apPanelWorkspace) return;
  apNotify("⏸ 正在中断" + (label ? "「" + label + "」" : "") + "的自动驾驶…");
  fetch("/api/dsh-graph-autopilot/stop", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: apPanelWorkspace }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { apNotify("❌ 中断失败：" + (d?.error ?? "未知错误")); return; }
      apNotify("⏸ 已中断本行自动驾驶");
      window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: d }));
    })
    .catch((e) => apNotify("❌ 网络错误：" + (e?.message ?? e)));
}

/** [v0.18] 看板卡片拖到回收站 = 归档该目标（可从回收站恢复） */
function apArchiveGoal(goalId) {
  if (!goalId || !apPanelWorkspace) return;
  apNotify("… 正在移入回收站：" + goalId);
  fetch("/api/dsh-graph-autopilot/archive", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: apPanelWorkspace, goal: goalId }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { apNotify("❌ 移入回收站失败：" + (d?.error ?? "未知错误")); return; }
      apNotify("🗑 已移入回收站：" + goalId + "（可在回收站恢复）");
      window.dispatchEvent(new CustomEvent("autopilot:trash-changed"));
      window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: { archived: goalId } }));
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
  // [v0.18] 推荐管理员 + 协作频道
  const [mgr, setMgr] = React.useState(null);
  const [mgrPrompt, setMgrPrompt] = React.useState("");
  const [recHint, setRecHint] = React.useState(""); // [v0.19] 按输入内容推荐
  const [laneSel, setLaneSel] = React.useState("");
  const [laneText, setLaneText] = React.useState("");
  const [lanePrompts, setLanePrompts] = React.useState({});
  const [laneOpen, setLaneOpen] = React.useState(false);
  // [v0.27] 推荐列表折叠开关（默认展开；折叠时只留「条数 + 提示」一行摘要）
  const [recsOpen, setRecsOpen] = React.useState(true);
  const [mgrOpen, setMgrOpen] = React.useState(false);
  const [collab, setCollab] = React.useState({ messages: [], claims: [] });
  const [collabOpen, setCollabOpen] = React.useState(false);
  const [collabText, setCollabText] = React.useState("");
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
    // [v0.18] 推荐管理员状态 + 协作频道
    fetch("/api/dsh-graph-autopilot/manager", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "get" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.ok) return;
        setMgr(d);
        setMgrPrompt(d.managerPrompt ?? d.defaultPrompt ?? "");
      })
      .catch(() => {});
    fetch("/api/dsh-graph-autopilot/manager", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "lane-prompt-get" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setLanePrompts(d.lanePrompts ?? {}); })
      .catch(() => {});
    fetch("/api/dsh-graph-autopilot/collab", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "list", limit: 30 }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setCollab({ messages: d.messages ?? [], claims: d.claims ?? [] }); })
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

  /** [v0.18] 推荐管理员设置写入 */
  const mgrSet = (patch) => {
    setBusy("manager-set");
    return fetch("/api/dsh-graph-autopilot/manager", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "set", ...patch }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setMsg("❌ " + (d?.error ?? "保存失败"));
        else setMgr((m) => ({ ...(m ?? {}), ...d }));
        return d;
      })
      .catch((e) => { setMsg("❌ " + (e?.message ?? "网络错误")); return null; })
      .finally(() => setBusy(""));
  };

  const btn = { borderRadius: 6, padding: "3px 9px", fontSize: 12, cursor: "pointer", border: "1px solid rgba(140,145,155,.55)", background: "rgba(120,125,135,.30)", color: "inherit", whiteSpace: "nowrap" };
  const btnPrimary = { ...btn, background: "#3b7ddd", borderColor: "#3b7ddd", color: "#fff" };
  const chip = { fontSize: 11, borderRadius: 5, padding: "1px 6px", background: "rgba(120,125,135,.28)", color: "inherit" };
  const input = { flex: 1, minWidth: 160, borderRadius: 6, border: "1px solid rgba(140,145,155,.5)", background: "rgba(20,22,27,.55)", color: "inherit", padding: "3px 8px", fontSize: 12 };
  const runner = st?.runner ?? null;
  const recs = st?.recommendations ?? [];
  const pickedIdxs = Object.keys(picked).filter((k) => picked[k]).map(Number);
  // 推荐卡类型 → 粗左边框色（与看板卡片视觉约定一致）
  const typeColor = { feature: "#4c8dff", bug: "#e05a5a", task: "#3ecf8e", improvement: "#b07cff", patch: "#e0a53a", chore: "#8a8f98" };

  // [v0.27] 采纳所选推荐（version=null，先落草稿）→ 紧接着运行管理 AI：
  // 管理 AI 读看板与协作频道，自行决定把任务放到哪条泳道、建什么连线（其上行文已含「自由编排任务」职责）。
  const adoptAndManage = () => {
    if (busy) return;
    if (pickedIdxs.length === 0) { setMsg("请先勾选要采纳的推荐，再点「采纳并由管理 AI 分配」"); return; }
    setBusy("adopt-manager");
    setMsg("… 正在采纳所选推荐…");
    let createdText = "";
    fetch("/api/dsh-graph-autopilot/adopt", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, picks: pickedIdxs, version: null }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setMsg("❌ 采纳失败：" + (d?.error ?? "未知错误")); return null; }
        createdText = (d?.created ?? []).map((c) => `${c.id} ${c.title}`).join("、") || "—";
        setPicked({});
        setMsg("✅ 已采纳：" + createdText + "；🤖 正在唤起管理 AI 分配…");
        return fetch("/api/dsh-graph-autopilot/manager", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace, action: "run" }),
        }).then((r) => r.json().then((d2) => ({ ok: r.ok, d2 })));
      })
      .then((res) => {
        if (!res) return;
        if (!res.ok) { setMsg("✅ 已采纳：" + createdText + "；❌ 管理 AI 启动失败：" + (res.d2?.error ?? "未知错误")); return; }
        setMsg("✅ 已采纳：" + createdText + "；🤖 管理 AI 已启动（" + (res.d2?.child_id ?? "") + "），它会读看板与协作频道，自行决定放到哪条泳道、建哪些连线");
        window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: { manager: res.d2 } }));
      })
      .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
      .finally(() => { setBusy(""); load(); });
  };

  return h("div", {
    "data-autopilot-panel": "",
    style: { display: "flex", flexDirection: "column", gap: 8, margin: "14px 0 10px", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", background: "var(--dsw-alias-fill-tsp-primary, rgba(128,128,128,.06))", fontSize: 12 },
  },
    // —— 推荐行（标准卡片，可拖进泳道）—— [v0.28] 问题20修复：折叠只隐藏**推荐卡片网格**，
    // 标题行 + 全部操作按钮（含输入框）保持常显；折叠态标题显示「💡 推荐（已收起）· N 条」。
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", {
        style: { flexShrink: 0, cursor: "pointer", userSelect: "none" },
        title: "点此展开 / 收起推荐卡片（操作按钮始终保留）",
        onClick: () => setRecsOpen((o) => !o),
      }, recsOpen ? "▾ 💡 推荐" : "▸ 💡 推荐（已收起）· " + recs.length + " 条"),
      h("button", {
        style: btn,
        title: "展开 / 收起推荐卡片（操作按钮始终保留）",
        onClick: () => setRecsOpen((o) => !o),
      }, recsOpen ? "收起" : "展开"),
      recsOpen && h("span", { style: chip }, recs.length + " 条"),
      !recsOpen && h("span", { className: "dg-hint", style: { opacity: 0.65 } }, "已收起：只隐藏推荐卡片，操作按钮常显；点标题或「展开」查看卡片"),
      h(React.Fragment, null,
        h("button", { style: btn, disabled: !!busy, onClick: () => post("scan", {}).then(load) }, busy === "scan" ? "扫描中…" : "扫描推荐"),
        h("button", {
          style: btn, disabled: !!busy,
          title: "完整扫描：拉一个子代理深度分析工作区与项目正式文件（README/构建配置/提交历史等），再由 AI 回写推荐清单",
          onClick: () => post("deep-scan", { hint: recHint }).then((d) => { if (d?.ok) setMsg("🔍 完整扫描已启动（子代理 " + (d.child_id ?? "") + "），完成后推荐清单会自动更新"); return load(); }),
        }, busy === "deep-scan" ? "启动中…" : "🔍 完整扫描"),
        // [v0.19] 按输入内容做推荐（走完整扫描，把输入作为本次推荐方向）
        h("input", {
          style: { ...input, minWidth: 200, flex: "1 1 200px" },
          placeholder: "输入推荐方向（如：把部署脚本补齐 / 修掉登录超时）→ 按它推荐",
          value: recHint,
          onChange: (e) => setRecHint(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter" && recHint.trim()) post("deep-scan", { hint: recHint }).then((d) => { if (d?.ok) setMsg("🔍 已按输入启动推荐扫描"); return load(); }); },
        }),
        h("button", {
          style: { ...btn, background: recHint.trim() ? "#3b7ddd" : undefined, borderColor: recHint.trim() ? "#3b7ddd" : undefined, color: recHint.trim() ? "#fff" : "inherit" },
          disabled: !!busy || !recHint.trim(),
          title: "按你输入的内容生成推荐（把输入作为本次推荐方向，交给 AI 深度扫描）",
          onClick: () => post("deep-scan", { hint: recHint }).then((d) => { if (d?.ok) { setMsg("🔍 已按输入启动推荐扫描"); setRecHint(""); } return load(); }),
        }, "按输入推荐"),
        h("span", { style: { opacity: 0.65 } }, "把卡片拖到任意泳道即可建目标执行；或勾选后批量采纳"),
        pickedIdxs.length > 0 && h("button", { style: btn, disabled: !!busy, onClick: () => post("adopt", { picks: pickedIdxs, version: null }).then(() => { setPicked({}); load(); }) }, "采纳所选 → backlog"),
        pickedIdxs.length > 0 && versions.length > 0 && h(React.Fragment, null,
          h("select", { style: input, value: runVersion, onChange: (e) => setRunVersion(e.target.value) },
            h("option", { value: "" }, "选择版本…"),
            versions.map((v) => h("option", { key: v, value: v }, v)),
          ),
          h("button", { style: btnPrimary, disabled: !!busy || !runVersion, onClick: () => post("adopt", { picks: pickedIdxs, version: runVersion, run: true }).then(() => { setPicked({}); load(); }) }, "采纳并 ▶ 自动执行"),
        ),
        // [v0.27] 采纳当前勾选 → 紧接着运行管理 AI（它读看板与协作频道，自行决定放哪条泳道、建哪些连线）
        recs.length > 0 && h("button", {
          style: { ...btn, background: "#7a5af8", borderColor: "#7a5af8", color: "#fff", fontWeight: 700 },
          disabled: !!busy,
          title: "采纳当前勾选的推荐，然后立刻运行管理 AI：它读取看板与协作频道，自行把任务分配到合适泳道并建立连线",
          onClick: adoptAndManage,
        }, busy === "adopt-manager" ? "分配中…" : "🤖 采纳并由管理 AI 分配"),
      ),
    ),
    recsOpen && recs.length > 0 && h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 } },
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
    // —— [v0.27] 执行状态行（原「▶ 行执行」整行已删：启停由泳道行头 ▶/■ 承担；runner 快照保留在此细字行）——
    // 评审下拉并非重复功能（行头没有），故随 runner 快照一起挪到这一行，避免丢失唯一入口。
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "0 0 0 14px", fontSize: 11 } },
      runner
        ? h("span", { style: chip }, `执行中: ${runner.version} · 当前 ${runner.current ?? "—"} · 待办 ${(runner.pending ?? []).length} · 完成 ${(runner.done ?? []).length}${(runner.failed ?? []).length ? " · 失败 " + runner.failed.length : ""}${runner.paused ? " · ⏸ " + runner.paused : ""}`)
        : h("span", { style: { opacity: 0.6 } }, "▶ 当前未在运行"),
      h("span", { className: "dg-hint" }, runner ? "（在泳道行头点绿色「■」即可中断）" : "（在泳道行头点灰色「▶」启动本行自动驾驶）"),
      // [v0.18] 评审模式：默认机审（机器门禁后自动裁决）；切到人审则停在「确认」等人
      h("span", { style: chip }, "评审"),
      h("select", {
        style: { ...input, flex: "0 0 auto", minWidth: 92, fontSize: 11, padding: "1px 6px" },
        value: st?.state?.reviewMode ?? "auto",
        disabled: !!busy,
        title: "机审=机器门禁通过即自动裁决（默认）；人审=停在确认列等负责人裁决",
        onChange: (e) => mgrSet({ reviewMode: e.target.value }).then(load),
      },
        h("option", { value: "auto" }, "机审（默认）"),
        h("option", { value: "human" }, "人审"),
      ),
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
    // [v0.27] 「⚙ 高级」（无提示模式 + 按泳道选模型）已整体迁至看板设置（问题 16/23）；
    // noHints/laneDraft 状态与相关 setter 随块删除，apApplyNoHints/apNoHintsOn/apHint 机制函数保留。
    // —— [v0.28] 🌐 托管 / 目标推进（面板开关行）——
    // 数据契约：POST /api/dsh-graph-autopilot/manager {action:"set", steward:{enabled}|advanceMode}；读回 get 的 steward?.enabled 与 advanceMode。
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "🌐 托管"),
      h("label", { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
        h("input", {
          type: "checkbox", checked: !!mgr?.steward?.enabled,
          title: "全局托管：自动扫描/采纳/起跑并处理阻塞，持续不停（勾选即生效）",
          onChange: (e) => mgrSet({ steward: { enabled: e.target.checked } }),
        }),
        "全局托管（自动扫描/采纳/起跑，持续不停）",
      ),
      h("label", { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
        h("input", {
          type: "checkbox", checked: !!mgr?.advanceMode,
          title: "目标推进：不加新任务，把非草稿任务全部推到交付（勾选即生效）",
          onChange: (e) => mgrSet({ advanceMode: e.target.checked }),
        }),
        "目标推进（不加新任务，推进到全部交付）",
      ),
    ),
    apHint("🌐 全局托管：勾选后自动扫描/采纳/起跑并处理阻塞，持续不停、永不自动停；取消勾选即回到手动操作。"),
    apHint("🌐 目标推进：勾选后不加新任务，只把非草稿任务全部推进到交付；取消勾选即恢复常规托管行为。"),
    // —— [v0.18] AI 推荐管理员（独立上行文；实时管理推荐 / 全局目标 / 全局提示词）——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "🤖 推荐管理"),
      h("label", { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
        h("input", {
          type: "checkbox", checked: !!mgr?.managerEnabled,
          onChange: (e) => mgrSet({ managerEnabled: e.target.checked }),
        }),
        "启用实时管理",
      ),
      h("span", { style: chip }, "间隔"),
      h("input", {
        style: { ...input, width: 56 }, type: "number", min: 1, max: 1440,
        value: mgr?.managerIntervalMin ?? 30,
        onChange: (e) => setMgr((m) => ({ ...(m ?? {}), managerIntervalMin: Number(e.target.value) })),
        onBlur: (e) => mgrSet({ managerIntervalMin: Number(e.target.value) }),
      }),
      h("span", { style: chip }, "分钟"),
      h("label", { style: { display: "inline-flex", gap: 4, alignItems: "center" } },
        h("input", {
          type: "checkbox", checked: mgr?.managerUpdateGlobals !== false,
          onChange: (e) => mgrSet({ managerUpdateGlobals: e.target.checked }),
        }),
        "允许维护全局目标/提示词",
      ),
      h("button", { style: btnPrimary, disabled: !!busy, onClick: () => post("manager", { action: "run" }).then(load) }, busy === "manager" ? "…" : "立即运行管理"),
      h("button", { style: btn, onClick: () => setMgrOpen(!mgrOpen) }, mgrOpen ? "收起上行文" : "编辑上行文"),
      mgr?.managerLastRun && h("span", { style: { opacity: 0.6, fontSize: 11 } }, "上次：" + String(mgr.managerLastRun).replace("T", " ").slice(0, 19)),
    ),
    mgrOpen && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "0 0 0 14px" } },
      h("textarea", {
        style: { ...input, minWidth: 0, height: 110, resize: "vertical", fontFamily: "inherit" },
        value: mgrPrompt,
        placeholder: "管理员独立上行文：定义它如何管理推荐清单、全局目标与全局提示词（留空=用内置默认上行文）",
        onChange: (e) => setMgrPrompt(e.target.value),
      }),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("button", { style: btnPrimary, disabled: !!busy, onClick: () => mgrSet({ managerPrompt: mgrPrompt }) }, "保存上行文"),
        h("button", { style: btn, onClick: () => setMgrPrompt(mgr?.defaultPrompt ?? "") }, "载入内置默认"),
      ),
    ),
    // —— [v0.19] 泳道职责提示词（每条泳道/固定分组可单独设置，派发时告知执行子代理）——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "🏷 泳道职责"),
      h("select", {
        style: { ...input, flex: "0 0 auto", minWidth: 150 },
        value: laneSel,
        onChange: (e) => { const v = e.target.value; setLaneSel(v); setLaneText(lanePrompts[v] ?? ""); setLaneOpen(true); },
      },
        h("option", { value: "" }, "选择泳道…"),
        versions.map((v) => h("option", { key: "v-" + v, value: v }, "🏷️ " + v)),
        h("option", { value: "standalone" }, "独立目标"),
        h("option", { value: "backlog" }, "草稿"),
        h("option", { value: "*" }, "全部泳道（通配）"),
      ),
      laneSel && h("span", { style: chip }, lanePrompts[laneSel] ? "已设置" : "未设置"),
      h("span", { style: { opacity: 0.6, fontSize: 11 } }, "告诉 AI 这条泳道是干什么的（如：后端=服务端接口与数据；部署测试=发版与冒烟）"),
      laneSel && h("button", { style: btn, onClick: () => setLaneOpen(!laneOpen) }, laneOpen ? "收起" : "编辑提示词"),
    ),
    laneOpen && laneSel && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "0 0 0 14px" } },
      h("textarea", {
        style: { ...input, minWidth: 0, height: 64, resize: "vertical", fontFamily: "inherit" },
        value: laneText,
        placeholder: "例如：本泳道负责服务端接口与数据层；改动需同时给出接口签名与兼容性说明。留空保存=清除。",
        onChange: (e) => setLaneText(e.target.value),
      }),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("button", {
          style: btnPrimary, disabled: !!busy,
          onClick: () => post("manager", { action: "lane-prompt-set", lane: laneSel, text: laneText }).then((d) => {
            if (d?.ok) { setLanePrompts(d.lanePrompts ?? {}); setMsg("✅ 已保存泳道职责：" + laneSel); }
            return load();
          }),
        }, "保存泳道职责"),
        h("span", { style: { opacity: 0.6, fontSize: 11 } }, "派发该泳道任务时会注入这条提示词"),
      ),
    ),
    // —— [v0.18] 协作频道（任务间沟通 + 资源占用，防冲突）——
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      h("strong", { style: { flexShrink: 0 } }, "💬 协作"),
      h("span", { style: chip }, (collab.messages?.length ?? 0) + " 条消息"),
      (collab.claims?.length ?? 0) > 0 && h("span", { style: chip }, "占用中 " + collab.claims.length),
      h("button", { style: btn, onClick: () => setCollabOpen(!collabOpen) }, collabOpen ? "收起频道" : "打开频道"),
      h("button", { style: btn, disabled: !!busy, onClick: () => load() }, "刷新"),
    ),
    collabOpen && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: "0 0 0 14px", maxHeight: 180, overflow: "auto" } },
      (collab.messages ?? []).slice(-15).map((m, i) => h("div", { key: i, style: { fontSize: 11, opacity: 0.85 } },
        `${String(m.at ?? "").slice(11, 19)} ${m.actor}${m.goal ? " @" + m.goal : ""}${m.kind === "release" ? "（释放）" : ""}：${m.text || (m.claims ?? []).join("、")}`)),
      (collab.messages ?? []).length === 0 && h("div", { style: { fontSize: 11, opacity: 0.6 } }, "暂无消息。执行子代理开工时会在此声明要改的文件；你也可以发指令给它们。"),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("input", { style: { ...input, flex: 1 }, placeholder: "给执行子代理发消息（如：优先改 src/a.ts，勿动 b.ts）", value: collabText, onChange: (e) => setCollabText(e.target.value) }),
        h("button", {
          style: btnPrimary, disabled: !!busy || !collabText.trim(),
          onClick: () => post("collab", { action: "post", text: collabText, actor: "human:gui" }).then((d) => { if (d?.ok) { setCollabText(""); load(); } }),
        }, "发送"),
      ),
    ),
    msg && h("div", { style: { color: "#e05a5a" } }, msg),
  );
}
// ---------------------------------------------------------------------------
// 底部行共用外壳：**可折叠（默认折叠，不占位置）** + **实时刷新**（⟳ 手动 + 展开时每 10s 轮询）
// ---------------------------------------------------------------------------
// [v0.19] 按钮/输入统一用**显式颜色**（不再依赖主题变量：实测 --dsw-alias-fill-tsp-secondary 在该主题下解析成白色 → 白底白字看不见）
const AP_ROW_BTN = { borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer", border: "1px solid rgba(140,145,155,.55)", background: "rgba(120,125,135,.30)", color: "inherit", whiteSpace: "nowrap" };
const AP_ROW_CHIP = { fontSize: 11, borderRadius: 5, padding: "0 6px", background: "rgba(120,125,135,.28)", color: "inherit" };
const AP_ROW_INPUT = { borderRadius: 6, border: "1px solid rgba(140,145,155,.5)", background: "rgba(20,22,27,.55)", color: "inherit", padding: "3px 8px", fontSize: 12, fontFamily: "inherit" };
const AP_ROW_PRIMARY = { ...AP_ROW_BTN, background: "#3b7ddd", borderColor: "#3b7ddd", color: "#fff" };
// 固定分组（与「独立目标」同属性：不可删除）——须与 core/autopilot.ts 的 PROTECTED_VERSION_SLUGS 保持一致
const AP_PROTECTED_VERSION_SLUGS = ["interaction", "deploy-test", "backend"];
function isApProtectedVersion(slug) { return AP_PROTECTED_VERSION_SLUGS.indexOf(String(slug ?? "").trim()) >= 0; }
// [v0.23] 常驻分组（与 core 的 DEFAULT_GROUPS 保持一致）：与独立目标同属性，无版本语义
const AP_DEFAULT_GROUP_SLUGS = ["interaction", "deploy-test", "backend"];
// [v0.27] 面板「⚙ 高级」迁至设置后本文件不再引用；保留给设置面板（按泳道选模型）等工厂作用域代码复用，勿删。
const AP_GROUP_NAMES = { interaction: "交互", "deploy-test": "部署测试", backend: "后端" };
function isDefaultGroup(slug) { return AP_DEFAULT_GROUP_SLUGS.indexOf(String(slug ?? "").trim()) >= 0; }

function apLaneShell(opts) {
  const { key, title, count, collapsed, onToggle, onRefresh, refreshing, fullWidth, actions, hint, children, dropProps } = opts;
  const labelEl = h("div", {
    key: key + "-label",
    onClick: onToggle,
    title: hint,
    ...(dropProps ?? {}),
    style: {
      padding: "5px 10px", borderRadius: 8, background: "rgba(128,128,128,.10)",
      display: "flex", flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap",
      minWidth: 0, cursor: "pointer", userSelect: "none",
      ...(dropProps && dropProps._active ? { background: "rgba(76,141,255,.18)", outline: "1px dashed rgba(76,141,255,.6)" } : {}),
      ...(fullWidth || collapsed ? { gridColumn: "1 / -1" } : {}),
    },
  },
    h("span", { style: { fontWeight: 700, fontSize: 12 } }, (collapsed ? "▸ " : "▾ ") + title + " · " + count),
    collapsed ? h("span", { style: { opacity: 0.55, fontSize: 11 } }, "点击展开") : null,
    h("span", { style: { flex: 1 } }),
    ...(actions ?? []),
    h("button", {
      style: AP_ROW_BTN, title: "立即刷新这一行（展开时也会每 10 秒自动刷新）",
      onClick: (e) => { e.stopPropagation(); onRefresh(); },
    }, refreshing ? "…" : "⟳ 刷新"),
  );
  const bodyEl = collapsed ? null : h("div", {
    key: key + "-body",
    ...(dropProps ? { onDragOver: dropProps.onDragOver, onDrop: dropProps.onDrop } : {}),
    style: { gridColumn: fullWidth ? "1 / -1" : "2 / -1", display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "8px 10px", borderRadius: 8, background: "rgba(128,128,128,.04)" },
  }, ...(children ?? []));
  return h(React.Fragment, null, labelEl, bodyEl);
}

// ---------------------------------------------------------------------------
// 模板行（看板底部一行）：可复用目标蓝图 —— 卡片直接拖到任意泳道即按模板建目标
// ---------------------------------------------------------------------------
const AP_TEMPLATE_TYPES = ["feature", "bug", "task", "improvement", "patch", "chore"];

function TemplateLane(props) {
  const workspace = props?.workspace ?? null;
  if (workspace) apPanelWorkspace = workspace; // 保底：面板未挂载时模板拖拽也有 workspace
  const [items, setItems] = React.useState([]);
  const [form, setForm] = React.useState(null); // {id?, title, type, description, criteriaText}
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(true); // 默认折叠：不占位置
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback((silent) => {
    if (!workspace) return;
    if (!silent) setRefreshing(true);
    fetch("/api/dsh-graph-autopilot/templates", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "list" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setItems(Array.isArray(d.templates) ? d.templates : []); })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [workspace]);

  React.useEffect(() => { load(true); }, [load]);
  React.useEffect(() => {
    const h = () => load(true);
    window.addEventListener("autopilot:adopted", h);
    return () => window.removeEventListener("autopilot:adopted", h);
  }, [load]);
  // 实时刷新：展开时每 10 秒自动同步（折叠时不发请求，零开销）
  React.useEffect(() => {
    if (collapsed) return undefined;
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
  }, [collapsed, load]);

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

  const btn = AP_ROW_BTN;
  const btnPrimary = { ...btn, background: "var(--dsw-alias-button-primary-fill, rgba(76,141,255,.9))", color: "#fff", borderColor: "transparent" };
  const chip = AP_ROW_CHIP;
  const input = { borderRadius: 6, border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))", background: "transparent", color: "inherit", padding: "3px 8px", fontSize: 12, fontFamily: "inherit" };

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

  return apLaneShell({
    key: "tpl-lane",
    title: "🧩 模板",
    count: items.length,
    collapsed,
    onToggle: () => setCollapsed((c) => !c),
    onRefresh: () => load(false),
    refreshing,
    fullWidth: !!props?.fullWidth,
    hint: "可折叠（默认折叠，省位置）；展开后每 10 秒自动刷新；卡片可拖到任意泳道建目标",
    actions: [
      h("button", {
        key: "new", style: btn, disabled: !!busy,
        title: "新建模板：填写标题/类型/描述/判据，之后拖到泳道即可复用",
        onClick: (e) => { e.stopPropagation(); setCollapsed(false); setForm((f) => f ?? { id: null, title: "", type: "task", description: "", criteriaText: "" }); },
      }, "＋ 新建"),
    ],
    children: [
      form && h("div", { key: "form", style: { display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 8, border: "1px dashed var(--dsw-alias-border-secondary, rgba(128,128,128,.4))" } },
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
      !form && msg && h("div", { key: "msg", style: { color: "#e05a5a", fontSize: 11 } }, msg),
      cards,
    ],
  });
}

// ---------------------------------------------------------------------------
// 回收站行（看板最底部）：已归档目标 + 已移除版本，均可一键恢复；可折叠 + 实时刷新
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// [v0.25] 无提示模式：一键隐藏所有帮助性说明（.dg-hint 段落）
// ---------------------------------------------------------------------------
const AP_NO_HINTS_KEY = "dsh-graph.no-hints";
function apNoHintsOn() {
  try { return localStorage.getItem(AP_NO_HINTS_KEY) === "1"; } catch { return false; }
}
function apApplyNoHints(on) {
  try {
    if (on) document.documentElement.setAttribute("data-dsh-no-hints", "1");
    else document.documentElement.removeAttribute("data-dsh-no-hints");
    localStorage.setItem(AP_NO_HINTS_KEY, on ? "1" : "0");
  } catch { /* 无 localStorage 时忽略 */ }
  const id = "dsh-graph-no-hints-style";
  if (!document.getElementById(id)) {
    const st = document.createElement("style");
    st.id = id;
    st.textContent = "html[data-dsh-no-hints] .dg-hint{display:none !important}";
    document.head.appendChild(st);
  }
  window.dispatchEvent(new CustomEvent("dsh-graph.no-hints-changed", { detail: { on } }));
}
// 插件加载即生效（无需等看板打开）
try { apApplyNoHints(apNoHintsOn()); } catch { /* 极早期环境忽略 */ }

/** 统一渲染提示文案：无提示模式下自动不渲染 */
function apHint(children, style) {
  if (apNoHintsOn()) return null;
  return h("div", { className: "dg-hint", style: { fontSize: 11, opacity: 0.7, ...(style ?? {}) } }, children);
}

// ---------------------------------------------------------------------------
// [v0.25] 回收站堆叠：把多条回收站条目手动堆成一格（省地方、便于管理），可散开
// ---------------------------------------------------------------------------
let apTrashDragKey = null;
function apTrashDragStart(kind, key) { apTrashDragKey = { kind, key }; }
function apTrashDragEnd() { apTrashDragKey = null; }

function TrashLane(props) {
  const workspace = props?.workspace ?? null;
  const [data, setData] = React.useState({ goals: [], versions: [] });
  const [collapsed, setCollapsed] = React.useState(true); // 默认折叠
  const [refreshing, setRefreshing] = React.useState(false);
  const [busy, setBusy] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [purgePending, setPurgePending] = React.useState(null); // 二次确认键
  const purgeTimer = React.useRef(null);
  const [hover, setHover] = React.useState(false);

  /** 两步确认：第一次点变成「确认彻底删除？」，3 秒内再点才真删 */
  const purgeConfirm = (keyName, run) => {
    if (purgePending !== keyName) {
      setPurgePending(keyName);
      if (purgeTimer.current) clearTimeout(purgeTimer.current);
      purgeTimer.current = setTimeout(() => setPurgePending(null), 3000);
      return;
    }
    if (purgeTimer.current) clearTimeout(purgeTimer.current);
    setPurgePending(null);
    run();
  };

  const purge = (body) => {
    setBusy(JSON.stringify(body)); setMsg("");
    fetch("/api/dsh-graph-autopilot/trash", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, ...body }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setMsg("❌ " + (d?.error ?? "彻底删除失败")); return; }
        setData({ goals: d.goals ?? [], versions: d.versions ?? [], stacks: d.stacks ?? [] });
        setMsg("🗑 已彻底删除（不可恢复）");
      })
      .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
      .finally(() => setBusy(""));
  };

  const load = React.useCallback((silent) => {
    if (!workspace) return;
    if (!silent) setRefreshing(true);
    fetch("/api/dsh-graph-autopilot/trash", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "list" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setData({ goals: d.goals ?? [], versions: d.versions ?? [], stacks: d.stacks ?? [] }); })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [workspace]);

  React.useEffect(() => { load(true); }, [load]);
  React.useEffect(() => {
    const h = () => load(true);
    window.addEventListener("autopilot:trash-changed", h);
    return () => window.removeEventListener("autopilot:trash-changed", h);
  }, [load]);
  // 实时刷新：展开时每 10 秒自动同步
  React.useEffect(() => {
    if (collapsed) return undefined;
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
  }, [collapsed, load]);

  const restore = (body) => {
    setBusy(JSON.stringify(body)); setMsg("");
    fetch("/api/dsh-graph-autopilot/trash", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, ...body }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setMsg("❌ " + (d?.error ?? "恢复失败")); return; }
        setData({ goals: d.goals ?? [], versions: d.versions ?? [], stacks: d.stacks ?? [] });
        setMsg("✅ 已恢复：" + (d.restored ?? ""));
        // 让看板立即重绘（恢复的目标/版本要马上出现）
        window.dispatchEvent(new CustomEvent("autopilot:adopted", { detail: { restored: d.restored } }));
        window.dispatchEvent(new CustomEvent("autopilot:trash-changed"));
      })
      .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
      .finally(() => setBusy(""));
  };

  const total = data.goals.length + data.versions.length;
  const children = [
    data.versions.length > 0 && h("div", { key: "v", style: { display: "flex", flexDirection: "column", gap: 4 } },
      h("div", { style: { fontSize: 11, opacity: 0.7 } }, "已移除的版本泳道（恢复后回到看板，数据完整）"),
      h("div", { style: { display: "flex", flexWrap: "wrap", overflowX: "auto", gap: 8, paddingBottom: 4 } },
        data.versions.map((v) => h("div", {
          key: v.dir,
          style: { background: "var(--dsw-alias-bg-card, rgba(24,26,32,.85))", borderRadius: 8, padding: "8px 10px", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", borderLeft: "3px solid #8a8f98", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 },
        },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("b", null, "🏷️ " + v.name),
            h("span", { style: AP_ROW_CHIP }, v.slug),
          ),
          h("div", { style: { opacity: 0.6, fontSize: 11 } }, "移入时间：" + (v.moved_at || "—")),
          h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
            h("button", { style: AP_ROW_BTN, disabled: !!busy, onClick: () => restore({ action: "restore-version", dir: v.dir }) }, busy.indexOf(v.dir) >= 0 ? "…" : "↩ 恢复版本"),
            h("button", {
              style: { ...AP_ROW_BTN, color: "#e05a5a" }, disabled: !!busy,
              title: "彻底删除（不可恢复，需点两次确认）",
              onClick: () => purgeConfirm(`version:${v.dir}`, () => purge({ action: "purge-version", dir: v.dir, confirm: true })),
            }, purgePending === `version:${v.dir}` ? "确认彻底删除？" : "🗑 彻底删除"),
          ),
        )))),
    data.goals.length > 0 && h("div", { key: "g", style: { display: "flex", flexDirection: "column", gap: 4 } },
      h("div", { style: { fontSize: 11, opacity: 0.7 } }, "已归档的目标（恢复后回到原泳道）"),
      h("div", { style: { display: "flex", flexWrap: "wrap", overflowX: "auto", gap: 8, paddingBottom: 4 } },
        data.goals.map((g) => h("div", {
          key: g.id,
          draggable: true,
          title: "拖到泳道 = 恢复并落到该泳道；拖到另一条回收站条目上 = 堆成一格",
          onDragStart: (e) => {
            try { e.dataTransfer.setData("text/plain", "autopilot-trash:" + g.id); e.dataTransfer.effectAllowed = "copy"; } catch { /* 旧引擎 */ }
            apDragStart("trash", g.id);
            apTrashDragStart("goal", g.id);
          },
          onDragEnd: () => { apDragEnd(); apTrashDragEnd(); },
          // [v0.25] 拖到另一条上 = 堆成一格（自动堆叠，省地方便于管理）
          onDragOver: (e) => { if (apTrashDragKey && apTrashDragKey.key !== g.id) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; } },
          onDrop: (e) => {
            if (!apTrashDragKey || apTrashDragKey.key === g.id) return;
            e.preventDefault(); e.stopPropagation();
            const src = apTrashDragKey;
            apTrashDragKey = null;
            setBusy("stack"); setMsg("");
            fetch("/api/dsh-graph-autopilot/trash", {
              method: "POST", credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspace, action: "stack", name: g.title, items: [src, { kind: "goal", key: g.id }] }),
            })
              .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
              .then(({ ok, d }) => {
                if (!ok) { setMsg("❌ " + (d?.error ?? "堆叠失败")); return; }
                setData({ goals: d.goals ?? [], versions: d.versions ?? [], stacks: d.stacks ?? [] });
                setMsg("🧱 已堆成一格（点「散开」可拆）");
              })
              .catch((e2) => setMsg("❌ " + (e2?.message ?? "网络错误")))
              .finally(() => setBusy(""));
          },
          style: { background: "var(--dsw-alias-bg-card, rgba(24,26,32,.85))", borderRadius: 8, padding: "8px 10px", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", borderLeft: "3px solid #6b7280", display: "flex", flexDirection: "column", gap: 4, fontSize: 12, cursor: "grab" },
        },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("b", null, g.title),
            h("span", { style: AP_ROW_CHIP }, g.id),
          ),
          h("div", { className: "dg-hint", style: { opacity: 0.6, fontSize: 11 } }, "来源：" + g.from),
          h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
            h("button", { style: AP_ROW_BTN, disabled: !!busy, onClick: () => restore({ action: "restore-goal", goal: g.id }) }, busy.indexOf(g.id) >= 0 ? "…" : "↩ 恢复目标"),
            // [v0.19] 一键回草稿
            h("button", {
              style: AP_ROW_BTN, disabled: !!busy,
              title: "取消归档并直接回到「草稿」泳道",
              onClick: () => restore({ action: "to-draft", goal: g.id }),
            }, "→ 草稿"),
            h("button", {
              style: { ...AP_ROW_BTN, color: "#e05a5a" }, disabled: !!busy,
              title: "彻底删除（不可恢复，需点两次确认）",
              onClick: () => purgeConfirm(`goal:${g.id}`, () => purge({ action: "purge-goal", goal: g.id, confirm: true })),
            }, purgePending === `goal:${g.id}` ? "确认彻底删除？" : "🗑 彻底删除"),
          ),
        )))),
    // [v0.25] 堆叠：拖条目到另一条上即成一堆；用原生 details 展开（无需额外状态），可「散开」
    (data.stacks ?? []).length > 0 && h("div", { key: "stacks", style: { display: "flex", flexDirection: "column", gap: 4 } },
      h("div", { className: "dg-hint", style: { fontSize: 11, opacity: 0.7 } }, "堆叠（把一条拖到另一条上即可成堆；点标题展开，点「散开」拆开）"),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
        (data.stacks ?? []).map((s) => h("details", {
          key: s.id,
          style: { background: "var(--dsw-alias-bg-card, rgba(24,26,32,.85))", borderRadius: 8, padding: "6px 10px", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))", borderLeft: "3px solid #8a8f98", fontSize: 12, minWidth: 200 },
        },
          h("summary", { style: { cursor: "pointer", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("b", null, "🧱 " + s.name),
            h("span", { style: AP_ROW_CHIP }, (s.items?.length ?? 0) + " 项"),
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 2, margin: "6px 0 2px 4px" } },
            (s.items ?? []).map((it) => h("div", { key: it.kind + ":" + it.key, style: { fontSize: 11, opacity: 0.9 } },
              `${it.kind === "version" ? "🏷️ " : ""}${it.key}`)),
          ),
          h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
            h("button", {
              style: AP_ROW_BTN, disabled: !!busy,
              onClick: () => {
                setBusy("unstack"); setMsg("");
                fetch("/api/dsh-graph-autopilot/trash", {
                  method: "POST", credentials: "same-origin",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ workspace, action: "unstack", id: s.id }),
                })
                  .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
                  .then(({ ok, d }) => {
                    if (!ok) { setMsg("❌ " + (d?.error ?? "散开失败")); return; }
                    setData({ goals: d.goals ?? [], versions: d.versions ?? [], stacks: d.stacks ?? [] });
                    setMsg("已散开该堆叠");
                  })
                  .catch((e2) => setMsg("❌ " + (e2?.message ?? "网络错误")))
                  .finally(() => setBusy(""));
              },
            }, "散开"),
          ),
        )))),
    total === 0 && h("div", { key: "empty", style: { opacity: 0.6, fontSize: 12, padding: "6px 0" } }, "回收站是空的：被移除的版本泳道与已归档目标都会出现在这里，可随时恢复。"),
    msg && h("div", { key: "msg", style: { fontSize: 11, color: msg.indexOf("❌") === 0 ? "#e05a5a" : "#3ecf8e" } }, msg),
  ];

  return apLaneShell({
    key: "trash-lane",
    title: "🗑 回收站",
    count: total,
    collapsed,
    onToggle: () => setCollapsed((c) => !c),
    onRefresh: () => load(false),
    refreshing,
    fullWidth: !!props?.fullWidth,
    hint: "可折叠（默认折叠，省位置）；展开后每 10 秒自动刷新；把看板卡片拖进来=移入回收站，把回收站条目拖出去=恢复并落到该泳道",
    // [v0.18] 承接看板卡片拖入（= 归档进回收站）；拖拽悬停时本行自动展开，方便落点
    dropProps: props?.anyDrag ? {
      _active: hover,
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (collapsed) setCollapsed(false);
        if (!hover) setHover(true);
      },
      onDrop: (e) => {
        e.preventDefault();
        setHover(false);
        const gid = props?.dragGoalId;
        if (gid && typeof props?.onDropCard === "function") props.onDropCard(gid);
      },
    } : undefined,
    children,
  });
}

// ---------------------------------------------------------------------------
// [v0.20] 泳道职责编辑器：嵌进「版本详情」弹窗——每条泳道在自己的详情里说明它是干什么的
// ---------------------------------------------------------------------------
function LanePromptEditor(props) {
  const workspace = props?.workspace ?? null;
  const lane = String(props?.lane ?? "").trim();
  const [text, setText] = React.useState("");
  const [saved, setSaved] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");

  React.useEffect(() => {
    if (!workspace || !lane) return;
    let alive = true;
    fetch("/api/dsh-graph-autopilot/manager", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "lane-prompt-get", lane }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.ok) { setText(d.text ?? ""); setSaved(d.text ?? ""); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [workspace, lane]);

  if (!workspace || !lane) return null;
  const dirty = text !== saved;
  return h("div", { style: { marginTop: 10, borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: 8 } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
      h("span", { style: { fontWeight: 700, fontSize: 12 } }, "职责提示词"),
      h("span", { style: { ...AP_ROW_CHIP, fontSize: 10 } }, lane),
      dirty ? h("span", { style: { fontSize: 10, color: "#e0a53a" } }, "未保存") : null,
    ),
    h("textarea", {
      style: { ...AP_ROW_INPUT, width: "100%", minHeight: 56, resize: "vertical", boxSizing: "border-box" },
      value: text,
      placeholder: "这条泳道是干什么的？（如：后端=服务端接口与数据；部署测试=发版与冒烟验证）派发该泳道任务时会注入给执行子代理；留空保存=清除",
      onChange: (e) => setText(e.target.value),
    }),
    h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4 } },
      h("button", {
        style: AP_ROW_PRIMARY, disabled: busy,
        onClick: () => {
          setBusy(true); setMsg("");
          fetch("/api/dsh-graph-autopilot/manager", {
            method: "POST", credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspace, action: "lane-prompt-set", lane, text }),
          })
            .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
            .then(({ ok, d }) => {
              if (!ok) { setMsg("❌ " + (d?.error ?? "保存失败")); return; }
              setSaved(text); setMsg("✅ 已保存");
            })
            .catch((e) => setMsg("❌ " + (e?.message ?? "网络错误")))
            .finally(() => setBusy(false));
        },
      }, busy ? "…" : "保存泳道职责"),
      msg && h("span", { style: { fontSize: 11 } }, msg),
    ),
  );
}

// ---------------------------------------------------------------------------
// [v0.22] 任务连线画布：任务块分首尾——点卡片**上部**=开始连接、**下部**=结束连接、**中部**=实时协作连接
// 覆盖层用 fixed 定位 SVG（视口坐标），因此不依赖祖先定位；橡皮擦模式点线即删。
// ---------------------------------------------------------------------------
const AP_LINK_KINDS = {
  start: { label: "开始连接", color: "#4c8dff", hint: "前者交付后后者才开始" },
  end: { label: "结束连接", color: "#e0a53a", hint: "后者收尾依赖前者" },
  mid: { label: "实时协作", color: "#3ecf8e", hint: "两者实时同步协作" },
};

function LinksLayer(props) {
  const workspace = props?.workspace ?? null;
  if (workspace) apPanelWorkspace = workspace;
  const [links, setLinks] = React.useState([]);
  const [mode, setMode] = React.useState("idle"); // idle | link | erase
  const [pending, setPending] = React.useState(null); // { id, kind }
  const [tick, setTick] = React.useState(0);
  const [msg, setMsg] = React.useState("");
  // [v0.27] 连线体验（问题 14）：光标位置（预览线）、悬停卡片（高亮 + 锚点提示）、悬停连线（擦除提示）
  const [pointer, setPointer] = React.useState(null);       // { x, y } 视口坐标
  const [hoverCard, setHoverCard] = React.useState(null);   // { id, kind }
  const [hoverLink, setHoverLink] = React.useState(null);   // 被悬停的连线 id
  const hoverElRef = React.useRef(null);                    // 被临时高亮的卡片元素 + 其原始样式（还原用）
  const rafRef = React.useRef(0);                           // 挂起的 rAF（节流光标）
  const ptrRef = React.useRef(null);                        // rAF 内读取的最新光标

  const load = React.useCallback(() => {
    if (!workspace) return;
    fetch("/api/dsh-graph-autopilot/links", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "list" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.ok) setLinks(Array.isArray(d.links) ? d.links : []); })
      .catch(() => {});
  }, [workspace]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const h = () => load();
    window.addEventListener("autopilot:adopted", h);
    window.addEventListener("autopilot:links-changed", h);
    return () => { window.removeEventListener("autopilot:adopted", h); window.removeEventListener("autopilot:links-changed", h); };
  }, [load]);
  // 位置随滚动/尺寸变化重算（每 800ms + 滚动/缩放事件）
  React.useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const t = setInterval(bump, 800);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => { clearInterval(t); window.removeEventListener("scroll", bump, true); window.removeEventListener("resize", bump); };
  }, []);
  React.useEffect(() => {
    if (mode !== "link") setPending(null);
    // [v0.27] 退出连线/擦除模式时清掉悬停反馈，并把卡片样式还原（绝不留存高亮污染）
    if (mode !== "link") { restoreHover(); setHoverCard(null); setPointer(null); }
    if (mode !== "erase") setHoverLink(null);
  }, [mode]);

  const cardRect = (id) => {
    const el = document.querySelector(`[data-goal-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r;
  };
  const anchor = (rect, kind, side) => {
    if (!rect) return null;
    if (kind === "start") return side === "from" ? { x: rect.left + rect.width / 2, y: rect.top } : { x: rect.left + rect.width / 2, y: rect.bottom };
    if (kind === "end") return side === "from" ? { x: rect.left + rect.width / 2, y: rect.bottom } : { x: rect.left + rect.width / 2, y: rect.top };
    return side === "from" ? { x: rect.right, y: rect.top + rect.height / 2 } : { x: rect.left, y: rect.top + rect.height / 2 };
  };

  // [v0.27] 悬停高亮：只临时改卡片的 outline/boxShadow，退出/移开/卸载立即按原值还原
  // （函数声明而非 const 箭头：下面的 mode 副作用会引用它，避免任何前向引用/求值顺序问题）
  function restoreHover() {
    const cur = hoverElRef.current;
    if (!cur) return;
    try {
      cur.el.style.boxShadow = cur.boxShadow;
      cur.el.style.outline = cur.outline;
      cur.el.style.outlineOffset = cur.outlineOffset;
    } catch { /* 元素已卸载 */ }
    hoverElRef.current = null;
  }
  function paintHover(el, kind) {
    if (hoverElRef.current && hoverElRef.current.el !== el) restoreHover();
    if (!el) { restoreHover(); return; }
    if (!hoverElRef.current) {
      hoverElRef.current = { el, boxShadow: el.style.boxShadow, outline: el.style.outline, outlineOffset: el.style.outlineOffset };
    }
    const color = (AP_LINK_KINDS[kind] ?? AP_LINK_KINDS.start).color;
    try {
      el.style.outline = "2px solid " + color;
      el.style.outlineOffset = "2px";
      el.style.boxShadow = "0 0 0 2px " + color + "aa, 0 0 18px " + color + "99";
    } catch { /* 元素已卸载 */ }
  }
  // rAF 节流（无 requestAnimationFrame 的极早期环境退化为 ~16ms 定时器）
  const raf = (cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16));
  const caf = (id) => { try { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); } catch { /* ignore */ } try { clearTimeout(id); } catch { /* ignore */ } };
  /** [v0.28] 坐标命中：连线交互走 document 捕获阶段监听（无捕获层，e.target 可能是任意元素）→ 统一用 elementsFromPoint 找卡片 */
  const cardAt = (x, y) => {
    try {
      const stack = document.elementsFromPoint(x, y) || [];
      return stack.find((n) => n?.getAttribute?.("data-goal-id")) ?? null;
    } catch { return null; }
  };
  /** [v0.27] 连线模式：记录光标（rAF 节流）→ 命中卡片即高亮 + 锚点提示 + 预览线 */
  const onLayerMove = (e) => {
    ptrRef.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current) return;
    rafRef.current = raf(() => {
      rafRef.current = 0;
      const p = ptrRef.current;
      if (!p) return;
      setPointer(p);
      const el = cardAt(p.x, p.y);
      if (!el) { setHoverCard(null); restoreHover(); return; }
      const rect = el.getBoundingClientRect();
      const rel = (p.y - rect.top) / Math.max(1, rect.height);
      const kind = rel < 0.33 ? "start" : rel > 0.66 ? "end" : "mid";
      setHoverCard({ id: el.getAttribute("data-goal-id"), kind });
      paintHover(el, kind);
    });
  };
  const onLayerLeave = () => {
    setPointer(null);
    setHoverCard(null);
    restoreHover();
  };
  // [v0.27] 连线几何只在 links/tick 变化时重算（光标移动不再反复重测 DOM）
  const paths = React.useMemo(() => {
    const out = [];
    for (const l of links) {
      const a = anchor(cardRect(l.from), l.kind, "from");
      const b = anchor(cardRect(l.to), l.kind, "to");
      if (!a || !b) continue;
      const c1 = { x: a.x, y: a.y + (l.kind === "start" ? -40 : l.kind === "end" ? 40 : 0) };
      const c2 = { x: b.x, y: b.y + (l.kind === "start" ? 40 : l.kind === "end" ? -40 : 0) };
      if (l.kind === "mid") { c1.x = a.x + 40; c2.x = b.x - 40; }
      out.push({ ...l, a, b, d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`, color: AP_LINK_KINDS[l.kind].color });
    }
    return out;
  }, [links, tick]);
  // [v0.27] 卸载兜底：取消挂起的 rAF + 还原被高亮的卡片（不留样式污染）
  React.useEffect(() => () => {
    if (rafRef.current) caf(rafRef.current);
    restoreHover();
  }, []);

  // [v0.28] 新问题修复：连线模式退不出来（鼠标一直画笔、按钮点不到）。
  // 根因：原全屏点击捕获层（pointerEvents:auto, zIndex 6）盖住了包括头部工具条在内的所有东西，
  // portal 到 .dg-head 的「✖ 退出连线」按钮被压在下面点不到。
  // 改法：删掉全屏捕获层，改用 document 级捕获阶段监听（随连线模式挂/卸）：
  //   click：elementsFromPoint 命中 [data-goal-id] → preventDefault+stopPropagation 拦住卡片原有 onClick，
  //          走选起点/完成连线；未命中且有 pending → 取消 pending（不吞事件）；未命中且无 pending → 不动作。
  //   mousemove：悬停高亮/锚点提示/预览线（复用 onLayerMove，事件源换成 document）。
  // 光标：不再全屏 crosshair；挂模式时给 documentElement 设 data-ap-linking="1" 并注入一次性样式
  //   [data-ap-linking] [data-goal-id]{cursor:crosshair}（只对卡片生效，其它地方正常光标）。
  // 擦除模式不挂监听：「点线删除」由连线 SVG 自身的 onClick 完成，卡片/工具条保持正常交互。
  React.useEffect(() => {
    if (mode !== "link" || typeof document === "undefined") return undefined;
    try {
      if (!document.getElementById("dsh-graph-ap-linking-style")) {
        const s = document.createElement("style");
        s.id = "dsh-graph-ap-linking-style";
        s.textContent = "[data-ap-linking] [data-goal-id]{cursor:crosshair}";
        document.head.appendChild(s);
      }
      document.documentElement.setAttribute("data-ap-linking", "1");
    } catch { /* 极早期环境忽略 */ }
    const onClickDoc = (e) => {
      const el = cardAt(e.clientX, e.clientY);
      if (!el) {           // 空白处点击 = 取消已选起点；不吞事件（「✖ 退出连线」等按钮照常工作）
        if (pending) { setPending(null); setMsg("已取消起点选择"); }
        return;
      }
      e.preventDefault(); // 拦住卡片原有 onClick（仅当点在目标卡片上）
      e.stopPropagation();
      const id = el.getAttribute("data-goal-id");
      const rect = el.getBoundingClientRect();
      const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
      const kind = rel < 0.33 ? "start" : rel > 0.66 ? "end" : "mid";
      if (!pending) { setPending({ id, kind }); setMsg(`起点 ${id}（${AP_LINK_KINDS[kind].label}）→ 再点终点`); return; }
      if (pending.id === id) { setPending(null); setMsg("已取消起点选择"); return; }
      const body = { workspace, action: "add", from: pending.id, to: id, kind: pending.kind };
      fetch("/api/dsh-graph-autopilot/links", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          if (!ok) { setMsg("❌ " + (d?.error ?? "连线失败")); return; }
          setLinks(Array.isArray(d.links) ? d.links : []);
          setMsg(`✅ 已建立 ${AP_LINK_KINDS[pending.kind].label}：${pending.id} → ${id}`);
          window.dispatchEvent(new CustomEvent("autopilot:links-changed"));
        })
        .catch((e2) => setMsg("❌ " + (e2?.message ?? "网络错误")))
        .finally(() => setPending(null));
    };
    document.addEventListener("click", onClickDoc, true);
    document.addEventListener("mousemove", onLayerMove, true);
    document.addEventListener("mouseleave", onLayerLeave);
    return () => {
      document.removeEventListener("click", onClickDoc, true);
      document.removeEventListener("mousemove", onLayerMove, true);
      document.removeEventListener("mouseleave", onLayerLeave);
      // 退出连线模式/卸载：移除光标属性（被高亮卡片的原样式由上方 mode 副作用与卸载兜底还原）
      try { document.documentElement.removeAttribute("data-ap-linking"); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pending, workspace]);

  const erase = (id, e) => {
    e.stopPropagation();
    fetch("/api/dsh-graph-autopilot/links", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, action: "remove", id }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { setMsg("❌ " + (d?.error ?? "删除失败")); return; }
        setLinks(Array.isArray(d.links) ? d.links : []);
        setHoverLink((cur) => (cur === id ? null : cur)); // [v0.27] 被删的线不能继续悬停
        setMsg("🧽 已擦除一条连线");
        window.dispatchEvent(new CustomEvent("autopilot:links-changed"));
      })
      .catch(() => {});
  };

  if (!workspace) return null;

  // [v0.27] 悬停卡片的三个锚点提示（上=开始 / 中=协作 / 下=结束）
  const hoverRect = hoverCard ? cardRect(hoverCard.id) : null;
  // [v0.27] 预览线：已选起点 → 光标（悬停到卡片时吸附到该卡片对应锚点，明确「会连到哪个部位」）
  const preview = (() => {
    if (mode !== "link" || !pending || !pointer) return null;
    const from = anchor(cardRect(pending.id), pending.kind, "from");
    if (!from) return null;
    const kind = AP_LINK_KINDS[pending.kind] ?? AP_LINK_KINDS.start;
    let to = pointer;
    let toKind = pending.kind;
    if (hoverCard) {
      const t = anchor(hoverRect, hoverCard.kind, "to");
      if (t) { to = t; toKind = hoverCard.kind; }
    }
    const c1 = { x: from.x, y: from.y + (pending.kind === "start" ? -40 : pending.kind === "end" ? 40 : 0) };
    const c2 = { x: to.x, y: to.y + (toKind === "start" ? 40 : toKind === "end" ? -40 : 0) };
    if (pending.kind === "mid") { c1.x = from.x + 40; c2.x = to.x - 40; }
    return { d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`, color: kind.color };
  })();

  // [v0.26] 工具条：挂进看板头部工具行（.dg-head，与 刷新/标签筛选/记忆/项目知识库/已归档 同一行）
  const toolbarEl = h("div", {
    style: { display: "flex", gap: 6, alignItems: "center", padding: "2px 8px", borderRadius: 8, background: "rgba(20,22,27,.55)", border: "1px solid rgba(140,145,155,.4)", fontSize: 11, marginLeft: 8, flexShrink: 0 },
  },
    h("span", { style: { fontWeight: 700 } }, "🔗 连线"),
    h("span", { style: AP_ROW_CHIP }, links.length + " 条"),
    h("button", { style: mode === "link" ? AP_ROW_PRIMARY : AP_ROW_BTN, onClick: () => setMode(mode === "link" ? "idle" : "link") }, mode === "link" ? "✖ 退出连线" : "✏️ 连线"),
    h("button", { style: mode === "erase" ? { ...AP_ROW_PRIMARY, background: "#c0392b", borderColor: "#c0392b" } : AP_ROW_BTN, onClick: () => setMode(mode === "erase" ? "idle" : "erase") }, mode === "erase" ? "✖ 退出擦除" : "🧽 橡皮擦"),
    ...Object.entries(AP_LINK_KINDS).map(([k, v]) => h("span", { key: k, title: v.hint, style: { display: "inline-flex", gap: 4, alignItems: "center", opacity: 0.9 } },
      h("span", { style: { width: 12, height: 3, borderRadius: 2, background: v.color, display: "inline-block" } }), v.label)),
    mode === "link" ? h("span", { style: { opacity: 0.75 } }, "点卡片上部=开始／中部=协作／下部=结束") : null,
    msg ? h("span", { style: { opacity: 0.9 } }, msg) : null,
    h("button", { style: AP_ROW_BTN, onClick: () => load() }, "⟳ 刷新"),
  );
  const headEl = (typeof document !== "undefined") ? document.querySelector(".dg-head") : null;
  const toolbarNode = (headEl && typeof ReactDOM !== "undefined" && ReactDOM && typeof ReactDOM.createPortal === "function")
    ? ReactDOM.createPortal(toolbarEl, headEl)
    : null;

  return h("div", {
    "data-ap-links-layer": "",
    style: { position: "fixed", inset: 0, zIndex: 6, pointerEvents: "none" },
  },
    h("svg", { width: "100%", height: "100%", style: { position: "absolute", inset: 0, pointerEvents: "none" } },
      h("defs", null,
        ...["start", "end", "mid"].map((k) => h("marker", {
          key: k, id: "ap-arrow-" + k, viewBox: "0 0 10 10", refX: 9, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse",
        }, h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: AP_LINK_KINDS[k].color })))),
      paths.map((p) => {
        const hovered = mode === "erase" && hoverLink === p.id; // [v0.27] 橡皮擦悬停：加粗 + 变红
        return h("path", {
          key: p.id,
          d: p.d,
          stroke: hovered ? "#ff6b6b" : p.color,
          strokeWidth: mode === "erase" ? (hovered ? 6 : 3) : 2,
          strokeDasharray: p.kind === "mid" ? "6 4" : undefined,
          strokeLinecap: "round",
          fill: "none",
          markerEnd: `url(#ap-arrow-${p.kind})`,
          style: {
            pointerEvents: mode === "erase" ? "stroke" : "none",
            cursor: mode === "erase" ? "pointer" : "default",
            filter: hovered ? "drop-shadow(0 0 4px #ff6b6b)" : undefined,
          },
          onClick: mode === "erase" ? (e) => erase(p.id, e) : undefined,
          onMouseEnter: mode === "erase" ? () => setHoverLink(p.id) : undefined,
          onMouseLeave: mode === "erase" ? () => setHoverLink((cur) => (cur === p.id ? null : cur)) : undefined,
        }, h("title", null, `${AP_LINK_KINDS[p.kind].label}：${p.from} → ${p.to}${mode === "erase" ? "（点此擦除）" : ""}`));
      }),
      // [v0.27] 橡皮擦悬停时在中点给出「点我删除」提示
      mode === "erase" && hoverLink && (() => {
        const p = paths.find((x) => x.id === hoverLink);
        if (!p) return null;
        return h("text", {
          x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 - 10, textAnchor: "middle", fontSize: 11,
          fill: "#ff6b6b", stroke: "rgba(0,0,0,.55)", strokeWidth: 3, paintOrder: "stroke",
          style: { pointerEvents: "none" },
        }, "点我删除");
      })(),
      // [v0.27] 预览线：已选起点 → 光标 / 吸附锚点（虚线，同色）
      preview && h("path", {
        d: preview.d, stroke: preview.color, strokeWidth: 2, strokeDasharray: "6 4", fill: "none",
        opacity: 0.9, style: { pointerEvents: "none" },
      }),
      // [v0.27] 悬停卡片的三个锚点小圆点，并高亮「当前鼠标所在部位会选中的类型」
      hoverCard && hoverRect && ["start", "mid", "end"].map((k) => {
        const pt = anchor(hoverRect, k, pending ? "to" : "from");
        if (!pt) return null;
        const active = hoverCard.kind === k;
        return h("circle", {
          key: "ap-dot-" + k, cx: pt.x, cy: pt.y, r: active ? 6.5 : 4,
          fill: active ? AP_LINK_KINDS[k].color : "rgba(20,22,27,.72)",
          stroke: AP_LINK_KINDS[k].color, strokeWidth: active ? 2.5 : 1.5, opacity: active ? 1 : 0.75,
          style: { pointerEvents: "none" },
        });
      }),
      // [v0.27] 跟随光标显示当前会建立的连接类型
      mode === "link" && hoverCard && pointer && h("text", {
        x: pointer.x + 12, y: pointer.y - 10, fontSize: 11, fill: AP_LINK_KINDS[hoverCard.kind].color,
        stroke: "rgba(0,0,0,.55)", strokeWidth: 3, paintOrder: "stroke",
        style: { pointerEvents: "none" },
      }, AP_LINK_KINDS[hoverCard.kind].label),
    ),
    // [v0.28] 原全屏点击捕获层已删除：它（pointerEvents:auto, zIndex 6）会盖住包括头部工具条在内的所有元素，
    // 导致 portal 到 .dg-head 的「✖ 退出连线 / ✖ 退出擦除」按钮点不到（连线模式退不出来）。
    // 连线交互改为 document 捕获阶段监听（见上方 useEffect）；本层只剩连线 SVG（pointerEvents:none，
    // 不遮挡任何点击），擦除模式的「点线删除」由每条连线自身的 onClick 承担，不受影响。
    // 工具条：**放进看板自身的头部工具行**（.dg-head，与 刷新/标签筛选/记忆/项目知识库/已归档 同一行），
    // 用 ReactDOM.createPortal 挂进去；极早期（头部还没渲染）时退化为层内展示。
    // 头部已存在 → portal 到工具行；否则退化为层内展示
    headEl ? toolbarNode : toolbarEl,
  );
}

>>>ESM-EXPORTS-START>>>
// 仅 node --test / 静态检查用；浏览器 bundle 由 build-client.sh 剥离本块。
export { AutopilotPanel, TemplateLane, TrashLane, LanePromptEditor, LinksLayer, apDragStart, apDragEnd, apAdoptIntoLane, apArchiveGoal };
<<<ESM-EXPORTS-END<<<
