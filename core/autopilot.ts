/**
 * [autopilot-fork] 自动驾驶层 —— 让「收集 → 执行 → 评审 → 交付」全套流程可以自走。
 *
 * 职责边界（全部复用 ops.ts 既有原语，不另起数据格式）：
 *  - 全局状态：全局提示词 / 全局目标 / 开关（.dsh-graph/autopilot.json）；
 *  - 推荐扫描：对工作区做启发式信号收集（git 历史 / 未提交改动 / TODO 标记 / 构建脚本缺口 /
 *    与全局目标的对齐度），产出结构化推荐清单；LLM 精化由主管会话在采纳前完成；
 *  - 采纳：推荐 → createGoal 落成 backlog 草稿或版本目标，判据经 setCriteria 写入并确认；
 *  - 行就绪：laneReadiness 给出每个目标能否被自动驾驶执行器派发的机器判定；
 *  - 自动预设：按目标文本推荐 Agent 预设（advisory，写进派发简介；手动选择始终优先）。
 *
 * 归档复用内置 archiveGoal/unarchiveGoal（versions/vX/archived/…），本模块只补 listArchived。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { appendEvent, readEvents } from "./events.ts";
import { createGoal, findGoalFile, loadGoal, saveGoal, setCriteria, moveGoal, unarchiveGoal, normalizeGoalType, readGoalBinding, GraphError } from "./ops.ts";

export const AUTOPILOT_STATE_FILE = "autopilot.json";
export const RECOMMENDATIONS_FILE = "autopilot-recommendations.json";

// ---------------------------------------------------------------------------
// 全局状态（全局提示词 / 全局目标 / 开关）
// ---------------------------------------------------------------------------
export interface AutopilotState {
  /** 全局提示词：设置后所有子 AI（执行/推荐/检查）都必须遵循；可随时追加。 */
  globalPrompt: string | null;
  /** 全局目标：推荐与持续检查的核心锚点。 */
  globalGoal: { text: string; updatedAt: string } | null;
  /** 初始执行子 AI 是否按任务分析自动选择 Agent 预设（手动选择时以手动为准）。 */
  autoPreset: boolean;
  /** 评审模式：auto = 机器门禁后自动裁决（automation=ai）；human = 停在 review 等人。**默认 auto（机审）**。 */
  reviewMode: "auto" | "human";
  /** [v0.18] 推荐管理员的**独立上行文**（为空时用内置默认上行文）。 */
  managerPrompt: string | null;
  /** [v0.18] 推荐管理员是否启用（实时/定时管理推荐）。 */
  managerEnabled: boolean;
  /** [v0.18] 管理轮询间隔（分钟）。 */
  managerIntervalMin: number;
  /** [v0.18] 上次管理运行时间（ISO）。 */
  managerLastRun: string | null;
  /** [v0.18] 允许管理员顺带维护全局目标 / 全局提示词。 */
  managerUpdateGlobals: boolean;
  /** [v0.20] 上次「阻塞自愈」唤起管理员的时间（ISO），用于冷却，避免反复拉起。 */
  blockerHandledAt?: string | null;
  /** [v0.25] 按泳道选模型：key = 泳道键（版本 slug / standalone / backlog / "*" 通配），值 = 该泳道执行子代理用的模型路由。 */
  laneModels?: Record<string, { provider?: string | null; model?: string | null; reasoning_effort?: string | null }>;
  /** [v0.19] 泳道职责提示词：key = 泳道键（版本 slug / standalone / backlog），值 = 该泳道是干什么的（派发时注入执行子代理）。 */
  lanePrompts: Record<string, string>;
  /** [v0.28] 目标推进模式：管理员定时器每轮检查「有未完结目标」的泳道并自动起跑 runner（绝不采纳新推荐）。 */
  advanceMode?: boolean;
  /** [v0.28] 全局托管模式：包含目标推进的全部行为，另含推荐自动扫描（空清单 15 分钟一扫）与
   *  自动采纳（推荐非空且无 runner 在跑时采纳第 1 条到「建议泳道」，10 分钟冷却）。
   *  两个模式都**永不自动停止**：只有开关被关掉才不再推进/不再采纳（不杀在跑的 runner）。 */
  steward?: { enabled: boolean; lastScanAt?: string | null; lastAdoptAt?: string | null };
}

const DEFAULT_STATE: AutopilotState = {
  globalPrompt: null,
  globalGoal: null,
  autoPreset: true,
  reviewMode: "auto",
  managerPrompt: null,
  managerEnabled: false,
  managerIntervalMin: 30,
  managerLastRun: null,
  managerUpdateGlobals: true,
  lanePrompts: {},
  advanceMode: false,
  steward: { enabled: false, lastScanAt: null, lastAdoptAt: null },
};

export function readAutopilotState(root: string): AutopilotState {
  try {
    const raw = JSON.parse(readFileSync(join(root, AUTOPILOT_STATE_FILE), "utf8"));
    return { ...DEFAULT_STATE, ...(raw && typeof raw === "object" ? raw : {}) } as AutopilotState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeAutopilotState(
  root: string,
  patch: Partial<AutopilotState>,
  opts?: { actor?: string },
): AutopilotState {
  const next: AutopilotState = { ...readAutopilotState(root), ...patch };
  writeFileSync(join(root, AUTOPILOT_STATE_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
  appendEvent(root, {
    actor: opts?.actor ?? "system:autopilot",
    event: "autopilot.state_set",
    details: { keys: Object.keys(patch) },
  });
  return next;
}

// ---------------------------------------------------------------------------
// 推荐扫描（启发式信号收集，零 LLM；LLM 精化交给主管会话）
// ---------------------------------------------------------------------------
export interface Recommendation {
  title: string;
  type: string;
  description: string;
  criteria: string[];
  reason: string;
  score: number;
}

const SCAN_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "core-dist", "archive", "archived",
  ".dsh-graph", ".worktrees", "screenshots", "screenshot", "tmp", "coverage",
]);
const SCAN_SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".vue"]);
const SCAN_MAX_FILES = 120;
const SCAN_MAX_FILE_BYTES = 512 * 1024;

function safeGit(wsDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: wsDir, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8",
    });
  } catch {
    return null; // 非仓库 / git 不可用：如实降级，不猜
  }
}

function normalizeTitle(t: string): string {
  return String(t ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** 提取目标正文某个小节文本（找不到返回空串）。 */
function sectionText(body: string, heading: string): string {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** CJK 字符二元组 + ASCII 词的重叠度（0~1），用于全局目标对齐打分。 */
function overlapRatio(goalText: string, text: string): number {
  const grams = (s: string) => {
    const t = String(s ?? "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) {
      const pair = t.slice(i, i + 2);
      if (/[\u4e00-\u9fff]{2}/.test(pair)) set.add(pair);
    }
    for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) set.add(w);
    return set;
  };
  const a = grams(goalText);
  if (a.size === 0) return 0;
  const b = grams(text);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

function existingGoalTitles(root: string): string[] {
  const titles: string[] = [];
  const pushIfGoal = (file: string) => {
    try {
      const doc = loadGoal(file);
      if (doc?.meta?.title) titles.push(String(doc.meta.title));
    } catch { /* 半成品文件跳过 */ }
  };
  const versionsDir = join(root, "versions");
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir)) {
      const gdir = join(versionsDir, v, "goals");
      if (!existsSync(gdir)) continue;
      for (const id of readdirSync(gdir)) {
        const f = join(gdir, id, "goal.md");
        if (existsSync(f)) pushIfGoal(f);
      }
    }
  }
  const standaloneDir = join(root, "goals");
  if (existsSync(standaloneDir)) {
    for (const id of readdirSync(standaloneDir)) {
      const f = join(standaloneDir, id, "goal.md");
      if (existsSync(f)) pushIfGoal(f);
    }
  }
  const backlogDir = join(root, "backlog");
  if (existsSync(backlogDir)) {
    for (const name of readdirSync(backlogDir)) {
      if (name.endsWith(".md")) pushIfGoal(join(backlogDir, name));
      else {
        const f = join(backlogDir, name, "goal.md");
        if (existsSync(f)) pushIfGoal(f);
      }
    }
  }
  return titles;
}

export function scanRecommendations(
  root: string,
  opts?: { workspaceDir?: string | null; globalGoalText?: string | null; actor?: string },
): Recommendation[] {
  const wsDir = opts?.workspaceDir ?? dirname(root);
  const existing = existingGoalTitles(root).map(normalizeTitle);
  const existingSet = new Set(existing);
  const recs: Recommendation[] = [];
  const seenTitles = new Set<string>();

  const push = (rec: Omit<Recommendation, "score"> & { score?: number }) => {
    const title = String(rec.title ?? "").trim();
    if (!title) return;
    const key = normalizeTitle(title);
    if (!key || existingSet.has(key) || seenTitles.has(key)) return;
    for (const t of seenTitles) {
      if (key.includes(t) || t.includes(key)) return; // 近重复
    }
    seenTitles.add(key);
    recs.push({ ...rec, title, score: rec.score ?? 0, criteria: rec.criteria ?? [] });
  };

  // ① 全局目标优先：以全局目标为锚拆解第一步（这是「全局目标模式」的推荐核心）
  const goalText = String(opts?.globalGoalText ?? "").trim();
  if (goalText) {
    push({
      title: `【全局目标】${goalText.slice(0, 40)}——拆解第一步`,
      type: "task",
      description: `围绕全局目标「${goalText}」拆解出的第一个可执行步骤。全局提示词与本目标均已生效，执行结果将对照全局目标持续检查。`,
      criteria: ["第一步范围明确且可在单次 attempt 内完成", "产出物可验证（文件/命令输出/报告）", "完成后向全局目标推进可度量"],
      reason: "全局目标模式：以全局目标为核心的任务拆解",
      score: 10,
    });
  }

  // ② git：未提交改动 → 提交/清理
  const status = safeGit(wsDir, ["status", "--porcelain"]);
  if (status && status.trim()) {
    const n = status.trim().split("\n").length;
    push({
      title: `提交并整理 ${n} 项未提交改动`,
      type: "chore",
      description: `工作区存在 ${n} 项未提交改动（git status --porcelain）。分类提交或入库清理，保持执行链路的 worktree 干净基线。`,
      criteria: ["改动按逻辑分组提交", "提交信息描述变更意图", "git status 干净或仅剩有意保留项"],
      reason: "git 工作区不干净（执行链路依赖干净基线）",
      score: 7,
    });
  }

  // ③ git：近期提交里的 TODO/FIXME 线索
  const log = safeGit(wsDir, ["log", "--oneline", "-15"]);
  if (log && /todo|fixme/i.test(log)) {
    push({
      title: "跟进提交历史中标记的 TODO/FIXME 事项",
      type: "task",
      description: "最近 15 条提交信息中出现了 TODO/FIXME 字样，逐条核对并转化为目标或关闭。",
      criteria: ["每条 TODO/FIXME 有明确处置（完成/立目标/关闭）", "处置结果可追溯"],
      reason: "提交历史含 TODO/FIXME 线索",
      score: 5,
    });
  }

  // ④ 源码 TODO/FIXME 扫描（有界：广度一层、总量 120 文件）
  let budget = SCAN_MAX_FILES;
  const todoFiles: { file: string; hits: string[] }[] = [];
  const scanDir = (dir: string, depth: number) => {
    if (depth > 2 || budget <= 0 || todoFiles.length >= 3) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (budget <= 0 || todoFiles.length >= 3) return;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(name)) scanDir(full, depth + 1);
        continue;
      }
      if (!SCAN_SOURCE_EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase())) continue;
      if (st.size > SCAN_MAX_FILE_BYTES) continue;
      budget--;
      try {
        const text = readFileSync(full, "utf8");
        const hits = text.split(/\r?\n/).filter((l) => /\b(TODO|FIXME)\b/.test(l)).slice(0, 3);
        if (hits.length) todoFiles.push({ file: full.slice(wsDir.length + 1), hits });
      } catch { /* 不可读跳过 */ }
    }
  };
  try { scanDir(wsDir, 0); } catch { /* 工作区不可读 */ }
  for (const t of todoFiles) {
    push({
      title: `清理 ${t.file} 中的 TODO/FIXME（${t.hits.length} 处）`,
      type: "task",
      description: `该文件存在 ${t.hits.length} 处 TODO/FIXME 标记，逐条转化为实现、立为目标或删除。首条：${t.hits[0]?.trim().slice(0, 80)}`,
      criteria: ["每处标记有明确处置", "处置不引入回归"],
      reason: "源码 TODO/FIXME 扫描命中",
      score: 4,
    });
  }

  // ⑤ 构建脚本缺口：无 test 脚本 → 补测试基线
  const pkgFile = join(wsDir, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
      if (!pkg.scripts?.test) {
        push({
          title: `为 ${pkg.name ?? "当前项目"} 补测试基线`,
          type: "chore",
          description: "package.json 缺少 test 脚本。评审的机器门禁依赖可执行测试，先立测试基线（哪怕最小 smoke）。这也会让本目标走快速评审通道。",
          criteria: ["npm test 可执行且有断言", "接入至少一个核心路径的冒烟用例"],
          reason: "机器评审门禁需要可执行测试",
          score: 6,
        });
      }
    } catch { /* package.json 损坏：跳过 */ }
  }

  // ⑥ 全局目标对齐加成
  if (goalText) {
    for (const r of recs) {
      if (overlapRatio(goalText, `${r.title} ${r.description}`) >= 0.08) r.score += 2;
    }
  }

  recs.sort((a, b) => b.score - a.score);
  return recs.slice(0, 8);
}

