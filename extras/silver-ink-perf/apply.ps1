param(
    [string]$ThemeDir = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity-silver-ink-theme'),
    [switch]$Revert
)
# Tối ưu hiệu năng cho theme Silver Ink (bản Ultra) trên card đồ hoạ tích hợp:
#  - video nền 60fps -> 30fps (Windows Media Foundation, không cần ffmpeg)
#  - core.js đã vá: vẽ mắt theo requestVideoFrameCallback, ghi nhớ kết quả dò chớp mắt,
#    canvas đúng kích thước hiển thị, 15fps khi không focus
# Vá dựa trên commit 3ecd665 của wwm100107-creator/antigravity-silver-ink-theme.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $ThemeDir 'engine\core.js'))) {
    throw "Không thấy theme Silver Ink tại $ThemeDir (dùng -ThemeDir để chỉ đường dẫn khác)."
}
$core = Join-Path $ThemeDir 'engine\core.js'
$coreOrig = Join-Path $ThemeDir 'engine\core.orig.js'
$themes = Join-Path $ThemeDir 'themes\themes.json'
$themesOrig = Join-Path $ThemeDir 'themes\themes.orig.json'
$cfg = Join-Path $ThemeDir 'theme_config.json'

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw 'Cần Python để build lại theme (python.org).' }

if ($Revert) {
    if (Test-Path $coreOrig) { Copy-Item $coreOrig $core -Force }
    if (Test-Path $themesOrig) { Copy-Item $themesOrig $themes -Force }
    & $py (Join-Path $ThemeDir 'scripts\build_payload.py') | Out-Null
    Write-Host 'Đã trả theme về bản gốc.' -ForegroundColor Cyan
    exit 0
}

if (-not (Test-Path $coreOrig)) { Copy-Item $core $coreOrig }
if (-not (Test-Path $themesOrig)) { Copy-Item $themes $themesOrig }

Write-Host '[1/4] Chép core.js đã tối ưu...'
Copy-Item (Join-Path $here 'core.js') $core -Force

Write-Host '[2/4] Chuyển video nền sang 30fps...'
$src = Join-Path $ThemeDir 'themes\assets\ink_starlight_60fps.mp4'
$dst = Join-Path $ThemeDir 'themes\assets\ink_starlight_30fps.mp4'
if (-not (Test-Path $dst)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'transcode.ps1') -In $src -Out $dst -Bitrate 4500000
}

Write-Host '[3/4] Trỏ theme sang video mới, bật bản Ultra...'
$t = Get-Content $themes -Raw -Encoding UTF8
$t = $t.Replace('assets/ink_starlight_60fps.mp4', 'assets/ink_starlight_30fps.mp4')
[IO.File]::WriteAllText($themes, $t, [Text.UTF8Encoding]::new($false))
if (Test-Path $cfg) {
    $c = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
    $c | Add-Member -NotePropertyName performanceMode -NotePropertyValue 'ultra' -Force
    [IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

Write-Host '[4/4] Build lại theme (daemon tự nạp lại)...'
& $py (Join-Path $ThemeDir 'scripts\build_payload.py') --profile ultra | Out-Null
Write-Host 'Xong. Gỡ: apply.ps1 -Revert' -ForegroundColor Cyan
