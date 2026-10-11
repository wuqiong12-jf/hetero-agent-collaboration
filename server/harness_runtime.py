"""Read-only checks for known incompatible packaged Harness runtimes.

This checks a carrier fingerprint, not its tools, provider, or SDK profile. An
unknown fingerprint stays unverified; only confirmed bad carriers are blocked.
"""
from __future__ import annotations

import hashlib
import os
import stat
import sys
from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import Literal, TypedDict


KNOWN_BAD_FINGERPRINTS: Mapping[str, int] = MappingProxyType({
    "7ff077cfa28b81aa33f96aca97911969f8b6499bc1f85e4a6d3ddd16b8aa67d6": 240_529_920,
})

WINDOWS_ACL_ENTRY_MISSING = (
    "当前 Windows Harness 运行时缺少 ACL 沙箱子进程入口，受限工具无法运行；"
    "启动检查未通过。请安装修复该入口的运行时后重新检测。"
)
RUNTIME_CHECK_FAILED = (
    "无法读取 Harness 运行时文件，启动检查未通过；请检查运行时安装后重新检测。"
)


class RuntimeInspection(TypedDict):
    runtimeCheck: Literal["blocked", "unverified", "not-applicable", "failed"]
    executionReady: bool
    runtimeIssue: Literal["windows-acl-entry-missing", "runtime-check-failed"] | None
    detail: str


def inspect_runtime(
    launch: Sequence[str],
    platform: str = sys.platform,
    known_bad_fingerprints: Mapping[str, int] = KNOWN_BAD_FINGERPRINTS,
) -> RuntimeInspection:
    """Read the selected carrier without executing it or caching the result.

    Fingerprints map SHA256 digests to byte sizes. The size only selects hash
    candidates; matching a size never blocks a carrier by itself. Both files
    in a Node launch must be readable, but this packaged-Windows check cannot
    verify a Node carrier. Failure diagnostics deliberately omit file paths.
    """
    try:
        if not launch:
            raise ValueError("No runtime carrier")
        node_carrier = len(launch) > 1
        for index, filename in enumerate(launch):
            with open(filename, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("Runtime carrier is not a regular file")
                candidates = {
                    digest for digest, size in known_bad_fingerprints.items()
                    if size == info.st_size
                } if platform == "win32" and not node_carrier and index == 0 else set()
                if candidates:
                    digest = hashlib.sha256()
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                    if digest.hexdigest() in candidates:
                        return {"runtimeCheck": "blocked", "executionReady": False,
                                "runtimeIssue": "windows-acl-entry-missing",
                                "detail": WINDOWS_ACL_ENTRY_MISSING}
                else:
                    stream.read(1)
    except (OSError, TypeError, ValueError):
        return {"runtimeCheck": "failed", "executionReady": False,
                "runtimeIssue": "runtime-check-failed", "detail": RUNTIME_CHECK_FAILED}

    if node_carrier:
        return {"runtimeCheck": "unverified", "executionReady": True,
                "runtimeIssue": None,
                "detail": "Node 运行时载体未经过此 Windows 打包入口兼容性核验。"}
    if platform == "win32":
        return {"runtimeCheck": "unverified", "executionReady": True,
                "runtimeIssue": None,
                "detail": "Windows 运行时载体尚未通过沙箱入口兼容性核验。"}
    return {"runtimeCheck": "not-applicable", "executionReady": True,
            "runtimeIssue": None, "detail": ""}