export function saveRecommendations(root: string, recs: Recommendation[], opts?: { actor?: string }): void {
  writeFileSync(join(root, RECOMMENDATIONS_FILE), JSON.stringify(recs, null, 2) + "\n", "utf8");
  appendEvent(root, {
    actor: opts?.actor ?? "system:autopilot",
    event: "autopilot.recommendations_saved",
    details: { count: recs.length },
  });
}

export function readRecommendations(root: string): Recommendation[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, RECOMMENDATIONS_FILE), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 采纳：推荐 → 真实目标（复用 createGoal + setCriteria，事件流与手工一致）
// ---------------------------------------------------------------------------
export function adoptRecommendations(
  root: string,
  picks: number[],
  opts: { version?: string | null; actor: string; confirmCriteria?: boolean },
): { created: { id: string; title: string; version: string | null }[] } {
  const recs = readRecommendations(root);
  const created: { id: string; title: string; version: string | null }[] = [];
  for (const pick of picks) {
    const idx = Number(pick);
    if (!Number.isInteger(idx) || idx < 1 || idx > recs.length) {
      throw new GraphError(`推荐序号无效：${pick}（有效范围 1-${recs.length}）`);
    }
    const rec = recs[idx - 1];
    const id = createGoal(root, {
      title: rec.title,
      type: rec.type,
      description: rec.description,
      actor: opts.actor,
      version: opts.version ?? undefined,
    });
    if (opts.confirmCriteria !== false && Array.isArray(rec.criteria) && rec.criteria.length > 0) {
      setCriteria(root, id, rec.criteria.map((c) => `${c} ✅已验前不视为完成`), opts.actor);
    }
    const file = findGoalFile(root, id);
    created.push({ id, title: rec.title, version: loadGoal(file).meta.version ?? null });
  }
  appendEvent(root, {
    actor: opts.actor,
    event: "autopilot.adopted",
    details: { picks, created: created.map((c) => c.id), version: opts.version ?? null },
  });
  return { created };
}

// ---------------------------------------------------------------------------
// 行就绪检查（自动驾驶执行器的派发前机器判定）
// ---------------------------------------------------------------------------
export interface LaneGoalReadiness {
  id: string;
  title: string;
  status: string;
  ready: boolean;
  blockers: string[];
}

export function laneReadiness(root: string, version: string, opts?: {
  /**
   * [v0.27] 问题 9 收尾：子代理存活探测。对「当前 attempt 的 child id」返回 false 表示**已死**
   * （典型场景：DSH 重启后内存 registry 里不再有该 child），此时不再以「已在执行中」阻断派发。
   * 未提供回调、拿不到 child id 或回调返回 true/未知时，一律保守按「仍在执行」处理。
   */
  isLive?: (childId: string) => boolean;
}): {
  version: string;
  goals: LaneGoalReadiness[];
  runnable: string[];
} {
  const gdir = join(root, "versions", version, "goals");
  if (!existsSync(gdir)) throw new GraphError(`版本 ${version} 不存在或没有 goals 目录`);
  const events = readEvents(root);
  const goals: LaneGoalReadiness[] = [];
  for (const id of readdirSync(gdir).sort()) {
    const file = join(gdir, id, "goal.md");
    if (!existsSync(file)) continue;
    const doc = loadGoal(file);
    if (doc.meta.archived) continue;
    const blockers: string[] = [];
    if (doc.meta.status === "in_progress") {
      // [v0.27] 问题 9：attempt 子代理已死（如 DSH 重启后 live registry 无此 child）时不阻断派发，
      // 让自动恢复能重新执行该目标；拿不到 child id（无绑定/绑定已清）时保守沿用旧阻断。
      let childGone = false;
      if (opts?.isLive) {
        try {
          const binding = readGoalBinding(root, id);
          if (binding?.child_id) childGone = opts.isLive(binding.child_id) === false;
        } catch { /* 绑定读取失败：保守按仍在执行处理 */ }
      }
      if (!childGone) blockers.push("已在执行中（等待当前 attempt 收尾）");
    }
    if (doc.meta.status === "blocked") blockers.push(`目标阻塞：${doc.meta.blocked_reason || "未提供原因"}`);
    if (doc.meta.status === "delivered") blockers.push("已交付");
    if (doc.meta.status === "draft") blockers.push("仍是草稿（backlog 目标不可派发）");
    const desc = sectionText(doc.body, "目标描述");
    if (!desc || desc.startsWith("（待登记")) blockers.push("目标描述为空或占位符——先补写描述再派发");
    const confirmed = events.some((e) => e.goal === id && e.event === "criteria.confirmed");
    if (!confirmed) blockers.push("质量判据未确认（criteria.confirmed 缺失）");
    goals.push({ id, title: doc.meta.title ?? id, status: String(doc.meta.status ?? ""), ready: blockers.length === 0, blockers });
  }
  return { version, goals, runnable: goals.filter((g) => g.ready).map((g) => g.id) };
}

// ---------------------------------------------------------------------------
// 自动预设推荐（advisory：写进派发简介；用户手动选择始终优先）
// ---------------------------------------------------------------------------
const PRESET_KEYWORDS: [string, string[]][] = [
  ["programming", ["代码", "接口", "api", "bug", "修复", "重构", "实现", "测试", "编译", "构建", "脚本", "开发", "服务", "前端", "后端"]],
  ["ppt", ["幻灯", "演示", "ppt", "汇报", "演讲", "deck"]],
  ["redteam", ["渗透", "安全", "红队", "漏洞", "攻防", "提权"]],
  ["plugin-dev", ["插件", "plugin", "扩展开发"]],
  ["swarm", ["蜂群", "多角色", "流水线", "分工", "协同"]],
  ["expert-mode", ["评审", "专家", "分析", "调研", "评估"]],
  ["flow", ["流程", "工作流", "自动化", "编排"]],
];

export function autoPresetFor(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  for (const [preset, words] of PRESET_KEYWORDS) {
    if (words.some((w) => t.includes(w))) return preset;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 归档清单（复用内置 archiveGoal 的目录约定）
// ---------------------------------------------------------------------------
/** 已交付（delivered）且未归档的目标清单 —— 归档行的「可归档」来源。 */
export function listDelivered(root: string): { id: string; title: string; version: string | null }[] {
  const out: { id: string; title: string; version: string | null }[] = [];
  const consider = (file: string, version: string | null) => {
    try {
      const doc = loadGoal(file);
      if (doc.meta.archived) return;
      if (String(doc.meta.status ?? "") !== "delivered") return;
      out.push({ id: doc.meta.id ?? "", title: doc.meta.title ?? "", version });
    } catch { /* 半成品跳过 */ }
  };
  const versionsDir = join(root, "versions");
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir)) {
      const gdir = join(versionsDir, v, "goals");
      if (!existsSync(gdir)) continue;
      for (const id of readdirSync(gdir)) {
        const f = join(gdir, id, "goal.md");
        if (existsSync(f)) consider(f, v);
      }
    }
  }
  const standaloneDir = join(root, "goals");
  if (existsSync(standaloneDir)) {
    for (const id of readdirSync(standaloneDir)) {
      const f = join(standaloneDir, id, "goal.md");
      if (existsSync(f)) consider(f, null);
    }
  }
  return out;
}

