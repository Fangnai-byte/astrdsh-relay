#!/usr/bin/env node
/**
 * 定位（契约 §12）与 state 持久化的单元测试。
 *
 * 这两个模块刻意不 import 任何外部包（只用 node 内置），所以能在普通 Node 下
 * 直接跑，不需要安装 dsh 依赖。CI 会执行本脚本。
 *
 * 用法：node scripts/test-location.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CWD_SOURCE, STATE_VERSION, normalizeRecord, parseConversation, parseState,
  renderSessionTitle, resolveLocation, serializeState,
} from '../dsh-astrbot-relay/lib/location.js'
import { loadState, resolveStatePath, saveState } from '../dsh-astrbot-relay/lib/state.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.test-tmp')

let passed = 0
const failures = []

const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`  ✗ ${name}\n      ${error.message.split('\n')[0]}`)
  }
}
const throws = (fn, pattern, message) => {
  try {
    fn()
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`${message ?? '抛出的错误信息不符'}：期望匹配 ${pattern}，实际是「${error.message}」`)
    }
    return
  }
  throw new Error(message ?? '期望抛错，但没有抛')
}

console.log('parseConversation / renderSessionTitle')

test('三段式 UMO 正常解析', () => {
  assert.deepStrictEqual(parseConversation('default:GroupMessage:123456'), {
    platform: 'default', messageType: 'GroupMessage', sessionId: '123456',
  })
})

test('session_id 里含冒号时完整保留（不被切坏）', () => {
  assert.deepStrictEqual(parseConversation('tg:PrivateMessage:user:42'), {
    platform: 'tg', messageType: 'PrivateMessage', sessionId: 'user:42',
  })
})

test('畸形 UMO 不抛错，缺失段位为空串', () => {
  assert.deepStrictEqual(parseConversation('onlyone'), { platform: 'onlyone', messageType: '', sessionId: '' })
  assert.deepStrictEqual(parseConversation(''), { platform: '', messageType: '', sessionId: '' })
  assert.deepStrictEqual(parseConversation(undefined), { platform: '', messageType: '', sessionId: '' })
})

test('默认模板渲染出可辨识的标题', () => {
  assert.equal(
    renderSessionTitle('星驿 · {platform}/{messageType}/{sessionId}', 'default:GroupMessage:1000000001'),
    '星驿 · default/GroupMessage/1000000001',
  )
})

test('{conversation} 占位符给出完整 UMO', () => {
  assert.equal(
    renderSessionTitle('[IM] {conversation}', 'default:FriendMessage:1000000001'),
    '[IM] default:FriendMessage:1000000001',
  )
})

test('未知占位符原样保留（配置写错要看得见，而不是静默变空）', () => {
  assert.equal(renderSessionTitle('{platform}-{typo}', 'p:M:s'), 'p-{typo}')
})

console.log('\nnormalizeRecord / parseState')

test('normalizeRecord 把错误类型归为 null 而不是崩溃', () => {
  const record = normalizeRecord('c', { sessionId: 42, cwd: '', workspaceId: '  ', seq: 'x', createdAt: NaN })
  assert.deepStrictEqual(record, {
    conversation: 'c', sessionId: null, cwd: null, workspaceId: null,
    policy: null, createdAt: null, lastActiveAt: null, seq: 0,
  })
})

test('合法 state 解析成功', () => {
  const parsed = parseState({
    version: STATE_VERSION,
    conversations: { 'a:b:c': { sessionId: 'im-1', cwd: 'D:\\ws', seq: 3 } },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0].sessionId, 'im-1')
  assert.equal(parsed.records[0].seq, 3)
})

test('空 conversations 是合法的（首次启动）', () => {
  assert.equal(parseState({ version: STATE_VERSION, conversations: {} }).ok, true)
})

test('版本不符被拒绝（附明确原因）', () => {
  const parsed = parseState({ version: 99, conversations: {} })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /版本/)
})

test('顶层为数组被拒绝', () => {
  assert.equal(parseState([]).ok, false)
  assert.equal(parseState(null).ok, false)
})

test('缺少 conversations 被拒绝', () => {
  assert.equal(parseState({ version: STATE_VERSION }).ok, false)
})

test('某条记录不是对象被拒绝，且错误里带出该会话键', () => {
  const parsed = parseState({ version: STATE_VERSION, conversations: { 'k:1:2': 'oops' } })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /k:1:2/)
})

console.log('\nserializeState / resolveLocation')

test('序列化按会话键排序，便于人工 review 与 diff', () => {
  const state = serializeState([
    { conversation: 'z:1:1', seq: 1 },
    { conversation: 'a:1:1', seq: 2 },
  ])
  assert.deepStrictEqual(Object.keys(state.conversations), ['a:1:1', 'z:1:1'])
  assert.equal(state.version, STATE_VERSION)
})

test('序列化 → 解析 往返一致', () => {
  const input = [normalizeRecord('d:GroupMessage:5', { sessionId: 'im-9', cwd: '/w', seq: 7 })]
  const back = parseState(serializeState(input))
  assert.equal(back.ok, true)
  assert.deepStrictEqual(back.records, input)
})

test('对话级覆盖优先于全局', () => {
  const location = resolveLocation({
    conversation: 'p:M:s',
    record: normalizeRecord('p:M:s', { sessionId: 'im-1', cwd: '/per-conversation' }),
    globalCwd: '/global',
    titleTemplate: 'T-{sessionId}',
    statePath: '/state.json',
  })
  assert.equal(location.source, CWD_SOURCE.CONVERSATION)
  assert.equal(location.cwd, '/per-conversation')
  assert.equal(location.found, true)
  assert.equal(location.title, 'T-s')
  assert.equal(location.statePath, '/state.json')
})

test('无对话级覆盖时落到全局', () => {
  const location = resolveLocation({ conversation: 'p:M:s', globalCwd: '/global' })
  assert.equal(location.source, CWD_SOURCE.GLOBAL)
  assert.equal(location.cwd, '/global')
  assert.equal(location.found, false)
  assert.equal(location.sessionId, null)
})

test('两处都没有时 source 为 none（由调用方决定是否报错）', () => {
  const location = resolveLocation({ conversation: 'p:M:s' })
  assert.equal(location.source, CWD_SOURCE.NONE)
  assert.equal(location.cwd, null)
})

test('会话未建立映射时仍回答「将会落在哪」', () => {
  const location = resolveLocation({ conversation: 'p:M:s', globalCwd: '/global', titleTemplate: 'T-{sessionId}' })
  assert.equal(location.found, false)
  assert.equal(location.cwd, '/global')
  assert.equal(location.title, 'T-s')
})

console.log('\nstate 文件读写')

test('resolveStatePath：未配置时落到 <DSH_HOME>/astrbot-relay/state.json', () => {
  const path = resolveStatePath('', { DSH_HOME: join(TMP, 'home') })
  assert.equal(path, join(TMP, 'home', 'astrbot-relay', 'state.json'))
})

test('resolveStatePath：配置了相对路径要响亮报错', () => {
  throws(() => resolveStatePath('relative/state.json', {}), /绝对路径/, '相对路径应被拒绝')
})

test('state 不存在 → 空映射，不抛错', () => {
  const { records, existed } = loadState(join(TMP, 'nope', 'state.json'))
  assert.equal(existed, false)
  assert.equal(records.size, 0)
})

test('保存后能读回（含原子写不留临时文件）', () => {
  const path = join(TMP, 'store', 'state.json')
  saveState(path, new Map([['p:M:s', normalizeRecord('p:M:s', { sessionId: 'im-1', seq: 2 })]]))
  assert.ok(existsSync(path), 'state 文件应存在')
  assert.ok(!existsSync(`${path}.tmp-${process.pid}`), '不应残留临时文件')
  const { records, existed } = loadState(path)
  assert.equal(existed, true)
  assert.equal(records.get('p:M:s').sessionId, 'im-1')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, STATE_VERSION)
})

test('state 是坏 JSON → 抛错（绝不静默重建）', () => {
  const path = join(TMP, 'broken', 'state.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{ not json', 'utf8')
  throws(() => loadState(path), /无法解析/, '坏 JSON 应抛错')
})

test('state 版本不符 → 抛错并指明路径', () => {
  const path = join(TMP, 'oldver', 'state.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 0, conversations: {} }), 'utf8')
  throws(() => loadState(path), /不合法/, '版本不符应抛错')
})

// ── 收尾 ──────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
