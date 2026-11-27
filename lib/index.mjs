import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-formation'
export const inject = ['webServer']
// 给冒烟测试直接验算定编口径：纯函数，不碰 ctx
export { computeQuota }

const BASE = '/dsh-formation'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_PATH = path.join(__dirname, '..', 'ui', 'index.html')

// 版本只有 package.json 一个来源，避免两处漂移
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0-dev'
  }
})()

// 配置唯一来源。默认落在用户主目录；冒烟测试可用环境变量指到工作区内。
const STORE = process.env.DSH_FORMATION_STORE || path.join(os.homedir(), '.dsh-formation')
const CFG_PATH = path.join(STORE, 'formation.config.json')

// ══════════════════ 日志环形缓冲 ══════════════════
const LOG_MAX = 400
const logs = []
let hostCtx = null

function log(level, msg, extra) {
  const row = { t: new Date().toISOString(), level: level, msg: String(msg) }
  if (extra !== undefined) row.extra = extra
  logs.push(row)
  if (logs.length > LOG_MAX) logs.shift()
  try {
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
    hostCtx?.logger?.[fn]?.('[formation] ' + msg)
  } catch {}
}

// ══════════════════ 配置 ══════════════════
const RULES = {
  requirement_gate: [1, 1, '需求沟通官'],
  chief: [1, 2, '幕僚长'],
  pm: [1, 6, '项目经理'],
  worker: [1, 40, '执行工程师'],
  verifier: [1, 8, '独立校验'],
  max_tasks: [1, 40, '拆解任务上限']
}

const DEFAULTS = {
  requirement_gate: 1,
  chief: 1,
  pm: 1,
  worker: 1,
  verifier: 1,
  max_tasks: 12,
  workspaces: {}
}

function ensureStore() {
  fs.mkdirSync(STORE, { recursive: true })
}

function loadConfig() {
  const cfg = { ...DEFAULTS, workspaces: {} }
  try {
    const disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
    Object.assign(cfg, disk)
    cfg.workspaces = disk.workspaces && typeof disk.workspaces === 'object' ? disk.workspaces : {}
  } catch {}
  return cfg
}

function saveConfig(cfg) {
  try {
    ensureStore()
    const out = { ...cfg, updated_at: new Date().toISOString(), updated_by: 'workbench' }
    const tmp = CFG_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, CFG_PATH) // 原子替换
    return out
  } catch (e) {
    throw new Error('配置写入失败（' + CFG_PATH + '）：' + String(e && e.message ? e.message : e))
  }
}

// 单进程内的写串行化：避免两个请求同时 read-modify-write 丢更新
let configChain = Promise.resolve()
function withConfigLock(fn) {
  const run = configChain.then(fn, fn)
  configChain = run.then(() => {}, () => {})
  return run
}

function validate(raw) {
  const cfg = {}
  const errors = []
  const warnings = []

  for (const [key, [lo, hi, label]] of Object.entries(RULES)) {
    const v = Number(raw?.[key] ?? DEFAULTS[key])
    if (!Number.isInteger(v)) { errors.push(`${label} 必须是整数`); continue }
    if (v < lo || v > hi) { errors.push(`${label} 必须在 ${lo}~${hi} 之间（收到 ${v}）`); continue }
    cfg[key] = v
  }
  if (errors.length) return { cfg, errors, warnings }

  // 注意：引入预算制后 worker 是**并发上限**（槽位），不是固定人头。
  // 上限大于拆解上限只是配置浪费，不会产生"空转烧钱"，所以降级为警告而不是拒绝保存。
  if (cfg.worker > cfg.max_tasks) {
    warnings.push(
      `执行上限 ${cfg.worker} > 拆解上限 ${cfg.max_tasks} 条：最多只有 ${cfg.max_tasks} 个槽位会被用到，另外 ${cfg.worker - cfg.max_tasks} 个永远空着（不花钱，但配置没意义）。`
    )
  }
  if (cfg.pm > cfg.worker) warnings.push(`项目经理(${cfg.pm}) 多于执行工程师(${cfg.worker})：有 PM 拿不到任务。`)
  if (cfg.worker / cfg.verifier > 7) {
    warnings.push(`校验配比 1:${(cfg.worker / cfg.verifier).toFixed(1)} 偏松（建议 1:5~1:7），校验容易变成走过场。`)
  }
  if (cfg.chief > 1) warnings.push('幕僚长 >1：仅当各领域完全独立时可用，跨领域依赖会漏。')

  return { cfg, errors, warnings }
}

// DSH 的工作区注册表（只读）
function workspaceRegistryPath() {
  const home = process.env.DSH_HOME
  return home
    ? path.join(home, 'storages', 'workspace.json')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'storages', 'workspace.json')
}

function listWorkspaces(cfg) {
  let table = {}
  try {
    const reg = JSON.parse(fs.readFileSync(workspaceRegistryPath(), 'utf8'))
    table = reg?.tables?.workspaces ?? {}
  } catch {}

  return Object.entries(table).map(([id, w]) => ({
    id,
    title: w?.title || '(未命名)',
    path: w?.path || '',
    enabled: cfg.workspaces?.[id] === true, // 缺省即关闭
    sessionCount: Array.isArray(w?.sessionIds) ? w.sessionIds.length : 0
  }))
}

