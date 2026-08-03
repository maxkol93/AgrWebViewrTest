# ═════════════════════════════════════════════════════════════════════════════
#  ВОССТАНОВЛЕНИЕ deploy\config.local.ps1 ИЗ ОБЛАКА.
#  Нужен, если локального конфига нет, а деплой настраивался только через
#  GitHub Actions (секреты GitHub прочитать обратно нельзя).
#
#  Запуск из корня репозитория, с ВЫКЛЮЧЕННЫМ VPN:
#      .\deploy\bootstrap-config.ps1
#      .\deploy\bootstrap-config.ps1 -FunctionName agr-viewer-api
#
#  Откуда берутся значения: деплой кладёт S3_BUCKET, ключи сервисного аккаунта
#  и ADMIN_TOKEN в переменные окружения Cloud Function — их и читаем.
#  Ничего в облаке не меняется, только чтение.
# ═════════════════════════════════════════════════════════════════════════════

param(
  [string]$FunctionName
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Fail($msg) { Write-Host "`n✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }

if (-not (Get-Command yc -ErrorAction SilentlyContinue)) { Fail "Не найден yc (Yandex CLI). См. DEPLOY.md." }

$target = Join-Path $root "deploy\config.local.ps1"
if (Test-Path $target) {
  Write-Host "  deploy\config.local.ps1 уже существует." -ForegroundColor Yellow
  $answer = Read-Host "  Перезаписать? (введите yes)"
  if ($answer -ne 'yes') { Fail "Отменено." }
}

# ── 1. Найти прод-функцию ────────────────────────────────────────────────────
Step "Ищу Cloud Function…"
$listJson = (yc serverless function list --format json) -join "`n"
if ($LASTEXITCODE -ne 0) { Fail "Не удалось получить список функций. VPN выключен? yc init выполнен?" }
$functions = @($listJson | ConvertFrom-Json)

if (-not $FunctionName) {
  # Дев-функции отбрасываем: восстанавливаем конфиг ПРОДА.
  $candidates = @($functions | Where-Object { $_.name -notmatch '(dev|test|stage)' })
  if ($candidates.Count -eq 0) { Fail "В каталоге нет подходящих функций." }
  if ($candidates.Count -gt 1) {
    Write-Host "  Найдено несколько функций:"
    $candidates | ForEach-Object { Write-Host "    - $($_.name)" }
    Fail "Укажите нужную явно: .\deploy\bootstrap-config.ps1 -FunctionName <имя>"
  }
  $FunctionName = $candidates[0].name
}
Ok "функция: $FunctionName"

# ── 2. Прочитать окружение последней версии ──────────────────────────────────
Step "Читаю переменные окружения последней версии…"
$versionJson = (yc serverless function version get-by-tag --function-name $FunctionName --tag '$latest' --format json) -join "`n"
if ($LASTEXITCODE -ne 0) { Fail "Не удалось получить версию функции $FunctionName." }
$version = $versionJson | ConvertFrom-Json
$envVars = $version.environment
if (-not $envVars) { Fail "У версии функции нет переменных окружения — восстанавливать нечего." }

function Get-EnvValue($name) {
  $value = $envVars.$name
  if (-not $value) { Fail "В окружении функции нет $name — конфиг придётся заполнить вручную." }
  return $value
}

$bucket   = Get-EnvValue 'S3_BUCKET'
$akid     = Get-EnvValue 'S3_ACCESS_KEY_ID'
$secret   = Get-EnvValue 'S3_SECRET_ACCESS_KEY'
$token    = Get-EnvValue 'ADMIN_TOKEN'
$endpoint = if ($envVars.S3_ENDPOINT) { $envVars.S3_ENDPOINT } else { "https://storage.yandexcloud.net" }
$region   = if ($envVars.S3_REGION)   { $envVars.S3_REGION }   else { "ru-central1" }
Ok "бакет: $bucket, ключи и ADMIN_TOKEN получены"

# ── 3. URL функции ───────────────────────────────────────────────────────────
$funcJson = (yc serverless function get --name $FunctionName --format json) -join "`n" | ConvertFrom-Json
$apiUrl = $funcJson.http_invoke_url
if (-not $apiUrl) { Fail "Не удалось получить URL функции." }
Ok "URL: $apiUrl"

# ── 4. Записать конфиг ───────────────────────────────────────────────────────
Step "Пишу deploy\config.local.ps1…"
$template = @'
# Конфиг ПРОД-стенда. Восстановлен из облака (deploy\bootstrap-config.ps1).
# Используется командой:  .\deploy.ps1 -Target prod
# В .gitignore — в git не попадёт.

$env:S3_BUCKET            = "__BUCKET__"
$env:S3_ENDPOINT          = "__ENDPOINT__"
$env:S3_REGION            = "__REGION__"

$env:S3_ACCESS_KEY_ID     = "__AKID__"
$env:S3_SECRET_ACCESS_KEY = "__SECRET__"

$env:STORAGE_BASE_URL     = "__STORAGE__"
$env:API_BASE_URL         = "__API__"

$env:YC_FUNCTION_NAME     = "__FUNC__"
$env:ADMIN_TOKEN          = "__TOKEN__"
'@

$config = $template `
  -replace '__BUCKET__',   $bucket `
  -replace '__ENDPOINT__', $endpoint `
  -replace '__REGION__',   $region `
  -replace '__AKID__',     $akid `
  -replace '__SECRET__',   $secret `
  -replace '__STORAGE__',  "$endpoint/$bucket" `
  -replace '__API__',      $apiUrl `
  -replace '__FUNC__',     $FunctionName `
  -replace '__TOKEN__',    $token

[System.IO.File]::WriteAllText($target, $config, (New-Object System.Text.UTF8Encoding($true)))
Ok "готово"

Write-Host "`n✓ КОНФИГ ПРОДА ВОССТАНОВЛЕН." -ForegroundColor Green
Write-Host "  Сверьте STORAGE_BASE_URL с секретом GitHub, если сайт отдаётся через свой домен." -ForegroundColor Yellow
Write-Host "`nДальше (VPN всё ещё выключен):" -ForegroundColor Yellow
Write-Host "  .\deploy\setup-dev-stand.ps1"
