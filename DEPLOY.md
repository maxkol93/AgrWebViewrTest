# Развёртывание в Yandex Cloud

Стек: Yandex Object Storage (хранилище + хостинг сайта) + Yandex Cloud Function (бэкенд для подписи загрузок).

## 1. Бакет в Object Storage

Консоль → **Object Storage** → создать бакет, например `agr-viewer`.

- Класс хранилища: **Стандартное**
- Доступ: **Публичный** для чтения объектов (нужно, чтобы браузер мог скачивать `.glb` и `models.json` напрямую)
- Размер: «Без ограничений»

### CORS бакета

Бакет → вкладка **CORS** → добавить правило:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Если хотите ограничить — замените `"*"` в `AllowedOrigins` на свой домен.

### Структура объектов в бакете

```
agr-viewer/
├── index.html              ← сайт
├── script.js               ← сайт
├── models.json             ← список моделей (создаст функция при первой загрузке)
├── models/
│   └── 1715000000000_example.glb
└── environments/
    ├── sunset.hdr
    ├── day.hdr
    └── night.hdr
```

HDR-карты залейте вручную через консоль один раз.

## 2. Сервисный аккаунт и статический ключ

Консоль → **IAM** → создать сервисный аккаунт `agr-viewer-sa` с ролью `storage.editor` (только на нужном бакете, если используете ACL).

В этом же сервисном аккаунте → **Создать статический ключ доступа**. Получите `accessKeyId` и `secretAccessKey` — они пойдут в переменные окружения функции.

## 3. Cloud Function

В `backend/` лежит код функции. Соберите пакет:

```bash
cd backend
npm install
zip -r ../function.zip index.js package.json node_modules
```

Консоль → **Cloud Functions** → создать функцию `agr-viewer-api`:

- Среда выполнения: **nodejs18** (или новее)
- Точка входа: `index.handler`
- Таймаут: 30 с, память: 256 МБ
- Загрузить `function.zip`

Переменные окружения:

| Имя                  | Значение                                     |
|----------------------|----------------------------------------------|
| `S3_BUCKET`          | `agr-viewer`                                 |
| `S3_ENDPOINT`        | `https://storage.yandexcloud.net` (по умолч.)|
| `S3_REGION`          | `ru-central1`                                |
| `S3_ACCESS_KEY_ID`   | из статического ключа сервисного аккаунта    |
| `S3_SECRET_ACCESS_KEY` | из статического ключа сервисного аккаунта  |
| `ADMIN_TOKEN`        | любая длинная случайная строка               |

Сделайте функцию **публичной** (вкладка «Тестирование» → «Сделать функцию публичной»). Запомните URL вида `https://functions.yandexcloud.net/d4eXXXXXXXXXXXXXXXXX`.

### Эндпоинты функции

У Cloud Function один URL, маршрут передаётся в query-параметре `?action=…` (Яндекс не пропускает дополнительные сегменты пути в код функции — поэтому не `/upload`, а `?action=upload`).

- `GET  …/<id>` → список моделей (используется только как health-check; сайт читает `models.json` напрямую из бакета)
- `POST …/<id>?action=upload` (X-Admin-Token) — body `{ name, size, format }`, возвращает подписанный PUT URL
- `POST …/<id>?action=commit` (X-Admin-Token) — body `{ model }`, добавляет запись в `models.json`
- `POST …/<id>?action=delete` (X-Admin-Token) — body `{ id }`, удаляет запись и объект

## 4. Хостинг сайта

В консоли бакета → **Веб-сайт** → включить статический хостинг:

- Главная страница: `index.html`
- Страница ошибок: `index.html`

Залейте `index.html` и `script.js` в корень бакета:

```bash
# через s3cmd / aws-cli / консоль
aws --endpoint-url=https://storage.yandexcloud.net s3 cp index.html s3://agr-viewer/
aws --endpoint-url=https://storage.yandexcloud.net s3 cp script.js  s3://agr-viewer/
```

Сайт будет доступен по адресу `https://agr-viewer.website.yandexcloud.net`.

## 5. Конфигурация фронтенда

Перед заливкой `index.html` подставьте в него ваши значения:

```html
<meta id="storage-base-url" name="storage-base-url"
      content="https://storage.yandexcloud.net/agr-viewer">
<meta id="api-base-url" name="api-base-url"
      content="https://functions.yandexcloud.net/d4eXXXXXXXXXXXXXXXXX">
```

Любой пользователь сможет смотреть модели без пароля. При попытке заливки/удаления сайт спросит `ADMIN_TOKEN` (через `prompt`) и запомнит его в `localStorage` под ключом `agrAdminToken`. Чтобы сбросить — в консоли браузера выполнить `localStorage.removeItem('agrAdminToken')`.

## Стоимость (порядок)

- Хранение 10 ГБ: ~10 ₽/мес
- Трафик 50 ГБ исходящий: ~48 ₽/мес (первые 10 ГБ бесплатно)
- Функция: бесплатный тир 1M запросов/мес, для админ-операций даже близко не выберется

Итого: **≈ 20–60 ₽/мес** под небольшую нагрузку.
