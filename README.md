# Edge 独立多线程下载助手

将 Microsoft Edge 中符合条件的公开直链交给本机下载器，通过 HTTP Range 分段下载并自动合并文件。项目完全独立运行，**无需安装或启动 PCL**。

[下载 v0.2.0](https://github.com/huoxushixiaoji-svg/-pcl-edge-/archive/refs/tags/v0.2.0.zip) · [完整中文说明](README-zh-CN.md) · [验证记录](VALIDATION.md)

## 主要特点

- 支持公开 HTTP/HTTPS GET 下载，服务器允许 Range 时最多使用 8 个分段。
- 服务器不支持分段时自动退回单连接，不会反复创建任务。
- 本机程序确认任务启动后才取消 Edge 原下载；扩展持续查询完成或失败状态。
- 自动跳过 Cookie、Authorization、POST、登录下载、网页导出、`blob:`、`data:`、无痕及可疑任务。
- 不传递或保存浏览器 Cookie、Authorization 内容、请求正文和客户端证书。
- 使用 Edge Native Messaging 与本机下载器通信，不运行本地 HTTP 服务。
- MIT 许可，不包含 PCL 源码或二进制文件。

## 安装

需要 Windows 10/11 64 位、Microsoft Edge、Windows PowerShell 5.1 和 .NET Framework 4.8。

1. 下载并完整解压 `v0.2.0`。
2. 双击 `Install.cmd`，选择下载保存目录。
3. 打开 `edge://extensions`，启用“开发人员模式”。
4. 点击“加载解压缩的扩展”，选择 `%LOCALAPPDATA%\EdgeMultiDownload\extension`。
5. 打开扩展，点击“检测本机下载器并启用接管”。

从 0.1.x 更新时运行 `Update.cmd`，再删除失效的旧解压扩展，从上述新目录重新加载。更新程序只清理旧桥接组件，不删除 PCL 主程序和已经下载的文件。

## 使用范围

本项目适合无需登录信息的公开文件直链。网盘、登录网站、临时鉴权链接和防盗链资源通常仍应由 Edge 下载。服务器是否支持分段以及实际网络状况会影响速度，无法保证所有文件都能提速。

开发测试：`node --test tests/*.test.mjs`。本机程序源码位于 `native/DownloaderHost.cs`，安装时使用 Windows 自带的 .NET Framework 编译器构建并运行基础自检。

> 当前版本仍需在 Windows 实机完成更多 Edge 与大文件端到端验证，详见 [VALIDATION.md](VALIDATION.md)。
