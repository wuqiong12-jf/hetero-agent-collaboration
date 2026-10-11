# Windows 命令通路修复 · 2026-10-11

版本：0.6.2。本轮恢复已有 SDK 的 Windows 受限命令执行，保留简单双栏界面与原生功能；没有开始用户任务或调用业务模型。

## 修复结果

原始 `0.1.5rc1` wheel 和凭证保留。以官方 `dsh-v0.1.5-rc.1`、提交 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` 为基线，回移 Windows ACL runner 的 bootstrap 分派，再生成独立的本地修复 EXE。软件通过 SDK 公开 `dsh_bin` 选择它，探针与执行共享同一选择；配置错误、无法读取或 SDK 不支持时拒绝，不回退其它载体。

运行时继续使用完整 `profile="sdk"`、read-only/workspace-write 和 `approval=never`。没有改用 sdk-minimal，也没有给 helper 添加第二次普通 SDK CLI 启动来掩盖入口问题。原坏指纹保护仍在；只读检测将新指纹保留为 unverified，独立功能验证与静态检测明确区分。

## 构建可复现性

原上游 legacy + hoisted deploy 在 pnpm 11.7 中明确关闭锁文件使用，会重新解析版本。本轮改为共享原锁的投影与冻结离线部署，外部依赖版本及 integrity 全部来自原锁。原锁 SHA256 为 `a6515566578a26c29b5faddaf94abb5ec452ce6e533f8957e813328ebd4b3c27`；核对 1543 条 registry 元数据，无差异。投影另含 workspace 元数据，实际部署为 511 个包。

保留原 pkg 和 node-pty 补丁、koffi 3.1.1，以及 Windows ConPTY 的两个原生文件。共享锁改变 workspace postinstall 的 file URI 身份，准备工具先核对 Git 提交、锁、脚本和包声明哈希，再仅映射同一已审阅脚本的精确身份，没有开放全部构建脚本。

打包使用同一 patched pkg 6.21.0 和 SEA，基础 Node 为官方校验后的 24.21.0。主 EXE SHA256 为 `9eac9670e1a8ad83328f2604641b28901c76edabe69f80c5893e62d1ab78e88f`；搜索 sidecar 为 `f9dde63498b3193f098355dbec97af99dc4f6b8fa0df5ed04114a03012c042cb`。它们是本地构建产物，不冒称官方新发布的修复 wheel。

构建使用短英文目录及缓存。pnpm 的两份大包下载失败后，经其它下载方式取得，SHA512 与原锁一致，导入缓存再完成离线安装。最终 SEA 获取基础 Node 时使用现有代理与正常审批；原依赖闭包未重新解析。Windows 路径兼容处理不移动原项目或覆盖原 SDK。

## 验证证据

- 最终完整回归 **267 项通过、0 失败、0 跳过**；前端及原生插件打包成功。
- 官方构建、原生 PTY、依赖闭包三组专项 **17 项通过**。初次使用带空格的系统 Node 路径时有两项原测试的日志引号断言失败；使用本机已有的无空格 Node 24.19 路径运行原测试后通过，未修改断言。
- 物理 Node ACL 后端 **28 项通过**；最终 EXE 及安装副本各有 **28 项真实检查通过**，包括精确入口、输出和退出码、工作目录与私有 TEMP 写成功、越界写拒绝，以及切回只读后的拒绝与原文件保留。
- 首轮 PowerShell 探针暴露只读 ConstrainedLanguage 下不允许类型构造；探针改用标准 cmdlet，并抑制首次模块 progress。权限与 token 未减弱。
- 验证工具流式读取 SEA 清单以发现准确虚拟入口，拒绝模糊或非法值；入口失败即停止。显式 runner 和 Node 对照保留，API Key、DSH selector 与 NODE_OPTIONS 不继承，超时等待进程清理，未确认结束时拒绝删除临时根。
- 现有官方 Python SDK 0.1.5rc1 使用安装副本，在 read-only/workspace-write 两种原策略下初始化成功；合成凭据、本机拒绝推理服务，HTTP 请求 **0**、模型 run **0**。没有验证付费业务任务的完整效果。
- 安装副本与候选文件哈希相同，主 EXE 和 sidecar 相邻保留。设置只添加 RELAY_HARNESS_BIN，原解释器、模型配置与 DPAPI 凭证保持。

## 实际后台与边界

插件安装及 UI 缓存版本为 0.6.2，新 MCP 控制连接 connected，保留七个工具与两个原生资源入口及旧 URI 别名。实际后台安全重载为 0.6.2，仍为 live/paused，原有四项任务保留；目标、任务书、团队、消息、会话、归档、设置和用量逐项哈希比较一致。持久化一致，执行与清理均为 0。只读能力返回 Codex 和 Harness available=true，Harness 来源 override、指纹状态 unverified。

用户任务没有自动恢复，也没有因验证产生付费模型调用。命令、初始化和静态自检分别证明各自层次；它们不等于所有工具的安全认证、真实模型任务验收或跨平台兼容性保证。原生客户端的当前面板缓存仍需按宿主方式手动刷新；本轮未自动操作 ChatGPT 桌面应用自身 UI。

密钥、会话、生产快照、日志、构建目录、SDK 与修复 EXE 均不上传。重建步骤见[Windows 说明](../HARNESS_WINDOWS.md)。提交与上传结果以 Git 记录为准。
