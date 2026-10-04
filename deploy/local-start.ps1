# 本机原生部署：PostgreSQL 15（免安装版，路径必须是纯英文）+ NestJS API
#
#   powershell -ExecutionPolicy Bypass -File deploy\local-start.ps1 -Migrate   # 首次：建库+建表+灌内容库+起服务
#   powershell -ExecutionPolicy Bypass -File deploy\local-start.ps1            # 日常：起服务
#   ... -Status / ... -Stop
#
# 为什么装在 D:\cs-training：PostgreSQL 在 Windows 上要求**安装目录与数据目录都是纯英文路径**，
# 放在含中文的目录（例如 D:\codex工作区\...）时 initdb 会报 invalid byte sequence for encoding "UTF8"。
param([switch]$Stop, [switch]$Status, [switch]$Migrate)

$ErrorActionPreference = 'Stop'
$Base        = 'D:\cs-training'
$ProjectRoot = 'D:\codex工作区\在线模拟接待训练系统'
$PgBin       = Join-Path $Base 'pgsql\bin'
$PgData      = Join-Path $Base 'pgdata'
$PgLog       = Join-Path $Base 'pg.log'
$ApiLog      = Join-Path $Base 'api.log'
$ApiErrLog   = Join-Path $Base 'api.err.log'
$SecretFile  = Join-Path $Base 'jwt.secret'
$UploadDir   = Join-Path $Base 'uploads'
$DbUrl       = 'postgres://cs_training:cs_training_pwd@127.0.0.1:5432/cs_training'
$Port        = 3000

function Get-JwtSecret {
  if (Test-Path $SecretFile) { return (Get-Content -LiteralPath $SecretFile -Raw).Trim() }
  $s = & node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  Set-Content -LiteralPath $SecretFile -Value $s.Trim() -NoNewline -Encoding ascii
  return $s.Trim()
}
function Test-PgRunning { & (Join-Path $PgBin 'pg_ctl.exe') status -D $PgData *> $null; return ($LASTEXITCODE -eq 0) }
function Test-ApiRunning { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }
function Use-ApiEnv {
  $env:DATABASE_URL = $DbUrl
  $env:USE_PG_MEM   = 'false'
  $env:PORT         = "$Port"
  $env:JWT_SECRET   = Get-JwtSecret
  $env:UPLOAD_DIR   = $UploadDir
}

if ($Stop) {
  if (Test-ApiRunning) {
    $apiPid = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess | Select-Object -First 1
    Stop-Process -Id $apiPid -Force; Write-Host "已停止 API（PID $apiPid）"
  }
  if (Test-PgRunning) { & (Join-Path $PgBin 'pg_ctl.exe') stop -D $PgData -m fast | Out-Null; Write-Host '已停止 PostgreSQL' }
  exit 0
}

if ($Status) {
  $pgState  = if (Test-PgRunning) { '运行中' } else { '未运行' }
  $apiState = if (Test-ApiRunning) { '运行中' } else { '未运行' }
  Write-Host "PostgreSQL：$pgState；API($Port)：$apiState"
  try { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 5).Content } catch { "健康检查失败：$($_.Exception.Message)" }
  exit 0
}

New-Item -ItemType Directory -Path $UploadDir -Force | Out-Null

if (-not (Test-PgRunning)) {
  # 注意：不要用 `& pg_ctl start | Out-Null` —— pg_ctl 拉起的 postgres 会继承 PowerShell 的输出管道，
  # 管道永远等不到 EOF，脚本会卡死在启动那一步（本机 2026-10-04 实际踩到过）。
  # 改用 Start-Process（独立窗口、不共用管道）并等它返回。
  Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') `
    -ArgumentList 'start', '-D', $PgData, '-l', $PgLog, '-o', '-p 5432' `
    -WindowStyle Hidden -Wait
  Start-Sleep -Seconds 3
  Write-Host 'PostgreSQL 已启动'
} else { Write-Host 'PostgreSQL 已在运行' }

$psql = Join-Path $PgBin 'psql.exe'
if ($Migrate) {
  $roleExists = (& $psql -U postgres -p 5432 -tAc "SELECT 1 FROM pg_roles WHERE rolname='cs_training'") 2>$null
  if ($roleExists -notmatch '1') { & $psql -U postgres -p 5432 -c "CREATE ROLE cs_training LOGIN PASSWORD 'cs_training_pwd'" | Out-Null; Write-Host '已创建角色 cs_training' }
  $dbExists = (& $psql -U postgres -p 5432 -tAc "SELECT 1 FROM pg_database WHERE datname='cs_training'") 2>$null
  if ($dbExists -notmatch '1') { & $psql -U postgres -p 5432 -c "CREATE DATABASE cs_training OWNER cs_training" | Out-Null; Write-Host '已创建数据库 cs_training' }

  Use-ApiEnv
  Push-Location $ProjectRoot
  try {
    & node 'backend/dist/db/migrate.js'; Write-Host "建表完成（migrate 退出码 $LASTEXITCODE）"
    & node 'backend/dist/db/seed.js';    Write-Host "内容库灌入完成（seed 退出码 $LASTEXITCODE）"
  } finally { Pop-Location }
}

if (-not (Test-ApiRunning)) {
  Use-ApiEnv
  Start-Process -FilePath node -ArgumentList 'backend/dist/main.js' `
    -WorkingDirectory $ProjectRoot -WindowStyle Hidden `
    -RedirectStandardOutput $ApiLog -RedirectStandardError $ApiErrLog
  Write-Host 'API 启动中…'; Start-Sleep -Seconds 8
} else { Write-Host "API 已在运行（端口 $Port）" }

try {
  Write-Host ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 8).Content)
  Write-Host ''
  Write-Host "入口：http://127.0.0.1:8080/    账号：admin/Admin@123、leader/Leader@123、agent/Agent@123"
} catch { Write-Host "健康检查失败：$($_.Exception.Message)（日志：$ApiErrLog）" }
