# dsh-formation

DSH 工作台插件：**工作区级多角色交付模式**。

开启编队的工作区，其下所有会话都按「需求沟通 → 设计书确认 → 幕僚长拆解 → 预算制定编派发 → 独立校验」组织交付；关闭即退回 DSH 默认行为。

> A DSH workbench plugin that turns a workspace into a multi-role delivery mode
> (requirement elicitation → design gate → decomposition → budgeted dispatch → independent verification),
> injected at the system-prompt level.

**它不是"点一下就跑"的工具**，而是一个开关：开关只改变工作区里会话的组织方式，页面上没有运行按钮，也没有运行记录。

---

## 它做什么

```
工作区开启 → 每轮系统提示词带「编队协议」→ 模型按五层流程组织交付
工作区关闭 → 协议段在装配时被剔除 → 回到默认行为
```

页面上是五个区块：**定编制**、**给授权**、**效果自测**、**诊断**、**日志**。前两个是功能，后三个是排查手段。

> 编制里的数字是**并发上限**，不是每轮固定派的人数。实际人数 = 幕僚长申报 → 插件按「下限 ≤ 申报 ≤ 上限」钳制后的 `granted`。见「关键接口」。

## 功能

| 区块 | 说明 |
|---|---|
| 编制 | 需求沟通官（固定 1）/ 幕僚长 / PM / 执行 / 校验 的上限 + 单次拆解上限，**全局一份** |
| 工作区授权 | 逐个开关，**默认全关**；关掉即删键，不是存 false |
| 效果自测 | 插件直接派 5 个子代理（1 幕僚长 + 3 执行 + 1 校验）跑一道三步算式，验结果、验并行、验独立校验；同时列出并清理自己造的历史自测会话 |
| 诊断 | 版本、存储路径、注册表、mode 三连、每个工作区的 `resolves`、活着的句柄数 |
| 日志 | 最近 400 条事件，可 5 秒自动刷新 |

## 安装

```bash
npm run build                  # 产出 dsh-formation-<version>.tgz
# 然后在 DSH 插件管理器里安装该 tgz（或使用 install_local_workbench）
```

安装后重启 DSH，工作台里出现「编队设置」。首次进入所有工作区都是关闭状态。

## 开发

```bash
npm run check    # 语法检查
npm test         # 离线冒烟（假 ctx，不依赖 DSH）
npm run build    # 打包
```

冒烟测试会在随机端口起一个假的 webServer，验证 12 个路由的契约 + 定编口径的 5 组断言，不需要真实 DSH 环境。

## 协议内容（注入到系统提示词的部分）

0. **判型**：纯问答不委派；交付类走下面的流程；判不准按纯问答处理。
1. **需求沟通**：固定 1 个沟通官，反复问清行业惯例与验收；每轮选项最后固定加「需求已经沟通完成，开始实现」，**不设轮数上限**，收尾权只在用户手里。
2. **设计书确认（强制闸）**：用户不确认不得进入实施。理由：规格错了下游校验员会"通过"错误实现。
3. **拆解**：幕僚长固定 1 个，只拆不实现；同时申报 `quota` 与 `quota_rationale`。
4. **派发（预算制）**：设置里的 `worker` / `verifier` 是**并发上限**，实际人数由 `GET /api/quota` 钳制后返回的 `granted` 决定。下限是硬的。
5. **槽位复用**：配额是并发上限不是总人数；一批任务全部通过校验后立即回收，空槽位马上交给下一批。
6. **校验**：每任务另起独立校验员，不给执行者自述；最近 5 个任务里 3 个打回 → 停派发。
7. **运行目录**：`runId` 固定 `run-yyyyMMdd-HHmmss`；产物落 `_runs/<runId>/out/<taskId>/`，临时文件落 `tmp/<taskId>/`，收尾必须清空 `tmp`。
8. **特长**：执行 `backend` / `data` / `general`，校验 `functional` / `security` / `general`；`verifier_specialty ≠ specialty`，没有验收条目的特长不得使用。

## 关键接口

| 接口 | 用途 |
|---|---|
| `GET /api/quota?tasks=&directions=&want_worker=&want_verifier=` | 定编：返回 `granted`（准数）、`floor`（硬下限）、`serialized`、`over_ceiling`、`estimate_tokens` |
| `POST /api/selftest` | 用一套算术题跑通「执行 + 独立校验」，验证编队是否真的在起作用 |
| `POST /api/verify/resume` | 冷恢复探针：记住数字 → dispose → 唤醒 → 问它记不记得 |

## 安全边界（请务必阅读）

- **接口无鉴权**：所有路由只靠监听 `127.0.0.1` 防护。同机进程可调用 `/api/workspaces/toggle` 修改授权、调用 `/api/selftest` 消耗模型额度。自测已加 30 秒节流，但不构成鉴权。
- **指令级，非强制级**：协议进入系统提示词，模型照做，但 DSH 不会物理阻止它自作主张。需要强制须拦 `agent/pre-step` 接管编排。
- **配置存于本机** `~/.dsh-formation/formation.config.json`，不含任何凭证。
- **不发送任何网络请求**：插件自身零外联，所有模型调用由 DSH 宿主发起。

## 已知限制

| 限制 | 说明 |
|---|---|
| 委派深度 | 子代理默认剩余深度 1 层，无法再派孙代理；`maxDepth` 参数实测无效。这也是自测由插件自己编排、而不交给子代理的原因 |
| 校验的盲区 | 校验员只认自己能验证的东西；若上游规格本身错了，它会给出"通过"的结论 |
| 并发上限 | 自测验证了 3 并行；协议在真实任务中仅验证到 2 并行 |
| 无跨 run 记忆 | 每次运行从零开始 |
| 冷恢复 | **已实测通过**：`dispose()` 后 `sendMessage` 能唤醒且保留上下文（探针 `/api/verify/resume`） |
| 协议开销 | 协议段约 2.3k 字符 / 58 行，粗估 1.5–1.9k token，**每轮都算**。编制数字越大，协议里的数字跟着变，但正文长度基本不变 |
| 无真实任务数据 | 截至 0.12.3，编队只在「效果自测」里跑通过；真实交付的申报是否贪心、槽位是否真复用，尚无观测 |
| 仅 Windows 兜底 | 工作区注册表路径优先读 `DSH_HOME`，未设置时回退到 `~/AppData/Roaming/dsh-desktop/harness/...`。非 Windows 平台请显式设置 `DSH_HOME`，否则页面看不到工作区（插件本身仍可用） |

## 卸载

在 DSH 插件管理器中移除 `dsh-formation`。配置残留在 `~/.dsh-formation/`，可手动删除。

## 许可证

MIT
