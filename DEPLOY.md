# Деплой

Обновление приложения — **одной командой** или **одним push**. Обновляются сразу и
сайт (`index.html`, `script.js`), и логика (Cloud Function в `backend/`).

Стек: Yandex Object Storage (хранилище + хостинг сайта) + Yandex Cloud Function (бэкенд).

---

## Как обновить приложение (каждый день)

### Вариант A — локально, одной командой

```powershell
.\deploy.ps1
```

Скрипт сам зальёт сайт в бакет и обновит Cloud Function. Всё.

### Вариант B — через git (автодеплой)

```powershell
git add -A
git commit -m "обновление"
git push
```

GitHub Actions подхватит push в `main` и сделает тот же деплой автоматически.
Статус — вкладка **Actions** в репозитории.

> Оба варианта делают одно и то же и полностью взаимозаменяемы.

### Версия на сайте

Внизу справа мелким полупрозрачным шрифтом показывается версия `v<major.minor>.<patch>`:
- **major.minor** — в файле `VERSION` (напр. `0.2`). Поднимаешь **вручную** при смене функционала (`0.3`, `1.0`…).
- **patch** — считается автоматически = число коммитов с момента последнего изменения `VERSION`. То есть после каждого пуша `+1`, а при ручном поднятии `VERSION` сбрасывается в `0` (`v0.3.0`).

Ничего вручную в HTML править не нужно — версия подставляется при деплое.

---

## Разовая настройка

Ниже — то, что делается **один раз**. После этого обновление всегда идёт командами выше.

### 0. Что где хранится

```
бакет agr-viewer/
├── index.html, script.js     ← сайт (заливает деплой)
├── models.json, projects.json ← создаёт функция автоматически при первом изменении
├── models/                   ← .glb, кладёт функция при загрузке
└── environments/             ← HDR-карты (залить вручную один раз)
```

Структуру папок создавать вручную не нужно — она появляется сама при заливке.
HDR-карты (`environments/*.hdr`) залейте один раз через консоль.

### 1. Бакет Object Storage

Консоль → **Object Storage** → создать бакет (напр. `agr-viewer`):
- Доступ на чтение объектов — **публичный** (браузер качает `.glb` и `models.json` напрямую).
- Вкладка **Веб-сайт** → включить хостинг: главная и страница ошибок — `index.html`.
- Вкладка **CORS** → правило:

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET","PUT","HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3000 }]
```

Сайт будет доступен по адресу `https://<бакет>.website.yandexcloud.net`.

### 2. Сервисный аккаунт и ключ

IAM → создать сервисный аккаунт (роль `storage.editor`) → **создать статический ключ**.
Сохраните `accessKeyId` и `secretAccessKey` — понадобятся в конфиге деплоя и функции.

### 3. Cloud Function

Консоль → **Cloud Functions** → создать функцию (напр. `agr-viewer-api`),
среда `nodejs18`, точка входа `index.handler`, сделать **публичной**.
Код и переменные окружения зальёт деплой — руками ничего собирать/зиповать не нужно.
Запомните URL функции вида `https://functions.yandexcloud.net/d4eXXXXX`.

### 4A. Настройка локального деплоя (`.\deploy.ps1`)

1. Установите **Node.js 18+** и **Yandex CLI**:
   ```powershell
   iex (New-Object Net.WebClient).DownloadString('https://storage.yandexcloud.net/yandexcloud-yc/install.ps1')
   ```
   Перезапустите терминал, затем `yc init` (авторизация + выбор облака/каталога).
2. Скопируйте конфиг и заполните его своими значениями:
   ```powershell
   Copy-Item deploy\config.example.ps1 deploy\config.local.ps1
   notepad deploy\config.local.ps1
   ```
   `config.local.ps1` в `.gitignore` — секреты в git не попадут.

Готово: теперь `.\deploy.ps1` работает.

### 4B. Настройка автодеплоя (GitHub Actions)

В репозитории → **Settings → Secrets and variables → Actions** добавьте секреты:

| Секрет                    | Значение                                            |
|---------------------------|-----------------------------------------------------|
| `S3_BUCKET`               | имя бакета, напр. `agr-viewer`                      |
| `S3_ACCESS_KEY_ID`        | из статического ключа сервисного аккаунта          |
| `S3_SECRET_ACCESS_KEY`    | из статического ключа сервисного аккаунта          |
| `STORAGE_BASE_URL`        | `https://storage.yandexcloud.net/agr-viewer`       |
| `API_BASE_URL`            | URL Cloud Function                                  |
| `ADMIN_TOKEN`             | длинная случайная строка (пароль на загрузку)      |
| `YC_FUNCTION_NAME`        | имя функции, напр. `agr-viewer-api`                |
| `YC_FOLDER_ID`            | ID каталога в Yandex Cloud                          |
| `YC_SA_JSON_CREDENTIALS`  | JSON авторизованного ключа сервисного аккаунта¹    |

¹ Создать: `yc iam key create --service-account-name <sa> --output key.json`,
затем вставить содержимое `key.json` в секрет. Сервисному аккаунту нужны роли
`storage.editor` и `functions.editor` (или `editor`).

Готово: теперь `git push` в `main` деплоит автоматически.

---

## Как это работает и сколько стоит

- Смотреть модели может любой без пароля. При загрузке/удалении сайт спросит `ADMIN_TOKEN`
  (сохранит в `localStorage` под ключом `agrAdminToken`; сброс — `localStorage.removeItem('agrAdminToken')`).
- Появляется кнопка ⚙ — управление моделями и проектами.
- Стоимость под небольшую нагрузку: **≈ 20–60 ₽/мес** (хранилище + трафик; функция в бесплатном тире).

### Эндпоинты функции (один URL, маршрут в `?action=`)

- `GET  ?action=list` / `?action=projects` — списки (сайт читает `models.json` напрямую из бакета)
- `POST ?action=upload|commit|delete|update` (заголовок `X-Admin-Token`) — операции с моделями
- `POST ?action=project-create|project-rename|project-delete` — операции с проектами
