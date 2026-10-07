# PCL 百宝箱下载助手

将 Edge 中符合条件的普通 HTTP/HTTPS 下载交给本机 PCL 百宝箱，使用 PCL 的下载引擎，并沿用百宝箱当前的“保存到”目录。

**当前版本：0.1.2（非官方实验版）。** 项目包含 Edge 扩展和 Windows 本机连接程序源码；需要单独安装 PCL。

## 功能

- 自动判断下载是否适合交接；需要 Cookie、Authorization 或 POST 的任务留在 Edge。
- 暂停原下载，自动打开 PCL 并填写下载表单；日志确认建立任务后，再取消 Edge 原任务。
- 每次交接读取 PCL 的保存目录，避免写入固定下载路径。
- 为同名文件选择新文件名，并为交接失败或结果不确定的任务保留恢复入口。
- 支持右键发送公开文件直链、设置文件大小门槛和排除网站。
- 跟踪最终下载链接与文件信息的后续变化，显示未接管原因。
- 在弹窗中查看、复制最近 Edge 下载的最终链接，或确认公开直链后手动交接正在下载的文件。

## 安装

环境：Windows 10/11 64 位、.NET Framework 4.8、Windows PowerShell 5.1、Microsoft Edge，以及已安装的 PCL。

1. 在仓库页面选择 **Code → Download ZIP**，完整解压。
2. 双击 **Install.cmd**，选择本机的 `Plain Craft Launcher 2.exe`。
3. 打开 `edge://extensions`，启用开发人员模式，点击“加载解压缩的扩展”。
4. 选择 `%LOCALAPPDATA%\PclEdgeBridge\extension`。
5. 在扩展弹窗中点击“检测百宝箱并启用接管”，核对保存目录，并用小文件试下载。

安装时自动编译本机连接程序，普通使用不需要安装 Node.js、Python 或 AutoHotkey。PCL 和 Edge 请使用普通权限运行；交接时请暂时不要操作 PCL 或切换窗口。

已安装旧版时：关闭自动接管，运行本版本的 **Update.cmd**，在 Edge 扩展管理页重新加载，再检测百宝箱。

安装或更新成功后，可以清理下载的 ZIP 和解压安装包；请保留 `%LOCALAPPDATA%\PclEdgeBridge` 以及 PCL 主程序所在目录。

如果 Edge 已开始下载但 PCL 没有打开，请打开扩展中的“最近 Edge 下载”。这里会显示最终链接及未接管原因；可以点击“复制链接”，或在确认无需登录的情况下点击“尝试用 PCL 接管”。已完成的下载只提供复制入口，避免重复下载。

## 文档与开发

- [完整中文说明与故障处理](README-zh-CN.md)
- [更新记录](CHANGELOG.md)
- [验证范围与已知限制](VALIDATION.md)
- [许可证](LICENSE.txt)

| 路径 | 用途 |
| --- | --- |
| `extension/` | Edge Manifest V3 扩展 |
| `native/Bridge.cs` | C# 本机通信与 PCL 界面操作 |
| `Install.cmd` / `Install.ps1` | 安装入口与编译脚本 |
| `Update.cmd` | 更新现有安装 |
| `Uninstall.cmd` / `Uninstall.ps1` | 卸载连接程序 |
| `tests/` | 扩展交接逻辑测试 |
| `SHA256SUMS.txt` | 仓库文件校验值 |

开发测试需要 Node.js。在项目根目录运行：

```sh
node --test tests/*.test.mjs
```

现有 31 项测试已通过；它们使用模拟的浏览器接口，不能替代 Windows 实机验证。安装脚本另会执行本机连接程序的基础自检。

## 限制

这是通过 Windows UI Automation 操作 PCL 下载表单的非官方适配，PCL 更新可能影响兼容性。适配样本内部版本为 **2.13.0.1**，具体信息见完整说明。

PCL 不继承 Edge 的登录信息、请求正文、Referer 或代理配置。部分防盗链或临时链接仍可能下载失败。速度取决于服务器与网络；任务建立成功也不代表文件下载完成。

项目按 MIT 许可证提供，仅涵盖本仓库的连接程序和扩展；不包含 PCL 主程序，与 PCL 或 Microsoft 官方无隶属关系。