export function listArchived(root: string): { id: string; title: string; from: string }[] {
  const out: { id: string; title: string; from: string }[] = [];
  const pushDoc = (file: string, from: string) => {
    try {
      const doc = loadGoal(file);
      out.push({ id: doc.meta.id ?? "", title: doc.meta.title ?? "", from });
    } catch { /* 半成品跳过 */ }
  };
  const versionsDir = join(root, "versions");
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir)) {
      const adir = join(versionsDir, v, "archived");
      if (!existsSync(adir)) continue;
      for (const id of readdirSync(adir)) {
        const f = join(adir, id, "goal.md");
        if (existsSync(f)) pushDoc(f, `versions/${v}/archived/${id}`);
      }
    }
  }
  const standaloneArch = join(root, "goals", "archived");
  if (existsSync(standaloneArch)) {
    for (const id of readdirSync(standaloneArch)) {
      const f = join(standaloneArch, id, "goal.md");
      if (existsSync(f)) pushDoc(f, `goals/archived/${id}`);
    }
  }
  const backlogArch = join(root, "backlog", "archived");
  if (existsSync(backlogArch)) {
    for (const name of readdirSync(backlogArch)) {
      // [v0.27] 问题 22：backlog 归档同时接受平铺 backlog/archived/<id>.md 与
      // 目录形态 backlog/archived/<id>/goal.md（带附件目标移回草稿后归档的落点）。
      if (name.endsWith(".md")) pushDoc(join(backlogArch, name), `backlog/archived/${name}`);
      else {
        const nested = join(backlogArch, name, "goal.md");
        if (existsSync(nested)) pushDoc(nested, `backlog/archived/${name}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 模板行（可复用的目标蓝图：拖到泳道 → 按模板建目标；模板本身长期留存）
// ---------------------------------------------------------------------------
export const TEMPLATES_FILE = "templates.json";

export interface GoalTemplate {
  id: string;
  title: string;
  type: string;
  description: string;
  criteria: string[];
  created_at: string;
  updated_at: string;
}

function templateIdFor(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return "tpl-" + (base || "untitled");
}

function readTemplatesFile(root: string): GoalTemplate[] {
  const file = join(root, TEMPLATES_FILE);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t: any) => t && typeof t.title === "string" && t.title.trim())
      .map((t: any) => ({
        id: String(t.id ?? templateIdFor(String(t.title))),
        title: String(t.title),
        type: normalizeGoalType(t.type),
        description: String(t.description ?? ""),
        criteria: Array.isArray(t.criteria) ? t.criteria.map((c: any) => String(c)).filter((c: string) => c.trim()) : [],
        created_at: String(t.created_at ?? ""),
        updated_at: String(t.updated_at ?? t.created_at ?? ""),
      }));
  } catch {
    return [];
  }
}

function writeTemplatesFile(root: string, list: GoalTemplate[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, TEMPLATES_FILE), JSON.stringify(list, null, 2) + "\n", "utf8");
}

export function listTemplates(root: string): GoalTemplate[] {
  return readTemplatesFile(root);
}

export function saveTemplate(
  root: string,
  input: { id?: string | null; title: string; type?: string; description?: string; criteria?: string[] },
  actor: string,
): GoalTemplate {
  const title = String(input?.title ?? "").trim();
  if (!title) throw new GraphError("模板标题不能为空");
  const list = readTemplatesFile(root);
  const now = new Date().toISOString();
  const fields = {
    title,
    type: normalizeGoalType(input.type),
    description: String(input.description ?? ""),
    criteria: Array.isArray(input.criteria) ? input.criteria.map((c) => String(c)).filter((c) => c.trim()) : [],
  };
  const existing = input.id ? list.find((t) => t.id === input.id) : null;
  if (existing) {
    Object.assign(existing, fields, { updated_at: now });
    writeTemplatesFile(root, list);
    appendEvent(root, { actor, event: "autopilot.template_saved", details: { id: existing.id, mode: "update" } });
    return existing;
  }
  // 新建：id 去重（同题模板追加 -2 / -3 …），保证拖拽落点定位稳定
  let id = templateIdFor(title);
  let n = 1;
  while (list.some((t) => t.id === id)) id = templateIdFor(title) + "-" + ++n;
  const tpl: GoalTemplate = { id, ...fields, created_at: now, updated_at: now };
  list.push(tpl);
  writeTemplatesFile(root, list);
  appendEvent(root, { actor, event: "autopilot.template_saved", details: { id, mode: "create" } });
  return tpl;
}

/** [v0.29] 问题 9：抹掉描述里的具体指代（目标 id / attempt id 等机器 id），保留原有结构与行文。
 *  只删「像 id 的 token」，不做改写、不做概括；删除后清理行内多余空白与行尾空白。 */
function stripGoalRefs(text: string, goalId: string): string {
  let t = String(text ?? "");
  const gid = String(goalId ?? "").trim();
  if (gid) t = t.split(gid).join("");
  t = t
    .replace(/\bg-\d{1,6}(?![\w\u4e00-\u9fff])/g, "")
    .replace(/\batt-\d{1,6}(?![\w\u4e00-\u9fff])/g, "");
  return t
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/**
 * [v0.29] 问题 9：由既有目标生成一条**通用模板**（读该目标 meta + body）。
 *  - title = 传入 name，或 `${类型}：${标题}`（类型取 meta.type 归一化后的机器值，与看板类型徽标同源）；
 *  - description = 原「目标描述」去掉目标 id / attempt id 等具体指代（保留结构与行文）；
 *  - criteria = 原判据原样保留（与 criteriaItemsOf 同口径：去 HTML 注释、按行 trim）；
 *  - tags 仅作为生成时的输入参考（模板结构不含 tags 字段），不写入 templates.json；
 *  - 落盘复用 saveTemplate（templates.json 唯一落盘路径），返回 {ok, template}。
 */
export function createTemplateFromGoal(
  root: string,
  goalId: string,
  opts: { name?: string | null } = {},
  actor: string,
): { ok: true; template: GoalTemplate } {
  const gid = String(goalId ?? "").trim();
  if (!gid) throw new GraphError("missing goal");
  const doc = loadGoal(findGoalFile(root, gid));
  const type = normalizeGoalType(doc.meta.type);
  const title = String(doc.meta.title ?? "").trim() || gid;
  const name = String(opts?.name ?? "").trim();
  const description = stripGoalRefs(sectionText(doc.body, "目标描述"), gid);
  const criteria = criteriaItemsOf(root, gid);
  const template = saveTemplate(
    root,
    { id: null, title: name || `${type}：${title}`, type, description, criteria },
    actor,
  );
  appendEvent(root, { actor, event: "autopilot.template_from_goal", details: { goal: gid, template: template.id } });
  return { ok: true, template };
}

export function deleteTemplate(root: string, id: string, actor: string): { ok: true; id: string } {
  const list = readTemplatesFile(root);
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) throw new GraphError(`模板不存在：${id}`);
  writeTemplatesFile(root, next);
  appendEvent(root, { actor, event: "autopilot.template_deleted", details: { id } });
  return { ok: true, id };
}

/**
 * 按模板建目标。version 语义与 createGoal 一致：
 *   null/undefined → backlog 草稿；"standalone" → 独立目标；其它 → 该版本泳道（不存在则隐式建版本）。
 * 模板本身不消耗，可反复拖用。
 */
export function applyTemplate(
  root: string,
  id: string,
  opts: { version?: string | null; actor: string; confirmCriteria?: boolean },
): { created: { id: string; title: string; version: string | null }[] } {
  const tpl = readTemplatesFile(root).find((t) => t.id === id);
  if (!tpl) throw new GraphError(`模板不存在：${id}`);
  const goalId = createGoal(root, {
    title: tpl.title,
    type: tpl.type,
    description: tpl.description,
    actor: opts.actor,
    version: opts.version ?? undefined,
  });
  if (opts.confirmCriteria !== false && tpl.criteria.length > 0) {
    setCriteria(root, goalId, tpl.criteria.map((c) => `${c} ✅已验前不视为完成`), opts.actor);
  }
  const file = findGoalFile(root, goalId);
  const created = { id: goalId, title: tpl.title, version: loadGoal(file).meta.version ?? null };
  appendEvent(root, {
    actor: opts.actor,
    event: "autopilot.template_applied",
    details: { template: id, goal: goalId, version: opts.version ?? null },
  });
  return { created: [created] };
}

// ---------------------------------------------------------------------------
// 回收站（看板最底部一行）：已归档目标 + 已移除版本，可一键恢复
// ---------------------------------------------------------------------------
export const TRASH_DIR = "_removed";

/**
 * 固定分组：与「独立目标」同属性——**不可删除**（负责人 2026-10-03 指定）。
 * 这是唯一事实来源：host 的 delete-version 路由与客户端隐藏删除入口都读它。
 */
export const PROTECTED_VERSION_SLUGS: string[] = ["interaction", "deploy-test", "backend"];

export function isProtectedVersion(slug: unknown, opts?: { root?: string | null; homeDir?: string | null }): boolean {
  const s = String(slug ?? "").trim();
  if (!s) return false;
  if (PROTECTED_VERSION_SLUGS.includes(s)) return true;
  // [v0.27] 问题 13：自建分组（workspace 定义 + 全局定义）与内置三条同属性 → 同样不可删除。
  // 兼容旧调用：只传 slug（无 root/home 上下文）时退化为「只认内置三条」。
  const root = String(opts?.root ?? "").trim();
  if (root) {
    try { if (readWorkspaceGroups(root).some((g) => g.slug === s)) return true; } catch { /* 读取失败按不保护处理 */ }
  }
  try { if (readGlobalGroupDefs(opts?.homeDir).some((g) => g.slug === s)) return true; } catch { /* 同上 */ }
  return false;
}

export interface RemovedVersion {
  /** 回收站内的目录名（含移入时间戳），恢复时用它定位 */
  dir: string;
  /** 去掉时间戳后的原版本 slug */
  slug: string;
  name: string;
  moved_at: string;
}

export function listRemovedVersions(root: string): RemovedVersion[] {
  const base = join(root, TRASH_DIR);
  if (!existsSync(base)) return [];
  const out: RemovedVersion[] = [];
  for (const dir of readdirSync(base)) {
    const vfile = join(base, dir, "version.md");
    if (!existsSync(vfile)) continue;
    const m = dir.match(/^(.*)-(\d{8}T\d{6})$/);
    let name = dir;
    try {
      const doc = loadGoal(vfile);
      name = String(doc.meta?.name ?? dir);
    } catch { /* 半成品用目录名兜底 */ }
    out.push({ dir, slug: (m ? m[1] : dir).trim(), name, moved_at: m ? m[2] : "" });
  }
  return out;
}

/** 把回收站里的版本目录移回 versions/<slug>。目标已存在则拒绝（绝不覆盖）。 */
export function restoreRemovedVersion(root: string, dir: string, actor: string): { ok: true; slug: string } {
  const base = String(dir ?? "").trim();
  if (!base || base.includes("/") || base.includes("\\") || base === "." || base === "..") {
    throw new GraphError(`非法回收站条目：${dir}`);
  }
  const src = join(root, TRASH_DIR, base);
  if (!existsSync(src)) throw new GraphError(`回收站中不存在：${base}`);
  const m = base.match(/^(.*)-(\d{8}T\d{6})$/);
  const slug = (m ? m[1] : base).trim();
  if (!slug) throw new GraphError(`无法从目录名解析版本 slug：${base}`);
  const dst = join(root, "versions", slug);
  if (existsSync(dst)) throw new GraphError(`版本 ${slug} 已存在，恢复会覆盖，已拒绝（请先重命名或清理）`);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
  appendEvent(root, { actor, event: "autopilot.trash_restored", details: { kind: "version", dir: base, slug } });
  return { ok: true, slug };
}

export function listTrash(root: string): { goals: { id: string; title: string; from: string }[]; versions: RemovedVersion[] } {
  return { goals: listArchived(root), versions: listRemovedVersions(root) };
}

// ---------------------------------------------------------------------------
// [v0.18] 目标扩展字段：选用技能 / Agent 预设（不选 = 空，派发时由 AI 自选）
// ---------------------------------------------------------------------------
export function setGoalExtras(
  root: string,
  id: string,
  extras: {
    skill_refs?: string[];
    preset?: string | null;
    actor: string;
    /** [v0.28] 问题 18：目标级执行设置 —— provider/model 覆盖泳道级与全局路由；
     *  context_len 为目标上下文预算（tokens，派发时以文字告知执行子代理注意裁剪）；
     *  extra_prompt 为负责人为本目标追加的执行要求（派发时作为独立段注入 attempt brief）。
     *  语义：undefined = 保持现状（不改动）；null 或空串 = 清除；非空 = 写入。 */
    provider?: string | null;
    model?: string | null;
    context_len?: number | string | null;
    extra_prompt?: string | null;
  },
): {
  ok: true;
  skill_refs: string[];
  preset: string | null;
  provider: string | null;
  model: string | null;
  context_len: number | null;
  extra_prompt: string | null;
} {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const refs = Array.isArray(extras.skill_refs)
    ? extras.skill_refs.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
    : Array.isArray(doc.meta.skill_refs) ? doc.meta.skill_refs as string[] : [];
  const preset = extras.preset == null ? null : String(extras.preset).trim() || null;
  const normStr = (v: unknown): string | null => (v == null ? null : (String(v).trim() || null));
  const provider = extras.provider === undefined ? ((doc.meta.agent_provider as string | undefined) ?? null) : normStr(extras.provider);
  const model = extras.model === undefined ? ((doc.meta.agent_model as string | undefined) ?? null) : normStr(extras.model);
  let contextLen: number | null = null;
  if (extras.context_len === undefined) {
    const prev = Number(doc.meta.agent_context_len);
    contextLen = Number.isFinite(prev) && prev > 0 ? Math.round(prev) : null;
  } else if (extras.context_len != null && String(extras.context_len).trim() !== "") {
    const n = Number(extras.context_len);
    contextLen = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const extraPrompt = extras.extra_prompt === undefined
    ? ((doc.meta.agent_extra_prompt as string | undefined) ?? null)
    : normStr(extras.extra_prompt);
  doc.meta.skill_refs = refs;
  doc.meta.agent_preset = preset;
  doc.meta.agent_provider = provider;
  doc.meta.agent_model = model;
  doc.meta.agent_context_len = contextLen;
  doc.meta.agent_extra_prompt = extraPrompt;
  saveGoal(file, doc);
  appendEvent(root, {
    actor: extras.actor,
    event: "autopilot.goal_extras_set",
    details: {
      goal: id,
      skills: refs,
      preset,
      provider,
      model,
      context_len: contextLen,
      extra_prompt_len: extraPrompt ? extraPrompt.length : 0,
    },
  });
  return { ok: true, skill_refs: refs, preset, provider, model, context_len: contextLen, extra_prompt: extraPrompt };
}

// ---------------------------------------------------------------------------
// [v0.18] 回收站：彻底删除（不可恢复）+ 恢复并落到指定泳道
// ---------------------------------------------------------------------------
export function purgeRemovedVersion(root: string, dir: string, actor: string): { ok: true; dir: string } {
  const base = String(dir ?? "").trim();
  if (!base || base.includes("/") || base.includes("\\") || base === "." || base === "..") {
    throw new GraphError(`非法回收站条目：${dir}`);
  }
  const target = join(root, TRASH_DIR, base);
  if (!existsSync(target)) throw new GraphError(`回收站中不存在：${base}`);
  rmSync(target, { recursive: true, force: true });
  appendEvent(root, { actor, event: "autopilot.trash_purged", details: { kind: "version", dir: base } });
  return { ok: true, dir: base };
}

/** 彻底删除已归档目标（定位方式与 listArchived 的 from 语义一致）。 */
export function purgeArchivedGoal(root: string, id: string, actor: string): { ok: true; id: string } {
  const gid = String(id ?? "").trim();
  if (!gid || gid.includes("/") || gid.includes("\\") || gid === "." || gid === "..") {
    throw new GraphError(`非法目标 id：${id}`);
  }
  const hit = listArchived(root).find((g) => g.id === gid);
  if (!hit) throw new GraphError(`回收站中不存在已归档目标：${gid}`);
  const parts = String(hit.from).replace(/\\/g, "/").split("/");
  // from 形如 versions/<v>/archived/<id> | goals/archived/<id> | backlog/archived/<file>.md | backlog/archived/<id>（[v0.27] 目录形态）
  // — 最后一节既可能是文件也可能是目录，rmSync(recursive) 两种都覆盖。
  let target: string | null = null;
  if (parts[0] === "versions" && parts[2] === "archived") target = join(root, "versions", parts[1], "archived", parts[3]);
  else if (parts[0] === "goals" && parts[1] === "archived") target = join(root, "goals", "archived", parts[2]);
  else if (parts[0] === "backlog" && parts[1] === "archived") target = join(root, "backlog", "archived", parts[2]);
  if (!target || !existsSync(target)) throw new GraphError(`无法定位归档实体：${hit.from}`);
  rmSync(target, { recursive: true, force: true });
  appendEvent(root, { actor, event: "autopilot.trash_purged", details: { kind: "goal", id: gid, from: hit.from } });
  return { ok: true, id: gid };
}

/**
 * 恢复已归档目标并（可选）移动到指定泳道：先把目标从归档取回原泳道，再 moveGoal 到目标泳道。
 * version 语义同 createGoal：null/undefined = 原地恢复；"standalone" = 独立目标；其它 = 该版本。
 */
export function restoreGoalToLane(
  root: string,
  id: string,
  opts: { version?: string | null; actor: string },
): { ok: true; id: string; version: string | null } {
  const gid = String(id ?? "").trim();
  if (!gid) throw new GraphError("missing goal");
  unarchiveGoal(root, gid, { actor: opts.actor });
  const want = opts.version === undefined ? null : opts.version;
  if (want) {
    const cur = loadGoal(findGoalFile(root, gid)).meta.version ?? null;
    if (want === "standalone") {
      if (cur !== null) moveGoal(root, gid, { to: "standalone", actor: opts.actor });
    } else if (cur !== want) {
      moveGoal(root, gid, { to: "version", version: want, actor: opts.actor });
    }
  }
  const after = loadGoal(findGoalFile(root, gid)).meta.version ?? null;
  return { ok: true, id: gid, version: after };
}

// ---------------------------------------------------------------------------
// [v0.18] 技能 / Agent 预设目录（新建目标时可选用；不选则 AI 自选）
// ---------------------------------------------------------------------------
export interface CatalogEntry { name: string; description: string; source: string; }

/**
 * 用户主目录解析（多级兜底）：显式参数 → USERPROFILE → HOME → os.homedir()。
 * 实测坑：DSH 宿主进程里 process.env.USERPROFILE 可能为空，只读它会导致技能/预设目录扫描全空。
 */
export function resolveUserHome(homeDir?: string | null): string {
  const explicit = String(homeDir ?? "").trim();
  if (explicit) return explicit;
  const envHome = String(process.env.USERPROFILE ?? "").trim() || String(process.env.HOME ?? "").trim();
  if (envHome) return envHome;
  try {
    return homedir();
  } catch {
    return "";
  }
}

function readSkillMeta(file: string, fallbackName: string, source: string): CatalogEntry | null {
  try {
    const raw = readFileSync(file, "utf8").slice(0, 4000);
    const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    let name = fallbackName;
    let description = "";
    if (fm) {
      const n = fm[1].match(/^\s*name:\s*(.+)$/m);
      const d = fm[1].match(/^\s*description:\s*(.+)$/m);
      if (n) name = n[1].trim().replace(/^["']|["']$/g, "");
      if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
    }
    if (!description) {
      const line = raw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.includes(":"));
      description = (line ?? "").slice(0, 160);
    }
    return { name, description: description.slice(0, 200), source };
  } catch {
    return null;
  }
}

/** 扫描 DSH 技能：<home>/.dsh/skills/* 与 <home>/.agents/skills/*（SKILL.md 为入口）。 */
export function listSkills(homeDir?: string | null): CatalogEntry[] {
  const home = resolveUserHome(homeDir);
  if (!home) return [];
  const out: CatalogEntry[] = [];
  const roots: [string, string][] = [
    [join(home, ".dsh", "skills"), "dsh"],
    [join(home, ".agents", "skills"), "agents"],
  ];
  for (const [dir, source] of roots) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      const skillFile = join(entry, "SKILL.md");
      if (existsSync(skillFile)) {
        const meta = readSkillMeta(skillFile, name, source);
        if (meta) out.push(meta);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫描 Agent 预设：<home>/.dsh/.agent-presets/*（目录或 .md 文件）。 */
export function listAgentPresets(homeDir?: string | null): CatalogEntry[] {
  const home = resolveUserHome(homeDir);
  if (!home) return [];
  const dir = join(home, ".dsh", ".agent-presets");
  if (!existsSync(dir)) return [];
  const out: CatalogEntry[] = [];
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    let meta: CatalogEntry | null = null;
    try {
      if (statSync(entry).isDirectory()) {
        for (const f of ["AGENTS.md", "PRESET.md", "README.md", "prompt.md"]) {
          const p = join(entry, f);
          if (existsSync(p)) { meta = readSkillMeta(p, name, "preset"); break; }
        }
        if (!meta) meta = { name, description: "", source: "preset" };
      } else if (name.toLowerCase().endsWith(".md")) {
        meta = readSkillMeta(entry, name.replace(/\.md$/i, ""), "preset");
      }
    } catch { /* 跳过异常项 */ }
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// [v0.18] 子任务协作频道 + 资源声明互斥（防冲突）
// ---------------------------------------------------------------------------
export const COLLAB_FILE = "autopilot-collab.jsonl";

export interface CollabEntry {
  at: string;
  actor: string;
  goal: string | null;
  text: string;
  claims?: string[];
  /** note=普通消息；claim/release=资源占用声明；contract=接口登记；requirement=需求登记 */
  kind: "note" | "claim" | "release" | "contract" | "requirement";
}

/**
 * [v0.20] 协作登记册：按工作区（root 即工作区）聚合「接口变更」与「需求变更」两类登记，
 * 用于防止接口改动不通知、需求与实现不匹配。派发任务时会注入给执行子代理。
 */
export function listRegistry(root: string, windowMin = 24 * 60): { contracts: CollabEntry[]; requirements: CollabEntry[] } {
  const cutoff = Date.now() - windowMin * 60_000;
  const contracts: CollabEntry[] = [];
  const requirements: CollabEntry[] = [];
  for (const e of readCollab(root, 500)) {
    const t = Date.parse(e.at ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (e.kind === "contract") contracts.push(e);
    else if (e.kind === "requirement") requirements.push(e);
  }
  return { contracts, requirements };
}

export function postCollab(
  root: string,
  input: { actor: string; goal?: string | null; text?: string; claims?: string[]; kind?: CollabEntry["kind"] },
  opts?: { maxKeep?: number },
): { ok: true; entry: CollabEntry } {
  const text = String(input.text ?? "").trim();
  const claims = Array.isArray(input.claims)
    ? input.claims.map((c) => String(c).trim()).filter(Boolean).slice(0, 40)
    : undefined;
  if (!text && (!claims || claims.length === 0)) throw new GraphError("协作消息需要 text 或 claims 至少其一");
  const entry: CollabEntry = {
    at: new Date().toISOString(),
    actor: String(input.actor ?? "unknown"),
    goal: input.goal ? String(input.goal) : null,
    text: text.slice(0, 2000),
    ...(claims && claims.length ? { claims } : {}),
    kind: input.kind ?? (claims && claims.length ? "claim" : "note"),
  };
  mkdirSync(root, { recursive: true });
  const file = join(root, COLLAB_FILE);
  writeFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "a" });
  // 只保留最近 maxKeep 条，避免无限增长（默认 500）
  const maxKeep = opts?.maxKeep ?? 500;
  try {
    const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (all.length > maxKeep) writeFileSync(file, all.slice(-maxKeep).join("\n") + "\n", "utf8");
  } catch { /* 截断失败不影响写入 */ }
  appendEvent(root, { actor: entry.actor, event: "autopilot.collab_posted", details: { kind: entry.kind, goal: entry.goal, claims: entry.claims ?? [] } });
  return { ok: true, entry };
}

export function readCollab(root: string, limit = 50): CollabEntry[] {
  const file = join(root, COLLAB_FILE);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out: CollabEntry[] = [];
    for (const l of lines.slice(-Math.max(1, limit))) {
      try { out.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 活跃声明：最近 windowMin 分钟内的 claim，**按时间顺序**处理 release（release 只作废它之前的声明）。 */
export function activeClaims(root: string, windowMin = 120): { goal: string | null; actor: string; paths: string[]; at: string }[] {
  const cutoff = Date.now() - windowMin * 60_000;
  const live: { goal: string | null; actor: string; paths: string[]; at: string }[] = [];
  for (const e of readCollab(root, 500)) {
    const t = Date.parse(e.at ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!e.goal) continue;
    // release：只撤掉该目标**此前**的声明（不能永久屏蔽该目标后续的新声明）
    if (e.kind === "release") {
      for (let i = live.length - 1; i >= 0; i--) if (live[i].goal === e.goal) live.splice(i, 1);
      continue;
    }
    if (e.claims && e.claims.length) live.push({ goal: e.goal, actor: e.actor, paths: e.claims, at: e.at });
  }
  return live;
}

/**
 * 派发前冲突检查：同一路径被**其它目标**声明且仍在窗口内 → 返回冲突描述（阻止并发改同一批文件）。
 * 自己的声明不算冲突（同一 target 重复派发由执行器串行化保证）。
 */
export function checkClaimConflicts(
  root: string,
  opts: { goal: string; paths?: string[]; windowMin?: number },
): string[] {
  const mine = String(opts.goal ?? "");
  const targets = new Set((opts.paths ?? []).map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean));
  if (targets.size === 0) return [];
  const conflicts: string[] = [];
  for (const c of activeClaims(root, opts.windowMin ?? 120)) {
    if (!c.goal || c.goal === mine) continue;
    const hit = c.paths.map((p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter((p) => targets.has(p));
    if (hit.length) conflicts.push(`${c.goal}（${c.actor}）已声明：${hit.join("、")}`);
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// [v0.18] 完整扫描推荐 / AI 推荐管理员（上行文 + 结果落库）
// ---------------------------------------------------------------------------
export const DEFAULT_MANAGER_PROMPT = [
  "你是看板「推荐线」的常驻管理员（AI），对该工作区负全责，并**实时管理整个项目**。",
  "职责：",
  "1. 维护推荐清单：只保留真正值得做、彼此不重复、与全局目标一致的任务；合并重复项、淘汰已过时项。",
  "2. 维护全局目标与全局提示词：发现漂移就修正；把负责人反复强调的约束沉淀为全局提示词（供所有执行/推荐子 AI 遵循）。",
  "3. **接受主对话的指令**：协作频道里 actor=human:gui 的消息就是负责人的指令，必须优先执行并在频道里回执（graph_collab_post）。",
  "4. **自由编排任务**：你可以移动任务来管理——换泳道 / 改状态（graph_transition）/ 调整先后关系（连线 links_add、links_remove）/ 归档或移入回收站；每次移动都要在协作频道登记原因。",
  "5. **处理所有阻塞与待选项**：blocked 目标必须分析原因并推动（补判据、补上下文卡片、改派或拆解），不允许长期滞留。",
  "6. 与已在看板上的目标去重，已在做的不要重复推荐。",
  "输出要求：只输出一个 JSON 对象，字段：recommendations[]（每项 title/type/description/criteria[]/reason）、globalGoal（字符串或 null）、globalPrompt（字符串或 null）、notes（给用户看的简短说明）。",
  "回写方式：调用 autopilot_manager_apply（推荐与全局）；要移动任务/连线/回收站/泳道提示词时用 graph_ap_control 的对应 action。",
].join("\n");

/** [v0.25] 取某泳道的模型路由（回退到 "*" 通配；都没有则返回 null = 用全局 executor 配置）。 */
export function laneModelFor(
  root: string,
  laneKey: string | null | undefined,
): { provider?: string | null; model?: string | null; reasoning_effort?: string | null } | null {
  const m = readAutopilotState(root).laneModels ?? {};
  const key = String(laneKey ?? "").trim();
  const hit = (key && m[key]) || m["*"];
  if (!hit) return null;
  const provider = hit.provider ? String(hit.provider) : undefined;
  const model = hit.model ? String(hit.model) : undefined;
  const effort = hit.reasoning_effort ? String(hit.reasoning_effort) : undefined;
  if (!provider && !model && !effort) return null;
  return { provider, model, reasoning_effort: effort };
}

/** 收集工作区客观信号（文件树 + 正式文件抽样 + git + 全局锚点），供深度扫描/管理员使用。 */
export function collectWorkspaceDigest(root: string, workspace: string, opts?: { maxFiles?: number }): string {
  const maxFiles = opts?.maxFiles ?? 120;
  const parts: string[] = [];
  const st = readAutopilotState(root);
  parts.push(`# 工作区\n${workspace}`);
  if (st.globalGoal?.text) parts.push(`# 全局目标\n${st.globalGoal.text}`);
  if (st.globalPrompt) parts.push(`# 全局提示词\n${st.globalPrompt}`);

  // 1. 正式文件抽样：README / 文档 / 构建与配置（这些是「项目的正式文件」）
  const formalNames = ["README.md", "README.MD", "AGENTS.md", "CLAUDE.md", "package.json", "pnpm-workspace.yaml", "go.mod", "Cargo.toml", "pyproject.toml", "Makefile", "docker-compose.yml"];
  const formal: string[] = [];
  for (const n of formalNames) {
    const p = join(workspace, n);
    if (existsSync(p)) {
      try { formal.push(`## ${n}\n${readFileSync(p, "utf8").slice(0, 1800)}`); } catch { /* 跳过 */ }
    }
  }
  if (formal.length) parts.push(`# 项目正式文件（抽样）\n${formal.join("\n\n")}`);

  // 2. 文件树（限深限宽，忽略重目录）
  const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);
  const tree: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (tree.length >= maxFiles || depth > 3) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir).filter((n) => !IGNORE.has(n) && !n.startsWith(".")); } catch { return; }
    for (const n of entries) {
      if (tree.length >= maxFiles) return;
      const full = join(dir, n);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      tree.push(`${prefix}${n}${isDir ? "/" : ""}`);
      if (isDir) walk(full, `${prefix}${n}/`, depth + 1);
    }
  };
  walk(workspace, "", 1);
  if (tree.length) parts.push(`# 文件树（限 ${maxFiles} 项）\n${tree.join("\n")}`);

  // 3. git 近况
  try {
    const log = execFileSync("git", ["-C", workspace, "log", "--oneline", "-20"], { encoding: "utf8", timeout: 8000 }).trim();
    if (log) parts.push(`# 最近提交\n${log}`);
    const status = execFileSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8", timeout: 8000 }).trim();
    if (status) parts.push(`# 未提交改动\n${status.slice(0, 2000)}`);
  } catch { /* 非 git 仓库 */ }

  // 4. 已在看板上的目标（去重锚点）
  const existing = scanExistingTitles(root);
  if (existing.length) parts.push(`# 看板上已存在的目标（禁止重复推荐）\n${existing.join("\n")}`);

  return parts.join("\n\n");
}

