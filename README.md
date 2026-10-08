# Edge Independent Multi-part Downloader

An experimental Microsoft Edge extension that hands eligible public HTTP/HTTPS downloads to a local multi-part downloader. It does not require or launch PCL.

The extension observes download metadata, rejects requests that carry cookies or authorization headers, pauses the Edge download, and asks the native host to start an independent task. Edge is canceled only after the host confirms that the task was created. Servers without HTTP Range support automatically use a single connection.

## Install on Windows

Requirements: Windows 10/11 64-bit, .NET Framework 4.8, Windows PowerShell 5.1, and Microsoft Edge.

1. Extract the complete release folder.
2. Run `Install.cmd` and select a download folder.
3. Open `edge://extensions`, enable Developer mode, and choose **Load unpacked**.
4. Select `%LOCALAPPDATA%\EdgeMultiDownload\extension`.
5. Open the extension and select **检测本机下载器并启用接管**.

Existing 0.1.x users should run `Update.cmd`, remove the now-invalid unpacked extension from `edge://extensions`, and load `%LOCALAPPDATA%\EdgeMultiDownload\extension`. The updater removes the former PCL bridge registration and `%LOCALAPPDATA%\PclEdgeBridge` files after the independent downloader is installed successfully. It never removes PCL itself or completed downloads.

## Behavior and limits

- Public HTTP/HTTPS GET downloads can use up to eight segments when the server supports Range requests.
- Cookie, Authorization, POST, `blob:`, `data:`, incognito, suspicious, and browser-generated downloads stay in Edge.
- The native downloader does not receive browser cookies, request bodies, client certificates, Referer, or browser proxy settings.
- A confirmed task can still fail later because a link expires, the server rejects Range requests, storage fills up, or connectivity changes. The extension polls the native task status and reports completion or failure.
- Download tasks and status files are stored under `%LOCALAPPDATA%\EdgeMultiDownload`; completed files are stored in the folder chosen during installation.

Run extension tests from the repository root with `node --test tests/*.test.mjs`. The installer compiles `native/DownloaderHost.cs` with the .NET Framework compiler and runs its built-in self-test.

This project is licensed under MIT and contains no PCL source code or binaries.