// ══════════════════ 工作区级模式 ══════════════════
const PROTOCOL_SECTION = 'formation:protocol'
const normPath = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase()

function resolveWorkspace(cwd) {
  const list = listWorkspaces(loadConfig())
  const hit = list.find((w) => normPath(w.path) === normPath(cwd))
  return { workspace: hit || null, enabled: Boolean(hit && hit.enabled) }
}

/** 协议正文：编制数值每次装配时现算，改设置下一轮即生效。 */
function buildProtocol(cfg) {
  return [
    '## 编队模式（本工作区已启用）',
    '',
    '### 0 判型（每轮先做）',
    '- **纯问答**：解释、查询、闲聊、给建议、读代码讲它干什么 —— 直接回答，不建任何子代理。',
    '- **交付类**：要产出或修改文件、要跑命令验证、能拆成多步 —— 走下面的流程。',
    '判不准按纯问答处理，末尾问一句是否按编队推进。',
    '',
    '### 1 需求沟通（交付类第一步，必经）',
    '起 **1 个**「需求沟通官」子代理（subagent）。它的唯一职责是把需求问清楚，不写方案不写代码。',
    '- 告诉它：用户多半是外行，你要把这类需求的行业惯例摊开来问（口径、边界、验收、风险），每轮不超过 4 个问题，每题给出「不问就按什么默认」。',
    '- 循环：它返回问题组 → 你用 `ask_user_question` 呈现 → 用户作答 → 用 `send_message` 把答案回传给**同一个**沟通官子代理（不要每轮新建）。',
    '- 每一轮的选项里**最后固定加一项**：「需求已经沟通完成，开始实现」。用户选它才算结束。**不设轮数上限**，收尾权只在用户手里。',
    '- 结束时它产出《需求设计书》：goal / scope(in,out) / constraints / acceptance / assumptions / domain_hints。`assumptions` 必须非空。',
    '',
    '### 2 设计书确认（强制闸）',
    '把设计书摘要给用户看，明确问「确认开始实施吗？」。**用户不确认，不得进入实施。**',
    '这一步存在的理由：规格写错时，下游校验员会「通过」错误实现——只有人能挡住。',
    '',
    '### 3 拆解（幕僚长，固定 1 个）',
    '起 **1 个**「幕僚长」子代理，只拆解不实现。每个任务必须带：id、title、specialty、priority、depends_on、可运行验收、verifier_specialty（必须 ≠ specialty）。',
    '任务数上限 ' + cfg.max_tasks + ' 条。',
    '它还要**申报这一轮的编制需求**：`quota: { worker, verifier }` 与 `quota_rationale`，一并写进 `_runs/<runId>/plan.json`。',
    '申报依据是任务条数、互不依赖的方向数、每个方向的工作量；**不许一律报满，也不许一律报 1**。',
    '',
    '### 4 派发（预算制：设置是上限，插件钳制）',
    '预算上限：执行 W=' + cfg.worker + '、校验 V=' + cfg.verifier + '。**这是并发天花板，不是整轮总人数。**',
    '- 定编前先取 `GET /dsh-formation/api/quota?tasks=<条数>&directions=<方向数>&want_worker=<申报>&want_verifier=<申报>`，**以返回里的 `granted` 为准**，不要自己拍。',
    '- 申报值超过设置上限（返回 `over_ceiling: true`）：**停下来问用户一次**，报清「需要几个 / 上限几个 / 预计多少 token」。用户不点头就按上限派、多余任务串行。**这是唯一为人数打断用户的地方，其余批次一律不要问。**',
    '- 插件给的下限是硬的：执行 ≥ max(1, ceil(任务数/6))，校验 ≥ max(1, ceil(任务数/5))，且每个任务必须有自己的校验员。**下限不因为用户嫌麻烦就降低。**',
    '- 方向数 G ≤ granted.worker：每个方向至少 1 人，余量按任务数加权分配。',
    '- 方向数 G > granted.worker：每人承担 ceil(G/granted.worker) 个方向，组内任务串行（返回里 `serialized: true` 即此情况）。',
    '- 任务数少于人数时：多余的人**只在存在不同 specialty 时**做异视角复核（每任务最多 1 个复核者），否则不拉起。',
    '- 一个任务只给一个人，**不得拆给两人**。',
    '',
    '### 4.1 槽位复用（配额是并发上限，不是总人数）',
    '一批 Worker 的任务**全部通过校验**后立即 dispose；空出的槽位**必须马上交给下一批未派发的任务**，不得等待、不得闲置，也不得为了「凑一批再上」而拖延。',
    '校验员按单任务回收：校验完即 dispose。',
    '稳态是 W 个槽位一直在流水，不是 W 个人从头跑到尾。',
    '唯一例外：`depends_on` 未满足的任务不得进槽位；此时明确报告「槽位空闲 N 个，等待依赖 T?」。',
    '',
    '### 5 校验',
    '每个任务**另起**独立校验子代理，输入只有规格与产物路径，**不传执行者自述**；它必须自己跑命令取证。',
    '最近 5 个任务中有 3 个被打回升级 → **停止派发**，报告卡点，等人介入。不要在错误方向上继续投入。',
    '',
    '### 6 目录与收尾',
    'runId 固定 `run-yyyyMMdd-HHmmss`。产物 `_runs/<runId>/out/<taskId>/`，临时 `_runs/<runId>/tmp/<taskId>/`。',
    '收尾必须清空 `tmp/`。汇总只报校验结论（通过/打回及依据），不复述执行过程。',
    '',
    '### 7 特长（按任务选用，可选）',
    '执行可用：`backend`（接口/数据库/并发）、`data`（清洗/聚合/口径）、`general`。',
    '校验可用：`functional`（功能与边界）、`security`（鉴权/输入/路径）、`general`。',
    '选中特长时，**它的验收条目必须写进子代理提示词**；没有验收条目的特长不得使用。',
    '汇总时报告：任务 → specialty / verifier_specialty / 是否通过。'
  ].join('\n')
}