function scanExistingTitles(root: string): string[] {
  const out: string[] = [];
  const push = (file: string, tag: string) => {
    try {
      const doc = loadGoal(file);
      out.push(`- [${tag}] ${doc.meta.title ?? ""}（${doc.meta.status ?? ""}）`);
    } catch { /* 跳过 */ }
  };
  const versionsDir = join(root, "versions");
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir)) {
      const gd = join(versionsDir, v, "goals");
      if (!existsSync(gd)) continue;
      for (const id of readdirSync(gd)) {
        const f = join(gd, id, "goal.md");
        if (existsSync(f)) push(f, v);
      }
    }
  }
  const sd = join(root, "goals");
  if (existsSync(sd)) {
    for (const id of readdirSync(sd)) {
      if (id === "archived") continue;
      const f = join(sd, id, "goal.md");
      if (existsSync(f)) push(f, "独立");
    }
  }
  const bd = join(root, "backlog");
  if (existsSync(bd)) {
    for (const n of readdirSync(bd)) {
      if (n === "archived") continue;
      // [v0.27] 问题 22：同时接受平铺 backlog/<id>.md 与目录形态 backlog/<id>/goal.md。
      if (n.endsWith(".md")) push(join(bd, n), "草稿");
      else {
        const nested = join(bd, n, "goal.md");
        if (existsSync(nested)) push(nested, "草稿");
      }
    }
  }
  return out;
}

