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
const SUBPROJECTS_KEY = 'subprojects.json';

// Проект/подпроект по умолчанию, куда попадают все «ничейные» модели.
const UNKNOWN_PROJECT_ID = 'unknown';
const UNKNOWN_PROJECT_NAME = 'Unknown';
const UNKNOWN_COMMON_ID = 'unknown-common';
const UNKNOWN_COMMON_CODE = 'unknown-common';
const COMMON_NAME = 'Common';

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
const writeSubprojectsJson = (arr) => writeJsonKey(SUBPROJECTS_KEY, arr);

// ─── Утилиты ──────────────────────────────────────────────────────────────

function trimStr(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function safeFileName(name) {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 200);
}

function publicUrl(key) {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `${ENDPOINT}/${BUCKET}/${enc}`;
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

function slugify(name) {
  const src = String(name || '').toLowerCase();
  let out = '';
  for (const ch of src) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// Дата в формате YYYY-MM-DD (без времени).
function normalizeDate(v, fallbackIso) {
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = fallbackIso ? new Date(fallbackIso) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// ─── Проекты ────────────────────────────────────────────────────────────────

function unknownProject() {
  return { id: UNKNOWN_PROJECT_ID, name: UNKNOWN_PROJECT_NAME, createdAt: new Date(0).toISOString() };
}

function unknownCommonSubproject() {
  return {
    id: UNKNOWN_COMMON_ID,
    code: UNKNOWN_COMMON_CODE,
    projectId: UNKNOWN_PROJECT_ID,
    name: COMMON_NAME,
    isCommon: true,
    createdAt: new Date(0).toISOString(),
  };
}

// Читает projects.json, гарантирует наличие проекта Unknown.
async function readProjectsJson() {
  const arr = await readJsonKey(PROJECTS_KEY, null);
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!list.some((p) => p && p.id === UNKNOWN_PROJECT_ID)) {
    list.unshift(unknownProject());
  }
  return list;
}

// Читает subprojects.json, гарантирует наличие Unknown/Common.
async function readSubprojectsJson() {
  const arr = await readJsonKey(SUBPROJECTS_KEY, null);
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!list.some((s) => s && s.id === UNKNOWN_COMMON_ID)) {
    list.unshift(unknownCommonSubproject());
  }
  return list;
}

// Читает models.json и нормализует записи под новую схему.
// Возвращает { models, changed }: changed=true если что-то добили дефолтами/мигрировали.
async function readModelsJson() {
  const raw = await readJsonKey(MODELS_KEY, []);
  if (!Array.isArray(raw)) return { models: [], changed: false };
  let changed = false;
  const models = raw.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const patched = { ...m };
    if (!patched.displayName) { patched.displayName = patched.name || 'Без имени'; changed = true; }
    // Миграция: старое поле projectId больше не используется — все «ничейные» в Unknown/Common.
    if (!patched.subprojectId) { patched.subprojectId = UNKNOWN_COMMON_ID; changed = true; }
    if (patched.projectId !== undefined) { delete patched.projectId; changed = true; }
    if (!patched.modelDate) { patched.modelDate = normalizeDate(null, patched.uploadedAt); changed = true; }
    if (patched.versionName === undefined) { patched.versionName = ''; changed = true; }
    if (patched.comment === undefined) { patched.comment = ''; changed = true; }
    return patched;
  });
  return { models, changed };
}

// Генерирует уникальный код для Common-подпроекта проекта (латиница).
function makeCommonCode(projectName, existingCodes) {
  const base = `${slugify(projectName)}-common`;
  let code = base;
  let i = 2;
  while (existingCodes.has(code)) { code = `${base}-${i}`; i += 1; }
  return code;
}

// Гарантирует наличие Common-подпроекта у проекта. Мутирует subprojects, возвращает его.
function ensureCommonSubproject(subprojects, project) {
  let common = subprojects.find((s) => s.projectId === project.id && s.isCommon);
  if (common) return common;
  const codes = new Set(subprojects.map((s) => s.code));
  common = {
    id: crypto.randomUUID(),
    code: project.id === UNKNOWN_PROJECT_ID ? UNKNOWN_COMMON_CODE : makeCommonCode(project.name, codes),
    projectId: project.id,
    name: COMMON_NAME,
    isCommon: true,
    createdAt: new Date().toISOString(),
  };
  subprojects.push(common);
  return common;
}

async function handleProjectsList() {
  return reply(200, await readProjectsJson());
}

