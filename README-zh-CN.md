# Edge 独立多线程下载助手 0.2.0

将 Edge 中符合条件的公开直链交给本机下载器，通过 HTTP Range 分段下载并自动合并文件。项目完全独立运行，无需安装或启动 PCL，也不包含 PCL 源码或二进制文件。

[下载 v0.2.0](https://github.com/huoxushixiaoji-svg/-pcl-edge-/archive/refs/tags/v0.2.0.zip)

扩展先检查下载方式、最终链接、浏览器风险状态和敏感请求头；符合条件时暂停 Edge 任务。本机程序确认独立任务已经创建后，扩展才取消 Edge 原任务。服务器支持 HTTP Range 时最多使用 8 个分段，不支持时自动退回单连接下载。

## 安装

需要 Windows 10/11 64 位、.NET Framework 4.8、Windows PowerShell 5.1 和 Microsoft Edge。

1. 完整解压本项目，双击 `Install.cmd`。
2. 选择独立下载器的保存目录。
3. 打开 `edge://extensions`，开启开发人员模式，点击“加载解压缩的扩展”。
4. 选择 `%LOCALAPPDATA%\EdgeMultiDownload\extension`。
5. 打开扩展，点击“检测本机下载器并启用接管”。

旧版用户运行 `Update.cmd`，然后在 `edge://extensions` 删除已经失效的旧解压扩展，并从 `%LOCALAPPDATA%\EdgeMultiDownload\extension` 重新加载。新版安装成功后会删除旧的本机通信注册项及 `%LOCALAPPDATA%\PclEdgeBridge` 目录，但不会删除 PCL 主程序或已完成的下载文件。

## 接管范围

- 自动接管只接受已观察到成功响应、没有 Cookie/Authorization、使用 GET 的公开 HTTP/HTTPS 下载。
- POST、登录下载、网盘、网页导出、`blob:`、`data:`、无痕任务和 Edge 标记为可疑的任务继续由 Edge 处理。
- 右键菜单和“最近 Edge 下载”允许手动发送确认过的公开直链。
- 本机下载器不继承 Edge 的 Cookie、请求正文、Referer、客户端证书或浏览器代理设置。
- 临时链接过期、磁盘空间不足或服务器中途拒绝请求仍可能导致失败；扩展会轮询任务状态并显示结果。

## 文件与开发

- `extension/`：Edge Manifest V3 扩展。
- `native/DownloaderHost.cs`：独立本机下载器、Native Messaging 主机和分段合并逻辑。
- `Install.*`、`Update.cmd`、`Uninstall.*`：安装、迁移和卸载入口。
- `tests/`：扩展决策与交接回归测试。

开发测试：`node --test tests/*.test.mjs`。安装时会使用 .NET Framework 4.8 自带编译器构建本机程序并运行 `--self-test`。

当前 Linux 云环境不能完成 Windows 编译、Edge 加载和真实文件端到端下载；这些检查需在 Windows 实机执行。
