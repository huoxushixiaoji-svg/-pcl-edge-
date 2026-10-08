param([string]$DownloadFolder, [switch]$Update)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    if (-not [Environment]::Is64BitOperatingSystem) { throw '此工具面向 Windows 10/11 64 位系统。' }
    $release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction Stop).Release
    if ($release -lt 528040) { throw '需要 .NET Framework 4.8。请先安装或更新该组件。' }
    $destination = Join-Path $env:LOCALAPPDATA 'EdgeMultiDownload'
    $legacyDestination = Join-Path $env:LOCALAPPDATA 'PclEdgeBridge'
    $extension = Join-Path $destination 'extension'
    $hostName = 'com.local.edge_multi_download'
    $extensionId = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension-id.txt') -Raw).Trim()
    if ($extensionId -notmatch '^[a-p]{32}$') { throw '扩展 ID 文件损坏。' }
    $existingConfig = Join-Path $destination 'config.json'
    if ($Update -and (Test-Path -LiteralPath $existingConfig)) {
        $installed = Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($installed.extensionId -ne $extensionId) { throw '已有安装的扩展 ID 不匹配。' }
        if (-not $DownloadFolder) { $DownloadFolder = $installed.downloadFolder }
    }
    if (-not $DownloadFolder) {
        $defaultFolder = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\EdgeMultiDownload'
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description = '选择独立下载器的保存目录'
        $picker.SelectedPath = $(if (Test-Path -LiteralPath $defaultFolder) { $defaultFolder } else { [Environment]::GetFolderPath('UserProfile') })
        $picker.ShowNewFolderButton = $true
        if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $DownloadFolder = $picker.SelectedPath }
        elseif ($Update -and (Test-Path -LiteralPath $legacyDestination)) { $DownloadFolder = $defaultFolder }
        else { throw '已取消选择下载目录，未安装。' }
    }
    $DownloadFolder = [IO.Path]::GetFullPath($DownloadFolder)
    [IO.Directory]::CreateDirectory($DownloadFolder) | Out-Null
    $probe = Join-Path $DownloadFolder ('.edge-download-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    $compilerRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $compiler = Join-Path $compilerRoot 'csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw '找不到 Windows 自带的 C# 编译器，需修复 .NET Framework 4.8。' }
    $built = Join-Path $destination 'DownloaderHost.new.exe'
    if (Test-Path -LiteralPath $built) { Remove-Item -LiteralPath $built -Force }
    $compilerArgs = @('/nologo','/codepage:65001','/target:winexe','/platform:anycpu','/optimize+',('/out:' + $built),('/win32manifest:' + (Join-Path $PSScriptRoot 'native\DownloaderHost.manifest')), '/reference:System.dll','/reference:System.Core.dll','/reference:System.Net.Http.dll','/reference:System.Web.Extensions.dll',(Join-Path $PSScriptRoot 'native\DownloaderHost.cs'))
    Write-Host '正在编译独立本机下载器……'
    & $compiler @compilerArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $built)) { throw '编译失败。请保留上述错误信息。' }
    $check = Start-Process -FilePath $built -ArgumentList '--self-test' -PassThru -Wait
    if ($check.ExitCode -ne 0) { throw ('下载器自检失败，退出代码：' + $check.ExitCode) }
    $hostExe = Join-Path $destination 'DownloaderHost.exe'
    Move-Item -LiteralPath $built -Destination $hostExe -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native\DownloaderHost.exe.config') -Destination ($hostExe + '.config') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'extension') -Destination $destination -Recurse -Force
    $utf8 = New-Object Text.UTF8Encoding($false)
    $config = [ordered]@{ extensionId=$extensionId; downloadFolder=$DownloadFolder; connections=8 }
    [IO.File]::WriteAllText((Join-Path $destination 'config.json'),($config | ConvertTo-Json),$utf8)
    $manifest = [ordered]@{ name=$hostName; description='Independent Edge multi-part downloader'; path=$hostExe; type='stdio'; allowed_origins=@('chrome-extension://' + $extensionId + '/') }
    $manifestPath = Join-Path $destination ($hostName + '.json')
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 4),$utf8)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName)
    try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Close() }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall.ps1') -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall.cmd') -Destination $destination -Force
    # Remove only files created by the old bridge installer. PCL itself and downloaded files stay untouched.
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('Software\Microsoft\Edge\NativeMessagingHosts\com.local.pcl_download_bridge',$false)
    if (Test-Path -LiteralPath $legacyDestination) { Remove-Item -LiteralPath $legacyDestination -Recurse -Force }
    Write-Host ''
    Write-Host ($(if ($Update) { '更新成功。' } else { '安装成功。' })) -ForegroundColor Green
    Write-Host ('下载保存位置：' + $DownloadFolder)
    Write-Host '独立下载器默认使用最多 8 个分段，不再需要或启动 PCL。'
    if ($Update) { Write-Host '在 edge://extensions 删除失效的旧版解压扩展，再重新加载下面的新目录：' }
    else { Write-Host '在 edge://extensions 开启开发人员模式，并加载下面的扩展目录：' }
    Write-Host $extension -ForegroundColor Cyan
    Write-Host ('扩展 ID 应为：' + $extensionId)
    if (-not $Update) { Start-Process explorer.exe -ArgumentList ('"' + $destination + '"') }
    exit 0
} catch {
    Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
