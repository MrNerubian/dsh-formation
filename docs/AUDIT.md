# 审计报告 · dsh-formation 0.12.2

审计日期：2026-11-27　范围：`lib/`、`client/`、`ui/`、打包、仓库结构与文档一致性

---

## 一、结论摘要

| 级别 | 发现 | 已修 | 保留 |
|---|---|---|---|
| 严重 | 5 | 4 | 1（无鉴权，属宿主职责） |
| 中 | 6 | 5 | 1（无单元测试，已部分补） |
| 低 | 5 | 2 | 3 |
| 文档失实 | 26 处 | 26 | 0 |

代码规模（0.12.2）：

| 文件 | 行数 | 体积 |
|---|---|---|
| `lib/index.mjs` | 973 | 41.6 KB |
| `ui/index.html` | 367 | 18.0 KB |
| `client/client.js` | 36 | 1.0 KB |
| 打包产物 | — | 27.7 KB |

零第三方运行时依赖，无 `eval` / `new Function` / `child_process` / 动态 `import()`。

---

## 二、严重问题

### C1 · 本地 HTTP 接口无鉴权（保留）

**现象**：12 个路由仅靠监听 `127.0.0.1` 防护。同机任意进程可改工作区授权（`/api/workspaces/toggle`）、触发自测（`/api/selftest`，真实消耗 5 次模型调用）、或触发冷恢复探针（`/api/verify/resume`，2 次调用）。

**处理**：自测 30 秒节流；参数类失败不占用节流窗口；**探针未加节流**（低频手工调用）。鉴权仍未做——加令牌会破坏 iframe 直连的简单性，且路由由 DSH 宿主托管。已在 README「安全边界」明示。

### C2 · 界面存储型 XSS（已修）

**现象**：工作区标题/路径来自 `workspace.json`（源自磁盘文件夹名，可控），直接拼进 `innerHTML`。

**已做**：所有动态插值（`w.title` / `w.path` / `w.id` / 错误信息 / 异常）统一走 `esc()`。0.12.2 新增的 `preview()` 与诊断行也已走 `esc()`。

### C3 · 子代理被注入协议段（已修）

**现象**：装配钩子是全局的，按 cwd 判断工作区；子代理 cwd 继承父级，同样命中，于是它一边被要求"只做这一件事"，一边被要求"必须委派整套流程"。

**已做**：检查 `session.header.parentSession`，子代理一律不注入，日志记「子代理不注入」。

### C4 · 装配钩子 fail-open（已修）

**现象**：`resolveWorkspace()` 抛错时 `catch` 直接返回原结果，**协议段留在里面**——等于所有工作区都被注入。同时安装顺序是「先 section 后 hook」，hook 注册失败时 section 无人过滤。

**已做**：① 任何异常路径一律 `strip()` 剔除（fail-closed）；② 安装顺序改为**先 hook 后 section**。

### C5 · 自测把错误结果判为通过（已修，0.8.1 → 0.11.0）

**现象**：三项求和时漏了减号，算出 `1776 + 84 + 437 = 2297`；校验员拿到的是插件算好的 `2297`，只核对了"我算得对不对"，于是判通过。

**已做**：① 每项带 `sign`，按符号聚合；② 校验员改为拿**原式**独立计算，不给插件合计。这条 bug 是 REVIEW 闸被定为强制的直接原因——**校验防不住错的规格**。

---

## 三、中等问题

| 编号 | 问题 | 处理 |
|---|---|---|
| M1 | 配置读改写无并发保护，两个请求同时保存会丢更新 | ✅ 已修：`withConfigLock` 单进程串行化 |
| M2 | `installMode` 失败后无重试，只能重启 | ✅ 已修：`ensureMode()` 诊断时重试，上限 3 次 |
| M3 | 存储目录写入失败时信息丢失 | ✅ 已修：抛带完整路径的错误，接口返回 500 与原文 |
| M4 | 仅冒烟测试，无单元测试 | 部分补：`computeQuota` 已导出并被 5 组断言覆盖；`validate` / `parseJsonLoose` / `firstNumber` 仍未单测 |
| M5 | 日志仅存内存，重启即失 | 保留。诊断够用；落盘会引入轮转与清理负担 |
| M6 | 升级时 profile 版本 pin 不更新 | ✅ 已绕过：`install_local_workbench` 对已装包返回 `changed:false`，pin 仍指旧版本 → 必须先 `plugin_manager remove_bundle` 再装。**这是操作流程，不是代码问题**，已写进发布步骤 |

---

## 四、低优先级

| 编号 | 建议 | 状态 |
|---|---|---|
| L1 | 版本号两处易漂移 | ✅ 已修：`VERSION` 直接读 `package.json` |
| L2 | 缺 `repository`、`author` 字段 | ✅ 已修：补齐 author / repository / homepage / bugs |
| L3 | 文案硬编码中文，无 i18n | 保留 |
| L4 | `private: true` 阻止误发 npm | 保留（有意为之） |
| L5 | 冷恢复探针无节流、无并发保护 | 保留。手工低频调用；连点两次会产生两个临时子代理，不会互相干扰 |

---

## 五、本轮（0.10–0.12）踩过并修掉的坑