export function buildDeepScanPrompt(root: string, workspace: string, hint?: string | null): string {
  const h = String(hint ?? "").trim();
  return [
    "你是 dsh-graph 看板的「完整扫描推荐」分析师。请对下面这个工作区做一次**深度分析**并给出可执行的任务推荐。",
    "",
    ...(h ? [`【负责人本次指定方向（优先围绕它推荐）】\n${h}`, ""] : []),
    "分析要求：",
    "1. 读「项目正式文件」（README/构建配置/规范文档）判断项目目标与当前阶段；",
    "2. 结合文件树、最近提交、未提交改动，找出**真正值得做**的缺口（未完成功能、明显缺陷、缺失的测试/文档/部署步骤、明显技术债）；",
    "3. 与「看板上已存在的目标」逐条去重 —— 已存在的绝不重复推荐；",
    "4. 每条推荐要具体到可执行（含验收判据），不要写「优化代码」这类空话；",
    "5. 只输出 5-12 条，按价值排序。",
    "",
    "输出：**调用 autopilot_save_recommendations 工具**回写结果（不要只在回复里输出 JSON），参数 recommendations 为数组，每项 {title, type(feature|bug|task|improvement|patch|chore), description, criteria[], reason}。",
    "",
    collectWorkspaceDigest(root, workspace),
  ].join("\n");
}

export function buildManagerPrompt(root: string, workspace: string): string {
  const st = readAutopilotState(root);
  const recs = readRecommendations(root);
  const collab = readCollab(root, 20);
  return [
    "【上行文（管理员职责说明）】",
    st.managerPrompt?.trim() || DEFAULT_MANAGER_PROMPT,
    "",
    "【当前推荐清单】",
    recs.length ? recs.map((r, i) => `${i + 1}. [${r.type}] ${r.title} — ${r.description ?? ""}`).join("\n") : "（空）",
    "",
    "【最近协作频道消息】",
    collab.length ? collab.map((c) => `- ${c.at} ${c.actor}${c.goal ? " @ " + c.goal : ""}: ${c.text || (c.claims ?? []).join(",")}`).join("\n") : "（空）",
    "",
    st.managerUpdateGlobals
      ? "允许你同时给出 globalGoal / globalPrompt 的更新（仅在确有改进时给出，否则置 null）。"
      : "本次**不要**改动 globalGoal / globalPrompt（保持 null）。",
    "",
    "输出：**调用 autopilot_manager_apply 工具**回写结果（recommendations[]、globalGoal、globalPrompt、notes）。",
    "",
    collectWorkspaceDigest(root, workspace, { maxFiles: 80 }),
  ].join("\n");
}

