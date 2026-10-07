param([string]$PclPath, [switch]$Update)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    if (-not [Environment]::Is64BitOperatingSystem) { throw '此工具面向 Windows 10/11 64 位系统。' }
    $release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction Stop).Release
    if ($release -lt 528040) { throw '需要 .NET Framework 4.8。请先安装或更新该组件。' }
    $destination = Join-Path $env:LOCALAPPDATA 'PclEdgeBridge'
    $extension = Join-Path $destination 'extension'
    $hostName = 'com.local.pcl_download_bridge'
    $extensionId = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension-id.txt') -Raw).Trim()
    if ($extensionId -notmatch '^[a-p]{32}$') { throw '扩展 ID 文件损坏。' }
    if ($Update) {
        $existingConfig = Join-Path $destination 'config.json'
        if (-not (Test-Path -LiteralPath $existingConfig)) { throw '未找到已有安装，请先运行 Install.cmd。' }
        $installed = Get-Content -LiteralPath $existingConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($installed.extensionId -ne $extensionId) { throw '已有安装的扩展 ID 不匹配，请先检查安装目录。' }
        $PclPath = $installed.pclPath
        Write-Host '正在更新现有安装，沿用已经选择的 PCL 主程序。'
    }
    if (-not $PclPath) {
        $picker = New-Object System.Windows.Forms.OpenFileDialog
        $picker.Title = '选择你平常使用的 Plain Craft Launcher 2.exe'
        $picker.Filter = 'PCL 主程序 (*.exe)|*.exe'
        $picker.CheckFileExists = $true
        if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '已取消选择 PCL，未安装。' }
        $PclPath = $picker.FileName
    }
    $PclPath = [IO.Path]::GetFullPath($PclPath)
    if (-not [IO.File]::Exists($PclPath) -or [IO.Path]::GetExtension($PclPath) -ine '.exe') { throw '请选择实际的 PCL EXE 主程序。' }
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($PclPath)
    $version = $versionInfo.FileVersion
    Write-Host ('PCL 路径：' + $PclPath)
    Write-Host ('文件版本：' + $version)
    if ($version -notlike '2.13.0.1*') { Write-Host '此版本未做静态适配确认；安装后请先运行扩展里的百宝箱检测。' -ForegroundColor Yellow }
    if ($PclPath.StartsWith($destination, [StringComparison]::OrdinalIgnoreCase)) { throw '请把 PCL 主程序放在独立的固定文件夹。' }
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    $compilerRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $compiler = Join-Path $compilerRoot 'csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw '找不到 Windows 自带的 C# 编译器，需修复 .NET Framework 4.8。' }
    $built = Join-Path $destination 'Bridge.new.exe'
    if (Test-Path -LiteralPath $built) { Remove-Item -LiteralPath $built -Force }
    $compilerArgs = @('/nologo','/codepage:65001','/target:winexe','/platform:anycpu','/optimize+',('/out:' + $built),('/win32manifest:' + (Join-Path $PSScriptRoot 'native\Bridge.manifest')), '/reference:System.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll')
    foreach ($dll in @('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll')) {
        $assemblyPath = Join-Path $compilerRoot ('WPF\' + $dll)
        if (-not (Test-Path -LiteralPath $assemblyPath)) { throw ('找不到 .NET WPF 组件：' + $assemblyPath) }
        $compilerArgs += '/reference:' + $assemblyPath
    }
    $compilerArgs += Join-Path $PSScriptRoot 'native\Bridge.cs'
    Write-Host '正在编译本机连接程序……'
    & $compiler @compilerArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $built)) { throw '编译失败。请保留上述错误信息。' }
    $check = Start-Process -FilePath $built -ArgumentList '--self-test' -PassThru -Wait
    if ($check.ExitCode -ne 0) { throw ('连接程序自检失败，退出代码：' + $check.ExitCode) }
    $hostExe = Join-Path $destination 'Bridge.exe'
    Move-Item -LiteralPath $built -Destination $hostExe -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native\Bridge.exe.config') -Destination ($hostExe + '.config') -Force
    # The public key in manifest.json keeps the unpacked extension ID stable.
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'extension') -Destination $destination -Recurse -Force
    $utf8 = New-Object Text.UTF8Encoding($false)
    $config = [ordered]@{ pclPath=$PclPath; extensionId=$extensionId; folderSource='pcl' }
    [IO.File]::WriteAllText((Join-Path $destination 'config.json'),($config | ConvertTo-Json),$utf8)
    $manifest = [ordered]@{ name=$hostName; description='PCL toolbox download bridge'; path=$hostExe; type='stdio'; allowed_origins=@('chrome-extension://' + $extensionId + '/') }
    $manifestPath = Join-Path $destination ($hostName + '.json')
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 4),$utf8)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName)
    try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Close() }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall.ps1') -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall.cmd') -Destination $destination -Force
    Write-Host ''
    if ($Update) {
        Write-Host '更新到 0.1.2 成功。接下来：' -ForegroundColor Green
        Write-Host '1. 在 Edge 打开 edge://extensions，点击此扩展的重新加载按钮（圆形箭头）。'
        Write-Host '2. 在 PCL 百宝箱确认“保存到”是你想要的目录。'
        Write-Host '3. 打开扩展弹窗，再点“检测百宝箱并启用接管”。'
    } else {
        Write-Host '安装成功。接下来：' -ForegroundColor Green
        Write-Host '1. 在 Edge 地址栏打开 edge://extensions ，开启开发人员模式。'
        Write-Host '2. 点击“加载解压缩的扩展”，选择下面这个文件夹：'
        Write-Host $extension -ForegroundColor Cyan
        Write-Host '3. 在扩展弹窗点击“检测百宝箱并启用接管”。PCL 打开后暂时不要操作鼠标键盘。'
    }
    Write-Host '下载保存位置：每次读取 PCL 百宝箱当前的“保存到”目录。'
    Write-Host ('扩展 ID 应为：' + $extensionId)
    Write-Host '退出 PCL、首次运行提示、隐藏页面等问题请查看 README-zh-CN.md。'
    if (-not $Update) { Start-Process explorer.exe -ArgumentList ('"' + $destination + '"') }
    exit 0
} catch {
    Write-Host ('安装未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