let modeStatus = { installed: false }
const assembleSeen = new Map()

function logAssemble(cwd, enabled, sectionCount, isChild) {
  const key = String(cwd || '')
  const last = assembleSeen.get(key)
  const now = Date.now()
  if (last && now - last.at < 60000 && last.enabled === enabled) return
  assembleSeen.set(key, { at: now, enabled })
  const msg = isChild
    ? '装配：子代理不注入（角色由父级指定）'
    : enabled
      ? '装配：已注入编队协议'
      : '装配：未启用，协议段已剔除'
  log('info', msg, { cwd: key, sections: sectionCount })
}

let modeInstalled = false
let modeRetries = 0
const MODE_MAX_RETRIES = 3

function installMode(ctx) {
  if (modeInstalled) return modeStatus

  // cordis 规定：不 inject 就不能用属性访问服务，这里一律按名取
  let sp = null
  let serviceName = null
  for (const candidate of ['systemPrompt', 'prompt']) {
    try {
      const svc = ctx.get(candidate)
      if (svc && typeof svc.section === 'function') { sp = svc; serviceName = candidate; break }
    } catch {}
  }

  if (!sp) {
    modeStatus = { installed: false, service: null, error: '找不到 systemPrompt 服务（ctx.get("systemPrompt") / ("prompt") 都没有 section()）' }
    log('error', modeStatus.error)
    return modeStatus
  }

  // 顺序很重要：先装钩子，再注册协议段。
  // 反过来一旦钩子失败，协议段会留在全局而无任何过滤 —— 所有工作区都会中招（fail-open）。
  try {
    ctx.on('system-prompt/assemble', async (assembly, meta, next) => {
      const result = await next()
      const strip = (r) => Object.assign({}, r, { sections: r.sections.filter((s) => s.name !== PROTOCOL_SECTION) })
      try {
        const agent = meta && meta.agent
        if (!agent || !Array.isArray(result && result.sections)) return result

        const header = (agent.session && agent.session.header) || {}
        const cwd = header.cwd
        // 子代理不注入：它已被父级指派单一角色，再套四角色协议会与"只做这一件事"冲突
        const isChild = Boolean(header.parentSession)
        let enabled = false
        if (!isChild) {
          try {
            enabled = resolveWorkspace(cwd).enabled
          } catch (e) {
            // 读不到工作区注册表时**必须 fail-closed**：宁可漏注入，也不能让协议漏到所有工作区
            log('error', '工作区解析失败，本轮回退为不注入：' + String(e && e.message ? e.message : e))
            enabled = false
          }
        }
        logAssemble(cwd, enabled, result.sections.length, isChild)

        if (!enabled) return strip(result)
        return Object.assign({}, result, {
          sections: result.sections.map((s) =>
            s.name === PROTOCOL_SECTION ? Object.assign({}, s, { text: buildProtocol(loadConfig()) }) : s
          )
        })
      } catch (e) {
        log('error', '装配异常，回退为不注入：' + String(e && e.message ? e.message : e))
        try { return strip(result) } catch { return result }
      }
    }, { global: true })
  } catch (e) {
    modeStatus = { installed: false, service: serviceName, error: '装配钩子注册失败：' + String(e && e.message ? e.message : e) }
    log('error', modeStatus.error)
    return modeStatus
  }

  try {
    sp.section({ name: PROTOCOL_SECTION, order: 60, text: buildProtocol(loadConfig()) })
    modeStatus = { installed: true, service: serviceName, section: true, hook: true, at: new Date().toISOString(), retries: modeRetries }
    modeInstalled = true
    log('info', '编队模式已就绪', { service: serviceName, name: PROTOCOL_SECTION, order: 60 })
  } catch (e) {
    modeStatus = { installed: false, service: serviceName, section: false, error: '协议段注册失败：' + String(e && e.message ? e.message : e) }
    log('error', modeStatus.error)
  }
  return modeStatus
}

/** 诊断接口会调用：没装上就有限次重试，避免"只能重启"。 */
function ensureMode(ctx) {
  if (modeInstalled) return modeStatus
  if (modeRetries >= MODE_MAX_RETRIES) return modeStatus
  modeRetries += 1
  log('warn', '尝试重新安装编队模式（第 ' + modeRetries + ' 次）')
  return installMode(ctx)
}