/** 管理员结果落库：推荐整表替换（去重）+ 可选维护全局目标/提示词。 */
export function applyManagerResult(
  root: string,
  input: { recommendations?: any[]; globalGoal?: string | null; globalPrompt?: string | null; notes?: string | null },
  actor: string,
): { recommendations: number; globalGoalUpdated: boolean; globalPromptUpdated: boolean } {
  const st = readAutopilotState(root);
  let recCount = 0;
  if (Array.isArray(input.recommendations)) {
    const cleaned: Recommendation[] = [];
    const seen = new Set<string>();
    for (const r of input.recommendations) {
      const title = String(r?.title ?? "").trim();
      if (!title) continue;
      const key = normalizeTitle(title);
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        title,
        type: normalizeGoalType(r?.type),
        description: String(r?.description ?? "").trim(),
        criteria: Array.isArray(r?.criteria) ? r.criteria.map((c: any) => String(c)).filter((c: string) => c.trim()) : [],
        reason: String(r?.reason ?? "AI 管理员维护").slice(0, 200),
        score: Number.isFinite(Number(r?.score)) ? Number(r.score) : 0,
      });
    }
    saveRecommendations(root, cleaned, { actor });
    recCount = cleaned.length;
  }
  let goalUpdated = false;
  let promptUpdated = false;
  if (st.managerUpdateGlobals) {
    const g = typeof input.globalGoal === "string" ? input.globalGoal.trim() : "";
    if (g && g !== (st.globalGoal?.text ?? "")) {
      writeAutopilotState(root, { globalGoal: { text: g, updatedAt: new Date().toISOString() } }, { actor });
      goalUpdated = true;
    }
    const p = typeof input.globalPrompt === "string" ? input.globalPrompt.trim() : "";
    if (p && p !== (st.globalPrompt ?? "")) {
      writeAutopilotState(root, { globalPrompt: p }, { actor });
      promptUpdated = true;
    }
  }
  writeAutopilotState(root, { managerLastRun: new Date().toISOString() }, { actor });
  appendEvent(root, {
    actor,
    event: "autopilot.manager_applied",
    details: { recommendations: recCount, globalGoalUpdated: goalUpdated, globalPromptUpdated: promptUpdated, notes: String(input.notes ?? "").slice(0, 200) },
  });
  return { recommendations: recCount, globalGoalUpdated: goalUpdated, globalPromptUpdated: promptUpdated };
}

/** [v0.20] 列出处于阻塞状态的目标（供「阻塞自愈」自动唤起管理员）。 */
export function listBlockedGoals(root: string): { id: string; title: string; reason: string | null; lane: string }[] {
  const out: { id: string; title: string; reason: string | null; lane: string }[] = [];
  const push = (file: string, lane: string) => {
    try {
      const doc = loadGoal(file);
      if (String(doc.meta.status ?? "") !== "blocked") return;
      out.push({
        id: String(doc.meta.id ?? ""),
        title: String(doc.meta.title ?? ""),
        reason: doc.meta.blocked_reason ? String(doc.meta.blocked_reason) : null,
        lane,
      });
    } catch { /* 半成品跳过 */ }
  };
  const vd = join(root, "versions");
  if (existsSync(vd)) {
    for (const v of readdirSync(vd)) {
      const gd = join(vd, v, "goals");
      if (!existsSync(gd)) continue;
      for (const id of readdirSync(gd)) {
        const f = join(gd, id, "goal.md");
        if (existsSync(f)) push(f, v);
      }
    }
  }
  const sd = join(root, "goals");
  if (existsSync(sd)) {
    for (const id of readdirSync(sd)) {
      if (id === "archived") continue;
      const f = join(sd, id, "goal.md");
      if (existsSync(f)) push(f, "standalone");
    }
  }
  return out;
}

/**
 * [v0.28] 列出「有未完结目标」的泳道（versions/* 各泳道 + 独立目标 goals/）。
 * 未完结 = 存在「非 draft 且未 delivered、未归档」的目标（planning/collecting/ready/
 * in_progress/review/blocked 都算推进对象）。供目标推进 / 全局托管模式判定该给哪条
 * 泳道确保 runner 在跑；versions 优先、独立目标（standalone）殿后。
 */
export function listLanesWithOpenGoals(root: string): { lane: string; open: number }[] {
  const out: { lane: string; open: number }[] = [];
  const isOpenGoal = (file: string): boolean => {
    try {
      const doc = loadGoal(file);
      if (doc.meta.archived) return false;
      const status = String(doc.meta.status ?? "");
      return status !== "draft" && status !== "delivered";
    } catch { /* 半成品跳过 */ return false; }
  };
  const versionsDir = join(root, "versions");
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir).sort()) {
      const gd = join(versionsDir, v, "goals");
      if (!existsSync(gd)) continue;
      let n = 0;
      for (const id of readdirSync(gd)) {
        const f = join(gd, id, "goal.md");
        if (existsSync(f) && isOpenGoal(f)) n++;
      }
      if (n > 0) out.push({ lane: v, open: n });
    }
  }
  const sd = join(root, "goals");
  if (existsSync(sd)) {
    let n = 0;
    for (const id of readdirSync(sd)) {
      if (id === "archived") continue;
      const f = join(sd, id, "goal.md");
      if (existsSync(f) && isOpenGoal(f)) n++;
    }
    if (n > 0) out.push({ lane: "standalone", open: n });
  }
  return out;
}

// ---------------------------------------------------------------------------
// [v0.25] 回收站堆叠：把多条回收站条目手动堆成一格（省地方、便于管理），可散开
// ---------------------------------------------------------------------------
export const TRASH_STACKS_FILE = "autopilot-trash-stacks.json";
/** 堆叠 id 的进程内自增序号（不引入随机数/加密强度需求） */
let trashStackSeq = 0;

export interface TrashStack {
  id: string;
  name: string;
  items: { kind: "goal" | "version"; key: string }[];
  created_at: string;
  created_by: string;
}

function readStacks(root: string): TrashStack[] {
  const f = join(root, TRASH_STACKS_FILE);
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s: any) => s && Array.isArray(s.items) && s.items.length > 0)
      .map((s: any) => ({
        id: String(s.id ?? ""),
        name: String(s.name ?? "堆叠"),
        items: s.items
          .filter((i: any) => i && (i.kind === "goal" || i.kind === "version") && i.key)
          .map((i: any) => ({ kind: i.kind as "goal" | "version", key: String(i.key) })),
        created_at: String(s.created_at ?? ""),
        created_by: String(s.created_by ?? ""),
      }));
  } catch {
    return [];
  }
}

function writeStacks(root: string, list: TrashStack[]): void {
  writeFileSync(join(root, TRASH_STACKS_FILE), JSON.stringify(list, null, 2) + "\n", "utf8");
}

export function listStacks(root: string): TrashStack[] {
  return readStacks(root);
}

/** 把若干回收站条目堆成一格（同一条目只属于一个堆叠；重复会先从旧堆叠里摘掉）。 */
export function stackTrashItems(
  root: string,
  input: { name?: string | null; items: { kind: "goal" | "version"; key: string }[] },
  actor: string,
): { ok: true; stack: TrashStack } {
  const wanted = (Array.isArray(input.items) ? input.items : [])
    .filter((i) => i && (i.kind === "goal" || i.kind === "version") && i.key)
    .map((i) => ({ kind: i.kind, key: String(i.key) }));
  if (wanted.length < 2) throw new GraphError("堆叠至少需要两条回收站条目");
  const keys = new Set(wanted.map((i) => `${i.kind}:${i.key}`));
  const list = readStacks(root)
    .map((s) => ({ ...s, items: s.items.filter((i) => !keys.has(`${i.kind}:${i.key}`)) }))
    .filter((s) => s.items.length > 0); // 被摘空的堆叠自动消失
  const stack: TrashStack = {
    id: `stk-${Date.now().toString(36)}-${(trashStackSeq = (trashStackSeq + 1) % 46656).toString(36)}`,
    name: String(input.name ?? "").trim() || `堆叠 ${wanted.length} 项`,
    items: wanted,
    created_at: new Date().toISOString(),
    created_by: actor,
  };
  list.push(stack);
  writeStacks(root, list);
  appendEvent(root, { actor, event: "autopilot.trash_stacked", details: { id: stack.id, count: stack.items.length } });
  return { ok: true, stack };
}

export function unstackTrash(root: string, id: string, actor: string): { ok: true; id: string } {
  const list = readStacks(root);
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) throw new GraphError(`堆叠不存在：${id}`);
  writeStacks(root, next);
  appendEvent(root, { actor, event: "autopilot.trash_unstacked", details: { id } });
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// [v0.22] 任务连线（阶段行画布）：任务块分首尾——前=开始连接、后=结束连接、中间=实时协作连接
// ---------------------------------------------------------------------------
export const LINKS_FILE = "autopilot-links.json";

export interface GoalLink {
  id: string;
  from: string;
  to: string;
  /** start=开始（A 完成后 B 才开始）｜end=结束（B 收尾依赖 A）｜mid=实时协作（双向同步） */
  kind: "start" | "end" | "mid";
  note?: string | null;
  created_at: string;
  created_by: string;
}

function normLinkKind(k: unknown): GoalLink["kind"] {
  const v = String(k ?? "").trim();
  return v === "start" || v === "end" || v === "mid" ? v : "mid";
}

function readLinksFile(root: string): GoalLink[] {
  const file = join(root, LINKS_FILE);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((l: any) => l && l.from && l.to)
      .map((l: any) => ({
        id: String(l.id ?? `${l.from}->${l.to}:${l.kind}`),
        from: String(l.from),
        to: String(l.to),
        kind: normLinkKind(l.kind),
        note: l.note ?? null,
        created_at: String(l.created_at ?? ""),
        created_by: String(l.created_by ?? ""),
      }));
  } catch {
    return [];
  }
}

function writeLinksFile(root: string, list: GoalLink[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, LINKS_FILE), JSON.stringify(list, null, 2) + "\n", "utf8");
}

export function listLinks(root: string, goal?: string | null): GoalLink[] {
  const all = readLinksFile(root);
  const g = String(goal ?? "").trim();
  return g ? all.filter((l) => l.from === g || l.to === g) : all;
}

export function addLink(
  root: string,
  input: { from: string; to: string; kind?: string; note?: string | null },
  actor: string,
): { ok: true; link: GoalLink; created: boolean } {
  const from = String(input?.from ?? "").trim();
  const to = String(input?.to ?? "").trim();
  if (!from || !to) throw new GraphError("连线需要 from 与 to（目标 id）");
  if (from === to) throw new GraphError("不能把目标连到自己");
  const kind = normLinkKind(input.kind);
  const list = readLinksFile(root);
  const hit = list.find((l) => l.from === from && l.to === to && l.kind === kind);
  if (hit) return { ok: true, link: hit, created: false };
  const link: GoalLink = {
    id: `${from}->${to}:${kind}:${Date.now().toString(36)}`,
    from,
    to,
    kind,
    note: input.note ? String(input.note).slice(0, 500) : null,
    created_at: new Date().toISOString(),
    created_by: actor,
  };
  list.push(link);
  writeLinksFile(root, list);
  appendEvent(root, { actor, event: "autopilot.link_added", details: { from, to, kind } });
  return { ok: true, link, created: true };
}

export function removeLink(root: string, id: string, actor: string): { ok: true; removed: string } {
  const list = readLinksFile(root);
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) throw new GraphError(`连线不存在：${id}`);
  writeLinksFile(root, next);
  appendEvent(root, { actor, event: "autopilot.link_removed", details: { id } });
  return { ok: true, removed: id };
}

/** 某目标的连线依赖（供派发前检查：start 连接要求前置目标已交付）。 */
export function linkGates(root: string, goal: string): { blockedBy: GoalLink[]; note: GoalLink[] } {
  const all = listLinks(root);
  return {
    blockedBy: all.filter((l) => l.to === goal && l.kind !== "mid"),
    note: all.filter((l) => (l.from === goal || l.to === goal) && l.kind === "mid"),
  };
}

