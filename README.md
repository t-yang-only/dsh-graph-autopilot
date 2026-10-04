# dsh-graph-autopilot

`dsh-graph-autopilot` —— 在 [dsh-graph](https://github.com/miuzel/dsh-graph)（基于图的目标管理看板）基础上叠加**自动驾驶 / 托管**能力的 DSH（DeepSeek Harness）插件 fork。

一句话定位：**把「目标看板」升级为「能被托管自动推进的目标看板」** —— 泳道能一键跑完「收集→执行→评审→交付」，AI 能自己推荐并采纳任务、自己分配资源、自己维护门禁，人只需要看和拍板。

> 私有定制 fork，非上游发布物。当前包版本 `0.29.0`（客户端 `PLUGIN_VERSION 0.17.0`，本次功能标注 `[v0.30]`）。

---

## 功能清单

### 一、任务台看板（基础层，来自上游）

- **二维泳道看板**：横向为生命周期阶段列（描述 / 收集 / 执行 / 确认 / 交付 / 阻塞），每个版本一条泳道，另有独立目标区与 backlog 暂存池。
- **拖拽排期**：卡片跨列/跨泳道拖拽改状态与归属；拖动靠近视口边缘自动滚动；落点有插入位置标记；拖拽虚影即当前卡片本身。
- **类型与标签筛选**：顶部按类型（feature / bug / task / improvement / patch / chore）与标签多选筛选，两者叠加为「与」关系；筛选入口在窄档收进 `⋯ 工具` 弹层。
- **泳道/列折叠**：阻塞列与交付列可折叠为窄条汇总；每条泳道底部的折叠三角可整条收起。
- **目标搜索与定位**：`Ctrl+F` / `Cmd+F` 聚焦搜索框，命中高亮 + 上一条/下一条跳转；窄档下命中聚合成单列「搜索结果」泳道并按版本/分区加组头。
- **窄宽度自适应**：右侧栏拖窄时按**看板根容器实测宽度**分档（<480px 进单泳道档：阶段列纵向堆叠、工具条折叠为 `⋯ 工具`），会话内看板页签与右侧栏渲染同一份实现。

### 二、常驻功能分组（autopilot）

- **每工作区自带、不可删除**的常驻分组：交互 / 部署测试 / 后端；与版本无关（不是排期对象）。
- 每个分组可设**职责提示词**，派发该泳道任务时自动注入。
- 支持**自建分组**：看板左上角「创建功能」可新建**工作区级**或**全局级**分组。

### 三、自动驾驶行（autopilot）

- 每条泳道行头有 **▶ 一键执行**：串联「收集 → 执行 → 评审 → 交付」全流程，无需逐段手工派发。
- 运行中行头按钮**变绿**，再点一次即**中断**当前托管流程。
- 托管流程内的评审默认走**机审**（AI 按判据核验），可通过设置切换人审。

### 四、机审 / 人审

- **默认机审**：由 AI 按目标登记的**质量判据**逐条核验产出物。
- **判据未打勾即打回执行层**：判据清单缺项时不会进入交付，而是退回执行补足，避免「没做全但过了评审」。

### 五、全局托管与目标推进

- **全局托管开关**：打开后 AI 持续托管全看板（推荐、采纳、派发、推进），**永不自动停止**。
- **只有手动关闭才停**；关闭动作看板上有明确入口，不隐藏、不自动降级。

### 六、推荐线（扫描与采纳）

- **扫描**：快速扫描工作区，产出推荐任务列表。
- **完整扫描**：拉起子代理深度分析工作区与项目正式文件，产出更完整的推荐。
- **按输入推荐**：可附带一段输入/提示词，按该方向推荐。
- **采纳并由管理 AI 分配**：推荐卡可拖进泳道直接建目标；也可一键采纳，由**管理 AI 指派**到合适的版本/分组。

### 七、AI 推荐管理员

- **独立上行文**（系统提示词独立，不与执行层共用）。
- **定时实时**：按设定节奏自动运行，持续维护推荐列表、全局目标与全局提示词。

### 八、任务执行板

- **子代理清单**：当前工作区所有子代理会话一览（目标 / attempt / 模型 / tokens / ctx / 存活状态），10 秒自动刷新。
- **转到对话**：每张卡可跳转到对应子代理会话。
- **多选发消息**：勾选多张卡后批量向所选会话排队（`queue`）投递消息，逐条回执。
- **实时代理输出**：卡片可展开该会话的实时输出流（受全局「实时代理输出」开关控制）。

### 九、任务连线画布（autopilot）

- **三类连接**：开始连接（前者交付后后者才开始）、结束连接（后者收尾依赖前者）、实时协作（两者实时同步）。
- **橡皮擦**与**预览线**：擦除模式点线即删；连线前有跟随光标的预览线。
- **参与派发门禁**：连线不只是画着看 —— 后端 `linkGates` 在派发前检查，`start` / `end` 连接要求前置目标**已交付**才放行。
- **卡片角标**（`[v0.30]`）：卡片左上角显示 `⛓ N` / `⤴ N` / `⇄ N`，直接看出「它在等谁 / 谁在等它 / 与谁实时协作」，鼠标悬停看中文全量说明。

### 十、回收站

- **堆叠**：多条草稿可堆叠成一个堆，保持看板整洁。
- **全部撤回草稿**：一键把堆内/回收站内容全部撤回草稿泳道。
- **彻底删除**：堆内条目可逐条或整体永久删除。
- **双向拖拽**：卡片可在看板与回收站之间双向拖拽。

### 十一、模板行（autopilot）

- 看板底部有模板行；**把任务拖入即生成通用模板**（保留流程结构、去掉具体内容）。
- 模板可再次拖进泳道直接建目标；也支持从某个目标反向生成模板并保存。

### 十二、执行设置

- 派发时可指定：**Agent 预设**、**技能**、**模型**、**上下文长度**、**追加要求**。
- 留空则由执行 AI 自选；技能/预设目录自动从本机加载。

### 十三、协作频道与登记册

- **协作频道**：任务间沟通，消息带目标归属。
- **资源声明防冲突**：派发前声明要改动的文件/路径；与其它活跃任务重叠时**拒绝**并提示先协作。
- **接口/需求登记册**：登记接口变更与需求变更，防「接口改了没通知」「需求与实现不匹配」。

### 十四、重启自动恢复（`[v0.30]` 增强）

- 看板数据、执行托管状态、连线与协作记录均在磁盘上，DSH 重启后自动恢复。
- **用户显式选择的开关也会保留**（见下条），不会「每次重启都回到默认」。

### 十五、记忆性（`[v0.30]`）

用户**在界面上显式做过的选择**持久化到 `localStorage`（键前缀统一 `dsh-graph.`，与既有 `dsh-graph.refresh-interval` / `dsh-graph.hidden-versions.*` 同风格），重启/刷新后按上次选择恢复：

| 状态 | 存储键 |
|------|--------|
| 已归档显示开关 | `dsh-graph.show-archived` |
| 类型筛选 | `dsh-graph.type-filter` |
| 标签筛选 | `dsh-graph.tag-filter` |
| 阻塞列折叠 | `dsh-graph.blocked-column-collapsed` |
| 交付列折叠 | `dsh-graph.deliver-column-collapsed` |
| 泳道折叠 | `dsh-graph.collapsed-lanes` |
| 单泳道档「查看版本」选择 | `dsh-graph.view-version` |

**边界**：只持久化「用户显式选择」，**不持久化运行时数据**（loading / error / 看板数据 / 弹窗状态 / 搜索命中 / 拖拽态等一律只活在本次会话内存）。localStorage 不可用（隐私模式、配额满）或存量值损坏时**回落默认值**，不抛错、不阻断渲染。

### 十六、主对话全控工具 `graph_ap_control`

主对话（主管 AI）用一个工具即可全控看板：读全局状态、跑扫描、采纳推荐、启动/中断托管行、归档、读写全局目标与全局提示词、管理模板与回收站等，不必逐条调用细粒度工具。

---

## 提供的工具

52 个 `graph_*` 工具（逐个说明见 [dsh-graph-host/README.md](dsh-graph-host/README.md) 或 `graph_help`）：

| 分组 | 工具 |
|------|------|
| 目标生命周期 | `graph_create_goal` · `graph_rename_goal` · `graph_set_description` · `graph_set_goal_type` · `graph_set_goal_tags` · `graph_amend_goal` · `graph_transition` · `graph_postpone_goal` · `graph_archive_goal` · `graph_unarchive_goal` · `graph_delete_goal` · `graph_clean_worktree` · `graph_list_worktrees` |
| 质量判据 | `graph_set_criteria` |
| 上下文卡片 | `graph_add_card` · `graph_fill_card` · `graph_review_card` · `graph_bind_collect_card` · `graph_delete_card` · `graph_convert_card_to_shared` · `graph_convert_card_to_owned` · `graph_attach_shared_card` · `graph_detach_shared_card` · `graph_list_shared_cards` |
| 附件 | `graph_store_attachment` · `graph_delete_attachment` |
| 排期 | `graph_move_goal` |
| 执行派发 | `graph_start_attempt` · `graph_set_directive` · `graph_record_attempt_handoff` · `graph_unbind_goal_child` · `graph_abandon_attempt` |
| 记忆 | `graph_memory_add` · `graph_memory_recall` · `graph_memory_remove` · `graph_memory_replace` |
| 配置管理 | `graph_get_settings` · `graph_update_settings` |
| 校验 / 对账 | `graph_validate` · `graph_rebuild` |
| 状态汇报 | `graph_report_status` · `graph_report_supervisor_status` |
| 评审裁决 | `graph_resolve_accept` |
| 历史讨论 | `graph_add_comment` |
| 完成摘要 | `graph_write_results` · `graph_refresh_results` |
| 换会话 | `graph_handoff` · `graph_claim_supervisor` |
| 自驾 / 协作 / 全控 | `graph_ap_control` · `graph_collab_post` · `graph_collab_read` |
| 帮助 | `graph_help` |

---

## 安装与使用

### 本机路径

本 fork 以**私有定制**方式安装在本机 DSH profile 中，源码位于：

```
~/.dsh/vendor/dsh-graph-fork
```

### 构建与安装步骤

```sh
cd ~/.dsh/vendor/dsh-graph-fork

# 1. 构建（同步 core + 拼接客户端 bundle + 拷贝发布资产到 dist/）
bash scripts/build.sh

# 2. 打包（在 dist/ 内生成 tarball）
cd dist && npm pack        # 产出 dsh-graph-<version>.tgz

# 3. 停掉 DSH

# 4. 在 DSH profile 内安装本地产物（--ignore-scripts 跳过构建钩子）
pnpm add file:<tgz 绝对路径> --ignore-scripts

# 5. 重启 DSH
```

> 改完源码必须重新执行第 1–2 步并重装；只改 `dsh-graph-host/lib/client/*.js` 不会自动生效 —— `dist/` 是生成物，`dist/lib/client.js` 由 `scripts/build-client.sh` 拼接而成。

### 使用

- 进入 DSH 会话，打开**看板**页签（或把看板放进右侧栏）。
- 底部即为自动驾驶面板：推荐线、模板行、回收站、全局托管开关都在那里。
- 托管的每一步进展都能在「任务执行板」里看到对应的子代理会话与实时输出。

---

## 与上游的关系

- 本仓库是 [**miuzel/dsh-graph**](https://github.com/miuzel/dsh-graph) 的 **fork**，遵循其许可证（MIT，Copyright © 2026 miuzel，见 [`dsh-graph-host/LICENSE`](dsh-graph-host/LICENSE)）。
- 上游提供**目标看板**这套基础能力（生命周期、判据、上下文卡片、拖拽排期、搜索、窄档适配等）；本 fork 的改动是**本地定制**，集中在「自动驾驶 / 托管」方向：常驻功能分组、自动驾驶行、机审/人审、全局托管与目标推进、推荐线与管理 AI、任务执行板、任务连线画布（含派发门禁）、回收站、模板行、执行设置、协作频道与登记册，以及用户显式选择的记忆性。
- 本 fork **不发布到 npm**，仅供本机使用；版本号与 CHANGELOG 沿用上游节结构，不承诺与上游同步。

---

## 仓库结构（monorepo，同上游）

- `core/` —— 核心层源码（唯一事实源），编译为 `dist/core/*.js` 进发布包；核心层不依赖 DSH。
- `dsh-graph-host/` —— 单包发布物源码：`index.js`（52 个 `graph_*` 工具 + REST 端点）、`lib/client/*.js`（看板源模块，构建产物为 `dist/lib/client.js`）、`cordis.patch.yml`、`supervisor-guide.{zh,en}.md`、`README.md`、`LICENSE`。
- `schema/`、`docs/`、`scripts/` —— 数据 / 设计文档 / 构建脚本；构建产物一律落在 `dist/`（gitignored）。

## English Summary

**dsh-graph-autopilot** is a private fork of [miuzel/dsh-graph](https://github.com/miuzel/dsh-graph), a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that organizes agent work as a graph-based goal kanban. This fork adds **autopilot / managed-execution** capabilities on top of the upstream board: per-workspace standing feature groups, one-click per-lane autopilot runs (collect → execute → review → deliver), AI review with criteria gating, a never-self-stopping global supervisor, recommendation scanning/adoption, an AI recommendation manager, a subagent execution board, a task-link canvas whose links act as real dispatch gates, a trash with stacking, a template lane, execution settings, a collaboration channel with resource claims, restart recovery, the `graph_ap_control` full-control tool for the main conversation, and `localStorage` persistence of user-made UI choices (filters, collapse states, archived toggle, single-lane version selection).

Install (local only): `bash scripts/build.sh` → `cd dist && npm pack` → stop DSH → `pnpm add file:<tgz> --ignore-scripts` inside the DSH profile → restart DSH. Licensed MIT, following upstream (Copyright © 2026 miuzel); changes are local customizations.
