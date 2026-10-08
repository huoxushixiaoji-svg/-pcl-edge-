$ErrorActionPreference = 'Stop'
try {
    $destination = Join-Path $env:LOCALAPPDATA 'EdgeMultiDownload'
    $legacyDestination = Join-Path $env:LOCALAPPDATA 'PclEdgeBridge'
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\Microsoft\Edge\NativeMessagingHosts\com.local.edge_multi_download',$false)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\Microsoft\Edge\NativeMessagingHosts\com.local.pcl_download_bridge',$false)
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    if (Test-Path -LiteralPath $legacyDestination) { Remove-Item -LiteralPath $legacyDestination -Recurse -Force }
    Write-Host '独立下载器及旧 PCL 桥接组件已卸载。请在 edge://extensions 删除扩展。' -ForegroundColor Green
    Write-Host '已完成的下载文件和 PCL 主程序均未删除。'
} catch {
    Write-Host ('卸载未完成：' + $_.Exception.Message + '。请关闭 Edge 后重试。') -ForegroundColor Red
    exit 1
}