// ---------------------------------------------------------------------------
// [v0.23] 常驻分组：交互 / 部署测试 / 后端
//   —— 与「独立目标」同属性：**每个工作区都有、不可删除**；不再是「版本泳道」语义
//      （没有发布/恢复为活跃这些版本动作），但每个分组可单独设职责提示词。
//   数据仍落在 versions/<slug>/（旧数据原地兼容，不搬家），靠 groups 定义 + 保护名单区分。
// [v0.27] 问题 13：分组可自建 —— 定义存 <root>/autopilot-groups.json（workspace 级）与
//   <home>/.dsh/group-defs.json（global 级）；两者都会被 ensureGroups 物化为本工作区的 versions/<slug>/。
// ---------------------------------------------------------------------------
export const DEFAULT_GROUPS: { slug: string; name: string; prompt: string }[] = [
  { slug: "interaction", name: "交互", prompt: "交互分组：负责界面与交互逻辑（页面、组件、用户操作路径、空态/加载态/错误态）。" },
  // [v0.29] 问题 8：显示名由「部署测试」归一为「部署」（slug 不变，旧数据原地兼容）。
  { slug: "deploy-test", name: "部署", prompt: "部署分组：负责构建产物发布到测试环境、冒烟验证、版本号记录与回滚方案。" },
  { slug: "backend", name: "后端", prompt: "后端分组：负责服务端接口与数据层（参数校验、错误码、必要日志、接口兼容性说明）。" },
];

export const DEFAULT_GROUP_SLUGS: string[] = DEFAULT_GROUPS.map((g) => g.slug);

/** [v0.29] 问题 8：旧默认分组显示名 → 现名。仅在 version.md 的 name 仍是**旧值**时归一（用户自定义名一律不动）。 */
const LEGACY_GROUP_NAMES: Record<string, string> = {
  "deploy-test": "部署测试",
};

export function isDefaultGroup(slug: unknown): boolean {
  return DEFAULT_GROUP_SLUGS.includes(String(slug ?? "").trim());
}

// —— [v0.27] 问题 13：自建分组定义（workspace / global 两级） ——
export const GROUPS_FILE = "autopilot-groups.json";
export const GROUP_DEFS_FILENAME = "group-defs.json";

export interface GroupDefinition {
  slug: string;
  name: string;
  scope: "workspace" | "global";
  prompt: string | null;
  created_at: string;
  created_by: string;
}

function normalizeGroupDef(raw: any, fallbackScope: "workspace" | "global"): GroupDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const slug = String(raw.slug ?? "").trim();
  const name = String(raw.name ?? "").trim();
  if (!slug || !name) return null;
  const scope: "workspace" | "global" = raw.scope === "global" || raw.scope === "workspace" ? raw.scope : fallbackScope;
  return {
    slug,
    name,
    scope,
    prompt: raw.prompt == null ? null : (String(raw.prompt).trim() || null),
    created_at: String(raw.created_at ?? ""),
    created_by: String(raw.created_by ?? ""),
  };
}

function readGroupDefsFile(file: string, fallbackScope: "workspace" | "global"): GroupDefinition[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map((r: any) => normalizeGroupDef(r, fallbackScope)).filter((g: GroupDefinition | null): g is GroupDefinition => !!g);
  } catch {
    return []; // 坏文件按「无自建分组」处理（与其它 JSON 读取同口径：不猜）
  }
}

/** workspace 级自建分组（<root>/autopilot-groups.json）。 */
export function readWorkspaceGroups(root: string): GroupDefinition[] {
  return readGroupDefsFile(join(root, GROUPS_FILE), "workspace");
}

function writeWorkspaceGroups(root: string, list: GroupDefinition[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, GROUPS_FILE), JSON.stringify(list, null, 2) + "\n", "utf8");
}

/** global 级分组定义文件路径（<home>/.dsh/group-defs.json）；home 解析不到时返回 null。 */
export function groupDefsFile(homeDir?: string | null): string | null {
  const home = resolveUserHome(homeDir);
  return home ? join(home, ".dsh", GROUP_DEFS_FILENAME) : null;
}

/** global 级自建分组（跨工作区共享；home 解析不到时为空表）。 */
export function readGlobalGroupDefs(homeDir?: string | null): GroupDefinition[] {
  const f = groupDefsFile(homeDir);
  return f ? readGroupDefsFile(f, "global") : [];
}

function writeGlobalGroupDefs(list: GroupDefinition[], homeDir?: string | null): void {
  const f = groupDefsFile(homeDir);
  if (!f) throw new GraphError("无法解析用户主目录（USERPROFILE/HOME 均不可用），不能写全局分组定义");
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(list, null, 2) + "\n", "utf8");
}

/** 分组名 → slug：保留中文/字母/数字，其它字符转 "-"，折叠重复并去首尾 "-"。 */
export function slugifyGroupName(name: string): string {
  const s = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  // Windows 保留设备名兜底（slug 会当目录名用）
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(s)) return `${s}-grp`;
  return s;
}

/** 合并清单：内置三条 + 自建（workspace 定义 + 全局定义），slug 去重、内置优先。 */
export function listGroups(root: string): { slug: string; name: string; prompt: string | null; scope: string; builtin: boolean }[] {
  const prompts = readAutopilotState(root).lanePrompts ?? {};
  const out: { slug: string; name: string; prompt: string | null; scope: string; builtin: boolean }[] = DEFAULT_GROUPS.map((g) => ({
    slug: g.slug,
    name: g.name,
    prompt: prompts[g.slug] ?? null,
    scope: "builtin",
    builtin: true,
  }));
  const seen = new Set(out.map((g) => g.slug));
  for (const g of [...readWorkspaceGroups(root), ...readGlobalGroupDefs()]) {
    if (seen.has(g.slug)) continue;
    seen.add(g.slug);
    out.push({ slug: g.slug, name: g.name, prompt: (prompts[g.slug] ?? g.prompt) || null, scope: g.scope, builtin: false });
  }
  return out;
}

/** 物化单个分组到本工作区：versions/<slug>/version.md（缺则补）+ goals 目录 + 职责提示词补种（只补缺）。 */
function materializeGroup(
  root: string,
  def: { slug: string; name: string; prompt: string | null },
  actor: string,
  created: string[],
  promptsSeeded: string[],
): void {
  const dir = join(root, "versions", def.slug);
  const vfile = join(dir, "version.md");
  if (!existsSync(vfile)) {
    mkdirSync(join(dir, "goals"), { recursive: true });
    const doc = {
      id: `v-grp-${def.slug}`,
      name: def.name,
      status: "active",
      created_at: new Date().toISOString(),
      created_by: actor,
      group: true,
    };
    writeFileSync(
      vfile,
      `---\n${JSON.stringify(doc, null, 2)}\n---\n\n## 范围\n\n（常驻分组：与独立目标同属性，每个工作区都有、不可删除）\n`,
      "utf8",
    );
    created.push(def.slug);
    appendEvent(root, { actor, event: "autopilot.group_created", details: { slug: def.slug, name: def.name } });
  } else {
    mkdirSync(join(dir, "goals"), { recursive: true });
  }
  const pr = def.prompt && String(def.prompt).trim();
  if (pr) {
    const st = readAutopilotState(root);
    const prompts = { ...(st.lanePrompts ?? {}) };
    if (!prompts[def.slug] || !String(prompts[def.slug]).trim()) {
      prompts[def.slug] = String(pr);
      writeAutopilotState(root, { lanePrompts: prompts }, { actor });
      promptsSeeded.push(def.slug);
    }
  }
}

/**
 * [v0.27] 问题 13：自建「常驻功能分组」。
 * - name 必填；slug 由名称 slugify（保留中文），与内置/已有自建/同名版本冲突则报错；
 * - scope="workspace"（默认）→ 写 <root>/autopilot-groups.json；scope="global" → 写 <home>/.dsh/group-defs.json；
 * - 两种 scope 都会立即物化到当前工作区（global 定义同样在本工作区生效）；
 * - 分组与内置三条同属性：受删除保护（isProtectedVersion 认自建 slug）。
 */
export function createGroup(
  root: string,
  input: { name: string; scope?: string | null; prompt?: string | null },
  actor: string,
): { ok: true; slug: string; name: string; scope: "workspace" | "global" } {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new GraphError("分组名称不能为空");
  const scope: "workspace" | "global" = input?.scope === "global" ? "global" : "workspace";
  const slug = slugifyGroupName(name);
  if (!slug) throw new GraphError(`无法从名称生成合法 slug：${name}`);
  if (isDefaultGroup(slug)) throw new GraphError(`「${slug}」与内置分组冲突（交互/部署测试/后端为内置常驻分组，换一个名称）`);
  if ([...readWorkspaceGroups(root), ...readGlobalGroupDefs()].some((g) => g.slug === slug)) {
    throw new GraphError(`分组已存在：${slug}（同名分组无需重复创建）`);
  }
  // 同名普通版本占用该 slug：拒绝，避免把既有版本悄悄变成分组
  if (existsSync(join(root, "versions", slug, "version.md"))) {
    throw new GraphError(`versions/${slug} 已被同名版本占用，换一个名称`);
  }
  const prompt = input?.prompt == null ? null : (String(input.prompt).trim() || null);
  const def: GroupDefinition = {
    slug,
    name,
    scope,
    prompt,
    created_at: new Date().toISOString(),
    created_by: actor,
  };
  if (scope === "workspace") {
    const list = readWorkspaceGroups(root);
    list.push(def);
    writeWorkspaceGroups(root, list);
  } else {
    const list = readGlobalGroupDefs();
    list.push(def);
    writeGlobalGroupDefs(list);
  }
  const created: string[] = [];
  const promptsSeeded: string[] = [];
  materializeGroup(root, { slug, name, prompt }, actor, created, promptsSeeded);
  appendEvent(root, {
    actor,
    event: "autopilot.group_created",
    details: { slug, name, scope, source: "user" },
  });
  return { ok: true, slug, name, scope };
}

/**
 * [v0.29] 问题 8：把既有分组目录的显示名从旧默认名归一为新默认名。
 * 只在 `versions/<slug>/version.md` 的 name **仍是旧值**时改写（用户自定义名绝不覆盖），
 * 单个分组失败不影响其它分组与看板数据。
 */
export function normalizeGroupNames(root: string, actor = "system:autopilot"): { renamed: string[] } {
  const renamed: string[] = [];
  for (const g of DEFAULT_GROUPS) {
    const legacy = LEGACY_GROUP_NAMES[g.slug];
    if (!legacy) continue;
    const vfile = join(root, "versions", g.slug, "version.md");
    if (!existsSync(vfile)) continue;
    try {
      const doc = loadGoal(vfile);
      if (String(doc.meta?.name ?? "") !== legacy) continue; // 已是新名 / 用户自定义名 → 不动
      doc.meta.name = g.name;
      saveGoal(vfile, doc);
      renamed.push(g.slug);
      appendEvent(root, { actor, event: "autopilot.group_renamed", details: { slug: g.slug, from: legacy, to: g.name } });
    } catch { /* 单个分组归一失败不影响其它分组 */ }
  }
  return { renamed };
}

