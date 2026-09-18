/**
 * dsh-astrbot-relay（星驿）— IM ↔ DSH 网桥（DSH 侧 / host half）
 *
 * 这是**骨架**，不是实现：
 *   - 已就位：插件契约（name / inject / Config / apply）、配置校验、路由表、
 *     鉴权入口、清理路径、健康检查。
 *   - 未实现：会话驱动、事件转发、审批 waterfall、幂等/背压/环形缓冲。
 *     未实现处一律返回 501 并带明确的 TODO，**不会**假装成功。
 *
 * 契约真相来源：`docs/BRIDGE-CONTRACT.md`
 * 设计依据：    `docs/DESIGN.md` §3
 * API 证据：    `docs/dsh-side-capabilities.md`
 *
 * 动笔前必读的三条已核实事实（写错就废）：
 *   1. `ctx.webServer.register` 注册的路由**没有任何鉴权**，必须自己实现（§5）。
 *   2. `text/delta` 来自 `agent/assistant-stream`，是**瞬时**事件，无订阅者即永久丢失
 *      → IM 侧必须先连 SSE 再 POST /message。
 *   3. 事件用 `Scoped<Agent>` 派发，但根 ctx 上未打 tag 的监听者会收到**所有** agent
 *      的事件 → 必须自己按 agent.id 过滤，否则串台到用户在 Web UI 的会话。
 */
