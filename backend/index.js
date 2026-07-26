const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const REGION = process.env.S3_REGION || 'ru-central1';
const ENDPOINT = process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net';
const BUCKET = process.env.S3_BUCKET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const MODELS_KEY = 'models.json';
const PROJECTS_KEY = 'projects.json';
const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_PROJECT_NAME = 'Без проекта';
const UPLOAD_URL_TTL = 3600;

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
  'Access-Control-Max-Age': '86400',
};

function reply(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function getHeader(event, name) {
  const headers = event.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function checkAuth(event) {
  if (!ADMIN_TOKEN) {
    throw Object.assign(new Error('ADMIN_TOKEN не задан в окружении функции'), { statusCode: 500 });
  }
  const token = getHeader(event, 'X-Admin-Token');
  if (token !== ADMIN_TOKEN) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
}

async function streamToString(stream) {
  if (typeof stream.transformToString === 'function') {
    return stream.transformToString();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function readJsonKey(key, fallback) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await streamToString(res.Body);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return fallback;
    throw err;
  }
}

async function writeJsonKey(key, data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache, max-age=0',
  }));
}

const writeModelsJson = (arr) => writeJsonKey(MODELS_KEY, arr);
const writeProjectsJson = (arr) => writeJsonKey(PROJECTS_KEY, arr);

function defaultProject() {
  return {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    createdAt: new Date(0).toISOString(),
  };
}

// Читает projects.json. Гарантирует наличие проекта по умолчанию.
// Если файла нет — возвращает [defaultProject] без записи (запишем при первом изменении).
async function readProjectsJson() {
  const arr = await readJsonKey(PROJECTS_KEY, null);
  if (!Array.isArray(arr) || arr.length === 0) {
    return [defaultProject()];
  }
  if (!arr.some((p) => p && p.id === DEFAULT_PROJECT_ID)) {
    arr.unshift(defaultProject());
  }
  return arr;
}

// Читает models.json и нормализует записи (displayName, projectId).
// Возвращает { models, changed }: changed=true если что-то пришлось добить дефолтами.
async function readModelsJson() {
  const raw = await readJsonKey(MODELS_KEY, []);
  if (!Array.isArray(raw)) return { models: [], changed: false };
  let changed = false;
  const models = raw.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const patched = { ...m };
    if (!patched.displayName) {
      patched.displayName = patched.name || 'Без имени';
      changed = true;
    }
    if (!patched.projectId) {
      patched.projectId = DEFAULT_PROJECT_ID;
      changed = true;
    }
    return patched;
  });
  return { models, changed };
}

function safeFileName(name) {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 200);
}

function publicUrl(key) {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `${ENDPOINT}/${BUCKET}/${enc}`;
}