/**
 * 自愈创建：保证本工作区一定存在这些常驻分组（内置三条 + 自建定义），缺目录/version.md 就补建，
 * 缺职责提示词就补默认。只补缺，绝不覆盖已有内容。返回本次实际创建/补种的 slug。
 */
export function ensureGroups(root: string, actor = "system:autopilot"): { created: string[]; promptsSeeded: string[]; renamed: string[] } {
  const created: string[] = [];
  const promptsSeeded: string[] = [];
  for (const g of DEFAULT_GROUPS) materializeGroup(root, { slug: g.slug, name: g.name, prompt: g.prompt }, actor, created, promptsSeeded);
  // [v0.27] 问题 13：自建分组（workspace 定义 + 全局定义）同样物化到本工作区（只补缺；单个失败不影响其它）
  const seen = new Set(DEFAULT_GROUP_SLUGS);
  for (const g of [...readWorkspaceGroups(root), ...readGlobalGroupDefs()]) {
    if (seen.has(g.slug)) continue;
    seen.add(g.slug);
    try {
      materializeGroup(root, { slug: g.slug, name: g.name, prompt: g.prompt }, actor, created, promptsSeeded);
    } catch { /* 单个分组物化失败不影响看板数据 */ }
  }
  // [v0.29] 问题 8：旧默认显示名（如「部署测试」）随自愈归一为新名（自定义名不动）
  const { renamed } = normalizeGroupNames(root, actor);
  return { created, promptsSeeded, renamed };
}

// ---------------------------------------------------------------------------
// [v0.20] 判据打勾的服务端持久化（确认列自动裁决的判据来源：客户端勾选 → 写回 meta）
// ---------------------------------------------------------------------------
export function setCriteriaChecked(
  root: string,
  id: string,
  checked: string[],
  actor: string,
): { ok: true; checked: string[] } {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const list = Array.isArray(checked) ? checked.map((c) => String(c).trim()).filter(Boolean).slice(0, 100) : [];
  doc.meta.criteria_checked = list;
  saveGoal(file, doc);
  appendEvent(root, { actor, event: "autopilot.criteria_checked", details: { goal: id, count: list.length } });
  return { ok: true, checked: list };
}

/** 取目标的判据条目（与客户端 criteriaItems 同源：去 HTML 注释 → 按行 trim）。 */
export function criteriaItemsOf(root: string, id: string): string[] {
  try {
    const doc = loadGoal(findGoalFile(root, id));
    const raw = sectionText(doc.body, "质量判据") ?? "";
    return String(raw).replace(/<!--[\s\S]*?-->/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 未打勾的判据（自动裁决用：为空 = 判据全部满足）。 */
export function unmetCriteria(root: string, id: string): string[] {
  const items = criteriaItemsOf(root, id);
  if (!items.length) return [];
  let checked: string[] = [];
  try {
    checked = (loadGoal(findGoalFile(root, id)).meta.criteria_checked as string[]) ?? [];
  } catch { /* 读不到视为全未勾 */ }
  return items.filter((t) => !checked.includes(t));
}

// ---------------------------------------------------------------------------
// [v0.19] 泳道职责提示词：告知执行子代理「这条泳道大概是干什么的」（后端 / 部署测试 / 交互 …）
// ---------------------------------------------------------------------------
export function setLanePrompt(
  root: string,
  lane: string,
  text: string | null,
  actor: string,
): { ok: true; lane: string; text: string | null } {
  const key = String(lane ?? "").trim();
  if (!key) throw new GraphError("missing lane");
  const st = readAutopilotState(root);
  const next: Record<string, string> = { ...(st.lanePrompts ?? {}) };
  const t = String(text ?? "").trim();
  if (t) next[key] = t.slice(0, 4000);
  else delete next[key];
  writeAutopilotState(root, { lanePrompts: next }, { actor });
  appendEvent(root, { actor, event: "autopilot.lane_prompt_set", details: { lane: key, cleared: !t, length: t.length } });
  return { ok: true, lane: key, text: t || null };
}

/** 取某泳道的职责提示词（回退到通配 "*"）。 */
export function lanePromptFor(root: string, laneKey: string | null | undefined): string | null {
  const m = readAutopilotState(root).lanePrompts ?? {};
  const key = String(laneKey ?? "").trim();
  const hit = (key && m[key]) || m["*"];
  return hit && String(hit).trim() ? String(hit) : null;
}

/** [v0.19] 归档目标一键回草稿：先取消归档，再移到 backlog（有 cards/attempts 附件时会被拒绝并说明原因）。 */
export function restoreGoalToDraft(root: string, id: string, actor: string): { ok: true; id: string } {
  const gid = String(id ?? "").trim();
  if (!gid) throw new GraphError("missing goal");
  unarchiveGoal(root, gid, { actor });
  try {
    moveGoal(root, gid, { to: "backlog", actor });
  } catch (e) {
    throw new GraphError(`已取消归档，但无法移入草稿：${(e as any)?.message ?? e}（带 cards/attempts 附件的目标不能平铺进草稿，可先恢复到原泳道或独立目标）`);
  }
  return { ok: true, id: gid };
}

/**
 * [v0.29] 问题 5：归档一键撤回（批量）——把已归档目标逐个回草稿。
 *  - goals 为空/不传/空数组 → 全部已归档目标（listArchived 的顺序）；传了一批 id → 只处理这一批；
 *    批内某个 id 不在归档清单里（已恢复 / 不存在）如实记为 failed，不静默丢弃。
 *  - 单个目标先走 restoreGoalToDraft；带 cards/attempts 附件时它会在「已取消归档」后失败，
 *    此时退回「restoreGoalToLane（取消归档，保持原泳道）+ moveGoalToDraftForce」那条路，
 *    附件目录随目标整体迁入 backlog/<id>/goal.md。
 *  - 逐个 try/catch：**单个失败绝不中断整批**。
 */
export function restoreAllArchivedToDraft(
  root: string,
  opts: { goals?: string[] | null; actor: string },
): { ok: true; restored: string[]; failed: { id: string; error: string }[] } {
  const actor = opts?.actor ?? "system:autopilot";
  const archived = listArchived(root);
  const known = new Map(archived.map((g) => [g.id, g]));
  // 空数组等价于「全部」（避免客户端传 [] 时静默什么都不做）
  const raw = Array.isArray(opts?.goals) ? (opts!.goals as unknown[]).map((g) => String(g ?? "").trim()).filter(Boolean) : [];
  const want = raw.length > 0 ? raw : null;
  const targets = want ? want.filter((id) => known.has(id)) : archived.map((g) => g.id);
  const restored: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (want) {
    for (const id of want) {
      if (!known.has(id)) failed.push({ id, error: "不在已归档目标清单中（可能已恢复或 id 不存在）" });
    }
  }
  for (const id of targets) {
    try {
      restoreGoalToDraft(root, id, actor);
      restored.push(id);
      continue;
    } catch {
      try {
        // force 路径自带「未归档则先取消归档」，这里再补一次 restoreGoalToLane 仅为兜底
        try { restoreGoalToLane(root, id, { version: null, actor }); } catch { /* 上一步多半已取消归档 */ }
        moveGoalToDraftForce(root, id, { actor });
        restored.push(id);
      } catch (e2) {
        failed.push({ id, error: String((e2 as any)?.message ?? e2) });
      }
    }
  }
  appendEvent(root, {
    actor,
    event: "autopilot.trash_restore_all",
    details: { requested: want ? want.length : archived.length, restored: restored.length, failed: failed.length },
  });
  return { ok: true, restored, failed };
}

/**
 * [v0.27] 问题 22：带附件（cards/ attempts/ 等）的目标也能移回草稿并暂存。
 * 与 moveGoal({to:"backlog"}) 的差别：**保留目录形态** backlog/<id>/goal.md，
 * 附件目录随目标目录整体迁移，不再因「不能平铺」被拒绝。
 * - meta.status 置 draft、meta.version 置 null（与 moveGoal 进 backlog 的状态口径一致）；
 * - 归档态目标先取消归档（回原泳道）再迁移，保证 archived 标记与事件口径一致；
 * - backlog/<id>/goal.md（或同名平铺 backlog/<id>.md）已存在时报错，绝不覆盖。
 * 读取端兼容：core/ops.ts 的 listGoalFiles / boardProjection / backlogGoals / countBacklogGoals
 * 与 core/autopilot.ts 的 existingGoalTitles / scanExistingTitles / listArchived 均已同时接受两种形态。
 */
export function moveGoalToDraftForce(root: string, id: string, opts: { actor: string }): { ok: true; id: string; file: string } {
  const gid = String(id ?? "").trim();
  if (!gid || gid.includes("/") || gid.includes("\\") || gid === "." || gid === "..") {
    throw new GraphError(`非法目标 id：${id}`);
  }
  const actor = opts?.actor ?? "system:autopilot";
  let file = findGoalFile(root, gid);
  let doc = loadGoal(file);
  if (doc.meta.archived) {
    // 归档目标不能被「静默」搬进草稿：先按标准流程取消归档，再统一迁移
    unarchiveGoal(root, gid, { actor });
    file = findGoalFile(root, gid);
    doc = loadGoal(file);
  }
  const srcDir = basename(file) === "goal.md" ? dirname(file) : null;
  const targetDir = join(root, "backlog", gid);
  const targetFile = join(targetDir, "goal.md");
  const flatFile = join(root, "backlog", `${gid}.md`);
  if (file !== targetFile) {
    if (existsSync(targetFile)) throw new GraphError(`草稿位置已存在：backlog/${gid}/goal.md（拒绝覆盖，请先处理同名草稿）`);
    // 平铺同名草稿只有在**不是本目标自身**时才算冲突（平铺 → 目录形态是本函数的正常迁移方向）
    if (flatFile !== file && existsSync(flatFile)) throw new GraphError(`草稿位置已有平铺文件：backlog/${gid}.md（拒绝覆盖，请先处理同名草稿）`);
    if (srcDir) {
      if (existsSync(targetDir)) {
        // 空目录残留：清掉再落位（不丢数据）；非空一律拒绝，绝不覆盖
        let leftovers: string[] = [];
        try { leftovers = readdirSync(targetDir); } catch { leftovers = ["?"]; }
        if (leftovers.length > 0) throw new GraphError(`草稿位置已存在非空目录：backlog/${gid}/（拒绝覆盖）`);
        rmSync(targetDir, { recursive: true, force: true });
      }
      // [autopilot-fork] Windows 语义（同 moveGoal）：只建父目录 backlog/，让 rename 自己落地最后一级
      mkdirSync(join(root, "backlog"), { recursive: true });
      renameSync(srcDir, targetDir); // 目录整体迁移：cards/ attempts/ 一起走
    } else {
      // 平铺草稿 backlog/<id>.md → 目录形态 backlog/<id>/goal.md
      mkdirSync(targetDir, { recursive: true });
      renameSync(file, targetFile);
    }
  }
  doc.meta.status = "draft";
  doc.meta.version = null;
  saveGoal(targetFile, doc);
  appendEvent(root, {
    actor,
    event: "goal.moved",
    goal: gid,
    details: { from: relative(root, file), to: relative(root, targetFile), forced: true },
  });
  appendEvent(root, {
    actor,
    event: "autopilot.goal_forced_to_draft",
    goal: gid,
    details: { file: relative(root, targetFile), had_dir_attachments: !!srcDir },
  });
  return { ok: true, id: gid, file: relative(root, targetFile) };
}
