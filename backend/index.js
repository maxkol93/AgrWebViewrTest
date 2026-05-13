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

async function readModelsJson() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: MODELS_KEY }));
    const text = await streamToString(res.Body);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return [];
    throw err;
  }
}

async function writeModelsJson(arr) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: MODELS_KEY,
    Body: JSON.stringify(arr, null, 2),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache, max-age=0',
  }));
}

function safeFileName(name) {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 200);
}

function publicUrl(key) {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `${ENDPOINT}/${BUCKET}/${enc}`;
}

async function handleUpload(event) {
  checkAuth(event);
  const body = JSON.parse(event.body || '{}');
  const { name, size, format } = body;
  if (!name || !format) return reply(400, { error: 'name и format обязательны' });
  if (format !== 'glb' && format !== 'gltf') {
    return reply(400, { error: 'Только glb или gltf' });
  }

  const models = await readModelsJson();
  if (models.some((m) => m.name === name)) {
    return reply(409, { error: `Модель с именем "${name}" уже существует` });
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
      name,
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
  if (!model || !model.id || !model.key || !model.name) {
    return reply(400, { error: 'model.{id,key,name} обязательны' });
  }
  const models = await readModelsJson();
  if (models.some((m) => m.id === model.id)) {
    return reply(200, { ok: true, duplicate: true });
  }
  models.unshift(model);
  await writeModelsJson(models);
  return reply(200, { ok: true });
}

async function handleDelete(event) {
  checkAuth(event);
  const { id } = JSON.parse(event.body || '{}');
  if (!id) return reply(400, { error: 'id обязателен' });

  const models = await readModelsJson();
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

async function handleList() {
  const models = await readModelsJson();
  return reply(200, models);
}

exports.handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = (event.path || event.url || '/').replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') return reply(204, '');

  try {
    if (method === 'GET' && (path === '/' || path === '/models')) return handleList();
    if (method === 'POST' && path === '/upload') return handleUpload(event);
    if (method === 'POST' && path === '/commit') return handleCommit(event);
    if (method === 'POST' && path === '/delete') return handleDelete(event);
    return reply(404, { error: `Не найдено: ${method} ${path}` });
  } catch (err) {
    console.error('Ошибка обработчика:', err);
    return reply(err.statusCode || 500, { error: err.message || 'internal error' });
  }
};
