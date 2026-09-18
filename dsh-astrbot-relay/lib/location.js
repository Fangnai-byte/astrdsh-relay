/**
 * 星驿 · 定位（DSH 侧）
 *
 * 「定位」= 回答两个问题：**这个 IM 对话落在哪个工作区**、**它对应哪个 DSH 会话**。
 * 契约 §12。
 *
 * ⚠️ 字段名两套命名空间（改动本文件前先读这一条）：
 *   · state.json 的**持久化**字段叫 `dshSessionId`（契约 §2.2 / §12.5）；
 *   · `/where` 的**响应**字段沿用 `sessionId`（契约 §12.1），因为 AstrBot 侧
 *     location_text.py 读的是这个名。读新名 / 答旧名是刻意为之，不是漏改。
 * 只改一侧（例如只改读入侧、忘了 serializeState）会让 id 静默变成 null，
 * 下次启动就把所有会话重新新建一遍——这是本文件最危险的自伤。
 *
 * 本文件是**纯函数**集合——不 import 任何外部包、不碰 fs、不碰 ctx——
 * 因此可以在普通 Node 下单测（见 scripts/test-location.mjs，CI 会跑）。
 * 有副作用的部分（读写 state.json）在 lib/state.js，路由在 lib/index.js。
 *
 * 已核实事实：AstrBot 的 `unified_msg_origin` 形如
 * `{platform_id}:{MessageType}:{session_id}`（如 `default:GroupMessage:123456`），
 * 会话标题的占位符就从这个形状解析而来。
 */

/** state.json 的结构版本。结构不兼容变更时递增，旧版本一律拒绝加载。 */
export const STATE_VERSION = 1

/**
 * 工作目录的来源。用于让用户一眼看出「这个目录是全局默认还是给该对话单独配的」。
 *
 * ⚠️ 判据必须与**最终生效的 cwd** 同源（契约 §12.1）：先定 cwd 再据此定 source，
 * 不能出现「cwd 来自全局、source 却写着 conversation」的自相矛盾。
 */
export const CWD_SOURCE = Object.freeze({
  /** 来自对话级覆盖（state 记录里的 cwd） */
  CONVERSATION: 'conversation',
  /** 来自插件全局配置 */
  GLOBAL: 'global',
  /** 两处都没有——调用方需要决定是否报错 */
  NONE: 'none',
})

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * 把 unified_msg_origin 拆成三段。
 *
 * session_id 里若含 `:` 会被完整保留（只按前两个冒号切分），
 * 避免把某些平台的复合会话 id 切坏。
 */
export function parseConversation(conversation) {
  const parts = String(conversation ?? '').split(':')
  return {
    platform: parts[0] ?? '',
    messageType: parts[1] ?? '',
    sessionId: parts.length > 2 ? parts.slice(2).join(':') : '',
  }
}

/**
 * 渲染 DSH 会话标题——这是「反向定位」的抓手：
 * 标题里带上来源 IM 对话，用户才能在 DSH Web UI 的会话列表里认出
 * 「哪条会话来自哪个群」。
 *
 * 支持的占位符：`{platform}` `{messageType}` `{sessionId}` `{conversation}`。
 * 未知占位符**原样保留**（而不是替换成空串），这样配置写错时看得见。
 */
export function renderSessionTitle(template, conversation) {
  const { platform, messageType, sessionId } = parseConversation(conversation)
  return String(template ?? '').replace(PLACEHOLDER, (whole, key) => {
    switch (key) {
      case 'platform': return platform
      case 'messageType': return messageType
      case 'sessionId': return sessionId
      case 'conversation': return String(conversation ?? '')
      default: return whole
    }
  })
}

