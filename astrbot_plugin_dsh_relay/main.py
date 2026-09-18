"""AstrDsh Relay（星驿）· AstrBot 侧 IM ↔ DSH 网桥（骨架）。

这是**骨架**，不是实现：配置读取、过滤器结构与「易错顺序」已经按源码事实固化，
真正的 HTTP/SSE 传输与会话状态机是 TODO，调用时给出明确的"未实现"提示，
不会让 AstrBot 主流程崩掉。

契约真相来源：``docs/BRIDGE-CONTRACT.md``
设计依据：      ``docs/DESIGN.md`` §3
API 证据：      ``docs/astrbot-side-capabilities.md``

────────────────────────────────────────────────────────────────────────
已核实、且**写错就会静默失败**的四条约束（不要"顺手改优雅"）：

1. ``filter`` 必须从 ``astrbot.api.event`` 导入，避免与内置 ``filter`` 冲突。
2. ``event.should_call_llm(True)`` —— 传 ``True`` 才是**禁止**默认 LLM
   （判定是 ``not event.call_llm``，参数语义与直觉相反）。
3. ``event.stop_event()`` 必须在 ``yield`` **之后**。先 stop 再 yield 会让
   ``RespondStage`` 不执行，**消息发不出去**。
4. 中间分片用 ``await event.send(...)``（绕过 ResultDecorateStage，避免被自动包成
   合并转发或转图），**最后一片**用 ``yield event.plain_result(...)`` 走正常结果链路。
   走 yield 时纯文本超过 ``forward_threshold``（本机 = 1500）会被包装成 Node。

P1 仍需确认的 API 名（本文件用到了，但在核实报告里只出现在推断骨架中）：
   ``event.is_private_chat()``、``event.get_message_type()``。
   确认前用 ``_is_private_chat()`` 这层薄封装兜住，改起来只动一处。
────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

try:  # 包内导入（正常安装路径）
    from . import contract
    from . import location_text
except ImportError:  # 直接以模块方式加载时的兜底，与同路线既有插件一致
    import contract  # type: ignore[no-redef]
    import location_text  # type: ignore[no-redef]


# ──────────────────────────────────────────────────────────────────────
# 传输层（TODO）
# ──────────────────────────────────────────────────────────────────────

class BridgeTransport:
    """HTTP + SSE 传输层。契约 §3。

    实现要点（P1/P2 填充）：

    * 网络库用 ``aiohttp``；**禁止 requests**（AstrBot 硬规范）。
    * ``/message`` 重试必须复用**同一个** ``Idempotency-Key``；换 key 重试等于
      多发一条消息，是 bug。契约 §6.2。
    * 建立顺序固定为：**先连 SSE，再 POST /message**。``text/delta`` 是 DSH 侧的
      瞬时事件，没有订阅者时永久丢失，反过来会丢开头几个 token。契约 §4.1。
    * SSE 禁止使用浏览器原生 EventSource（设不了 Authorization 头）；
      断线重连必须带 ``Last-Event-ID``。
    * 收到 ``429 queue_full`` 时**不重试**，直接把「排队中」回给用户。
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config
        self._closed = False

    async def health(self) -> dict[str, Any]:
        """``GET /health``；启动时校验 ``bridgeVersion``，不匹配则拒绝启用。"""
        raise NotImplementedError("P1: GET /health 尚未实现")

    async def where(self, *, conversation: str) -> dict[str, Any]:
        """``GET /where``：定位该对话的工作区与 DSH 会话（契约 §12）。

        TODO(P1)：随传输层一起实现。返回结构见契约 §12.1；
        排版已由 ``location_text.format_location`` 完成并有单测覆盖，
        所以传输层一通，这条命令立刻可用。
        """
        raise NotImplementedError("P1: GET /where 尚未实现")

    async def send_message(
        self,
        *,
        conversation: str,
        text: str,
        message_id: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """``POST /message``。返回 ``{"accepted": bool, "duplicate": bool, ...}``。"""
        raise NotImplementedError("P1: POST /message 尚未实现")

    def events(
        self, *, conversation: str, last_event_id: int | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """``GET /events``：SSE 下行通道，逐帧产出已解析的事件字典。"""
        raise NotImplementedError("P2: GET /events (SSE) 尚未实现")

    async def send_approval(
        self, *, conversation: str, call_id: str, outcome: str, code: str
    ) -> dict[str, Any]:
        """``POST /approval``。``outcome`` 必须在 contract.APPROVAL_OUTCOMES_ALLOWED 内。"""
        raise NotImplementedError("P2: POST /approval 尚未实现")

    async def aclose(self) -> None:
        """关闭连接池。由 ``Main.terminate`` 调用。"""
        self._closed = True


# ──────────────────────────────────────────────────────────────────────
# 插件主体
# ──────────────────────────────────────────────────────────────────────

class Main(Star):
    """IM → DSH 桥接插件。"""

    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config
        self._transport: BridgeTransport | None = None
        self._bridge_ok: bool | None = None  # None=未探测

    # ---- 配置读取 ----------------------------------------------------

    def _cfg(self, key: str, default: Any = None) -> Any:
        """读配置。``AstrBotConfig`` 继承 dict，但缺失键与显式 None 都要回落默认值。"""
        if self.config is None:
            return default
        value = self.config.get(key) if hasattr(self.config, "get") else None
        return default if value is None else value

    def _transport_or_create(self) -> BridgeTransport:
        if self._transport is None:
            self._transport = BridgeTransport(dict(self.config or {}))
        return self._transport

    # ---- 过滤器 ------------------------------------------------------

    # 用 event_message_type(ALL) 而非 command()：前者群聊无需 @ 即可收到消息
    # （过滤器通过就会 is_wake=True），后者强制要求 is_at_or_wake_command。
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_bridge_message(self, event: AstrMessageEvent):
        """前缀触发 + 审批命令的统一入口。"""
        if not self._cfg("enable", True):
            return

        prefix = str(self._cfg("trigger_prefix", "/dsh ") or "")
        raw = (event.message_str or "").strip()
        if not prefix or not raw.startswith(prefix):
            return  # 不匹配：不设结果、不发消息，完全不干扰 AstrBot 默认逻辑

        if not self._session_allowed(event.unified_msg_origin):
            return

        if self._cfg("reply_in_private_only", False) and not _is_private_chat(event):
            return

        command = raw[len(prefix):].strip()
        if not command:
            yield event.plain_result(
                f"用法：{prefix}<内容>　|　审批：{prefix}"
                f"{contract.APPROVAL_COMMAND_APPROVE} <验证码>　|　定位："
                f"{prefix}{contract.COMMAND_WHERE}"
            )
            event.stop_event()  # 必须在 yield 之后
            return

        head = command.split(maxsplit=1)[0].lower()

        # 定位：只读诊断，不投给 agent。
        if head == contract.COMMAND_WHERE:
            async for result in self._handle_where_command(event):
                yield result
            event.stop_event()
            return

        # 审批回执走独立分支：它不是对话内容，不能投给 agent。
        if head in (contract.APPROVAL_COMMAND_APPROVE, contract.APPROVAL_COMMAND_REJECT):
            async for result in self._handle_approval_command(event, command):
                yield result
            event.stop_event()
            return

        # 命中后接管本事件：传 True 才是"禁止默认 LLM"
        event.should_call_llm(True)

        async for result in self._handle_task(event, command):
            yield result
        event.stop_event()

    # ---- 任务处理 ----------------------------------------------------

    async def _handle_task(self, event: AstrMessageEvent, prompt: str) -> AsyncIterator[Any]:
        """把一条 IM 消息投给 DSH 并把结果回帖。

        P1 最小闭环：POST /message → 等 ``message/final`` / ``turn/end`` → 整段回帖。
        P2 追加：消费 ``text/delta`` 做节流流式回帖（``throttle_ms`` / ``flush_chars``）。
        """
        transport = self._transport_or_create()

        try:
            await transport.send_message(
                conversation=event.unified_msg_origin,
                text=prompt,
                message_id=str(getattr(event.message_obj, "message_id", "") or ""),
                # TODO(P1) 真正的幂等键必须在**重试之间复用**，因此要在这里生成一次
                # 并把它一起传进重试循环，而不是每次重试都新建。
                idempotency_key="",  # TODO(P1): uuid4()
            )
        except NotImplementedError as exc:
            yield event.plain_result(f"[星驿 骨架] {exc}")
            return
        except Exception as exc:  # noqa: BLE001 - 单条消息失败不得影响插件
            logger.warning(f"[dsh_relay] 投递失败：{exc}")
            yield event.plain_result(f"桥接调用失败：{exc}")
            return

        # TODO(P1) 这里等 SSE 上的 message/final 与 turn/end 收敛出最终文本，
        # 然后交给 `self._reply(event, final_text)` 回帖（切分与分片策略已就位）。
        yield event.plain_result("[星驿 骨架] 传输层未实现，未收到回复。")

    async def _handle_where_command(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        """``/dsh where`` —— 定位当前对话的工作区与 DSH 会话（契约 §12）。

        设计取舍：**本地那几行永远打印**。因为用户问「我在哪」时最需要的信息
        （会话键、桥接地址）本来就在本地，不该被一次网络往返的失败拖没——
        插件刚装、地址填错、桥接端没起，这些恰恰是最需要定位能力的时刻。
        """
        lines = location_text.format_where_header(
            event.unified_msg_origin,
            str(self._cfg("bridge_url", "") or ""),
        )
        try:
            info = await self._transport_or_create().where(
                conversation=event.unified_msg_origin
            )
        except NotImplementedError as exc:
            lines.append(f"· 桥接端：{exc}")
        except Exception as exc:  # noqa: BLE001 - 定位失败不应影响插件
            logger.warning(f"[dsh_relay] 定位查询失败：{exc}")
            lines.append(f"· 桥接端查询失败：{exc}")
        else:
            lines.extend(location_text.format_location(info))

        yield event.plain_result("\n".join(lines))

    async def _handle_approval_command(
        self, event: AstrMessageEvent, command: str
    ) -> AsyncIterator[Any]:
        """``/dsh approve <code>`` / ``/dsh reject <code>``。契约 §7。"""
        parts = command.split()
        head = parts[0].lower()
        outcome = (
            contract.APPROVAL_ALLOW_ONCE
            if head == contract.APPROVAL_COMMAND_APPROVE
            else contract.APPROVAL_REJECTED
        )
        if outcome not in contract.APPROVAL_OUTCOMES_ALLOWED:  # 防御性：白名单兜底
            yield event.plain_result("不支持的审批结论。")
            return
        if len(parts) < 2 or not parts[1].strip():
            yield event.plain_result(f"用法：{head} <验证码>")
            return
        code = parts[1].strip()

        try:
            await self._transport_or_create().send_approval(
                conversation=event.unified_msg_origin,
                call_id="",  # TODO(P2): 由本地 pending 表按 code 反查 callId
                outcome=outcome,
                code=code,
            )
        except NotImplementedError as exc:
            yield event.plain_result(f"[星驿 骨架] {exc}")
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh_relay] 审批回执失败：{exc}")
            yield event.plain_result(f"审批回执失败：{exc}")
            return

        yield event.plain_result("已提交。")

    # ---- 回帖（结构已定型，P1 复用）----------------------------------

    async def _reply(self, event: AstrMessageEvent, text: str) -> AsyncIterator[Any]:
        """把 DSH 的文本回帖到同一会话。

        切分策略（契约 §9 未决 #5、设计 §3 第 5 层）：
          中间分片 ``await event.send()``；最后一片 ``yield plain_result()``。
        """
        chunk_size = int(self._cfg("chunk_size", 800) or 0)
        chunks = _split_for_im(text, chunk_size)
        if not chunks:
            yield event.plain_result("（DSH 没有返回内容）")
            return
        for chunk in chunks[:-1]:
            await event.send(event.plain_result(chunk))
        yield event.plain_result(chunks[-1])

    # ---- 辅助 --------------------------------------------------------

    def _session_allowed(self, umo: str) -> bool:
        allow = self._cfg("allow_from", []) or []
        if not isinstance(allow, (list, tuple, set)) or not allow:
            return True  # 空 = 全部允许
        return umo in {str(item).strip() for item in allow}

    async def push_to_session(self, umo: str, text: str) -> bool:
        """主动推送（不经事件）。

        与"回复当前事件"的区别（已核实）：
          * ``event.plain_result()`` 必须 yield，会走 ResultDecorateStage；
          * ``await event.send(...)`` 立即发出，绕过该阶段；
          * 主动推送用 ``await self.context.send_message(umo, chain)``。

        TODO(P1/P3)：``MessageChain`` 的导入路径需确认后再启用。
        核实报告里用的是 ``from astrbot.api.event import MessageChain``，
        但该路径未独立取证，因此这里不写死。
        """
        raise NotImplementedError(
            "P3: 主动推送尚未实现（需先确认 MessageChain 导入路径）"
        )

    async def terminate(self) -> None:
        """插件卸载：释放连接池。

        注意：本插件创建的任何后台任务（SSE 读取、health 轮询、节流定时器）
        都必须在这里取消并 await，否则重载时会留下泄漏的协程。
        不要依赖 AstrBot 代劳。
        """
        if self._transport is not None:
            await self._transport.aclose()
            self._transport = None
        logger.info("[dsh_relay] terminated")


# ──────────────────────────────────────────────────────────────────────
# 纯函数
# ──────────────────────────────────────────────────────────────────────

def _is_private_chat(event: AstrMessageEvent) -> bool:
    """私聊判定。

    UMO 格式已核实为 ``{platform_id}:{MessageType}:{session_id}``，
    因此先用 ``is_private_chat()``（若存在），否则回落到 UMO 解析。
    """
    checker = getattr(event, "is_private_chat", None)
    if callable(checker):
        try:
            return bool(checker())
        except Exception:  # noqa: BLE001 - 判定失败时按群聊处理（更保守：不响应）
            pass
    parts = str(getattr(event, "unified_msg_origin", "")).split(":")
    return len(parts) >= 2 and parts[1] == "FriendMessage"


def _split_for_im(text: str, size: int) -> list[str]:
    """占位切分：按字符硬切。

    已核实：AstrBot **没有**通用切分工具，且 aiocqhttp 适配器完全没有长度切分
    逻辑，所以必须自己切。

    TODO(P4)：改为按段落 / 代码围栏边界切分，并保留围栏完整性
    （既有 connector 的 ``core/reply_render.py`` 可作参考）。
    """
    if not text:
        return []
    if not size or size <= 0 or len(text) <= size:
        return [text]
    return [text[i : i + size] for i in range(0, len(text), size)]
