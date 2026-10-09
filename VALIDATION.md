# 验证记录

日期：2026-10-09。版本：0.3.0。

## 已验证

- 扩展不再引用 PCL 本机主机、UI Automation、PCL 路径或日志。
- 本机源码独立实现 URL 校验、文件名处理、HTTP Range 探测、1 至 8 路分段、重试、合并、真实字节进度、速度和逐个任务的暂停/继续/取消。
- 安装脚本只在新版成功安装后清理旧注册项和 `%LOCALAPPDATA%\PclEdgeBridge`，明确保留 PCL 主程序与下载文件。
- `node --test tests/*.test.mjs`：42 项通过，0 失败，包括真实进度响应、暂停/继续/取消确认、重复指令拦截、旧状态覆盖保护、多任务共用提示窗及关闭后重开、恢复 Edge 前确认取消、手动任务恢复暂停状态。
- `dotnet run --project tests/native/NativeTests.csproj`：使用相同的下载器源码，在 Linux .NET 8 下对本地限速 HTTP 服务运行集成测试。验证 8 MB 文件的分段暂停/继续及另一任务继续下载、暂停中取消、单连接取消、网络读取阻塞时取消、单连接与未知大小下载、分段中断重试、错误 Content-Range 拒绝。所有成功下载均逐字节核对，取消和完成后检查临时文件清理。
- `node tests/ui.mjs`：Chromium headless 实际渲染 HTML/CSS/模块，以模拟扩展 API 验证二级菜单、任务按钮、已知/未知进度、编辑设置时不被轮询覆盖、展开的历史链接不被重建，以及提示窗 `×` 关闭不触发取消。
- JavaScript 模块语法检查及 Manifest JSON 解析通过。
- 使用 .NET 8 SDK 和 `Microsoft.NETFramework.ReferenceAssemblies` 对最终 `DownloaderHost.cs` 进行 C# 5 / `net48` 编译：0 警告、0 错误。测试使用的 JSON 适配器不参与生产编译。

## 尚需 Windows 实机验证

- 使用 Windows 自带的 .NET Framework 4.8 编译器构建，并运行安装后的 `--self-test`。
- Edge Native Messaging 注册、任务子进程在 Edge 关闭后的存活行为、提示窗位置与显示、暂停/继续/取消的完整通信链路。
- 支持 Range 与不支持 Range 的真实服务器、大文件、重定向、断网、磁盘空间不足和同名文件。

在这些 Windows 检查完成前，0.3.0 应视为开发版本。暂停保留正在运行的任务，不提供重启 Windows 后的断点续传。