// ══════════════════ HTTP 工具 ══════════════════
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { tooLarge = true; return } // 不 destroy：让请求正常收尾，才能回一个明确的错误
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return reject(new Error('请求体过大（上限 ' + limit + ' 字节）'))
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': raw.length, 'Cache-Control': 'no-store' })
  res.end(raw)
}

const json = (res, code, obj) => send(res, code, JSON.stringify(obj))

// ══════════════════ 路由处理 ══════════════════
function handleIndex(req, res) {
  try { send(res, 200, fs.readFileSync(UI_PATH), 'text/html; charset=utf-8') }
  catch (e) { send(res, 500, 'UI 未打包：' + e.message, 'text/plain; charset=utf-8') }
}

async function handleConfig(req, res) {
  if (req.method === 'GET') return json(res, 200, loadConfig())
  if (req.method !== 'POST') return json(res, 405, { ok: false, errors: ['只支持 GET/POST'] })

  let raw
  try { raw = JSON.parse(await readBody(req)) } catch (e) {
    return json(res, 400, { ok: false, errors: ['JSON 解析失败：' + e.message] })
  }
  const { cfg, errors, warnings } = validate(raw)
  if (errors.length) return json(res, 200, { ok: false, errors, warnings })

  try {
    const saved = await withConfigLock(() => {
      cfg.workspaces = loadConfig().workspaces // 编制保存不得覆盖工作区开关
      return saveConfig(cfg)
    })
    log('info', '编制已保存', { worker: saved.worker, verifier: saved.verifier, pm: saved.pm, max_tasks: saved.max_tasks })
    return json(res, 200, { ok: true, config: saved, warnings })
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    log('error', '编制保存失败：' + msg)
    return json(res, 500, { ok: false, errors: [msg] })
  }
}

function handleWorkspaces(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, errors: ['只支持 GET'] })
  return json(res, 200, { workspaces: listWorkspaces(loadConfig()) })
}

async function handleWorkspaceToggle(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, errors: ['只支持 POST'] })

  let raw
  try { raw = JSON.parse(await readBody(req)) } catch (e) {
    return json(res, 400, { ok: false, errors: ['JSON 解析失败：' + e.message] })
  }
  const id = String(raw?.id ?? '').trim()
  if (!id) return json(res, 200, { ok: false, errors: ['缺少工作区 id'] })

  const cfg = loadConfig()
  if (!listWorkspaces(cfg).some((w) => w.id === id)) {
    return json(res, 200, { ok: false, errors: ['未知工作区：' + id] })
  }

  const enabled = raw?.enabled === true

  try {
    await withConfigLock(() => {
      const latest = loadConfig()
      latest.workspaces = latest.workspaces || {}
      if (enabled) latest.workspaces[id] = true
      else delete latest.workspaces[id] // 默认不启用：关掉即删除键
      saveConfig(latest)
    })
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    log('error', '工作区开关保存失败：' + msg)
    return json(res, 500, { ok: false, errors: [msg] })
  }

  log(enabled ? 'info' : 'warn', enabled ? '工作区已启用编队' : '工作区已关闭编队', { id })
  return json(res, 200, { ok: true, workspaces: listWorkspaces(loadConfig()) })
}

function handleDiagnostics(req, res) {
  // 没装上就在诊断时重试，避免"失败后只能重启"
  if (!modeInstalled && hostCtx) {
    try { ensureMode(hostCtx) } catch {}
  }
  const cfg = loadConfig()
  return json(res, 200, {
    plugin: { name: name, version: VERSION },
    store: STORE,
    configPath: CFG_PATH,
    configExists: fs.existsSync(CFG_PATH),
    workspaceRegistry: workspaceRegistryPath(),
    workspaceRegistryExists: fs.existsSync(workspaceRegistryPath()),
    mode: modeStatus,
    // 活着的 agent 句柄数（区别于面板里按历史计数的条目）
    liveAgents: (() => { try { return hostCtx?.get?.('agents')?.list?.().length ?? null } catch { return null } })(),
    config: cfg,
    workspaces: listWorkspaces(cfg).map((w) => ({
      title: w.title,
      path: w.path,
      enabled: w.enabled,
      resolves: resolveWorkspace(w.path).enabled,
      sessionCount: w.sessionCount
    })),
    logCount: logs.length,
    checkedAt: new Date().toISOString()
  })
}

function handleLogs(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit') || 120)))
  const level = url.searchParams.get('level')
  const rows = (level ? logs.filter((l) => l.level === level) : logs).slice(-limit)
  return json(res, 200, { total: logs.length, rows })
}

function handleEffective(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const cwd = url.searchParams.get('cwd') || ''
  const r = resolveWorkspace(cwd)
  return json(res, 200, {
    cwd,
    workspaceId: r.workspace ? r.workspace.id : null,
    workspaceTitle: r.workspace ? r.workspace.title : null,
    enabled: r.enabled,
    sectionIncluded: r.enabled,
    protocolPreview: r.enabled ? buildProtocol(loadConfig()).slice(0, 240) : null
  })
}

