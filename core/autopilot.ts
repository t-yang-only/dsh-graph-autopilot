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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { appendEvent, readEvents } from "./events.ts";
import { createGoal, findGoalFile, loadGoal, setCriteria, normalizeGoalType, GraphError } from "./ops.ts";

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
  /** 评审模式：auto = 机器门禁后自动裁决（automation=ai）；human = 停在 review 等人。 */
  reviewMode: "auto" | "human";
}

const DEFAULT_STATE: AutopilotState = {
  globalPrompt: null,
  globalGoal: null,
  autoPreset: true,
  reviewMode: "auto",
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
