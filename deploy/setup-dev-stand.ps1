# ═════════════════════════════════════════════════════════════════════════════
#  РАЗОВАЯ НАСТРОЙКА ДЕВ-СТЕНДА В YANDEX CLOUD.
#  Запуск из корня репозитория, с ВЫКЛЮЧЕННЫМ VPN (yc и Object Storage
#  ходят в ru-central1):
#
#      .\deploy\setup-dev-stand.ps1
#
#  Создаёт: бакет agr-viewer-dev (публичное чтение, хостинг, CORS)
#           и функцию agr-viewer-api-dev (публичную).
#  Пишет:   deploy\config.dev.ps1        — конфиг локального деплоя на дев
#           deploy\dev-stand.out.json    — значения для секретов GitHub
#
#  Скрипт идемпотентный: если бакет/функция уже есть — просто дочитает их данные.
#  Ничего в проде не трогает.
# ═════════════════════════════════════════════════════════════════════════════

param(
  [string]$DevBucket   = "agr-viewer-dev",
  [string]$DevFunction = "agr-viewer-api-dev"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Fail($msg) { Write-Host "`n✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }

# ── 0. Инструменты и креды ───────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Не найден node. Установите Node.js 18+." }
if (-not (Get-Command yc   -ErrorAction SilentlyContinue)) { Fail "Не найден yc (Yandex CLI). См. DEPLOY.md." }

$prodConfig = Join-Path $root "deploy\config.local.ps1"
if (-not (Test-Path $prodConfig)) {
  Fail "Нет deploy\config.local.ps1 — из него берутся ключи сервисного аккаунта (они общие у стендов)."
}
. $prodConfig
$prodBucket = $env:S3_BUCKET
if (-not $prodBucket) { Fail "В config.local.ps1 не задан S3_BUCKET." }
if ($prodBucket -eq $DevBucket) { Fail "Дев-бакет совпадает с прод-бакетом ($prodBucket) — так нельзя." }

Write-Host "  прод-бакет:  $prodBucket"
Write-Host "  дев-бакет:   $DevBucket"
Write-Host "  дев-функция: $DevFunction"

# ── 1. Бакет ─────────────────────────────────────────────────────────────────
Step "Бакет $DevBucket…"
$bucketExists = $false
try {
  yc storage bucket get $DevBucket 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $bucketExists = $true }
} catch { }

if ($bucketExists) {
  Ok "уже существует — создание пропущено"
} else {
  yc storage bucket create --name $DevBucket --public-read
  if ($LASTEXITCODE -ne 0) { Fail "Не удалось создать бакет $DevBucket." }
  Ok "создан (публичное чтение)"
}

# Хостинг сайта + CORS — через S3 API, теми же ключами, что у деплоя.
Step "Настройка хостинга и CORS…"
if (-not (Test-Path (Join-Path $root "deploy\node_modules"))) {
  npm --prefix deploy install --silent
  if ($LASTEXITCODE -ne 0) { Fail "npm install в deploy\ не удался." }
}
$env:S3_BUCKET = $DevBucket
node deploy/configure-bucket.mjs
if ($LASTEXITCODE -ne 0) { Fail "Не удалось настроить бакет." }
$env:S3_BUCKET = $prodBucket   # вернуть окружение как было

# ── 2. Cloud Function ────────────────────────────────────────────────────────
Step "Функция $DevFunction…"
$funcExists = $false
try {
  yc serverless function get --name $DevFunction 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $funcExists = $true }
} catch { }

if ($funcExists) {
  Ok "уже существует — создание пропущено"
} else {
  yc serverless function create --name $DevFunction --description "Дев-стенд AgrViewer"
  if ($LASTEXITCODE -ne 0) { Fail "Не удалось создать функцию $DevFunction." }
  Ok "создана"
}

yc serverless function allow-unauthenticated-invoke --name $DevFunction | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Не удалось сделать функцию публичной." }
Ok "публичный вызов разрешён"

$funcJson = (yc serverless function get --name $DevFunction --format json) -join "`n" | ConvertFrom-Json
$apiUrl = $funcJson.http_invoke_url
if (-not $apiUrl) { Fail "Не удалось получить URL функции." }
Ok "URL: $apiUrl"

# Код функции зальёт первый деплой (.\deploy.ps1 или push в ветку dev) —
# создавать версию здесь незачем.

# ── 3. Свой ADMIN_TOKEN для дева ─────────────────────────────────────────────
Step "Генерирую ADMIN_TOKEN для дева…"
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$devAdminToken = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
Ok "готов (у дева свой, прод-токен не используется)"

# ── 4. Файлы с результатами ──────────────────────────────────────────────────
$storageBase = "https://storage.yandexcloud.net/$DevBucket"
$siteUrl     = "https://$DevBucket.website.yandexcloud.net"

Step "Пишу deploy\config.dev.ps1…"
$template = @'
# Конфиг ДЕВ-стенда. Создан автоматически (deploy\setup-dev-stand.ps1).
# Используется командой:  .\deploy.ps1        (без -Target prod)
# В .gitignore — в git не попадёт.

$env:S3_BUCKET            = "__BUCKET__"
$env:S3_ENDPOINT          = "https://storage.yandexcloud.net"
$env:S3_REGION            = "ru-central1"

$env:S3_ACCESS_KEY_ID     = "__AKID__"
$env:S3_SECRET_ACCESS_KEY = "__SECRET__"

$env:STORAGE_BASE_URL     = "__STORAGE__"
$env:API_BASE_URL         = "__API__"

$env:YC_FUNCTION_NAME     = "__FUNC__"
$env:ADMIN_TOKEN          = "__TOKEN__"
'@

$config = $template `
  -replace '__BUCKET__',  $DevBucket `
  -replace '__AKID__',    $env:S3_ACCESS_KEY_ID `
  -replace '__SECRET__',  $env:S3_SECRET_ACCESS_KEY `
  -replace '__STORAGE__', $storageBase `
  -replace '__API__',     $apiUrl `
  -replace '__FUNC__',    $DevFunction `
  -replace '__TOKEN__',   $devAdminToken

$config | Out-File -FilePath (Join-Path $root "deploy\config.dev.ps1") -Encoding utf8
Ok "deploy\config.dev.ps1"

# Значения для второго шага (настройка GitHub) — файл тоже в .gitignore.
$out = [ordered]@{
  prodBucket     = $prodBucket
  devBucket      = $DevBucket
  devFunction    = $DevFunction
  devStorageBase = $storageBase
  devApiUrl      = $apiUrl
  devSiteUrl     = $siteUrl
  devAdminToken  = $devAdminToken
}
$out | ConvertTo-Json | Out-File -FilePath (Join-Path $root "deploy\dev-stand.out.json") -Encoding utf8
Ok "deploy\dev-stand.out.json"

# ── Готово ───────────────────────────────────────────────────────────────────
Write-Host "`n✓ ДЕВ-СТЕНД В ОБЛАКЕ ГОТОВ." -ForegroundColor Green
Write-Host "  Сайт дева: $siteUrl" -ForegroundColor Green
Write-Host "`nДальше (VPN можно включить обратно):" -ForegroundColor Yellow
Write-Host "  1) .\deploy\setup-dev-github.ps1   — создаст окружения и секреты в GitHub"
Write-Host "  2) залить данные из прода           — вкладка Actions → Sync prod → dev"