// ══════════════════ 效果自测 ══════════════════
const SELFTEST_TASKS = [
  { id: 'a', expr: '48 * 37', expect: 1776, sign: 1 },
  { id: 'b', expr: '1260 / 15', expect: 84, sign: 1 },
  { id: 'c', expr: '19 * 23', expect: 437, sign: -1 } // 这一项在总和里是减
]
const TEST_EXPECTED = 1423

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error((label || '操作') + ' 超时（' + Math.round(ms / 1000) + 's）')), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

function parseJsonLoose(text) {
  const s = String(text || '').trim()
  try { return JSON.parse(s) } catch {}
  const m = s.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

function firstNumber(text) {
  const m = String(text || '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** 起一个子代理，等它的 result，返回文本/结构化输出。 */
async function spawnChild(parent, label, promptText, opts = {}) {
  const subagents = hostCtx?.get?.('subagents')
  if (!subagents) throw new Error('subagents 服务不可用')
  const childId = 'formation-' + String(label).replace(/[^\w]+/g, '-').slice(0, 24) + '-' +
    Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  const ac = new AbortController()
  const t0 = Date.now()

  const request = {
    parent,
    cwd: opts.cwd || parent.session?.header?.cwd || os.homedir(),
    prompt: [{ type: 'text', text: promptText }],
    signal: ac.signal
  }
  if (opts.outputSchema) request.outputSchema = opts.outputSchema

  const activation = await subagents.startActivation({
    provider: 'spawn',
    label: String(label),
    delivery: 'caller',
    childId,
    signal: ac.signal,
    request
  })

  try {
    const result = await withTimeout(activation.result, 240000, label)
    return {
      text: (result.output || []).filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(''),
      structured: result.structured,
      stopReason: result.stopReason,
      diagnostic: result.diagnostic,
      ms: Date.now() - t0,
      childId
    }
  } finally {
    try { await activation.dispose() } catch {}
  }
}

let lastSelfTestAt = 0

async function handleSelfTest(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, errors: ['只支持 POST'] })

  let body = {}
  try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
  const workspaceId = String(body.workspaceId || '').trim()

  const ws = listWorkspaces(loadConfig()).find((w) => w.id === workspaceId)
  if (!ws) return json(res, 200, { ok: false, errors: ['未知工作区：' + workspaceId] })
  if (!ws.enabled) return json(res, 200, { ok: false, errors: ['工作区「' + ws.title + '」未启用编队，测不出效果'] })

  const agents = hostCtx?.get?.('agents')
  if (!agents) return json(res, 200, { ok: false, errors: ['agents 服务不可用'] })
  let roots = []
  try { roots = agents.roots() || [] } catch {}
  const root = roots.length ? agents.get(roots[0].id) : null
  if (!root) return json(res, 200, { ok: false, errors: ['没有活跃会话可作为根'] })

  // 参数类失败不占用节流窗口；只有真正要起子代理时才计时
  if (Date.now() - lastSelfTestAt < 30000) {
    return json(res, 200, { ok: false, errors: ['自测 30 秒内只能跑一次（每次会真实消耗 5 次模型调用）'] })
  }
  lastSelfTestAt = Date.now()

  const cwd = ws.path
  const t0 = Date.now()
  const trace = []

  try {
    // ① 幕僚长：只拆解（不给示例数字，避免照抄）
    const chief = await spawnChild(root, 'st-chief', [
      '你是「幕僚长」。只做拆解，不做任何计算。',
      '把算式 (48 × 37) + (1260 ÷ 15) − (19 × 23) 拆成三个独立子任务。',
      '每个子任务给出：id（a/b/c）、expr（只含一个括号内的运算表达式）、sign（加项 +1，减项 -1）。',
      '只输出 JSON，不要解释：{"tasks":[{"id":"","expr":"","sign":1}]}'
    ].join('\n'), { cwd })
    trace.push({ stage: '① 幕僚长', ms: chief.ms, brief: chief.text.slice(0, 200) })

    const plan = parseJsonLoose(chief.text)
    let tasks = plan && Array.isArray(plan.tasks) ? plan.tasks.slice(0, 3) : []
    if (tasks.length !== 3 || tasks.some((t) => typeof t.expr !== 'string' || !t.expr.trim())) {
      tasks = SELFTEST_TASKS.map((t) => ({ id: t.id, expr: t.expr, sign: t.sign }))
      trace.push({ stage: '① 幕僚长', ms: 0, brief: '拆解不可用，已回退内置任务' })
    }
    tasks = tasks.map((t) => ({
      id: t.id,
      expr: t.expr,
      sign: Number(t.sign) === -1 ? -1 : 1,
      expect: (SELFTEST_TASKS.find((x) => x.id === t.id) || {}).expect
    }))

    // ② 执行：同一批并行派发
    const batchStart = Date.now()
    const execs = await Promise.all(tasks.map((t) =>
      spawnChild(root, 'st-exec-' + t.id, [
        '你是「执行工程师」。只算这一个式子，不要做别的事，最后只回一个数字。',
        '式子：' + t.expr
      ].join('\n'), { cwd })
    ))
    const batchMs = Date.now() - batchStart
    const sumChildren = execs.reduce((s, e) => s + e.ms, 0)

    const values = {}
    let allCorrect = true
    tasks.forEach((t, i) => {
      const n = firstNumber(execs[i] && execs[i].text)
      values[t.id] = n
      if (t.expect !== undefined && n !== t.expect) allCorrect = false
    })
    trace.push({ stage: '② 执行 ×' + tasks.length, ms: batchMs, brief: JSON.stringify(values) })

    // 按符号聚合，不是无脑求和
    const final = tasks.reduce((s, t) => s + (Number(values[t.id]) || 0) * t.sign, 0)
    const correct = allCorrect && final === TEST_EXPECTED

    // ③ 独立校验：给原式与中间值，让它自己算 —— 不给我的合计，否则它只核对我的算术
    const verify = await spawnChild(root, 'st-verify', [
      '你是「独立校验」。不要相信任何人的计算，自己算一遍再判断。',
      '原式：(48 × 37) + (1260 ÷ 15) − (19 × 23)',
      '执行者报来的三个中间值：' + JSON.stringify(values),
      '请独立计算原式的最终结果，并判断它与 ' + final + ' 是否一致。',
      '只回 JSON：{"passed":true或false,"independent_final":数字,"note":"一句话"}'
    ].join('\n'), { cwd })
    const verdict = parseJsonLoose(verify.text) || { passed: false, note: verify.text.slice(0, 200) }
    trace.push({ stage: '③ 独立校验', ms: verify.ms, brief: JSON.stringify(verdict) })

    const totalMs = Date.now() - t0
    const speedup = batchMs > 0 ? Number((sumChildren / batchMs).toFixed(2)) : null
    log(correct ? 'info' : 'warn', '自测完成', { correct, parallel: tasks.length, speedup, final })

    return json(res, 200, {
      ok: true,
      mode: 'plugin-orchestrated',
      workspace: ws.title,
      agentsSpawned: 2 + tasks.length,
      parallel: tasks.length,
      values,
      signs: tasks.map((t) => ({ id: t.id, sign: t.sign })),
      final,
      expected: TEST_EXPECTED,
      correct,
      verified: verdict.passed === true,
      independentFinal: verdict.independent_final === undefined ? null : verdict.independent_final,
      verifyNote: verdict.note || '',
      batchMs,
      sumChildrenMs: sumChildren,
      speedup,
      totalMs,
      trace
    })
  } catch (e) {
    log('error', '自测失败：' + String(e && e.message ? e.message : e))
    return json(res, 200, { ok: false, error: String(e && e.message ? e.message : e), trace, totalMs: Date.now() - t0 })
  }
}

// ══════════════════ 自测会话清理 ══════════════════
// dispose() 只卸载句柄与注册，会话日志由持久化插件落盘，会永久留在会话树里。
// 这里只清理本插件自己造出来的那几类，命名前缀白名单，绝不碰用户会话。
const SELFTEST_PREFIX = /^formation-(st-|test-|child-|selfcheck-)/

function harnessHome() {
  return path.dirname(path.dirname(workspaceRegistryPath()))
}

function dirSize(dir) {
  let total = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += dirSize(p)
      else { try { total += fs.statSync(p).size } catch {} }
    }
  } catch {}
  return total
}