/**
 * 取出记录里的 DSH 会话 id。
 *
 * 字段名以契约 §2.2 为准：**dshSessionId**。旧的 `sessionId` 只作为一次性迁移别名
 * 读入（早期版本可能已经写进过 state.json），迁移后由 serializeState 统一写出新名。
 *
 * ⚠️ 类型不对时**抛错，不降级为 null**。
 * 降级 null 等于「这条记录没有会话」→ 下一条消息会静默新建一个 DSH 会话，
 * 老对话的历史就此失联，正是契约 §12.5 明令禁止的行为。
 * 宁可加载失败让人当场看见，也不要一个悄悄把历史弄丢的网桥。
 */
function dshSessionIdOf(conversation, raw) {
  const value = raw.dshSessionId ?? raw.sessionId
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `state.conversations[${JSON.stringify(conversation)}].dshSessionId 必须是非空字符串，` +
      `收到 ${JSON.stringify(value)}；拒绝降级为 null（那会静默新建会话，契约 §12.5）`,
    )
  }
  return value
}

/**
 * 把一条 state 记录规整成固定形状。
 *
 * state.json 是**人工可编辑**的，所以策略是「字段级宽容、结构级严格」：
 * 可有可无的字段类型不对 → 归为 null；但 dshSessionId 这种一旦错就会
 * **静默丢历史**的字段，宁可抛错（见上面的 dshSessionIdOf）。
 *
 * 注意：`workspaceId` 不在输出里——DSH 侧的 agent 创建只认 cwd
 * （`meta: { cwd }`），保留一个从不被使用的字段只会让人以为「配了就会生效」。
 * 契约 §12.3 的工作区级配置随 P5 控制面一起实现。
 */
export function normalizeRecord(conversation, raw = {}) {
  const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)
  const num = (value) => (Number.isFinite(value) ? value : null)
  return {
    conversation: String(conversation),
    dshSessionId: dshSessionIdOf(conversation, raw),
    cwd: str(raw.cwd),
    policy: str(raw.policy),
    createdAt: num(raw.createdAt),
    lastActiveAt: num(raw.lastActiveAt),
    seq: num(raw.seq) ?? 0,
  }
}

/**
 * 造一条**新的**会话记录。
 *
 * 记录形状的唯一权威是上面的 normalizeRecord。index.js 里手写记录字面量
 * = 把字段白名单抄了第二份：两边一旦漂移，症状是「写进去的字段重启后读不回来」
 * 或「读得回来但写不出去」——静默丢掉映射，最难查。所以新建也走 normalizeRecord，
 * 让「读入」与「新建」共用同一份形状定义（见 §2.2 / §12.5）。
 *
 * cwd 默认 null（= 跟随全局配置）而不是把当时的全局值烙进来：§12.3 要求改全局
 * cwd 对既有会话生效，烙进来就相当于给它永久钉死；要按对话分目录请人工编辑 state.json。
 */
export function newRecord({ conversation, dshSessionId, cwd = null, policy = null, now = Date.now() }) {
  // 新建时 id 必须有：允许 null 就等于当场造一条「没有会话」的记录，
  // 下一条消息会静默新建 DSH 会话（§12.5 明令禁止）。
  if (typeof dshSessionId !== 'string' || dshSessionId.trim() === '') {
    throw new Error(`newRecord: dshSessionId 必须是非空字符串，收到 ${JSON.stringify(dshSessionId)}`)
  }
  return normalizeRecord(conversation, {
    dshSessionId, cwd, policy, createdAt: now, lastActiveAt: now, seq: 0,
  })
}

/**
 * 校验并解析 state 的顶层结构。
 *
 * 契约 §2.2 要求**加载失败即拒绝启用**，不静默重建——静默重建会把所有 IM 会话
 * 重新挂到新 DSH 会话上，丢掉历史。因此这里返回明确的失败原因，
 * 由调用方（lib/state.js）抛错。
 *
 * @returns {{ok: true, records: object[]} | {ok: false, reason: string}}
 */
