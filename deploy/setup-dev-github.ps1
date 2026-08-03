# ═════════════════════════════════════════════════════════════════════════════
#  РАЗОВАЯ НАСТРОЙКА ДВУХ ОКРУЖЕНИЙ В GITHUB.
#  Запуск из корня репозитория, с ВКЛЮЧЁННЫМ VPN (нужен доступ к github.com):
#
#      .\deploy\setup-dev-github.ps1
#
#  Что делает:
#    • создаёт Environments "prod" и "dev";
#    • раскладывает по ним секреты, различающиеся между стендами
#      (S3_BUCKET, STORAGE_BASE_URL, API_BASE_URL, YC_FUNCTION_NAME, ADMIN_TOKEN);
#    • заводит переменные PROD_BUCKET / DEV_BUCKET (для синхронизации данных)
#      и SITE_URL в каждом окружении;
#    • удаляет те же пять секретов с уровня репозитория.
#
#  Последнее — важно: если оставить их на уровне репозитория, дев-деплой при
#  отсутствии дев-секрета молча возьмёт прод-значение и зальёт дев поверх прода.
#  Общие для стендов ключи (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
#  YC_FOLDER_ID, YC_SA_JSON_CREDENTIALS) остаются на уровне репозитория.
#
#  Значения берутся из deploy\config.local.ps1 (прод) и deploy\config.dev.ps1
#  (дев, создаётся скриптом setup-dev-stand.ps1).
# ═════════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Fail($msg) { Write-Host "`n✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "Не найден gh (GitHub CLI)." }

$repo = (gh repo view --json nameWithOwner -q .nameWithOwner)
if ($LASTEXITCODE -ne 0 -or -not $repo) { Fail "Не удалось определить репозиторий (gh авторизован?)." }
Write-Host "  репозиторий: $repo"

# ── Собрать значения обоих стендов ───────────────────────────────────────────
# Конфиги задают одни и те же имена переменных, поэтому читаем их по очереди
# и сразу забираем нужное в отдельные хеш-таблицы.
$STAND_KEYS = @('S3_BUCKET', 'STORAGE_BASE_URL', 'API_BASE_URL', 'YC_FUNCTION_NAME', 'ADMIN_TOKEN')

function Read-StandConfig($path, $name) {
  if (-not (Test-Path $path)) { Fail "Нет $path — конфиг стенда '$name'." }
  # Обнулить перед чтением: иначе пропущенная в конфиге строка молча
  # унаследует значение предыдущего стенда — ровно та ошибка, от которой уходим.
  foreach ($k in $STAND_KEYS) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
  . $path
  $values = @{
    S3_BUCKET        = $env:S3_BUCKET
    STORAGE_BASE_URL = $env:STORAGE_BASE_URL
    API_BASE_URL     = $env:API_BASE_URL
    YC_FUNCTION_NAME = $env:YC_FUNCTION_NAME
    ADMIN_TOKEN      = $env:ADMIN_TOKEN
  }
  foreach ($k in $values.Keys) {
    if (-not $values[$k]) { Fail "В $path не задан $k." }
  }
  return $values
}

$prod = Read-StandConfig (Join-Path $root "deploy\config.local.ps1") "prod"
$dev  = Read-StandConfig (Join-Path $root "deploy\config.dev.ps1")  "dev"

if ($prod.S3_BUCKET -eq $dev.S3_BUCKET) { Fail "Бакеты прода и дева совпадают — проверьте конфиги." }
if ($prod.ADMIN_TOKEN -eq $dev.ADMIN_TOKEN) { Fail "ADMIN_TOKEN у стендов должен различаться." }

Write-Host "  prod → бакет $($prod.S3_BUCKET), функция $($prod.YC_FUNCTION_NAME)"
Write-Host "  dev  → бакет $($dev.S3_BUCKET), функция $($dev.YC_FUNCTION_NAME)"

# ── 1. Окружения и секреты ───────────────────────────────────────────────────
$stands = [ordered]@{ prod = $prod; dev = $dev }

foreach ($stand in $stands.Keys) {
  Step "Окружение '$stand'…"
  gh api -X PUT "repos/$repo/environments/$stand" --silent
  if ($LASTEXITCODE -ne 0) { Fail "Не удалось создать окружение $stand." }
  Ok "создано"

  $values = $stands[$stand]
  foreach ($key in $STAND_KEYS) {
    gh secret set $key --env $stand --repo $repo --body $values[$key]
    if ($LASTEXITCODE -ne 0) { Fail "Не удалось записать секрет $key в окружение $stand." }
  }
  Ok "5 секретов записано"

  $siteUrl = "https://$($values.S3_BUCKET).website.yandexcloud.net"
  gh variable set SITE_URL --env $stand --repo $repo --body $siteUrl
  if ($LASTEXITCODE -ne 0) { Fail "Не удалось записать переменную SITE_URL в окружение $stand." }
  Ok "SITE_URL = $siteUrl"
}

# ── 2. Переменные для синхронизации данных ───────────────────────────────────
Step "Переменные репозитория для Sync prod → dev…"
gh variable set PROD_BUCKET --repo $repo --body $prod.S3_BUCKET
if ($LASTEXITCODE -ne 0) { Fail "Не удалось записать PROD_BUCKET." }
gh variable set DEV_BUCKET --repo $repo --body $dev.S3_BUCKET
if ($LASTEXITCODE -ne 0) { Fail "Не удалось записать DEV_BUCKET." }
Ok "PROD_BUCKET = $($prod.S3_BUCKET), DEV_BUCKET = $($dev.S3_BUCKET)"

# ── 3. Убрать разъехавшиеся секреты с уровня репозитория ─────────────────────
Step "Удаление секретов уровня репозитория (они теперь в окружениях)…"
Write-Host "  Будут удалены: S3_BUCKET, STORAGE_BASE_URL, API_BASE_URL, YC_FUNCTION_NAME, ADMIN_TOKEN"
Write-Host "  Остаются: S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, YC_FOLDER_ID, YC_SA_JSON_CREDENTIALS"
$answer = Read-Host "  Продолжить? (введите yes)"
if ($answer -ne 'yes') {
  Write-Host "  Пропущено. Учтите: пока они на уровне репозитория, забытый дев-секрет" -ForegroundColor Yellow
  Write-Host "  подменится прод-значением, и дев-деплой уедет в прод." -ForegroundColor Yellow
} else {
  foreach ($key in $STAND_KEYS) {
    gh secret delete $key --repo $repo 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "удалён $key" } else { Write-Host "  · $key уже отсутствует" }
  }
}

Write-Host "`n✓ GITHUB НАСТРОЕН." -ForegroundColor Green
Write-Host "  Проверить: Settings → Environments (prod, dev) и Secrets and variables → Actions"
Write-Host "`nДальше:" -ForegroundColor Yellow
Write-Host "  1) git switch -c dev; git push -u origin dev   — первый деплой дев-стенда"
Write-Host "  2) Actions → 'Sync prod → dev' → dry=true       — посмотреть план копирования данных"
