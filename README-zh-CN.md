# Edge 独立多线程下载助手 0.3.0

将 Edge 中符合条件的公开直链交给本机下载器，通过 HTTP Range 分段下载并自动合并文件。项目完全独立运行，无需安装或启动 PCL，也不包含 PCL 源码或二进制文件。

[下载 v0.3.0](https://github.com/huoxushixiaoji-svg/-pcl-edge-/archive/refs/tags/v0.3.0.zip)

扩展先检查下载方式、最终链接、浏览器风险状态和敏感请求头；符合条件时暂停 Edge 任务。本机程序确认独立任务已经创建后，扩展才取消 Edge 原任务。服务器支持 HTTP Range 时最多使用 8 个分段，不支持时自动退回单连接下载。

## 安装

需要 Windows 10/11 64 位、.NET Framework 4.8、Windows PowerShell 5.1 和 Microsoft Edge。

1. 完整解压本项目，双击 `Install.cmd`。
2. 选择独立下载器的保存目录。
3. 打开 `edge://extensions`，开启开发人员模式，点击“加载解压缩的扩展”。
4. 选择 `%LOCALAPPDATA%\EdgeMultiDownload\extension`。
5. 打开扩展，进入右上角 `⋯ → 设置`，点击“检测本机下载器并启用接管”。

旧版用户先等待已有任务完成或取消，运行 `Update.cmd`，然后在 `edge://extensions` 点击现有扩展的“重新加载”，保留设置与下载历史。仅旧的 0.1.x 扩展路径已经失效时，需要删除旧扩展并从 `%LOCALAPPDATA%\EdgeMultiDownload\extension` 重新加载。必须同时更新本机下载器与扩展，才支持 0.3.0 的任务控制。新版安装成功后会清理旧桥接组件，但不会删除 PCL 主程序或已完成的下载文件。

## 界面与任务管理

- 主界面只显示当前任务；右上角 `⋯` 中进入“设置”或“下载历史”，点击“返回下载”回到任务列表。
- 每个独立任务显示进度条、已下载大小、总大小与速度。大小未知时进度条不显示百分比，完成后显示实际大小。
- “暂停”保留当前分段和连接，“继续”在本机工作进程仍存活时从当前进度接着下载。暂停期间不增加已下载字节；不提供重启 Windows 后的断点续传。
- “取消”停止网络读取并删除临时分段和未完成的输出；已完成文件保留。
- 下载开始时自动弹出靠近 Edge 右上角的小窗，多个任务共用一个窗口；点击 `×` 可关闭，下载继续在本机进行。新的任务会再次弹出提示。
- 提示窗使用扩展界面，不属于 Edge 内置下载面板。在设置中取消勾选“下载开始时弹出进度提示”并保存，可关闭后续自动弹窗。
- 面板或提示窗打开时约每秒刷新；窗口关闭时后台定期查询任务完成状态。

## 接管范围

- 自动接管只接受已观察到成功响应、没有 Cookie/Authorization、使用 GET 的公开 HTTP/HTTPS 下载。
- POST、登录下载、网盘、网页导出、`blob:`、`data:`、无痕任务和 Edge 标记为可疑的任务继续由 Edge 处理。
- 右键菜单和二级菜单“下载历史 → 最近 Edge 下载”允许手动发送确认过的公开直链。
- 本机下载器不继承 Edge 的 Cookie、请求正文、Referer、客户端证书或浏览器代理设置。
- 临时链接过期、磁盘空间不足或服务器中途拒绝请求仍可能导致失败；扩展会轮询任务状态并显示结果。

## 文件与开发

- `extension/`：Edge Manifest V3 扩展。
- `native/DownloaderHost.cs`：独立本机下载器、Native Messaging 主机和分段合并逻辑。
- `Install.*`、`Update.cmd`、`Uninstall.*`：安装、迁移和卸载入口。
- `tests/`：扩展决策、任务控制、浏览器界面和真实下载引擎集成测试。

开发测试：`node --test tests/*.test.mjs`。安装时会使用 .NET Framework 4.8 自带编译器构建本机程序并运行 `--self-test`。

下载引擎集成测试：`dotnet run --project tests/native/NativeTests.csproj`，需要 .NET 8，测试适配器只在测试中使用。浏览器检查需安装 `playwright-core`，运行 `node tests/ui.mjs`，可用 `EDGE_CHROMIUM` 指定浏览器路径。

Linux 云环境已验证 .NET Framework 4.8 源码编译、真实 HTTP 下载引擎及 Chromium 界面。Windows 安装、Edge Native Messaging、右上角提示窗位置与关闭浏览器后的任务存活仍需在 Windows 实机确认。