async function handleSubprojectsList() {
  return reply(200, await readSubprojectsJson());
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

  // Каждому проекту сразу заводим Common-подпроект.
  const subprojects = await readSubprojectsJson();
  const common = ensureCommonSubproject(subprojects, project);

  await writeProjectsJson(projects);
  await writeSubprojectsJson(subprojects);
  return reply(200, { ok: true, project, common });
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
  if (id === UNKNOWN_PROJECT_ID) {
    return reply(400, { error: 'Проект Unknown нельзя удалить' });
  }

  const projects = await readProjectsJson();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return reply(404, { error: 'Проект не найден' });

  const subprojects = await readSubprojectsJson();
  const subIds = new Set(subprojects.filter((s) => s.projectId === id).map((s) => s.id));

  const { models } = await readModelsJson();
  const inUse = models.filter((m) => subIds.has(m.subprojectId));
  if (inUse.length > 0) {
    return reply(409, {
      error: `В проекте ${inUse.length} модел(ей). Сначала перенесите их в другой проект.`,
      modelsCount: inUse.length,
    });
  }

  projects.splice(idx, 1);
  const nextSubprojects = subprojects.filter((s) => s.projectId !== id);
  await writeProjectsJson(projects);
  await writeSubprojectsJson(nextSubprojects);
  return reply(200, { ok: true });
}

// ─── Подпроекты ───────────────────────────────────────────────────────────

async function handleSubprojectCreate(event) {
  checkAuth(event);
  const body = JSON.parse(event.body || '{}');
  const projectId = trimStr(body.projectId, 80);
  const name = trimStr(body.name, 200);
  const code = trimStr(body.code, 80);
  if (!projectId || !name || !code) {
    return reply(400, { error: 'projectId, name и code обязательны' });
  }

  const projects = await readProjectsJson();
  if (!projects.some((p) => p.id === projectId)) {
    return reply(404, { error: 'Указанный проект не найден' });
  }

  const subprojects = await readSubprojectsJson();
  if (subprojects.some((s) => s.code === code)) {
    return reply(409, { error: `Код "${code}" уже занят другим подпроектом` });
  }

  const sub = {
    id: crypto.randomUUID(),
    code,
    projectId,
    name,
    isCommon: false,
    createdAt: new Date().toISOString(),
  };
  subprojects.push(sub);
  await writeSubprojectsJson(subprojects);
  return reply(200, { ok: true, subproject: sub });
}

async function handleSubprojectUpdate(event) {
  checkAuth(event);
  const body = JSON.parse(event.body || '{}');
  const id = trimStr(body.id, 80);
  if (!id) return reply(400, { error: 'id обязателен' });

  const subprojects = await readSubprojectsJson();
  const idx = subprojects.findIndex((s) => s.id === id);
  if (idx < 0) return reply(404, { error: 'Подпроект не найден' });

  const patch = {};
  if (body.name !== undefined) {
    const name = trimStr(body.name, 200);
    if (!name) return reply(400, { error: 'name не может быть пустым' });
    patch.name = name;
  }
  if (body.code !== undefined) {
    const code = trimStr(body.code, 80);
    if (!code) return reply(400, { error: 'code не может быть пустым' });
    if (subprojects.some((s, i) => i !== idx && s.code === code)) {
      return reply(409, { error: `Код "${code}" уже занят другим подпроектом` });
    }
    patch.code = code;
  }
  if (body.projectId !== undefined) {
    const projectId = trimStr(body.projectId, 80);
    const projects = await readProjectsJson();
    if (!projects.some((p) => p.id === projectId)) {
      return reply(404, { error: 'Указанный проект не найден' });
    }
    patch.projectId = projectId;
  }
  if (Object.keys(patch).length === 0) {
    return reply(400, { error: 'Нечего обновлять (name, code и/или projectId)' });
  }

  subprojects[idx] = { ...subprojects[idx], ...patch };
  await writeSubprojectsJson(subprojects);
  return reply(200, { ok: true, subproject: subprojects[idx] });
}