| 问题 | 说明 |
|---|---|
| 子代理不能再派孙代理 | 实测「剩余层级均为 0」，`request.maxDepth: 3` **无任何效果** → 五层编排不能靠子代理完成，自测改为插件自己在深度 1 编排 |
| 冷恢复探针误判 | round1 的 assistant 消息落盘晚于 `result` 返回。旧逻辑取"最后一条 assistant"，读到的是 round1 的回复，把**成功判成失败**。改为以 assistant 条数做基线增量 + 二次确认 |
| 自测节流被无效参数吃掉 | 计时写在参数校验前 → 改为校验通过后才计时 |
| 超大请求体导致连接被重置 | `req.destroy()` 让客户端只看到断连 → 改为读完返回「请求体过大（上限 65536 字节）」 |
| 打包漏 `package.json` | `files` 白名单不含自身；手写 tar 不会自动带 → 安装被拒。已把 `package.json/README/LICENSE/CHANGELOG` 列为始终打包 |
| `package.json` 带 BOM | 安装器报「not valid JSON」→ 全部文件改为无 BOM UTF-8 |
| 子代理启动报 `throwIfAborted` | `startActivation` 要求 `signal` → 每次显式传 `AbortController().signal` |
| 裸 `agents.create()` 失败 | 无父级/无凭证 → 一律挂在活跃根会话下 spawn |

---

## 六、文档一致性审计（0.12.2 本次）

对「插件说明 / 代码实际行为 / 项目文档」三方比对，修正 26 处失实：

| 位置 | 原文 | 实际 | 处理 |
|---|---|---|---|
| `client.js` 工作台说明 | 「四角色」 | 五层流程，编制是并发上限 | 改 |
| `package.json` description | 「四角色交付模式」 | 同上 | 改 |
| UI 顶部导语 | 「只做两件事」 | 页面上有 5 个区块 | 改 |
| UI 编制说明 | 「数量决定能同时铺开多少子代理」 | 是并发上限，实际人数由申报+钳制决定 | 改 |
| UI 诊断行 | 只显示 4 个字段 | 漏 `chief` / `requirement_gate` | 改 |
| README 标题与首段 | 四角色 / 四棒 | 五层 | 改 |
| README 功能表 | 自测「5 个子代理」未说明构成 | 1+3+1 | 补 |
| README 已知限制 | 缺协议开销、缺"无真实任务数据" | — | 补 2 行 |
| `AUDIT.md` 全篇 | 0.9.2、600 行、7 路由、19.3 KB、L2 待定 | 0.12.2、973 行、12 路由、27.7 KB、L2 已修 | 重写 |
| `SPEC-session-flow.md` L3 | 「状态：草案，未实现」 | 协议层已实现 | 改 |
| `SPEC-session-flow.md` L36 / L59 / L279 | ELICIT 有轮数上限 `max_rounds: 6`、8 次硬顶 | **不设轮数上限**，收尾权只在用户 | 改 |
| `SPEC-session-flow.md` L228 | `W = 配置的 worker 数` | `granted.worker`（预算制） | 改 |
| `SPEC-session-flow.md` L232 | 复核上限 = 任务数 × 2 | 每任务最多 1 个复核者（与 §4.3 自相矛盾） | 改 |
| `SPEC-session-flow.md` L290 | 运行记录写 `~/.dsh-formation/runs/` | `<workspace>/_runs/<runId>/`（与 §9.3 自相矛盾） | 改 |
| `SPEC-session-flow.md` L303 | 页面显示状态/轮数/进度 | 页面只有设置，无运行视图 | 改 |
| `SPEC-session-flow.md` §9.4 / §11 | 冷恢复"待验证" | 已实测通过 | 改 |
| `SPEC-specialties.md` L3 | 「草案，未实现」 | 协议 §7 已落地特长名与验收约束 | 改 |
| `SPEC-specialties.md` L42 | 引用 `presets/specialties.json` | **该文件不存在**，特长直接写在协议里 | 标注 |
| `SPEC-specialties.md` L104 | 协议约 700 token | 约 2.3k 字符，粗估 1.5–1.9k token | 改 |
| `SPEC-specialties.md` 实施拆分 | 版本号 v0.10 / v0.11 | 实际落在 0.11.0 / 0.12.x | 改 |
| `编队-交付闭环.md`（工作区） | v0.9.1，四角色，无沟通官 | 落后 5 个版本 | 重写 |

---

## 七、已排除的风险

- 无 `eval` / `new Function` / `child_process` / 动态 `import()`
- 零第三方运行时依赖
- 无绝对路径硬编码（一律 `os.homedir()` / 环境变量推导）
- 无文件读取接口暴露（`/api/effective` 只做字符串比较；`/api/quota` 只读配置，不碰文件系统）
- 请求体有 64KB 上限
- 所有 `catch` 均有兜底返回值，单次异常不会让插件卸载

---

## 八、发布前 checklist（0.12.2）

- [x] `npm run check` 通过
- [x] `npm test` 冒烟通过（12 条路由 + 5 组定编断言）
- [x] 打包体积 27.7 KB（< 8 MiB）
- [x] `files` 白名单正确，`package.json` 必带
- [x] 全文件无 BOM、UTF-8
- [x] README 写明安全边界与已知限制
- [x] LICENSE 持有人：奈幽 (MrNerubian)
- [x] `package.json` 补齐 author / repository / homepage / bugs
- [x] 三个接口在真实宿主上验过（`/diagnostics` / `/quota` / `/verify/resume`）
- [ ] `git init` 与推送
- [ ] 真实任务验证（编队至今只在自测里跑通过）