import {
  createHash, randomUUID, timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import {
  BRIDGE_VERSION, ROUTES, ERROR_CODE, ERROR_STATUS, POLICY,
  APPROVAL_OUTCOME_ALLOWED, newSessionId,
} from './contract.js'

export const name = 'dsh-astrbot-relay'

/**
 * 依赖服务。框架会等它们就绪后再跑 apply。
 * 已核实：`dsh-agent-loop` 提供 agents factory，且本机 web profile 已挂载它。
 */
export const inject = ['webServer', 'agents', 'sessions']

/**
 * 配置 schema。
 *
 * 【未核实】`@deepseek-ai/schemastery` 作为第三方插件依赖是否可解析——
 * P1 必须先实测；官方向导明确要求导出 Standard Schema 而非普通对象，
 * 因此这里不提供「退化成普通对象」的兜底。
 *
 * 设计原则：凡不同部署可能取不同值的参数都不许硬编码；非法配置在**加载时**失败。
 */
export const Config = Schema.object({
  // ---- 必填 ----
  token: Schema.string().required(),        // 共享密钥，两侧各自持有，不进日志
  cwd: Schema.string().required(),          // agent 工作目录，必须绝对路径

  // ---- 传输 ----
  pathPrefix: Schema.string().default('/astrbot-relay'),   // 不要写尾斜杠
  heartbeatMs: Schema.number().default(15000),
  eventBufferSize: Schema.number().default(512),
  hmacMode: Schema.boolean().default(false),            // 可选强化，见契约 §5.2

  // ---- 会话映射 ----
  statePath: Schema.string().default(''),              // 空 = <DSH_HOME>/astrbot-relay/state.json
  policy: Schema.union([POLICY.ONE_TO_ONE, POLICY.ON_DEMAND, POLICY.DAILY])
    .default(POLICY.ONE_TO_ONE),
  idleTtlMs: Schema.number().default(86_400_000),

  // ---- 背压与幂等 ----
  maxQueuedPerConversation: Schema.number().default(4),
  idempotencyEntries: Schema.number().default(512),
  idempotencyTtlMs: Schema.number().default(600_000),

  // ---- 审批 ----
  approvalEnabled: Schema.boolean().default(true),
  approvalTimeoutMs: Schema.number().default(120_000),

  // ---- 输出 ----
  forwardReasoning: Schema.boolean().default(false),
})

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 已由 Config schema 校验并填好默认值
 */
export function apply(ctx, config) {
  // 配置错误要响亮：宁可加载失败，也不要运行期静默降级。
  assertConfigIsUsable(config)

  ctx.inject(['webServer', 'agents', 'sessions'], (host) => {
    const log = host.logger ?? ctx.logger
    const tag = `[${name}]`

    /**
     * 运行时状态。实现阶段填充：
     *   conversations: Map<conversationKey, {
     *     dshSessionId, agent, seq, subscribers:Set<res>, buffer:[],
     *     pending:Map<callId, {resolve, timer, code, expiresAt}>, queue:[],
     *     seenIdempotencyKeys, lastActiveAt
     *   }>
     *
     * 权威映射必须持久化到 config.statePath（原子写：tmp + rename），
     * 启动解析失败时**拒绝启用**，不静默重建。契约 §2.2。
     */
    const conversations = new Map()

    // ────────────────────────────────────────────────────────────────
    // 路由表
    // ────────────────────────────────────────────────────────────────
    // 注意：path 不要写尾斜杠；重复 (kind, path) 会抛错，必须降级为 no-op
    // 而不是把 host 搞崩。
    const routes = [
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.HEALTH), handler: handleHealth },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.MESSAGE), handler: handleMessage },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.EVENTS), handler: handleEvents },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.APPROVAL), handler: handleApproval },
    ]

    ctx.effect(() => {
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(host.webServer.register(route))
        } catch (error) {
          // 重复注册：降级为 no-op，保住 host。
          log?.warn?.(`${tag} 路由注册失败，已跳过 ${route.path}：${String(error)}`)
        }
      }
      log?.info?.(`${tag} mounted at ${config.pathPrefix} (bridgeVersion=${BRIDGE_VERSION})`)
      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch { /* 卸载期异常不得逃逸 */ }
        }
      }
    }, `${name}: routes`)

    // ────────────────────────────────────────────────────────────────
    // agent 事件转发（实现阶段填充）
    // ────────────────────────────────────────────────────────────────
    //
    // TODO(P2) 流式：瞬时事件，逐 token。
    //   host.on('agent/assistant-stream', ({ agent, frame }) => {
    //     const c = conversations.get(byAgentId(agent.id))   // ← 必须过滤，见文件头第 3 条
    //     if (!c) return
    //     if (frame.type === 'start') { ... }
    //     if (frame.type === 'end')   { ... }
    //     const chunk = frame.chunk
    //     if (chunk.type === 'text-delta') push(c, { type: EVENT.TEXT_DELTA, text: chunk.text })
    //     else if (chunk.type === 'reasoning-delta' && config.forwardReasoning) { ... }
    //     else if (chunk.type === 'tool-call-delta') { ... 聚合后发 tool/call ... }
    //   })
    //   注意：`ctx.on(...)` 本身就会注册为 effect 并返回 disposer，
    //   **不需要**再包一层 ctx.effect。
    //
    // TODO(P2) 持久事件：最终文本与 turn 边界。
    //   host.on('session/event', (session, event) => {
    //     if (event.type === 'assistant/message') push(c, { type: EVENT.MESSAGE_FINAL, ... })
    //     else if (event.type === 'turn/end')     push(c, { type: EVENT.TURN_END, ... })
    //   })
    //   ⚠️ `message/final` 是唯一权威最终文本；`text/delta` 只用于边跑边显示，
    //      不得拼接成最终回复（多 step 任务会重复叠加）。
    //
    // TODO(P2) 心跳：setInterval 必须包在 ctx.effect 里并返回 clearInterval。
    //
    // TODO(P2) 审批 waterfall。
    //   host.on('approval/request', (request, next) => {
    //     const c = conversations.get(byAgentId(request.agent.id))
    //     if (!c || !config.approvalEnabled) return next()   // 不接管就让框架按默认策略处理
    //     return askApproval(c, request)
    //   })
    //   ⚠️ 审批服务自身**零超时**：不自己加超时就会永久堵死该 turn。
    //      超时 resolve APPROVAL_OUTCOME.REJECTED（fail closed，不是 'cancelled'）。
    //   ⚠️ request.signal 的 abort → resolve 'cancelled' + clearTimeout + 清 pending 表。
    //   ⚠️ approval/asked 与 approval/decided 必须包在**已开启的 turn** 内，否则 DSH 抛错。
    //   范例：dsh-acp/lib/index.js:1115-1138
    //
    // TODO(P1) 卸载收尾（顺序正确性见契约 §9 未决 #1）：
    //   agent.cancel({ kind: 'user' }) → await agent.whenIdle()
    //   → await sessions.flush(agent.session) → dispose()

    // ────────────────────────────────────────────────────────────────
    // 路由实现
    // ────────────────────────────────────────────────────────────────

    /** GET /health — 已实现（纯常量 + 内存计数，无未核实 API）。 */
    function handleHealth(request, response) {
      writeJson(response, 200, {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        conversations: conversations.size,
        // dshVersion 需要从 host.describe 之类的服务读取——【未核实】，
        // 实现阶段补上；契约允许字段缺失时由 IM 侧忽略。
      })
    }

    /** POST /message — TODO(P1)。 */
    function handleMessage(request, response) {
      if (!authorize(request, response, config)) return
      writeError(response, ERROR_CODE.UNSUPPORTED,
        'POST /message 尚未实现（P1）。骨架不假装成功。')
    }

    /** GET /events — TODO(P2)。 */
    function handleEvents(request, response) {
      if (!authorize(request, response, config)) return
      // TODO(P2) SSE 写法照抄 dsh-client-hmr/lib/index.js:114-158：
      //   response.writeHead(200, {
      //     'content-type': 'text/event-stream',
      //     'cache-control': 'no-cache',
      //     connection: 'keep-alive',
      //   })
      //   response.write(': connected\n\n')
      //   ... 按 Last-Event-ID 从环形缓冲重放 ...
      //   response.on('close', cleanup)
      writeError(response, ERROR_CODE.UNSUPPORTED,
        'GET /events 尚未实现（P2）。骨架不假装成功。')
    }

    /** POST /approval — TODO(P2)。 */
    function handleApproval(request, response) {
      if (!authorize(request, response, config)) return
      // TODO(P2) 校验：code 一次性 + conversation 匹配 + 未过期 + 未决议
      //   + outcome ∈ APPROVAL_OUTCOME_ALLOWED
      //   已决议/已超时 → 409（幂等冲突，不算错误）
      void APPROVAL_OUTCOME_ALLOWED
      writeError(response, ERROR_CODE.UNSUPPORTED,
        'POST /approval 尚未实现（P2）。骨架不假装成功。')
    }

    log?.info?.(`${tag} loaded (skeleton)`)

    // 供实现阶段使用的占位引用，避免 lint 报未使用。
    void randomUUID
    void newSessionId
  })
}

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

