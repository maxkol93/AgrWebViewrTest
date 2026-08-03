# ═════════════════════════════════════════════════════════════════════════════
#  ДЕПЛОЙ ОДНОЙ КОМАНДОЙ.  Запуск из корня репозитория:
#      .\deploy.ps1              → дев-стенд (по умолчанию, безопасно)
#      .\deploy.ps1 -Target prod → прод, к пользователям
#
#  Обновляет за один раз:
#    1) сайт   (index.html + script.js)  → бакет Object Storage
#    2) логику (Cloud Function из backend/) → Yandex Cloud Functions
#
#  Перед первым запуском:
#    • скопируйте deploy\config.example.ps1 → deploy\config.local.ps1 (прод)
#      и deploy\config.dev.ps1 (дев), заполните значения
#    • установите Yandex CLI (yc) и выполните `yc init` (см. DEPLOY.md)
# ═════════════════════════════════════════════════════════════════════════════

param(
  [ValidateSet('dev', 'prod')]
  [string]$Target = 'dev'
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Fail($msg) { Write-Host "`n✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }

# ── 1. Конфигурация ──────────────────────────────────────────────────────────
# Прод и дев читают разные файлы конфигурации — перепутать стенды нельзя.
$configName = if ($Target -eq 'prod') { "config.local.ps1" } else { "config.dev.ps1" }
$configPath = Join-Path $root "deploy\$configName"
if (-not (Test-Path $configPath)) {
  Fail "Нет файла deploy\$configName`n   Скопируйте deploy\config.example.ps1 в deploy\$configName и заполните значения."
}
. $configPath
$env:APP_ENV = $Target

if ($Target -eq 'prod') {
  Write-Host "`n!! Деплой в ПРОД — увидят пользователи." -ForegroundColor Yellow
  $answer = Read-Host "   Продолжить? (введите yes)"
  if ($answer -ne 'yes') { Fail "Отменено." }
}

# ── 2. Проверка инструментов ─────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Не найден node. Установите Node.js 18+." }
if (-not (Get-Command yc   -ErrorAction SilentlyContinue)) {
  Fail "Не найден yc (Yandex CLI). Установите:`n   iex (New-Object Net.WebClient).DownloadString('https://storage.yandexcloud.net/yandexcloud-yc/install.ps1')`n   затем перезапустите терминал и выполните: yc init"
}

# ── 3. Зависимости загрузчика ────────────────────────────────────────────────
# Ставим каждый раз: в deploy\package.json лежат ещё и three.js, Draco и шрифт,
# которые заливаются на сайт, — их версии должны совпадать с package.json.
Step "Проверяю зависимости загрузчика…"
npm --prefix deploy install --silent --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install в deploy\ не удался." }

# ── 4. Сайт → бакет ──────────────────────────────────────────────────────────
Step "Заливаю сайт в Object Storage (стенд: $Target)…"
node deploy/deploy-frontend.mjs
if ($LASTEXITCODE -ne 0) { Fail "Заливка сайта не удалась." }

# ── 5. Логика → Cloud Function ───────────────────────────────────────────────
Step "Обновляю Cloud Function `"$env:YC_FUNCTION_NAME`"…"
$ycArgs = @(
  "serverless", "function", "version", "create",
  "--function-name",    $env:YC_FUNCTION_NAME,
  "--runtime",          "nodejs18",
  "--entrypoint",       "index.handler",
  "--memory",           "256m",
  "--execution-timeout","30s",
  "--source-path",      "./backend",
  "--environment",      "S3_BUCKET=$($env:S3_BUCKET)",
  "--environment",      "S3_ENDPOINT=$($env:S3_ENDPOINT)",
  "--environment",      "S3_REGION=$($env:S3_REGION)",
  "--environment",      "S3_ACCESS_KEY_ID=$($env:S3_ACCESS_KEY_ID)",
  "--environment",      "S3_SECRET_ACCESS_KEY=$($env:S3_SECRET_ACCESS_KEY)",
  "--environment",      "ADMIN_TOKEN=$($env:ADMIN_TOKEN)"
)
& yc @ycArgs
if ($LASTEXITCODE -ne 0) { Fail "Обновление Cloud Function не удалось." }

# ── Готово ───────────────────────────────────────────────────────────────────
$siteUrl = "https://$($env:S3_BUCKET).website.yandexcloud.net"
Write-Host "`n✓ ГОТОВО. Стенд '$Target' обновлён." -ForegroundColor Green
Write-Host "  Сайт: $siteUrl" -ForegroundColor Green