export function parseState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'state 顶层必须是对象' }
  }
  if (raw.version !== STATE_VERSION) {
    return {
      ok: false,
      reason: `不支持的 state 版本 ${JSON.stringify(raw.version)}（期望 ${STATE_VERSION}）`,
    }
  }
  const table = raw.conversations
  if (table === undefined) return { ok: false, reason: 'state 缺少 conversations 字段' }
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return { ok: false, reason: 'state.conversations 必须是「会话键 → 记录」的对象' }
  }
  const records = []
  for (const [conversation, value] of Object.entries(table)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: `state.conversations[${JSON.stringify(conversation)}] 必须是对象` }
    }
    records.push(normalizeRecord(conversation, value))
  }
  return { ok: true, records }
}

/** 反向：把记录集合序列化成 state.json 的结构。接受 Map 或数组。 */
export function serializeState(records) {
  const conversations = {}
  const list = records instanceof Map ? [...records.values()] : [...(records ?? [])]
  // 按会话键排序，使 state.json 的 diff 稳定（便于人工 review 与版本控制）
  for (const record of list.sort((a, b) => a.conversation.localeCompare(b.conversation))) {
    // 落盘字段 = 契约 §2.2 的字段名：dshSessionId。
    // ⚠️ 这里必须与 readRaw 侧（dshSessionIdOf）**用同一个名字**，
    // 只改读不改写会把 id 静默写成 null（写进去的读不回来），
    // 下次启动就等于「所有会话没有映射」→ 全部重新新建，历史全丢。
    // 写出的字段集合 = normalizeRecord 读入的字段集合，多一个少一个都是 bug；
    // 因此 workspaceId 一并去掉了（DSH 侧建 agent 只认 meta.cwd，见 normalizeRecord 注释）。
    conversations[record.conversation] = {
      dshSessionId: record.dshSessionId ?? null,
      cwd: record.cwd ?? null,
      policy: record.policy ?? null,
      createdAt: record.createdAt ?? null,
      lastActiveAt: record.lastActiveAt ?? null,
      seq: record.seq ?? 0,
    }
  }
  return { version: STATE_VERSION, conversations }
}

/**
 * 解析某个会话的「位置」。
 *
 * 工作目录的解析顺序：**对话级覆盖 → 全局配置 → 无**。
 * 会话尚未建立映射时（record 为 null）也照样能回答「它将会落在哪」，
 * 此时 `found: false` 但 `cwd` 与来源仍会被填上——这对排查很关键。
 */
export function resolveLocation({
  conversation,
  record = null,
  globalCwd = '',
  titleTemplate = '',
  statePath = '',
}) {
  const recordCwd = record?.cwd ?? null
  const globalCwdValue = typeof globalCwd === 'string' && globalCwd.trim() !== '' ? globalCwd : null

  // source 必须与**最终生效的 cwd** 同源（契约 §12.1）：先定 cwd，再据此定 source。
  let cwd = null
  let source = CWD_SOURCE.NONE
  if (recordCwd) {
    cwd = recordCwd
    source = CWD_SOURCE.CONVERSATION
  } else if (globalCwdValue) {
    cwd = globalCwdValue
    source = CWD_SOURCE.GLOBAL
  }

  return {
    conversation: String(conversation ?? ''),
    found: record !== null,
    // ⚠️ 两套命名空间，别混：
    //   state.json 持久化字段 = dshSessionId（契约 §2.2 / §12.5）
    //   /where 面向 IM 的响应字段 = sessionId（契约 §12.1，兼容 AstrBot 侧
    //   location_text.py 的 info.get("sessionId")，那份解析不在本仓库的同一发布节奏里）
    // 这里做的是「读新名、答旧名」的显式转译，不是字段名没改完。
    sessionId: record === null ? null : dshSessionIdOf(conversation, record),
    // 反向定位：告诉 IM 用户在 DSH 会话列表里该找哪个标题
    title: renderSessionTitle(titleTemplate, conversation),
    cwd,
    source,
    policy: record?.policy ?? null,
    createdAt: record?.createdAt ?? null,
    lastActiveAt: record?.lastActiveAt ?? null,
    seq: record?.seq ?? 0,
    statePath,
  }
}
