$ErrorActionPreference = 'Stop'
try {
    $destination = Join-Path $env:LOCALAPPDATA 'PclEdgeBridge'
    $subKey = 'Software\Microsoft\Edge\NativeMessagingHosts\com.local.pcl_download_bridge'
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($subKey,$false)
    foreach ($name in @('extension','reservations')) {
        $path = Join-Path $destination $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    foreach ($name in @('Bridge.exe','Bridge.exe.config','Bridge.new.exe','config.json','com.local.pcl_download_bridge.json')) {
        $path = Join-Path $destination $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Write-Host '本机连接已卸载。请在 edge://extensions 删除“PCL 百宝箱下载助手”。' -ForegroundColor Green
    Write-Host 'PCL 主程序和已经下载的文件均保留。'
    Write-Host ('安装目录中只保留卸载脚本，可手动删除：' + $destination)
} catch {
    Write-Host ('卸载未完成：' + $_.Exception.Message + '。请关闭 Edge 后重试。') -ForegroundColor Red
    exit 1
}
