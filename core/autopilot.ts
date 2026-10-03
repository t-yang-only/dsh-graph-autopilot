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
import { dirname, join } from "node:path";
import { appendEvent, readEvents } from "./events.ts";
import { createGoal, findGoalFile, loadGoal, saveGoal, setCriteria, moveGoal, unarchiveGoal, normalizeGoalType, GraphError } from "./ops.ts";

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

export function laneReadiness(root: string, version: string): {
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
    if (doc.meta.status === "in_progress") blockers.push("已在执行中（等待当前 attempt 收尾）");
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
      if (name.endsWith(".md")) pushDoc(join(backlogArch, name), `backlog/archived/${name}`);
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

export function isProtectedVersion(slug: unknown): boolean {
  return PROTECTED_VERSION_SLUGS.includes(String(slug ?? "").trim());
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
  extras: { skill_refs?: string[]; preset?: string | null; actor: string },
): { ok: true; skill_refs: string[]; preset: string | null } {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const refs = Array.isArray(extras.skill_refs)
    ? extras.skill_refs.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
    : Array.isArray(doc.meta.skill_refs) ? doc.meta.skill_refs as string[] : [];
  const preset = extras.preset == null ? null : String(extras.preset).trim() || null;
  doc.meta.skill_refs = refs;
  doc.meta.agent_preset = preset;
  saveGoal(file, doc);
  appendEvent(root, {
    actor: extras.actor,
    event: "autopilot.goal_extras_set",
    details: { goal: id, skills: refs, preset },
  });
  return { ok: true, skill_refs: refs, preset };
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
  // from 形如 versions/<v>/archived/<id> | goals/archived/<id> | backlog/archived/<file>.md
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
  kind: "note" | "claim" | "release";
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
  "你是看板「推荐线」的常驻管理员（AI），对该工作区负全责。",
  "职责：",
  "1. 维护推荐清单：只保留真正值得做、彼此不重复、与全局目标一致的任务；合并重复项、淘汰已过时项。",
  "2. 维护全局目标：若现状与用户目标漂移，给出更准确的全局目标表述。",
  "3. 维护全局提示词：把用户反复强调的约束沉淀为全局提示词（供所有执行/推荐子 AI 遵循）。",
  "4. 与已存在目标去重：已在看板上的任务不得重复推荐。",
  "输出要求：只输出一个 JSON 对象，字段：recommendations[]（每项 title/type/description/criteria[]/reason）、globalGoal（字符串或 null）、globalPrompt（字符串或 null）、notes（给用户看的简短说明）。",
].join("\n");

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
      if (!n.endsWith(".md")) continue;
      push(join(bd, n), "草稿");
    }
  }
  return out;
}

export function buildDeepScanPrompt(root: string, workspace: string): string {
  return [
    "你是 dsh-graph 看板的「完整扫描推荐」分析师。请对下面这个工作区做一次**深度分析**并给出可执行的任务推荐。",
    "",
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