function scanSelfTestSessions() {
  const home = harnessHome()
  const dirs = []
  const files = []
  let bytes = 0

  try {
    const sessRoot = path.join(home, 'sessions')
    for (const bucket of fs.readdirSync(sessRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      const bpath = path.join(sessRoot, bucket.name)
      for (const d of fs.readdirSync(bpath, { withFileTypes: true })) {
        if (d.isDirectory() && SELFTEST_PREFIX.test(d.name)) {
          const full = path.join(bpath, d.name)
          dirs.push(full)
          bytes += dirSize(full)
        }
      }
    }
  } catch {}

  try {
    const projRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
    for (const f of fs.readdirSync(projRoot, { withFileTypes: true })) {
      if (f.isFile() && SELFTEST_PREFIX.test(f.name)) {
        const full = path.join(projRoot, f.name)
        files.push(full)
        try { bytes += fs.statSync(full).size } catch {}
      }
    }
  } catch {}

  return { dirs, files, bytes, count: dirs.length + files.length }
}

function handleSelfTestSessions(req, res) {
  const s = scanSelfTestSessions()
  return json(res, 200, {
    ok: true,
    sessionDirs: s.dirs.length,
    cacheFiles: s.files.length,
    bytes: s.bytes,
    sample: s.dirs.slice(-5).map((p) => path.basename(p))
  })
}

function handleSelfTestCleanup(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, errors: ['只支持 POST'] })
  const s = scanSelfTestSessions()
  const removed = { dirs: 0, files: 0, bytes: s.bytes, skipped: [], failed: [] }
  const FRESH_MS = 5 * 60 * 1000 // 最近 5 分钟还在动的，视为可能在跑，跳过

  for (const d of s.dirs) {
    try {
      const st = fs.statSync(d)
      if (Date.now() - st.mtimeMs < FRESH_MS) { removed.skipped.push(path.basename(d)); continue }
      fs.rmSync(d, { recursive: true, force: true })
      removed.dirs++
    } catch (e) {
      removed.failed.push(path.basename(d) + ': ' + String(e && e.message ? e.message : e))
    }
  }
  for (const f of s.files) {
    try { fs.unlinkSync(f); removed.files++ }
    catch (e) { removed.failed.push(path.basename(f) + ': ' + String(e && e.message ? e.message : e)) }
  }
  log(removed.dirs || removed.files ? 'info' : 'warn', '清理自测会话',
    { dirs: removed.dirs, files: removed.files, failed: removed.failed.length })
  return json(res, 200, { ok: removed.failed.length === 0, removed })
}