/** 拼接基址与路径，保证恰好一个斜杠且无尾斜杠。 */
function join(prefix, path) {
  const left = String(prefix || '').replace(/\/+$/, '')
  const right = String(path || '').replace(/^\/+/, '')
  return `${left}/${right}`
}

/**
 * 配置可用性校验。
 *
 * 这些约束无法用 Schemastery 表达（需要跨字段 / 与运行环境比较），
 * 因此手工检查，并且**加载即失败**。
 */
function assertConfigIsUsable(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('dsh-astrbot-relay: 缺少配置')
  }
  if (typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error('dsh-astrbot-relay: token 必须是 >=32 字符的共享密钥')
  }
  if (typeof config.cwd !== 'string' || !isAbsolutePath(config.cwd)) {
    throw new Error(`dsh-astrbot-relay: cwd 必须是绝对路径，收到 ${JSON.stringify(config.cwd)}`)
  }
  if (typeof config.pathPrefix !== 'string' || config.pathPrefix.trim() === '') {
    throw new Error('dsh-astrbot-relay: pathPrefix 不能为空')
  }
  if (config.pathPrefix.endsWith('/')) {
    throw new Error('dsh-astrbot-relay: pathPrefix 不要以 "/" 结尾（prefix 匹配会因此错位）')
  }
}

/** Windows 与 POSIX 通用的绝对路径判定。 */
function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/**
 * Bearer 鉴权。
 *
 * 已核实：框架**不提供**任何鉴权，注册的路由是裸的，所以这里是唯一防线。
 * 失败一律 401，且响应体不区分「token 错」与「token 缺失」。
 *
 * 实现在此完成（不依赖未核实 API），因为它是安全边界，不能留 TODO。
 * 比较必须是定长（timing-safe）：先用等长哈希再逐字符比较。
 */
function authorize(request, response, config) {
  const header = request?.headers?.authorization ?? request?.headers?.Authorization ?? ''
  const presented = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : ''
  if (presented && timingSafeEqual(presented, config.token)) return true
  writeError(response, ERROR_CODE.UNAUTHORIZED, 'unauthorized')
  return false
}

/**
 * 定长比较：`node:crypto` 的 timingSafeEqual 要求等长入参，
 * 因此先把两者各自 sha256 到固定 32 字节再比较，
 * 使比较时间与输入长度、内容前缀都无关。
 */
function timingSafeEqual(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest()
  const hb = createHash('sha256').update(String(b), 'utf8').digest()
  return nodeTimingSafeEqual(ha, hb)
}

/** 写 JSON 响应。 */
function writeJson(response, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 安全头，与 dsh 页面路由的口径一致。
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(payload)
}

/**
 * 写统一错误响应。契约 §8。
 * @param {string} code ERROR_CODE 之一
 */
function writeError(response, code, message, details) {
  const status = ERROR_STATUS[code] ?? 500
  const headers = code === ERROR_CODE.QUEUE_FULL
    // 背压：明确告知不要立即重试。契约 §6.3。
    ? { 'retry-after': '5' }
    : undefined
  const body = { error: { code, message } }
  if (details !== undefined) body.error.details = details
  writeJson(response, status, body, headers)
}