function trimStr(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

// Гарантирует, что в projects.json есть запись с указанным id.
// Возвращает обновлённый список и флаг изменения.
function ensureProjectExists(projects, projectId) {
  if (projects.some((p) => p.id === projectId)) return { projects, changed: false };
  if (projectId === DEFAULT_PROJECT_ID) {
    return { projects: [defaultProject(), ...projects], changed: true };
  }
  return { projects, changed: false };
}

// ─── Проекты ────────────────────────────────────────────────────────────────

async function handleProjectsList() {
  const projects = await readProjectsJson();
  return reply(200, projects);
}

async function handleProjectCreate(event) {
  checkAuth(event);
  const { name } = JSON.parse(event.body || '{}');
  const trimmed = trimStr(name, 120);
  if (!trimmed) return reply(400, { error: 'name обязателен' });

  const projects = await readProjectsJson();
  if (projects.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return reply(409, { error: `Проект с именем "${trimmed}" уже существует` });
  }
  const project = { id: crypto.randomUUID(), name: trimmed, createdAt: new Date().toISOString() };
  projects.push(project);
  await writeProjectsJson(projects);
  return reply(200, { ok: true, project });
}

async function handleProjectRename(event) {
  checkAuth(event);
  const { id, name } = JSON.parse(event.body || '{}');
  const trimmed = trimStr(name, 120);
  if (!id || !trimmed) return reply(400, { error: 'id и name обязательны' });

  const projects = await readProjectsJson();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return reply(404, { error: 'Проект не найден' });
  if (projects.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
    return reply(409, { error: `Проект с именем "${trimmed}" уже существует` });
  }
  projects[idx] = { ...projects[idx], name: trimmed };
  await writeProjectsJson(projects);
  return reply(200, { ok: true, project: projects[idx] });
}

async function handleProjectDelete(event) {
  checkAuth(event);
  const { id } = JSON.parse(event.body || '{}');
  if (!id) return reply(400, { error: 'id обязателен' });
  if (id === DEFAULT_PROJECT_ID) {
    return reply(400, { error: 'Проект по умолчанию нельзя удалить' });
  }

  const projects = await readProjectsJson();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return reply(404, { error: 'Проект не найден' });

  const { models } = await readModelsJson();
  const inUse = models.filter((m) => m.projectId === id);
  if (inUse.length > 0) {
    return reply(409, {
      error: `В проекте ${inUse.length} модел(ей). Сначала перенесите их в другой проект.`,
      modelsCount: inUse.length,
    });
  }

  projects.splice(idx, 1);
  await writeProjectsJson(projects);
  return reply(200, { ok: true });
}

// ─── Модели ─────────────────────────────────────────────────────────────────

async function handleList() {
  const { models, changed } = await readModelsJson();
  if (changed) {
    // Тихая миграция: при первом чтении старых записей нормализуем их в storage.
    try { await writeModelsJson(models); } catch (e) { console.warn('migration write failed', e); }
  }
  return reply(200, models);
}

async function handleUpload(event) {
  checkAuth(event);
  const body = JSON.parse(event.body || '{}');
  const { name, size, format } = body;
  const displayName = trimStr(body.displayName, 200);
  const newProjectName = trimStr(body.newProjectName, 120);
  let projectId = trimStr(body.projectId, 80);

  if (!name || !format) return reply(400, { error: 'name и format обязательны' });
  if (format !== 'glb' && format !== 'gltf') {
    return reply(400, { error: 'Только glb или gltf' });
  }
  if (!displayName) return reply(400, { error: 'displayName обязателен' });
  if (!projectId && !newProjectName) {
    return reply(400, { error: 'Укажите projectId или newProjectName' });
  }

  let projects = await readProjectsJson();

  // Создаём новый проект, если запросили
  if (newProjectName) {
    if (projects.some((p) => p.name.toLowerCase() === newProjectName.toLowerCase())) {
      return reply(409, { error: `Проект с именем "${newProjectName}" уже существует` });
    }
    const project = { id: crypto.randomUUID(), name: newProjectName, createdAt: new Date().toISOString() };
    projects.push(project);
    await writeProjectsJson(projects);
    projectId = project.id;
  } else {
    // Гарантируем существование указанного проекта (особый случай — DEFAULT, его дозаписываем при необходимости)
    const ensured = ensureProjectExists(projects, projectId);
    if (ensured.changed) {
      projects = ensured.projects;
      await writeProjectsJson(projects);
    }
    if (!projects.some((p) => p.id === projectId)) {
      return reply(404, { error: 'Указанный проект не найден' });
    }
  }

  const { models } = await readModelsJson();
  if (models.some((m) => m.displayName === displayName && m.projectId === projectId)) {
    return reply(409, { error: `Модель "${displayName}" уже есть в этом проекте` });
  }

  const id = crypto.randomUUID();
  const key = `models/${Date.now()}_${safeFileName(name)}`;
  const contentType = format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json';

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL });

  return reply(200, {
    uploadUrl,
    uploadHeaders: { 'Content-Type': contentType },
    model: {
      id,
      name,                // оригинальное имя файла (для скачивания/диагностики)
      displayName,         // пользовательское имя
      projectId,
      key,
      format,
      size: Number(size) || 0,
      uploadedAt: new Date().toISOString(),
      url: publicUrl(key),
    },
  });
}

