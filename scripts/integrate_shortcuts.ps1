param(
    [switch]$Install,
    [switch]$Restore
)
# Gắn / gỡ Antigravity Launcher vào các shortcut Antigravity sẵn có (Desktop + Start Menu).
# Bản sao lưu shortcut gốc: original_shortcuts_backup.json (ở thư mục gốc repo, không đưa lên git).

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackupPath = Join-Path $ProjectDir "original_shortcuts_backup.json"
$LauncherPy = Join-Path $ProjectDir "launcher.py"

function Find-PythonW {
    $cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        $exe = (& $py.Source -3 -c "import sys; print(sys.executable)" 2>$null)
        if ($exe) {
            $w = Join-Path (Split-Path $exe) "pythonw.exe"
            if (Test-Path $w) { return $w }
        }
    }
    $guess = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\pythonw.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($guess) { return $guess.FullName }
    throw "Không tìm thấy pythonw.exe. Hãy cài Python 3.10+ từ python.org (tick 'Add python.exe to PATH')."
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$StartMenu = [Environment]::GetFolderPath("Programs")
$AgExe = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe"
$IdeExe = "$env:LOCALAPPDATA\Programs\Antigravity IDE\Antigravity IDE.exe"

$ShortcutSpecs = @(
    @{ Path = Join-Path $Desktop "Antigravity.lnk"; Target = "antigravity"; Icon = "$AgExe,0" },
    @{ Path = Join-Path $Desktop "Antigravity IDE.lnk"; Target = "antigravity_ide"; Icon = "$IdeExe,0" },
    @{ Path = Join-Path $StartMenu "Antigravity.lnk"; Target = "antigravity"; Icon = "$AgExe,0" },
    @{ Path = Join-Path $StartMenu "Antigravity\Antigravity.lnk"; Target = "antigravity"; Icon = "$AgExe,0" },
    @{ Path = Join-Path $StartMenu "Antigravity\Antigravity IDE.lnk"; Target = "antigravity_ide"; Icon = "$IdeExe,0" }
)

$sh = New-Object -ComObject WScript.Shell

function Refresh-ShellIcons {
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ShellNotify {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);
}
"@ -ErrorAction SilentlyContinue
        [ShellNotify]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch {}
}

if ($Restore) {
    if (-not (Test-Path $BackupPath)) {
        Write-Host "Không tìm thấy bản sao lưu: $BackupPath" -ForegroundColor Yellow
        exit 1
    }
    $backups = Get-Content $BackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $backups) {
        if (Test-Path $item.Path) {
            $lnk = $sh.CreateShortcut($item.Path)
            $lnk.TargetPath = $item.TargetPath
            $lnk.Arguments = $item.Arguments
            $lnk.WorkingDirectory = $item.WorkingDirectory
            $lnk.IconLocation = $item.IconLocation
            $lnk.Save()
            Write-Host "[KHÔI PHỤC] $($item.Path)" -ForegroundColor Green
        }
    }
    Refresh-ShellIcons
    Write-Host "`nĐã trả các shortcut Antigravity về mặc định." -ForegroundColor Cyan
    exit 0
}

$PythonW = Find-PythonW
$found = @($ShortcutSpecs | Where-Object { Test-Path $_.Path })

# Desktop chưa có shortcut Antigravity → tạo mới
if (-not (Test-Path $ShortcutSpecs[0].Path) -and (Test-Path $AgExe)) {
    $lnk = $sh.CreateShortcut($ShortcutSpecs[0].Path)
    $lnk.TargetPath = $AgExe
    $lnk.Save()
    $found = @($ShortcutSpecs | Where-Object { Test-Path $_.Path })
}
if ($found.Count -eq 0) {
    throw "Không thấy shortcut Antigravity nào và cũng không thấy $AgExe."
}

if (-not (Test-Path $BackupPath)) {
    $backupList = @()
    foreach ($spec in $found) {
        $lnk = $sh.CreateShortcut($spec.Path)
        if ($lnk.Arguments -notlike "*launcher.py*") {
            $backupList += [PSCustomObject]@{
                Path             = $spec.Path
                TargetPath       = $lnk.TargetPath
                Arguments        = $lnk.Arguments
                WorkingDirectory = $lnk.WorkingDirectory
                IconLocation     = $lnk.IconLocation
            }
        }
    }
    if ($backupList.Count -gt 0) {
        $backupList | ConvertTo-Json -Depth 4 | Set-Content -Path $BackupPath -Encoding UTF8
        Write-Host "Đã sao lưu shortcut gốc: $BackupPath" -ForegroundColor Gray
    }
}

foreach ($spec in $found) {
    $lnk = $sh.CreateShortcut($spec.Path)
    $lnk.TargetPath = $PythonW
    $lnk.Arguments = "`"$LauncherPy`" --target $($spec.Target)"
    $lnk.WorkingDirectory = $ProjectDir
    $lnk.IconLocation = $spec.Icon
    $lnk.Save()
    Write-Host "[ĐÃ GẮN] $($spec.Path)  →  $($spec.Target)" -ForegroundColor Green
}

Refresh-ShellIcons
Write-Host "`nXong! Mở Antigravity từ Desktop hoặc Start Menu là intro tự chạy." -ForegroundColor Cyan
