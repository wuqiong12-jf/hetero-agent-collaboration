# Windows Harness 修复运行时

返回 [项目首页](../README.md)或[技术说明](TECHNICAL_NOTES.md)。

本页面向需要重建运行时的开发者。普通使用者可使用已经配置好的本地载体；仓库不包含大型 EXE、作者的运行目录或模型凭证。

## 为什么需要独立载体

已确认的一份官方 Python runtime `0.1.5rc1` Windows EXE 缺少 ACL 沙箱子进程的 bootstrap 分派。主进程已经收到 `--profile sdk`，但受限命令启动时再次进入普通 CLI，报缺少 profile。按已知文件指纹重装同一份 wheel 不能修复这个入口。

软件继续阻挡已证实的坏指纹。v0.6.2 增加 `RELAY_HARNESS_BIN`，通过官方 SDK 的公开 `dsh_bin` 参数选择独立可执行文件；探针和执行使用同一选定路径，无效路径或旧 SDK 不支持覆盖时直接拒绝，不回退到另一份载体。默认未配置该字段时仍使用原 bundled resolver。

覆盖只能是单行绝对文件路径，Windows 仅接受 `.exe`，不能填写命令、脚本或额外参数。它不会改变 `profile="sdk"`、只读／工作目录写入策略或 `approval=never`。设置中的重新检测只读文件；变更后台环境或本地配置后需要重启后台。

检查仍将新载体标为 `unverified`，因为文件存在或未知哈希不是工具功能验证。`runtimeSource` 区分 bundled/override，不向前端输出路径；override 的 `bundledRuntimeVersion` 只表示环境内原 wheel 的版本，不代表选定 EXE 已通过版本兼容核验。

## 从匹配源码重建