async function handleCommit(event) {
  checkAuth(event);
  const { model } = JSON.parse(event.body || '{}');
  if (!model || !model.id || !model.key || !model.name || !model.displayName || !model.projectId) {
    return reply(400, { error: 'model.{id,key,name,displayName,projectId} обязательны' });
  }
  const { models } = await readModelsJson();
  if (models.some((m) => m.id === model.id)) {
    return reply(200, { ok: true, duplicate: true });
  }
  // Проверяем, что проект существует
  const projects = await readProjectsJson();
  if (!projects.some((p) => p.id === model.projectId)) {
    return reply(404, { error: 'Указанный проект не найден' });
  }
  models.unshift(model);
  await writeModelsJson(models);
  return reply(200, { ok: true });
}

async function handleDelete(event) {
  checkAuth(event);
  const { id } = JSON.parse(event.body || '{}');
  if (!id) return reply(400, { error: 'id обязателен' });

  const { models } = await readModelsJson();
  const idx = models.findIndex((m) => m.id === id);
  if (idx < 0) return reply(404, { error: 'Модель не найдена' });
  const [model] = models.splice(idx, 1);
  await writeModelsJson(models);

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: model.key }));
  } catch (e) {
    console.error('Не удалось удалить объект из бакета:', e);
  }
  return reply(200, { ok: true });
}

// Обновление displayName и/или projectId существующей модели
async function handleModelUpdate(event) {
  checkAuth(event);
  const body = JSON.parse(event.body || '{}');
  const id = trimStr(body.id, 120);
  if (!id) return reply(400, { error: 'id обязателен' });

  const patch = {};
  if (body.displayName !== undefined) {
    const dn = trimStr(body.displayName, 200);
    if (!dn) return reply(400, { error: 'displayName не может быть пустым' });
    patch.displayName = dn;
  }
  if (body.projectId !== undefined) {
    const pid = trimStr(body.projectId, 80);
    if (!pid) return reply(400, { error: 'projectId не может быть пустым' });
    patch.projectId = pid;
  }
  if (Object.keys(patch).length === 0) {
    return reply(400, { error: 'Нечего обновлять (displayName и/или projectId)' });
  }

  if (patch.projectId) {
    const projects = await readProjectsJson();
    if (!projects.some((p) => p.id === patch.projectId)) {
      return reply(404, { error: 'Указанный проект не найден' });
    }
  }

  const { models } = await readModelsJson();
  const idx = models.findIndex((m) => m.id === id);
  if (idx < 0) return reply(404, { error: 'Модель не найдена' });

  const targetProject = patch.projectId || models[idx].projectId;
  const targetDisplay = patch.displayName || models[idx].displayName;
  // Проверка уникальности имени внутри проекта (кроме самой модели)
  if (models.some((m, i) => i !== idx && m.projectId === targetProject && m.displayName === targetDisplay)) {
    return reply(409, { error: `Модель "${targetDisplay}" уже есть в этом проекте` });
  }

  models[idx] = { ...models[idx], ...patch };
  await writeModelsJson(models);
  return reply(200, { ok: true, model: models[idx] });
}

exports.handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const action = (event.queryStringParameters || {}).action || '';

  if (method === 'OPTIONS') return reply(200, { ok: true });

  try {
    if (method === 'GET' && (action === '' || action === 'list')) return handleList();
    if (method === 'GET' && action === 'projects') return handleProjectsList();

    if (method === 'POST' && action === 'upload') return handleUpload(event);
    if (method === 'POST' && action === 'commit') return handleCommit(event);
    if (method === 'POST' && action === 'delete') return handleDelete(event);
    if (method === 'POST' && action === 'update') return handleModelUpdate(event);

    if (method === 'POST' && action === 'project-create') return handleProjectCreate(event);
    if (method === 'POST' && action === 'project-rename') return handleProjectRename(event);
    if (method === 'POST' && action === 'project-delete') return handleProjectDelete(event);

    return reply(404, { error: `Не найдено: ${method} ?action=${action}` });
  } catch (err) {
    console.error('Ошибка обработчика:', err);
    return reply(err.statusCode || 500, { error: err.message || 'internal error' });
  }
};
