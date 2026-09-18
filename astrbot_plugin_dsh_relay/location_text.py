"""星驿 · 定位结果的文本排版（AstrBot 侧）。

**纯函数，不 import astrbot**，因此可以在普通 Python 下直接单测
（见 ``scripts/test-location-text.py``，CI 会跑）。

契约 §12 规定桥接端 ``GET /where`` 的返回结构；本文件只负责把它排版成
IM 里能读的几行文字，不做任何网络或框架调用。
"""

from __future__ import annotations

from typing import Any

#: ``/where`` 返回的 ``source`` 字段 → 中文说明。
#: 来源很重要：它告诉用户「这个目录是给本对话单独配的，还是全局默认」。
_CWD_SOURCE_TEXT = {
    "conversation": "对话级配置",
    "global": "全局默认",
    "none": "未配置",
}


def format_location(info: Any) -> list[str]:
    """把 ``GET /where`` 的返回排版成若干行 IM 文本。

    Args:
        info: 桥接端返回的 JSON（应当是 dict）。

    Returns:
        行列表，调用方用 ``"\\n".join(...)`` 拼成一条消息。

    容错策略：这是个**诊断**功能，排版绝不能因为字段缺失或类型怪异而抛错——
    那样用户就把唯一的排查线索弄丢了。因此一律降级成可读文本。
    """
    if not isinstance(info, dict):
        return [f"· 桥接端返回了意外结果：{str(info)[:120]}"]

    lines: list[str] = []

    title = info.get("title")
    if isinstance(title, str) and title.strip():
        # 反向定位的抓手：告诉用户在 DSH 会话列表里按哪个标题找
        lines.append(f"· DSH 会话标题：{title}")

    session_id = info.get("sessionId")
    if isinstance(session_id, str) and session_id.strip():
        lines.append(f"· DSH 会话 id：{session_id}")
    else:
        lines.append("· DSH 会话：尚未建立（下一条消息会触发创建）")

    cwd = info.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        source = info.get("source")
        origin = _CWD_SOURCE_TEXT.get(source, str(source) if source else "未知")
        lines.append(f"· 工作目录：{cwd}（来源：{origin}）")
    else:
        lines.append("· 工作目录：未配置")

    workspace_id = info.get("workspaceId")
    if isinstance(workspace_id, str) and workspace_id.strip():
        lines.append(f"· 工作区 id：{workspace_id}")

    if not info.get("found", False):
        lines.append("· 该对话尚无绑定记录（上面的工作目录是新会话将使用的位置）")

    return lines


def format_where_header(conversation: str, bridge_url: str) -> list[str]:
    """排版「本地就能回答」的那几行——不依赖任何网络往返。

    用户问「我在哪」时，最先需要的是会话键与桥接地址；把它们放在最前面，
    意味着即使桥接端查询失败甚至整个插件刚装上，诊断信息依然可用。
    """
    return [
        "星驿 · 定位",
        f"· 会话键：{conversation}",
        f"· 桥接地址：{bridge_url or '（未配置）'}",
    ]