// ══════════════════ 技术验证：子代理冷恢复 ══════════════════
// 沟通官在实现阶段要回收、追加需求时要重新拉起，依赖"已 dispose 的子代理能否被唤醒"。
// 这个接口就是那条链路的探针：记住一个数字 → 回收 → 唤醒 → 问它还记不记得。
function outputText(result) {
  return (result && result.output || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 会话消息 → 纯文本（assistant 消息的 content 是块数组） */
function textOf(msg) {
  if (!msg) return ''
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
}

async function handleVerifyResume(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, errors: ['只支持 POST'] })

  const agents = hostCtx?.get?.('agents')
  const subagents = hostCtx?.get?.('subagents')
  const sessions = hostCtx?.get?.('sessions')
  if (!agents || !subagents) return json(res, 200, { ok: false, errors: ['agents / subagents 不可用'] })

  let roots = []
  try { roots = agents.roots() || [] } catch {}
  const root = roots.length ? agents.get(roots[0].id) : null
  if (!root) return json(res, 200, { ok: false, errors: ['没有活跃会话可作为根'] })

  const childId = 'formation-resume-' + Date.now()
  const ac = new AbortController()
  const out = { childId, round1: null, round2: null, remembered: null, err1: null, err2: null }

  // 第一轮：记住 7391
  let act = null
  try {
    act = await subagents.startActivation({
      provider: 'spawn',
      label: 'resume-verify',
      delivery: 'caller',
      childId,
      signal: ac.signal,
      request: {
        parent: root,
        cwd: (root.session && root.session.header && root.session.header.cwd) || os.homedir(),
        prompt: [{ type: 'text', text: '记住这个数字：7391。只回复两个字：已记住' }],
        signal: ac.signal
      }
    })
    out.round1 = outputText(await withTimeout(act.result, 60000, 'round1')).slice(0, 200)
  } catch (e) {
    out.err1 = String(e && e.message ? e.message : e)
  } finally {
    if (act) { try { await act.dispose() } catch {} }
  }

  // 回收后冷恢复：对同一个 child 发消息，看它是否被唤醒且记得 7391
  try {
    // 坑（实测踩过）：round1 的 assistant 消息落盘比 result 返回晚。
    // 直接取「最后一条 assistant」会读到 round1 的「已记住」，把 7391 误判成没记住。
    // 正确做法：先等 round1 那条消息出现并计入基线，再等基线增长。
    const readAssistants = () =>
      (sessions?.get?.(childId)?.deriveMessages?.() || []).filter((m) => m && m.role === 'assistant')

    let base = readAssistants()
    const settle = Date.now() + 15000
    while (readAssistants().length <= base.length && Date.now() < settle) {
      await new Promise((r) => setTimeout(r, 300))
      base = readAssistants()
    }
    const beforeAssist = base.length
    out.assistBefore = beforeAssist
    out.round1FromStore = textOf(base[base.length - 1]).slice(0, 200)

    out.messageId = await subagents.sendMessage(
      root,
      childId,
      [{ type: 'text', text: '刚才让你记的数字是多少？只回数字。' }],
      { signal: ac.signal }
    )

    const deadline = Date.now() + 60000
    let picked = null
    while (Date.now() < deadline) {
      const list = readAssistants()
      out.assistAfter = list.length
      if (list.length > beforeAssist) { picked = list[list.length - 1]; break }
      await new Promise((r) => setTimeout(r, 400))
    }
    await new Promise((r) => setTimeout(r, 1200)) // 等文本块写完整
    const list2 = readAssistants()
    if (list2.length > beforeAssist) picked = list2[list2.length - 1]
    out.assistAfter = list2.length
    out.round2 = picked ? textOf(picked).slice(0, 200) : null
    out.remembered = /7391/.test(out.round2 || '')
  } catch (e) {
    out.err2 = String(e && e.message ? e.message : e)
  }

  const ok = out.remembered === true
  log(ok ? 'info' : 'warn', '冷恢复验证：' + (ok ? '通过' : '未通过'), { childId })
  return json(res, 200, { ok, ...out })
}

// ══════════════════ 预算制定编 ══════════════════
// 设置里的 worker / verifier 是**并发上限**，真正起几个由幕僚长按本批任务量申报，这里钳制。
// 下限是硬的：任务越多越不允许压编制——否则"人多了嫌麻烦就少派"会让校验名存实亡。
const TOKENS_PER_SUBAGENT = 25000

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

