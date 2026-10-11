#!/usr/bin/env python3
"""Agentless checks of Relay's read-only Harness tool composition.

Uses the installed public Python SDK and a selected runtime. All homes and
plugins are synthetic, all provider URLs point at a deny-only loopback server,
and no session/prompt request is sent. This complements, rather than replaces,
the separate Windows filesystem ACL checks.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import uuid

PREFIX = "relay-harness-tool-check-"
BLOCKED_TOOLS = ("workflow", "ralph", "subagent", "subagent_fork",
                 "send_message", "interrupt_agent", "list_agents")
SENTINELS = ("relay_fixture_home_tool", "relay_fixture_profile_tool")


def parse_cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin", required=True, help="absolute path of the matching Harness runtime executable")
    parser.add_argument("--temp-parent", default=tempfile.gettempdir(), help="existing parent of an owned disposable fixture")
    parser.add_argument("--timeout-seconds", type=int, default=30)
    options = parser.parse_args(argv)
    binary = Path(options.bin)
    parent = Path(options.temp_parent)
    if not binary.is_absolute() or any(c in options.bin for c in "\r\n\0") or not binary.is_file():
        parser.error("--bin must be an existing absolute executable file")
    if sys.platform == "win32" and binary.suffix.lower() != ".exe":
        parser.error("--bin must select a Windows .exe file")
    if not parent.is_absolute() or not parent.is_dir():
        parser.error("--temp-parent must be an existing absolute directory")
    if not 1 <= options.timeout_seconds <= 120:
        parser.error("--timeout-seconds must be between 1 and 120")
    options.bin = binary.resolve(strict=True)
    options.temp_parent = parent.resolve(strict=True)
    return options


def load_bridge():
    directory = Path(__file__).resolve().parent.parent / "server"
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("relay_readonly_bridge", directory / "harness_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_owned_root(root: Path, parent: Path, nonce: str) -> None:
    if root.is_symlink() or root.resolve(strict=True).parent != parent.resolve(strict=True):
        raise ValueError("Fixture ownership check failed")
    if not root.name.startswith(PREFIX) or not root.is_dir():
        raise ValueError("Fixture ownership check failed")
    marker = root / ".relay-fixture-owner"
    if marker.is_symlink() or marker.read_text(encoding="ascii") != nonce:
        raise ValueError("Fixture ownership check failed")


def remove_owned_root(root: Path, parent: Path, nonce: str) -> None:
    assert_owned_root(root, parent, nonce)
    shutil.rmtree(root)


@contextmanager
def isolated_environment(root: Path, base_url: str):
    previous = dict(os.environ)
    # Retain OS lookup facts, never ambient provider keys, loader switches,
    # proxy credentials or the user's Harness home. The SDK starts with this
    # controlled environment and then supplies its explicit selected home.
    names = ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "USERPROFILE",
             "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)")
    by_name = {name.upper(): value for name, value in previous.items()}
    environment = {name: by_name[name] for name in names if name in by_name}
    environment.update({"TEMP": str(root), "TMP": str(root),
                        "DEEPSEEK_API_KEY": "relay-synthetic-denied-inference",
                        "DEEPSEEK_BASE_URL": base_url,
                        "DEEPSEEK_SEARCH_BASE_URL": base_url,
                        "DSH_TELEMETRY_DISABLED": "1"})
    try:
        os.environ.clear()
        os.environ.update(environment)
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


@contextmanager
def deny_inference():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(True)
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"fixture forbids provider calls")

        do_POST = do_GET
        do_PUT = do_GET
        do_DELETE = do_GET
        do_HEAD = do_GET
        do_OPTIONS = do_GET
        do_PATCH = do_GET

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def sentinel_source(marker: Path, name: str) -> str:
    return """import { writeFile } from 'node:fs/promises';
export const name = 'relay-fixture-sentinel';
export const inject = ['tools'];
export async function apply(ctx) {
  await writeFile(MARKER, 'fixture-started', 'utf8');
  ctx.tools.register({name: NAME, description: 'Synthetic inherited plugin sentinel',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    output: {schema: {type: 'boolean'}, render: value => [{type: 'text', text: String(value)}]},
    execute: async () => {throw new Error('Fixture sentinel must never execute');}});
}
""".replace("MARKER", json.dumps(str(marker))).replace("NAME", json.dumps(name))


def diagnostic_source(report: Path, readonly: bool, test_file: Path | None = None) -> str:
    # appReady commits after complete Loader startup, so the tool inventory
    # cannot race async registrations. The checks call only absent tools;
    # write-mode control lists tools but never executes them.
    test_file = test_file or report.parent / "workspace" / "baseline.txt"
    return """import { readFile, writeFile } from 'node:fs/promises';
