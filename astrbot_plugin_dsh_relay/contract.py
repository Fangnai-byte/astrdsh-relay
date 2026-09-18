"""AstrDsh Relay（星驿）：契约常量的机器可读副本（AstrBot 侧）。

唯一真相来源是 ``docs/BRIDGE-CONTRACT.md``。
本文件与 DSH 侧 ``dsh-astrbot-relay/lib/contract.js`` 必须逐字对应；
改动任一侧都要同步契约文档与另一侧。
"""

from __future__ import annotations

#: 契约版本。破坏性变更必须递增；/health 返回它，不匹配时拒绝启用。
BRIDGE_VERSION = "1"

#: 路由。契约 §3。相对 AstrBot 侧配置项 ``bridge_url``。
ROUTE_MESSAGE = "/message"
ROUTE_EVENTS = "/events"
ROUTE_APPROVAL = "/approval"
ROUTE_HEALTH = "/health"

#: 下行事件类型。契约 §4。
EVENT_TURN_START = "turn/start"
EVENT_TEXT_DELTA = "text/delta"
EVENT_REASONING_DELTA = "reasoning/delta"
EVENT_TOOL_CALL = "tool/call"
EVENT_APPROVAL_REQUIRED = "approval/required"
EVENT_APPROVAL_RESOLVED = "approval/resolved"
EVENT_MESSAGE_FINAL = "message/final"
EVENT_TURN_END = "turn/end"
EVENT_HEARTBEAT = "heartbeat"
EVENT_GAP = "gap"

#: 未知事件类型必须被忽略（前向兼容），因此这里是"已知集合"而非白名单。
KNOWN_EVENT_TYPES = frozenset({
    EVENT_TURN_START,
    EVENT_TEXT_DELTA,
    EVENT_REASONING_DELTA,
    EVENT_TOOL_CALL,
    EVENT_APPROVAL_REQUIRED,
    EVENT_APPROVAL_RESOLVED,
    EVENT_MESSAGE_FINAL,
    EVENT_TURN_END,
    EVENT_HEARTBEAT,
    EVENT_GAP,
})

#: 统一错误码。契约 §8。
ERROR_UNAUTHORIZED = "unauthorized"
ERROR_NOT_FOUND = "not_found"
ERROR_QUEUE_FULL = "queue_full"
ERROR_AGENT_BUSY = "agent_busy"
ERROR_UNSUPPORTED = "unsupported"
ERROR_INTERNAL = "internal"

#: 可重试的错误码（含纯传输层失败）。契约 §6.2。
RETRYABLE_ERROR_CODES = frozenset({ERROR_INTERNAL})

#: IM 用户可接受的审批结论白名单。契约 §7.2 第 4 条。
#: DSH 侧完整枚举还有 ``cancelled`` / ``unavailable``，那两个是系统语义，
#: 不允许由 IM 用户触发。
APPROVAL_ALLOW_ONCE = "allowed-once"
APPROVAL_REJECTED = "rejected"
APPROVAL_OUTCOMES_ALLOWED = frozenset({APPROVAL_ALLOW_ONCE, APPROVAL_REJECTED})

#: 审批命令关键字。契约 §7.2 第 5 条：只接受明确命令，不接受"是/否"。
APPROVAL_COMMAND_APPROVE = "approve"
APPROVAL_COMMAND_REJECT = "reject"
