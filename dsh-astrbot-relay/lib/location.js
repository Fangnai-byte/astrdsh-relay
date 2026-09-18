/**
 * 星驿 · 定位（DSH 侧）
 *
 * 「定位」= 回答两个问题：**这个 IM 对话落在哪个工作区**、**它对应哪个 DSH 会话**。
 * 契约 §12。
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
 */
export const CWD_SOURCE = Object.freeze({
  /** 来自对话级覆盖（state 记录里的 cwd / workspaceId） */
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
 * 把一条 state 记录规整成固定形状。
 *
 * state.json 是**人工可编辑**的，所以这里的策略是「尽量规整、只在该拒绝时拒绝」：
 * 单个字段类型不对 → 归为 null；整条记录不是对象 → 由 parseState 拒绝。
 */
export function normalizeRecord(conversation, raw = {}) {
  const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)
  const num = (value) => (Number.isFinite(value) ? value : null)
  return {
    conversation: String(conversation),
    sessionId: str(raw.sessionId),
    cwd: str(raw.cwd),
    workspaceId: str(raw.workspaceId),
    policy: str(raw.policy),
    createdAt: num(raw.createdAt),
    lastActiveAt: num(raw.lastActiveAt),
    seq: num(raw.seq) ?? 0,
  }
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
    conversations[record.conversation] = {
      sessionId: record.sessionId ?? null,
      cwd: record.cwd ?? null,
      workspaceId: record.workspaceId ?? null,
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
  globalWorkspaceId = '',
  titleTemplate = '',
  statePath = '',
}) {
  const recordCwd = record?.cwd ?? null
  const recordWorkspace = record?.workspaceId ?? null
  const globalCwdValue = typeof globalCwd === 'string' && globalCwd.trim() !== '' ? globalCwd : null
  const globalWorkspaceValue =
    typeof globalWorkspaceId === 'string' && globalWorkspaceId.trim() !== '' ? globalWorkspaceId : null

  let cwd = null
  let workspaceId = null
  let source = CWD_SOURCE.NONE
  if (recordCwd || recordWorkspace) {
    cwd = recordCwd
    workspaceId = recordWorkspace
    source = CWD_SOURCE.CONVERSATION
  } else if (globalCwdValue || globalWorkspaceValue) {
    cwd = globalCwdValue
    workspaceId = globalWorkspaceValue
    source = CWD_SOURCE.GLOBAL
  }

  return {
    conversation: String(conversation ?? ''),
    found: record !== null,
    sessionId: record?.sessionId ?? null,
    // 反向定位：告诉 IM 用户在 DSH 会话列表里该找哪个标题
    title: renderSessionTitle(titleTemplate, conversation),
    cwd,
    workspaceId,
    source,
    policy: record?.policy ?? null,
    createdAt: record?.createdAt ?? null,
    lastActiveAt: record?.lastActiveAt ?? null,
    seq: record?.seq ?? 0,
    statePath,
  }
}
