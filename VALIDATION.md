# 验证记录

日期：2026-10-08。版本：0.2.0。

## 已验证

- 扩展不再引用 PCL 本机主机、UI Automation、PCL 路径或日志。
- 本机源码独立实现 URL 校验、文件名处理、HTTP Range 探测、1 至 8 路分段、重试、合并、任务状态与取消标记。
- 安装脚本只在新版成功安装后清理旧注册项和 `%LOCALAPPDATA%\PclEdgeBridge`，明确保留 PCL 主程序与下载文件。
- `node --test tests/*.test.mjs`：32 项通过，0 失败，包括独立任务完成状态轮询。
- JavaScript 模块语法检查及 Manifest JSON 解析通过。
- 使用 .NET 8 SDK 和 `Microsoft.NETFramework.ReferenceAssemblies` 对 `DownloaderHost.cs` 进行 `net48` 编译：0 警告、0 错误。

## 尚需 Windows 实机验证

- 使用 Windows 自带的 .NET Framework 4.8 编译器构建，并运行安装后的 `--self-test`。
- Edge Native Messaging 注册、任务子进程在 Edge 关闭后的存活行为、状态轮询和取消。
- 支持 Range 与不支持 Range 的真实服务器、大文件、重定向、断网、磁盘空间不足和同名文件。

在这些 Windows 检查完成前，0.2.0 应视为开发版本。