本补丁基于官方 tag `dsh-v0.1.5-rc.1`，提交 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。运行时入口修复参考官方后续提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` 的相应分支；同时将打包脚本的 legacy deploy 改为 pnpm 11.7 的共享锁投影和冻结离线部署，保留原锁中的外部依赖版本与完整性。产物属于本地修复构建，不能称作新下载的官方修复 wheel。

需要 Windows x64、Node.js 24、Git，以及源码指定的 pnpm 11.7.0。建议把独立构建放在短英文路径，临时目录和缓存也使用英文路径。下列目录仅是示例，请选择新的专用目录：

```powershell
git clone --depth 1 --branch dsh-v0.1.5-rc.1 https://github.com/deepseek-ai/deepseek-harness.git D:\build\harness-acl
Set-Location D:\build\harness-acl
git rev-parse HEAD
git apply C:\path\to\hetero-agent-collaboration\scripts\harness-windows-acl.patch
New-Item -ItemType Directory -Path .\scratch -Force | Out-Null
$env:TEMP = (Resolve-Path .\scratch).Path
$env:TMP = $env:TEMP
$env:CI = 'true'
npm install --prefix .build-tools --ignore-scripts --no-audit --no-fund pnpm@11.7.0
$env:npm_execpath = (Resolve-Path .build-tools\node_modules\pnpm\bin\pnpm.cjs).Path
node $env:npm_execpath install --frozen-lockfile --store-dir .\store --cache-dir .\cache
$env:pnpm_config_store_dir = (Join-Path (Get-Location) 'store')
$env:pnpm_config_cache_dir = (Join-Path (Get-Location) 'cache')
$env:pnpm_config_verify_deps_before_run = 'false'
node C:\path\to\hetero-agent-collaboration\scripts\prepare-harness-build.mjs (Get-Location).Path
node .\node_modules\tsx\dist\cli.mjs scripts\build-exe-for-python-sdk.ts --targets=node24-win-x64
```

构建器先验证完整依赖闭包，再编译、部署闭包并打包 SEA。不要在未完整构建时使用 `--skip-build`，不要更改原锁文件、删除 ACL 后端、改用 `sdk-minimal` 或放宽权限来解决入口故障。Windows 子步骤需要 `npm_execpath` 指向实际 JS 入口；只发现 `pnpm.cmd` 不够。

pnpm 11.7 的 legacy + hoisted deploy 会禁用锁文件并重新解析范围，即使命令追加 frozen 参数也无效。本补丁选择共享锁路径，投影原版本、patch hashes 和 integrity，再做冻结离线安装；部署失败会停止，不回退到重新解析。`auto-install-peers=true` 匹配原锁设置，由 frozen 约束版本。`allow-unused-patches` 仅容许 dev-only pkg 的未使用声明，实际 patch 应用失败仍会拒绝。

这里的 `pnpm_config_*` 环境字段会传给构建子步骤。pnpm 11.7 不把相应 `npm_config_*` 字段当作配置；用错前缀可能落入另一份缓存。禁用本次 run/exec 的依赖自修复，避免打包时静默重建源目录 `node_modules`；依赖在前一步已按原锁完成验证与安装。

准备工具先核对固定 Git 提交、原锁、已审阅 postinstall 的脚本和包声明哈希，再把该脚本原有的相对 file 身份映射为此目录的精确绝对 file URI。它只补这一项 `allowBuilds`，不开放其它构建脚本；存在相反的决定或任何哈希变化时拒绝。映射信息只保存于自己的构建目录，不写入项目凭证或生产配置。

Windows 产物位于 `dist-exe`：主 EXE 与同名的 `-rg.exe` sidecar。移动产物时保持文件名和相邻位置，不只复制主文件。

## 不调用模型的功能验证

项目提供[Windows 验证工具](../scripts/verify-harness-windows.mjs)。它创建自己拥有的临时根，所有探针文件都在其中，隔离继承环境，不加载 SDK profile、模型凭证或生产任务：

```powershell
node C:\path\to\hetero-agent-collaboration\scripts\verify-harness-windows.mjs --bin D:\build\harness-acl\dist-exe\deepseek-harness-sdk-runtime-win-x64.exe
```

默认先只读、流式检查 EXE 的 SEA 清单，从唯一的实际 bootstrap 虚拟路径计算 runner。打包可能保留更高的父目录，不能硬编码项目名或假定只有 `C:\snapshot\node`。清单缺失、不同有效路径有歧义或路径非法时拒绝；也可用 `--runner` 显式提供准确虚拟路径。错误入口会在第一项检查处停止，不进行后续写入探针。Node 对照必须用 `--node <绝对 node.exe>`、`--runner <物理 runner.js>`。

通过条件包括：

- 无参数时准确返回 runner 的 127 错误与 `missing --workspace` 签名。
- 只读子命令的输出与退出码 17 均正确传回。
- 工作目录写入和私有临时目录写入成功，越界测试文件写入被拒绝，外部基准文件仍可读取。
- 切回只读后，工作目录、临时目录和外部测试文件的写入都被拒绝，先前写入的文件仍保留。
- 宿主检查文件状态和内容，核对输出证明；子进程结束、清理成功，整体 `ok=true`。

任何入口、行为、超时、清理失败都会使报告失败。报告只包含固定测试内容、哈希及检查结果，不回显用户目录或原始 stderr。未确认结束的子进程会阻止删除其临时根。这验证当前载体和本机 ACL 行为，不等同于所有工具的安全认证或真实模型任务的验收。

只读 token 下，PowerShell 会进入 `ConstrainedLanguage`。探针使用该模式允许的文件操作 cmdlet，不靠放开类型构造或改变执行策略来通过测试。

## 启用已验证的载体

保留当前 Python SDK 0.1.5rc1 和原 wheel，不覆盖其文件。先在空闲状态暂停协作，确认没有读、写或待清理执行，再设置：

```powershell
$env:RELAY_HARNESS_BIN = 'D:\runtime\deepseek-harness-sdk-runtime-win-x64.exe'
npm start
```

需要跨启动保存时，将绝对路径写入项目忽略的 `.relay/local-config.json` 的 `RELAY_HARNESS_BIN` 字段，保留原有字段和凭证。现有环境变量优先；显式空值也会被拒绝，而不是作为默认回退。

重启后台后查看重新检测结果。检测和初始化本身不代表任务已开始或模型连接已验证；保留已有暂停状态，由原有任务入口继续。需要回到 bundled 载体时删除环境和本地配置中的覆盖字段；若原载体仍是已知坏指纹，软件会继续阻挡它。

源码依据：[官方 0.1.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)、[旧 bootstrap](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/python/sdk-runtime/runtime-bootstrap.mjs)、[后续 bootstrap 修复](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/python/sdk-runtime/runtime-bootstrap.mjs)、[官方 Python SDK](https://pypi.org/project/deepseek-harness-sdk/0.1.5rc1/)。