export const name = 'relay-fixture-diagnostic';
export const inject = ['tools', 'appReady', 'agents'];
export function apply(ctx) {
  const ready = ctx.get('appReady');
  if (!ready) throw new Error('Fixture startup boundary unavailable');
  ready.onReady(() => { void (async () => {
    try {
      const tools = ctx.tools.schemas().map(tool => tool.name).sort();
      const unavailable = Object.fromEntries(BLOCKED.map(name => [name, ctx.tools.get(name) === undefined]));
      const unknown = {};
      let fileProtection;
      if (READONLY) {
        for (const name of BLOCKED) {
          // Never invoke an unexpectedly present tool; inventory failure is
          // sufficient evidence and preserves the no-agent contract.
          if (!unavailable[name]) { unknown[name] = false; continue; }
          const result = await ctx.tools.execute({callId: 'relay-fixture-' + name,
            name, arguments: {}, signal: new AbortController().signal});
          unknown[name] = result.isError === true && result.error?.info?.code === 'UNKNOWN_TOOL';
        }
        // Create an idle agent through the same public factory the SDK uses.
        // Reading in that real scope satisfies the observation policy before
        // edit/write, so missing context or stale-read errors cannot pass as
        // sandbox denials. No followup or model request is made.
        const handle = await ctx.agents.create({sessionId: 'relay-fixture-idle',
          meta: {cwd: process.cwd()}, agentOptions: {provider: 'deepseek-official', model: 'deepseek-flash'}});
        try {
          const call = (name, args) => handle.agent.ctx.tools.execute({callId: 'relay-fs-' + name,
            name, arguments: args, agent: handle.agent, signal: new AbortController().signal});
          const read = await call('read', {file_path: TESTFILE});
          const write = await call('write', {file_path: TESTFILE, content: 'fixture-write-changed'});
          const edit = await call('edit', {file_path: TESTFILE,
            old_string: 'fixture-original', new_string: 'fixture-edit-changed'});
          fileProtection = {idleAgent: true,
            readSucceeded: read.isError !== true && read.value?.lines?.some(line => line.text === 'fixture-original'),
            writeDenied: write.isError === true && write.error?.info?.code === 'FS_SANDBOX_DENIED',
            editDenied: edit.isError === true && edit.error?.info?.code === 'FS_SANDBOX_DENIED',
            contentsRetained: await readFile(TESTFILE, 'utf8') === 'fixture-original'};
        } finally { await handle.dispose(); }
      }
      await writeFile(REPORT, JSON.stringify({tools, unavailable, unknown, fileProtection}), 'utf8');
    } catch { await writeFile(REPORT, JSON.stringify({fixtureError: true}), 'utf8'); }
  })(); });
}
""".replace("BLOCKED", json.dumps(BLOCKED_TOOLS)).replace("READONLY", "true" if readonly else "false").replace("REPORT", json.dumps(str(report))).replace("TESTFILE", json.dumps(str(test_file)))


def validate_report(report: dict) -> None:
    if any(type(report.get(name)) is not int or report[name] != 0 for name in ("providerRequests", "modelRuns")):
        raise ValueError("Verification must make zero provider requests and model runs")
    readonly = report.get("readOnly", {})
    writable = report.get("workspaceWrite", {})
    if readonly.get("freshHome") is not True or readonly.get("homeRemoved") is not True:
        raise ValueError("Read-only runtime must own and remove its fresh home")
    if writable.get("originalHome") is not True:
        raise ValueError("Write-mode control must retain its selected home")
    if readonly.get("sentinelsStarted") is not False or writable.get("sentinelsStarted") is not True:
        raise ValueError("Inherited plugin control failed")
    for mode in (readonly, writable):
        if not isinstance(mode.get("tools"), list) or not all(isinstance(name, str) for name in mode["tools"]):
            raise ValueError("Missing tool inventory")
    if any(name in readonly["tools"] for name in (*BLOCKED_TOOLS, *SENTINELS)):
        raise ValueError("Read-only runtime exposed a blocked or inherited tool")
    if not all(name in writable["tools"] for name in SENTINELS):
        raise ValueError("Write-mode control did not register inherited tools")
    if not all(name in writable["tools"] for name in BLOCKED_TOOLS):
        raise ValueError("Write-mode control did not expose the expected built-in tools")
    if readonly.get("unknownTools") != {name: True for name in BLOCKED_TOOLS}:
        raise ValueError("Blocked tool execution did not return UNKNOWN_TOOL")
    protection = readonly.get("fileProtection", {})
    if protection != {"idleAgent": True, "readSucceeded": True, "writeDenied": True,
                      "editDenied": True, "contentsRetained": True}:
        raise ValueError("Scoped read/write/edit file protection did not pass")


def verify(options, bridge=None, harness_class=None):
    bridge = bridge or load_bridge()
    if harness_class is None:
        from deepseek_harness import DeepSeekHarness
        harness_class = DeepSeekHarness
    parent = options.temp_parent
    root = Path(tempfile.mkdtemp(prefix=PREFIX, dir=parent))
    nonce = uuid.uuid4().hex
    (root / ".relay-fixture-owner").write_text(nonce, encoding="ascii")
    try:
        workspace = root / "workspace"
        home = root / "synthetic-old-home"
        profile = home / "profiles" / "sdk"
        workspace.mkdir()
        test_file = workspace / "baseline.txt"
        test_file.write_text("fixture-original", encoding="utf-8")
        profile.mkdir(parents=True)
        manifest = {"name": "relay-synthetic-sdk-profile", "private": True,
                    "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
                                            "patchReload": "startup"}}}
        (profile / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
        markers = [root / f"sentinel-{index}.started" for index in range(2)]
        for index, patch_path in enumerate((home / "cordis.patch.yml", profile / "cordis.patch.yml")):
            plugin = root / f"sentinel-{index}.mjs"
            plugin.write_text(sentinel_source(markers[index], SENTINELS[index]), encoding="utf-8")
            # JSON is a valid YAML patch list and avoids shell/YAML quoting.
            patch_path.write_text(json.dumps([{"insert": [{"id": f"fixture-sentinel-{index}", "name": plugin.as_uri()}]}]), encoding="utf-8")
        results = {}
        with deny_inference() as (base_url, requests), isolated_environment(root, base_url):
            for mode in ("read-only", "workspace-write"):
                readonly = mode == "read-only"
                key = "readOnly" if readonly else "workspaceWrite"
                with bridge.execution_home(home, mode) as selected_home:
                    selected_home = Path(selected_home)
                    if readonly and (selected_home == home or selected_home.parent != home):
                        raise ValueError("Read-only home selection failed")
                    report_path = root / f"{key}.json"
                    diagnostic = root / f"{key}.mjs"
                    diagnostic.write_text(diagnostic_source(report_path, readonly, test_file), encoding="utf-8")
                    policy = root / f"{key}.patch.yml"
                    policy.write_text(bridge.permission_patch(mode), encoding="utf-8")
                    diagnostic_patch = root / f"{key}.diagnostic.patch.yml"
                    diagnostic_patch.write_text(json.dumps([{"insert": [{"id": "fixture-diagnostic", "name": diagnostic.as_uri()}]}]), encoding="utf-8")
                    harness = harness_class(dsh_bin=str(options.bin), cwd=str(workspace), runtime_cwd=str(workspace),
                        dsh_home=str(selected_home), profile="sdk", provider="deepseek-official", model="deepseek-flash",
                        patches=(str(policy), str(diagnostic_patch)), initialize_timeout_seconds=options.timeout_seconds,
                        request_timeout_seconds=options.timeout_seconds, shutdown_timeout_seconds=2,
                        env={"DSH_PERMISSION_MODE": mode, "DSH_MAX_TOKENS_AS_SUCCESS": "false"})
                    try:
                        harness.start()  # Initialize only. No agent/session prompt.
                        deadline = time.monotonic() + options.timeout_seconds
                        while not report_path.is_file():
                            if time.monotonic() >= deadline:
                                raise TimeoutError("Fixture tool inventory did not finish")
                            time.sleep(0.025)
                        inventory = json.loads(report_path.read_text(encoding="utf-8"))
                        if inventory.get("fixtureError"):
                            raise RuntimeError("Fixture tool diagnostics failed")
                        started = [p.is_file() for p in markers]
                        results[key] = {"tools": inventory["tools"],
                                        "sentinelsStarted": any(started) if readonly else all(started)}
                        if readonly:
                            results[key].update(freshHome=True, unknownTools=inventory["unknown"],
                                                fileProtection=inventory.get("fileProtection"))
                        else:
                            results[key]["originalHome"] = selected_home == home
                    finally:
                        harness.close()
                if readonly:
                    results[key]["homeRemoved"] = not selected_home.exists()
            results.update(version=1, providerRequests=len(requests), modelRuns=0)
        validate_report(results)
        return results
    finally:
        remove_owned_root(root, parent, nonce)


def main(argv=None):
    options = parse_cli(argv)
    try:
        report = verify(options)
    except Exception as exc:
        # SDK exceptions can include environment, private paths or stderr.
        # Report only a stable failure category, never the exception text.
        print(json.dumps({"ok": False, "errorType": type(exc).__name__}))
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
