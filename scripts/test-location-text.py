#!/usr/bin/env python3
"""``astrbot_plugin_dsh_relay/location_text.py`` 的单元测试。

该模块刻意不 import astrbot，所以不需要安装 AstrBot 就能跑。CI 会执行本脚本。

用法：python scripts/test-location-text.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Windows 控制台默认是 GBK，直接 print 对勾会 UnicodeEncodeError。
# 显式切到 UTF-8，避免「测试还没跑就死在输出上」。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):  # 老解释器或被重定向时忽略
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "astrbot_plugin_dsh_relay"))

import location_text  # noqa: E402  （必须在 sys.path 调整之后导入）

_passed = 0
_failed: list[str] = []


def test(name: str):
    def decorator(fn):
        global _passed
        try:
            fn()
            _passed += 1
            print(f"  \u2713 {name}")
        except AssertionError as exc:
            _failed.append(name)
            print(f"  \u2717 {name}\n      {exc}")
        return fn

    return decorator


def _joined(info) -> str:
    return "\n".join(location_text.format_location(info))


print("format_where_header")


@test("本地三行不依赖网络，且空地址降级为可读文本")
def _() -> None:
    lines = location_text.format_where_header("default:GroupMessage:1000000001", "http://x/astrbot-relay")
    assert lines[0] == "星驿 · 定位", lines
    assert "default:GroupMessage:1000000001" in lines[1], lines
    assert "http://x/astrbot-relay" in lines[2], lines
    assert "（未配置）" in "\n".join(location_text.format_where_header("a:b:c", ""))


print("\nformat_location")


@test("完整结果：标题 / 会话 id / 目录来源 / 工作区 全部呈现")
def _() -> None:
    text = _joined({
        "found": True, "title": "星驿 · default/GroupMessage/1", "sessionId": "im-abc",
        "cwd": "D:\\AI\\workspace", "source": "conversation", "workspaceId": "ws-1",
    })
    assert "星驿 · default/GroupMessage/1" in text, text
    assert "im-abc" in text, text
    assert "D:\\AI\\workspace" in text, text
    assert "对话级配置" in text, text
    assert "ws-1" in text, text
    assert "尚无绑定记录" not in text, text


@test("全局来源被标注为「全局默认」——用户要能区分是不是给本对话单独配的")
def _() -> None:
    text = _joined({"found": False, "cwd": "/global", "source": "global", "title": "T"})
    assert "全局默认" in text, text
    assert "尚无绑定记录" in text, text


@test("未建立会话时给出下一步会发生什么，而不是留空")
def _() -> None:
    text = _joined({"found": False, "cwd": None, "sessionId": None})
    assert "尚未建立" in text, text
    assert "工作目录：未配置" in text, text


@test("缺字段不抛错（诊断功能不能因排版而失效）")
def _() -> None:
    assert location_text.format_location({}), "空字典必须能排版"


@test("非 dict 输入降级成可读提示")
def _() -> None:
    lines = location_text.format_location(["nope"])
    assert len(lines) == 1 and "意外结果" in lines[0], lines
    assert "意外结果" in _joined(None), "None 也要降级"


@test("未知 source 不吞掉信息，原样带出")
def _() -> None:
    text = _joined({"cwd": "/w", "source": "something-new"})
    assert "something-new" in text, text


print(f"\n通过 {_passed} 项，失败 {len(_failed)} 项")
if _failed:
    print(f"失败项：{'、'.join(_failed)}")
    sys.exit(1)
