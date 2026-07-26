# ─────────────────────────────────────────────────────────────────────────────
#  Конфигурация деплоя. СКОПИРУЙТЕ этот файл в config.local.ps1 и впишите значения.
#  config.local.ps1 в .gitignore — секреты НЕ попадут в git.
# ─────────────────────────────────────────────────────────────────────────────

# --- Бакет / хранилище ---
$env:S3_BUCKET            = "agr-viewer"                                  # имя бакета
$env:S3_ENDPOINT          = "https://storage.yandexcloud.net"            # обычно не менять
$env:S3_REGION            = "ru-central1"                                # обычно не менять

# Статический ключ сервисного аккаунта (роль storage.editor) — тот же, что в функции
$env:S3_ACCESS_KEY_ID     = "ВАШ_ACCESS_KEY_ID"
$env:S3_SECRET_ACCESS_KEY = "ВАШ_SECRET_ACCESS_KEY"

# --- URL, которые подставляются в сайт ---
$env:STORAGE_BASE_URL     = "https://storage.yandexcloud.net/agr-viewer" # публичный префикс бакета
$env:API_BASE_URL         = "https://functions.yandexcloud.net/d4eXXXXX" # URL Cloud Function

# --- Cloud Function (бэкенд) ---
$env:YC_FUNCTION_NAME     = "agr-viewer-api"                             # имя функции в облаке
$env:ADMIN_TOKEN          = "длинная-случайная-строка"                   # пароль на загрузку/удаление
