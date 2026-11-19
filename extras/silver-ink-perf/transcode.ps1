param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Width = 1920,
    [int]$Height = 1080,
    [int]$Bitrate = 4000000,
    [int]$FpsNum = 30000,
    [int]$FpsDen = 1001,
    [double]$TrimSeconds = 0
)
# Chuyển mã video bằng Windows.Media.Transcoding (Media Foundation, có tăng tốc phần cứng).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$asTaskProg = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
    $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    return $t.Result
}

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
[void][Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]

$outDir = Split-Path -Parent $Out
$outName = Split-Path -Leaf $Out
$src = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($In)) ([Windows.Storage.StorageFile])
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])
$dst = Await ($folder.CreateFileAsync($outName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD1080p)
$profile.Video.Width = $Width
$profile.Video.Height = $Height
$profile.Video.Bitrate = $Bitrate
$profile.Video.FrameRate.Numerator = $FpsNum
$profile.Video.FrameRate.Denominator = $FpsDen
$profile.Audio = $null

$tc = New-Object Windows.Media.Transcoding.MediaTranscoder
$tc.HardwareAccelerationEnabled = $true
$tc.AlwaysReencode = $true
if ($TrimSeconds -gt 0) {
    # chỉ dùng khi thử: cắt bớt phần cuối, giữ $TrimSeconds giây đầu
    $props = Await ($src.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
    $total = $props.Duration.TotalSeconds
    $tc.TrimStopTime = [TimeSpan]::FromSeconds([Math]::Max(0, $total - $TrimSeconds))
}

$prep = Await ($tc.PrepareFileTranscodeAsync($src, $dst, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if (-not $prep.CanTranscode) { throw "Cannot transcode: $($prep.FailureReason)" }
$sw = [Diagnostics.Stopwatch]::StartNew()
$task = $asTaskProg.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
$task.Wait(-1) | Out-Null
$sw.Stop()
$mb = [Math]::Round((Get-Item -LiteralPath $Out).Length / 1MB, 2)
"OK $outName  $mb MB  in $([Math]::Round($sw.Elapsed.TotalSeconds, 1))s"
