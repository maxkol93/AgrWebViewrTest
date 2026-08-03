# ─────────────────────────────────────────────────────────────────────────────
#  Конфигурация деплоя. Скопируйте этот файл ДВАЖДЫ и впишите значения:
#     config.local.ps1 → ПРОД  (.\deploy.ps1 -Target prod)
#     config.dev.ps1   → ДЕВ   (.\deploy.ps1)
#  Оба в .gitignore — секреты НЕ попадут в git.
#
#  Ключи сервисного аккаунта у стендов общие, различаются бакет, функция,
#  URL и ADMIN_TOKEN. Ниже показаны значения ПРОДА; для дева см. комментарии.
# ─────────────────────────────────────────────────────────────────────────────

# --- Бакет / хранилище ---
$env:S3_BUCKET            = "agr-viewer"                                  # дев: agr-viewer-dev
$env:S3_ENDPOINT          = "https://storage.yandexcloud.net"            # обычно не менять
$env:S3_REGION            = "ru-central1"                                # обычно не менять

# Статический ключ сервисного аккаунта (роль storage.editor) — тот же, что в функции.
# У прода и дева одинаковый: стенды живут в одном каталоге облака.
$env:S3_ACCESS_KEY_ID     = "ВАШ_ACCESS_KEY_ID"
$env:S3_SECRET_ACCESS_KEY = "ВАШ_SECRET_ACCESS_KEY"

# --- URL, которые подставляются в сайт ---
$env:STORAGE_BASE_URL     = "https://storage.yandexcloud.net/agr-viewer" # дев: .../agr-viewer-dev
$env:API_BASE_URL         = "https://functions.yandexcloud.net/d4eXXXXX" # дев: URL дев-функции

# --- Cloud Function (бэкенд) ---
$env:YC_FUNCTION_NAME     = "agr-viewer-api"                             # дев: agr-viewer-api-dev
$env:ADMIN_TOKEN          = "длинная-случайная-строка"                   # у дева СВОЙ токен