function computeQuota(q) {
  const cfg = loadConfig()
  const ceiling = { worker: cfg.worker, verifier: cfg.verifier }
  const notes = []

  const tasks = Math.floor(Number(q.tasks))
  if (!Number.isFinite(tasks) || tasks < 1) {
    return { ok: false, errors: ['tasks 必须是 ≥1 的整数（本批任务条数）'], ceiling }
  }
  if (tasks > cfg.max_tasks) {
    return {
      ok: false,
      errors: ['任务 ' + tasks + ' 条 > 单次拆解上限 ' + cfg.max_tasks + ' 条：让幕僚长合批，或调高设置里的上限。'],
      ceiling
    }
  }

  const rawDir = Math.floor(Number(q.directions))
  const g = Math.max(1, Math.min(Number.isFinite(rawDir) && rawDir > 0 ? rawDir : tasks, tasks))

  // 下限按任务量算，但不得高于上限（高了就封顶，多余任务串行）
  const workerNeed = Math.max(1, Math.ceil(tasks / 6))
  const verifierNeed = Math.max(1, Math.ceil(tasks / 5))
  const floor = { worker: Math.min(cfg.worker, workerNeed), verifier: Math.min(cfg.verifier, verifierNeed) }
  if (workerNeed > cfg.worker) notes.push('任务量需要 ' + workerNeed + ' 个执行，超过上限 ' + cfg.worker + '：已封顶，多余任务串行。')
  if (verifierNeed > cfg.verifier) notes.push('任务量需要 ' + verifierNeed + ' 个校验，超过上限 ' + cfg.verifier + '：已封顶，校验排队。')

  // 未申报时按**下限**给：默认给满上限等于鼓励空转，省钱优先
  const num = (v) => (v === undefined || v === '' || v === null ? null : Math.floor(Number(v)))
  const wants = { worker: num(q.want_worker), verifier: num(q.want_verifier) }

  const granted = {
    worker: clampInt(wants.worker ?? floor.worker, floor.worker, cfg.worker),
    verifier: clampInt(wants.verifier ?? floor.verifier, floor.verifier, cfg.verifier)
  }

  const clamped = {
    worker: wants.worker !== null && wants.worker !== granted.worker,
    verifier: wants.verifier !== null && wants.verifier !== granted.verifier
  }
  if (clamped.worker) notes.push('执行申报 ' + wants.worker + ' 被钳到 ' + granted.worker + '（下限 ' + floor.worker + ' / 上限 ' + cfg.worker + '）')
  if (clamped.verifier) notes.push('校验申报 ' + wants.verifier + ' 被钳到 ' + granted.verifier + '（下限 ' + floor.verifier + ' / 上限 ' + cfg.verifier + '）')

  // 申报超过设置上限：这是唯一需要用户点头的情况
  const overCeiling = (wants.worker !== null && wants.worker > cfg.worker) || (wants.verifier !== null && wants.verifier > cfg.verifier)
  const serialized = g > granted.worker

  return {
    ok: true,
    tasks,
    directions: g,
    ceiling,
    floor,
    wants,
    granted,
    clamped,
    over_ceiling: overCeiling,
    serialized,
    directions_per_worker: serialized ? Math.ceil(g / granted.worker) : 1,
    estimate_tokens: (granted.worker + tasks + 3) * TOKENS_PER_SUBAGENT,
    notes,
    use: '按 granted 派人：执行 ' + granted.worker + '、校验 ' + granted.verifier + '。不要把 ceiling 当人数用。'
  }
}

function handleQuota(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, errors: ['只支持 GET'] })
  const url = new URL(req.url, 'http://localhost')
  const q = Object.fromEntries(url.searchParams.entries())
  const out = computeQuota(q)
  log('info', '定编请求', { tasks: q.tasks, directions: q.directions, granted: out.granted })
  return json(res, out.ok ? 200 : 400, out)
}

const routes = {
  [BASE]: handleIndex,
  [BASE + '/api/config']: handleConfig,
  [BASE + '/api/workspaces']: handleWorkspaces,
  [BASE + '/api/workspaces/toggle']: handleWorkspaceToggle,
  [BASE + '/api/diagnostics']: handleDiagnostics,
  [BASE + '/api/logs']: handleLogs,
  [BASE + '/api/effective']: handleEffective,
  [BASE + '/api/quota']: handleQuota,
  [BASE + '/api/selftest']: handleSelfTest,
  [BASE + '/api/selftest/sessions']: handleSelfTestSessions,
  [BASE + '/api/selftest/cleanup']: handleSelfTestCleanup,
  [BASE + '/api/verify/resume']: handleVerifyResume
}

export function apply(ctx, config = {}) {
  hostCtx = ctx
  ensureStore()
  try { installMode(ctx) } catch (e) {
    log('error', '模式安装失败：' + String(e && e.message ? e.message : e))
  }
  ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => {
    const disposers = Object.entries(routes).map(([p, handler]) =>
      webCtx.webServer.register({ kind: 'exact', path: p, handler })
    )
    return () => { for (const d of disposers) { try { d?.() } catch {} } }
  }, 'dsh-formation: routes'))
}
