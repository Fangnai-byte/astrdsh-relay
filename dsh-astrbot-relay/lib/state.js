/**
 * 星驿 · 会话映射的持久化（DSH 侧）
 *
 * 权威映射（IM 会话 → DSH 会话 + 工作目录）落在 state.json。
 * 契约 §2.2：**原子写**（临时文件 + rename），启动解析失败时拒绝启用。
 *
 * 只依赖 node 内置模块与 lib/location.js，因此可在普通 Node 下单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseState, serializeState } from './location.js'

export const DEFAULT_STATE_DIRNAME = 'astrbot-relay'
export const DEFAULT_STATE_FILENAME = 'state.json'

/**
 * 解析 state 文件路径。
 *
 * 配置了 `statePath` 就用它（必须是绝对路径）；否则落在
 * `<DSH_HOME>/astrbot-relay/state.json`。
 * 与契约 §2.2 一致：**不使用 `ctx.storage`**（该 API 本轮未核实）。
 */
export function resolveStatePath(configured, env = process.env) {
  const raw = String(configured ?? '').trim()
  if (raw !== '') {
    if (!isAbsolute(raw)) {
      throw new Error(`dsh-astrbot-relay: statePath 必须是绝对路径，收到 ${JSON.stringify(raw)}`)
    }
    return raw
  }
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, DEFAULT_STATE_DIRNAME, DEFAULT_STATE_FILENAME)
}

/**
 * 读取并校验 state。
 *
 * 文件不存在 → 空映射（首次启动的正常情况）。
 * 文件存在但损坏 → **抛错**，绝不静默重建：静默重建会把所有 IM 会话重新挂到
 * 新 DSH 会话上，丢掉历史。
 *
 * @returns {{records: Map<string, object>, existed: boolean}}
 */
export function loadState(path) {
  if (!existsSync(path)) return { records: new Map(), existed: false }

  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-astrbot-relay: state 文件无法解析（${path}）：${error.message}`)
  }

  const parsed = parseState(raw)
  if (!parsed.ok) {
    throw new Error(`dsh-astrbot-relay: state 文件不合法（${path}）：${parsed.reason}`)
  }
  return { records: new Map(parsed.records.map((record) => [record.conversation, record])), existed: true }
}

/**
 * 原子写入 state：先写同目录临时文件再 rename。
 * 直接覆写会在崩溃/断电时留下半截 JSON，而那正好会触发上面「拒绝启用」的路径。
 */
export function saveState(path, records) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(serializeState(records), null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
