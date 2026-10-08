"""Relay's isolated stdin/JSONL bridge to the official DeepSeek Harness SDK.

No prompt or credential is put on a command line. --probe only imports and
resolves installed SDK runtime files; it never initializes an LLM session.
"""
from __future__ import annotations

import json
import importlib.metadata
import os
import sys
import tempfile
import threading
import uuid
from pathlib import Path


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def scrub(value: object) -> str:
    text = str(value)
    for name in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ACCESS_TOKEN"):
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[credential redacted]")
    return text[:1000]


def probe() -> None:
    try:
        import deepseek_harness as sdk
        from deepseek_harness import DeepSeekHarness  # noqa: F401
        from deepseek_harness_runtime import resolve_bundled_launch_args

        launch = resolve_bundled_launch_args()
        ready = bool(launch and Path(launch[0]).is_file())
        config_fields = getattr(getattr(sdk, "DeepSeekHarnessConfig", None), "__dataclass_fields__", {})
        supports_effort = "reasoning_effort" in config_fields
        versions = {}
        for distribution, key in (("deepseek-harness-sdk", "sdkVersion"),
                                  ("deepseek-harness-runtime-bin", "runtimeVersion")):
            try:
                versions[key] = importlib.metadata.version(distribution)
            except importlib.metadata.PackageNotFoundError:
                pass
        emit({"type": "capabilities", "sdk": True, "runtime": ready,
              "reasoningEffortSupported": supports_effort,
              "reasoningEfforts": ["off", "low", "high", "max"] if supports_effort else [],
              **versions,
              "detail": "" if ready else "Matching native runtime is unavailable."})
    except Exception as exc:
        emit({"type": "capabilities", "sdk": False, "runtime": False,
              "detail": scrub(exc)})


def token_usage(events: list) -> dict | None:
    # Report actual provider usage only, never an estimate. Sum completion
    # usage per root assistant message; internal tools can cause several calls.
    total: dict[str, int] = {}
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data") or {}
        message = data.get("message") or data
        usage = message.get("usage") or data.get("usage")
        if not isinstance(usage, dict):
            continue
        for output, candidates in (
            ("inputTokens", ("inputTokens", "input_tokens", "prompt_tokens")),
            ("outputTokens", ("outputTokens", "output_tokens", "completion_tokens")),
        ):
            amount = next((usage.get(key) for key in candidates
                           if isinstance(usage.get(key), (int, float))), None)
            if amount is not None:
                total[output] = total.get(output, 0) + int(amount)
        # Harness uses disjoint cache-read/input counts. The workbench's input
        # count includes all prompt tokens, with cache hits also reported.
        cached = usage.get("cacheReadTokens")
        if isinstance(cached, (int, float)):
            total["inputTokens"] = total.get("inputTokens", 0) + int(cached)
            total["cachedInputTokens"] = total.get("cachedInputTokens", 0) + int(cached)
        cached_writes = usage.get("cacheWriteTokens")
        if isinstance(cached_writes, (int, float)):
            total["inputTokens"] = total.get("inputTokens", 0) + int(cached_writes)
    return total or None


def permission_patch(access_mode: str) -> str:
    """Bundle the exact sandbox mode with deterministic rejection of upgrades."""
    if access_mode not in ("read-only", "workspace-write"):
        raise ValueError("accessMode must be read-only or workspace-write.")
    preset = "relay-readonly" if access_mode == "read-only" else "relay-workspace"
    return f"""- id: sandbox-policy
  config:
    mode: {access_mode}
- id: approval
  config:
    policy: never
- id: permission
  config:
    defaultPreset: {preset}
    presets:
      {preset}:
        sandbox: {access_mode}
        approval: never
- id: sdk-jsonrpc-server
  config:
    maxTokensAsSuccess: false
"""


