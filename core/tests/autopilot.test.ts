/** [autopilot-fork] 自动驾驶层单元测试（node:test，零外部依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, findGoalFile, loadGoal, archiveGoal, GraphError } from "../ops.ts";
import { readEvents } from "../events.ts";
import {
  readAutopilotState,
  writeAutopilotState,
  scanRecommendations,
  saveRecommendations,
  readRecommendations,
  adoptRecommendations,
  laneReadiness,
  autoPresetFor,
  listArchived,
} from "../autopilot.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-autopilot-"));
  init(dir);
  return dir;
}

test("全局状态：默认值 + 写读回环 + 事件", () => {
  const root = tmpRoot();
  const def = readAutopilotState(root);
  assert.equal(def.autoPreset, true);
  assert.equal(def.reviewMode, "auto");
  assert.equal(def.globalPrompt, null);

  const next = writeAutopilotState(root, { globalPrompt: "遵循最小改动原则", autoPreset: false }, { actor: "test" });
  assert.equal(next.globalPrompt, "遵循最小改动原则");
  assert.equal(next.autoPreset, false);
  assert.equal(readAutopilotState(root).globalPrompt, "遵循最小改动原则");

  const ev = readEvents(root).find((e) => e.event === "autopilot.state_set");
  assert.ok(ev, "应记录 autopilot.state_set 事件");
});

test("推荐扫描：TODO 与缺测试脚本产生推荐；与既有目标去重", () => {
  const root = tmpRoot();
  const ws = join(root, "..", "ws-proj");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "proj", scripts: {} }), "utf8");
  writeFileSync(join(ws, "app.ts"), "// TODO: 补齐重试逻辑\nexport const x = 1;\n", "utf8");

  const recs = scanRecommendations(root, { workspaceDir: ws });
  assert.ok(recs.length >= 2, `应至少产出 2 条推荐，实际 ${recs.length}`);
  assert.ok(recs.some((r) => r.title.includes("TODO")), "应命中 TODO 扫描");
  assert.ok(recs.some((r) => r.title.includes("测试基线")), "应命中缺 test 脚本");

  // 把第一条采纳成目标后再扫：同题推荐应被去重
  saveRecommendations(root, recs, { actor: "test" });
  adoptRecommendations(root, [1], { actor: "test" });
  const recs2 = scanRecommendations(root, { workspaceDir: ws });
  const firstTitle = recs[0].title;
  assert.ok(!recs2.some((r) => r.title === firstTitle) || recs[0].title.includes("TODO") === false || true);
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  if (recs2.some((r) => norm(r.title) === norm(firstTitle))) {
    assert.fail("扫描应与既有目标去重");
  }
});

test("全局目标对齐：目标文本提高相关推荐分值并产出拆解推荐", () => {
  const root = tmpRoot();
  const ws = join(root, "..", "ws-goal");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "server.go"), "// FIXME: 超时未处理\npackage main\n", "utf8");
  const recs = scanRecommendations(root, {
    workspaceDir: ws,
    globalGoalText: "把服务的超时处理整理成可靠机制",
  });
  assert.ok(recs.length >= 1);
  assert.ok(recs[0].title.includes("全局目标"), "全局目标拆解推荐应排首位");
});

test("采纳：推荐落成版本目标 + 判据写入并确认", () => {
  const root = tmpRoot();
  saveRecommendations(root, [{
    title: "为登录接口补齐限流",
    type: "feature",
    description: "登录接口缺限流，补齐并测试。",
    criteria: ["限流阈值可配置", "超限返回 429"],
    reason: "测试",
    score: 1,
  }], { actor: "test" });

  const { created } = adoptRecommendations(root, [1], { version: "V0.1", actor: "test" });
  assert.equal(created.length, 1);
  const id = created[0].id;
  assert.equal(created[0].version, "V0.1");

  const doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.status, "planning");
  assert.equal(doc.meta.version, "V0.1");
  assert.ok(doc.body.includes("限流阈值可配置"), "判据应写入目标正文");
  const ev = readEvents(root).find((e) => e.goal === id && e.event === "criteria.confirmed");
  assert.ok(ev, "采纳即确认判据（criteria.confirmed）");

  // 无效序号应抛 GraphError
  assert.throws(() => adoptRecommendations(root, [99], { actor: "test" }), GraphError);
});

test("行就绪：描述+判据齐备即可派发；占位描述给出阻断原因", () => {
  const root = tmpRoot();
  saveRecommendations(root, [{
    title: "就绪目标",
    type: "task",
    description: "描述完整。",
    criteria: ["可验证"],
    reason: "测试",
    score: 1,
  }], { actor: "test" });
  const { created } = adoptRecommendations(root, [1], { version: "V0.1", actor: "test" });

  const plan = laneReadiness(root, "V0.1");
  assert.equal(plan.goals.length, 1);
  assert.equal(plan.runnable.length, 1, "采纳目标应就绪");

  // 手工建一个只有占位描述的目标（无判据确认）
  const id2 = createGoal(root, { title: "占位目标", actor: "test", version: "V0.1" });
  const plan2 = laneReadiness(root, "V0.1");
  const g2 = plan2.goals.find((g) => g.id === id2);
  assert.ok(g2);
  assert.equal(g2.ready, false);
  assert.ok(g2.blockers.some((b) => b.includes("描述")));
  assert.ok(g2.blockers.some((b) => b.includes("判据")));
});

test("自动预设：关键词映射与空值", () => {
  assert.equal(autoPresetFor("修复登录接口的 bug"), "programming");
  assert.equal(autoPresetFor("做一份汇报 PPT"), "ppt");
  assert.equal(autoPresetFor("纯粹的模糊需求"), null);
  assert.equal(autoPresetFor(""), null);
});

test("归档清单：archiveGoal 后可见", () => {
  const root = tmpRoot();
  saveRecommendations(root, [{
    title: "要归档的目标",
    type: "task",
    description: "描述。",
    criteria: ["可验证"],
    reason: "测试",
    score: 1,
  }], { actor: "test" });
  const { created } = adoptRecommendations(root, [1], { version: "V0.1", actor: "test" });
  const id = created[0].id;
  // 先推进到 delivered（archive 仅允许 draft/planning/delivered 中的特定路径——planning 可归档）
  archiveGoal(root, id, { actor: "test" });
  const list = listArchived(root);
  assert.ok(list.some((g) => g.id === id), "归档目标应出现在清单中");
});
