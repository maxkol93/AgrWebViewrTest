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
├── projects.json           ← список проектов (создаст функция при первом изменении)
├── models/
│   └── 1715000000000_example.glb
└── environments/
    ├── sunset.hdr
    ├── day.hdr
    └── night.hdr
```

Каждая запись в `models.json` имеет вид:
```json
{
  "id": "uuid",
  "name": "house.glb",              // оригинальное имя файла
  "displayName": "Фасад финал",     // пользовательское имя модели
  "projectId": "uuid|default",      // привязка к проекту
  "key": "models/...",
  "format": "glb",
  "size": 12345678,
  "uploadedAt": "...",
  "url": "https://..."
}
```

Записи в `projects.json`:
```json
{ "id": "uuid", "name": "Дом на Тверской", "createdAt": "..." }
```

При первом запуске после миграции бэкенд автоматически проставляет старым моделям `displayName = name` и `projectId = "default"` (специальный проект «Без проекта»).

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

Модели:
- `GET  …/<id>` → список моделей (используется только как health-check; сайт читает `models.json` напрямую из бакета)
- `POST …/<id>?action=upload` (X-Admin-Token) — body `{ name, size, format, displayName, projectId? | newProjectName? }`, возвращает подписанный PUT URL и подготовленную запись модели
- `POST …/<id>?action=commit` (X-Admin-Token) — body `{ model }`, добавляет запись в `models.json`
- `POST …/<id>?action=delete` (X-Admin-Token) — body `{ id }`, удаляет запись и объект
- `POST …/<id>?action=update` (X-Admin-Token) — body `{ id, displayName?, projectId? }`, переименовывает модель и/или переносит в другой проект

Проекты:
- `GET  …/<id>?action=projects` → список проектов
- `POST …/<id>?action=project-create` (X-Admin-Token) — body `{ name }`
- `POST …/<id>?action=project-rename` (X-Admin-Token) — body `{ id, name }`
- `POST …/<id>?action=project-delete` (X-Admin-Token) — body `{ id }` (запрещено, если в проекте остались модели)

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

Любой пользователь сможет смотреть модели без пароля. При попытке заливки/удаления сайт спросит `ADMIN_TOKEN` (через `prompt`) и запомнит его в `localStorage` под ключом `agrAdminToken`. После этого появится кнопка ⚙ в левом верхнем углу — модалка с управлением моделями (переименование, смена проекта, удаление) и проектами (создание, переименование, удаление). Чтобы сбросить — в консоли браузера выполнить `localStorage.removeItem('agrAdminToken')`.

### Пользовательский флоу загрузки

При выборе файла открывается диалог: ввод **названия модели** (по умолчанию — имя файла без расширения) и выбор **проекта** — либо существующего из списка, либо создание нового по имени. Модель не может быть без проекта; если в системе пока ни одного проекта кроме «Без проекта», диалог сразу предложит ввести имя нового проекта.

## Стоимость (порядок)

- Хранение 10 ГБ: ~10 ₽/мес
- Трафик 50 ГБ исходящий: ~48 ₽/мес (первые 10 ГБ бесплатно)
- Функция: бесплатный тир 1M запросов/мес, для админ-операций даже близко не выберется

Итого: **≈ 20–60 ₽/мес** под небольшую нагрузку.