def run(payload: dict) -> None:
    access_mode = payload.get("accessMode", "workspace-write")
    patch_text = permission_patch(access_mode)
    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        raise RuntimeError("DEEPSEEK_API_KEY is required.")
    import deepseek_harness as sdk
    from deepseek_harness import DeepSeekHarness

    reasoning_effort = payload.get("reasoningEffort")
    if reasoning_effort is not None:
        if reasoning_effort not in ("off", "low", "high", "max"):
            raise RuntimeError("Unsupported Harness reasoning effort; use off, low, high, or max.")
        fields = getattr(getattr(sdk, "DeepSeekHarnessConfig", None), "__dataclass_fields__", {})
        if "reasoning_effort" not in fields:
            raise RuntimeError("Installed Harness SDK does not support reasoning_effort.")

    workspace = Path(payload["workspace"]).resolve(strict=True)
    if not workspace.is_dir():
        raise RuntimeError("Workspace must be an existing directory.")
    home = Path(payload["home"]).resolve()
    home.mkdir(parents=True, exist_ok=True)
    # The public SDK has no process-restart resume method. This bridge runs
    # one fresh native session; the caller supplies scoped chat history when
    # continuing a DeepSeek conversation rather than pretending this UUID
    # rehydrates a previous runtime's model context.
    session_id = f"relay-{uuid.uuid4().hex}"
    # Full SDK uses confined shell and filesystem backends. These final
    # invocation patches override inherited home defaults and reject every
    # escalation; sdk-minimal's unrestricted shell is deliberately not used.
    delta_seen = False
    tool_names: dict[str, str] = {}
    request_failed = threading.Event()

    def on_notification(notification) -> None:
        nonlocal delta_seen
        if notification.method != "session.event":
            return
        # Never render private chain-of-thought or descendants as root output.
        if notification.payload.get("sessionId") != session_id:
            return
        event = notification.payload.get("event") or {}
        data = event.get("data") or {}
        kind = event.get("type")
        if kind == "assistant/chunk":
            chunk = data.get("chunk") or {}
            if chunk.get("type") == "text-delta" and isinstance(chunk.get("text"), str):
                delta_seen = True
                emit({"type": "delta", "text": chunk["text"]})
        elif kind == "assistant/message" and not delta_seen:
            message = data.get("message") or data
            text = "".join(str(block.get("text") or "")
                           for block in message.get("content", [])
                           if isinstance(block, dict) and block.get("type") == "text")
            if text:
                emit({"type": "delta", "text": text})
        elif kind == "tool/call":
            call = data.get("call") or data
            name = call.get("name") or call.get("tool") or "tool"
            tool_names[str(call.get("callId") or call.get("id") or "")] = str(name)
            arguments = call.get("arguments")
            details = scrub(json.dumps(arguments, ensure_ascii=False)) if arguments else ""
            emit({"type": "tool", "method": kind,
                  "text": f"\n[工具：{name}]\n{details}\n"})
        elif kind in ("tool/result", "tool/end"):
            message = data.get("message") or data
            name = tool_names.get(str(message.get("callId") or ""), "tool")
            content = "".join(str(block.get("text") or "")
                              for block in message.get("content", [])
                              if isinstance(block, dict) and block.get("type") == "text")
            emit({"type": "tool", "method": kind,
                  "text": f"\n[工具输出：{name}]\n{scrub(content)}\n"})

    with tempfile.TemporaryDirectory(prefix="relay-harness-policy-", dir=home) as temp:
        patch = Path(temp) / "relay-policy.patch.yml"
        patch.write_text(patch_text, encoding="utf-8")
        harness = DeepSeekHarness(
            provider="deepseek-official",
            model=payload.get("model") or "deepseek-flash",
            max_tokens=int(payload.get("maxTokens") or 8192),
            cwd=str(workspace),
            runtime_cwd=str(workspace),
            dsh_home=str(home),
            profile="sdk",
            patches=(str(patch),),
            initialize_timeout_seconds=30,
            request_timeout_seconds=float(payload.get("timeoutSeconds") or 1200),
            shutdown_timeout_seconds=1,
            env={"DSH_PERMISSION_MODE": access_mode, "DSH_MAX_TOKENS_AS_SUCCESS": "false"},
            **({"reasoning_effort": reasoning_effort} if reasoning_effort is not None else {}),
        )
        with harness:
            # Fail closed for future server-initiated requests. The shipped
            # SDK approval service itself rejects asks through the patch.
            def reject_requests() -> None:
                try:
                    while True:
                        request = harness.client.next_request()
                        request_failed.set()
                        harness.client.respond_error(
                            request.id, code=-32601,
                            message="Relay has no approval handler")
                except Exception:
                    pass  # Transport closure ends the daemon naturally.

            threading.Thread(target=reject_requests, daemon=True,
                             name="relay-harness-request-denial").start()
            result = harness.run(payload["prompt"], session_id=session_id,
                                 on_notification=on_notification)
            if request_failed.is_set():
                raise RuntimeError("Harness requested an unsupported host action; rejected.")
            if result.finish_reason != "completed":
                raise RuntimeError(f"Harness turn did not complete: {result.finish_reason}")
            if not result.final_response.strip():
                raise RuntimeError("Harness returned no final public response.")
        # Announce completion after the SDK has flushed and reaped its runtime.
        # The Node side can now stop this bridge without losing durable state.
        emit({"type": "result", "text": result.final_response,
              "finishReason": result.finish_reason,
              "usage": token_usage(result.events)})


if __name__ == "__main__":
    payload = {}
    try:
        if "--probe" in sys.argv:
            probe()
        else:
            line = sys.stdin.readline(2 * 1024 * 1024)
            if not line.endswith("\n"):
                raise ValueError("Missing or oversized JSON input.")
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError("JSON input must be an object.")
            run(payload)
            # The Node owner keeps stdin open while confirming Windows /T
            # termination. Keep this root alive after SDK shutdown so that
            # taskkill can acknowledge the complete owned tree. Parent death
            # closes stdin and exits this already-shut-down bridge naturally.
            if payload.get("holdUntilClosed") is True:
                sys.stdin.read()
    except Exception as exc:
        emit({"type": "error", "message": scrub(exc)})
        if "--probe" not in sys.argv and isinstance(payload, dict) and payload.get("holdUntilClosed") is True:
            sys.stdin.read()
        sys.exit(1)
