# build-local.ps1 — 在本机构建 Weport。
#
# 为什么需要这个包装：本机（以及任何 github.com:443 不可达的网络）上，
# electron-builder 会去 github.com 下载 Electron 压缩包并**超时失败**：
#
#   ⨯ connect ETIMEDOUT 20.205.243.166:443
#
# 设置国内镜像后可以正常完成。这个脚本把镜像环境变量固定下来，避免每次构建
# 都要重新回忆一遍 —— 那是很容易忘、忘了就浪费十分钟的坑。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1              # 默认 build:dir
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1 build        # NSIS 安装包
#   powershell -ExecutionPolicy Bypass -File scripts/build-local.ps1 build:dir
#
# 注意：build:mac / build:linux 需要对应的宿主系统（electron-builder 不做交叉
# 打包），本脚本不做拦截 —— 传进去会得到 electron-builder 自己的报错。

param(
  [string]$Task = 'build:dir',
  [switch]$SkipMirror
)

$ErrorActionPreference = 'Stop'

if (-not $SkipMirror) {
  # 只在未显式设置时覆盖，方便有代理的机器自己指定镜像。
  if (-not $env:ELECTRON_MIRROR) {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
  Write-Output "ELECTRON_MIRROR=$env:ELECTRON_MIRROR"
  Write-Output "ELECTRON_BUILDER_BINARIES_MIRROR=$env:ELECTRON_BUILDER_BINARIES_MIRROR"
}

$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
Push-Location $projectRoot
try {
  Write-Output "构建 $Task ..."
  npm run $Task
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exit -ne 0) {
  Write-Output "构建失败（exit=$exit）。若报错是下载 Electron 超时，先确认上面的镜像变量已生效。"
  exit $exit
}

Write-Output '构建完成。'
Get-ChildItem (Join-Path $projectRoot 'release') -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime |
  Format-Table -AutoSize