async function handleSubprojectDelete(event) {
  checkAuth(event);
  const { id } = JSON.parse(event.body || '{}');
  if (!id) return reply(400, { error: 'id обязателен' });
  if (id === UNKNOWN_COMMON_ID) {
    return reply(400, { error: 'Подпроект Unknown/Common нельзя удалить' });
  }

  const subprojects = await readSubprojectsJson();
  const idx = subprojects.findIndex((s) => s.id === id);
  if (idx < 0) return reply(404, { error: 'Подпроект не найден' });
  if (subprojects[idx].isCommon) {
    return reply(400, { error: 'Common-подпроект нельзя удалить отдельно (удаляется вместе с проектом)' });
  }

  const { models } = await readModelsJson();
  const inUse = models.filter((m) => m.subprojectId === id);
  if (inUse.length > 0) {
    return reply(409, {
      error: `В подпроекте ${inUse.length} модел(ей). Сначала перенесите их в другой подпроект.`,
      modelsCount: inUse.length,
    });
  }

  subprojects.splice(idx, 1);
  await writeSubprojectsJson(subprojects);
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
  const subprojectId = trimStr(body.subprojectId, 80);
  const versionName = trimStr(body.versionName, 200);
  const comment = trimStr(body.comment, 2000);

  if (!name || !format) return reply(400, { error: 'name и format обязательны' });
  if (format !== 'glb' && format !== 'gltf') {
    return reply(400, { error: 'Только glb или gltf' });
  }
  if (!displayName) return reply(400, { error: 'displayName обязателен' });
  if (!subprojectId) return reply(400, { error: 'subprojectId обязателен' });

  const subprojects = await readSubprojectsJson();
  if (!subprojects.some((s) => s.id === subprojectId)) {
    return reply(404, { error: 'Указанный подпроект не найден' });
  }

  const modelDate = normalizeDate(body.modelDate, null);

  const id = crypto.randomUUID();
  const key = `models/${Date.now()}_${safeFileName(name)}`;
  const contentType = format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json';

  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL });

  return reply(200, {
    uploadUrl,
    uploadHeaders: { 'Content-Type': contentType },
    model: {
      id,
      name,               // оригинальное имя файла (для скачивания/диагностики)
      displayName,        // пользовательское имя
      subprojectId,
      modelDate,
      versionName,
      comment,
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
  if (!model || !model.id || !model.key || !model.name || !model.displayName || !model.subprojectId) {
    return reply(400, { error: 'model.{id,key,name,displayName,subprojectId} обязательны' });
  }
  const { models } = await readModelsJson();
  if (models.some((m) => m.id === model.id)) {
    return reply(200, { ok: true, duplicate: true });
  }
  const subprojects = await readSubprojectsJson();
  if (!subprojects.some((s) => s.id === model.subprojectId)) {
    return reply(404, { error: 'Указанный подпроект не найден' });
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

// Обновление полей существующей модели: displayName, subprojectId, modelDate, versionName, comment.
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
  if (body.subprojectId !== undefined) {
    const sid = trimStr(body.subprojectId, 80);
    if (!sid) return reply(400, { error: 'subprojectId не может быть пустым' });
    const subprojects = await readSubprojectsJson();
    if (!subprojects.some((s) => s.id === sid)) {
      return reply(404, { error: 'Указанный подпроект не найден' });
    }
    patch.subprojectId = sid;
  }
  if (body.modelDate !== undefined) patch.modelDate = normalizeDate(body.modelDate, null);
  if (body.versionName !== undefined) patch.versionName = trimStr(body.versionName, 200);
  if (body.comment !== undefined) patch.comment = trimStr(body.comment, 2000);

  if (Object.keys(patch).length === 0) {
    return reply(400, { error: 'Нечего обновлять' });
  }

  const { models } = await readModelsJson();
  const idx = models.findIndex((m) => m.id === id);
  if (idx < 0) return reply(404, { error: 'Модель не найдена' });

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
    if (method === 'GET' && action === 'subprojects') return handleSubprojectsList();

    if (method === 'POST' && action === 'upload') return handleUpload(event);
    if (method === 'POST' && action === 'commit') return handleCommit(event);
    if (method === 'POST' && action === 'delete') return handleDelete(event);
    if (method === 'POST' && action === 'update') return handleModelUpdate(event);

    if (method === 'POST' && action === 'project-create') return handleProjectCreate(event);
    if (method === 'POST' && action === 'project-rename') return handleProjectRename(event);
    if (method === 'POST' && action === 'project-delete') return handleProjectDelete(event);

    if (method === 'POST' && action === 'subproject-create') return handleSubprojectCreate(event);
    if (method === 'POST' && action === 'subproject-update') return handleSubprojectUpdate(event);
    if (method === 'POST' && action === 'subproject-delete') return handleSubprojectDelete(event);

    return reply(404, { error: `Не найдено: ${method} ?action=${action}` });
  } catch (err) {
    console.error('Ошибка обработчика:', err);
    return reply(err.statusCode || 500, { error: err.message || 'internal error' });
  }
};
