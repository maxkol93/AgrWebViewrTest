// Отчёт по телеметрии загрузки: читает события из telemetry/<дата>/ и показывает,
// на какой фазе у пользователей встаёт загрузка.
//
// События пишет Cloud Function (POST ?action=telemetry), шлёт их браузер
// посетителя один раз за открытие страницы. См. docs/perf-loading-plan.md, п. 1.
//
// Конфигурация из окружения (те же переменные, что у деплоя):
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (опц.), S3_REGION (опц.)
//
// Запуск:
//   . .\deploy\config.dev.ps1; node deploy/telemetry-report.mjs
//   node deploy/telemetry-report.mjs --days 3        — только последние 3 дня (по умолчанию 7)
//   node deploy/telemetry-report.mjs --slowest 20    — длиннее список худших сессий
//   node deploy/telemetry-report.mjs --raw           — вывалить события как JSON (для своих раскопок)
//   node deploy/telemetry-report.mjs --tag me        — только события с меткой me (свой браузер)
//   node deploy/telemetry-report.mjs --no-tag        — только события без метки (живые пользователи)
//
// Метку браузер ставит сам: localStorage.setItem('agrTelemetry', 'me'). Свои открытия
// при этом продолжают писаться — просто отделимы от чужих.
//
// Бакет в РФ доступен только с выключенным VPN, а разбирать удобно потом и где угодно,
// поэтому дамп и отчёт разделены:
//   node deploy/telemetry-report.mjs --raw > events.json   (нужен доступ к бакету)
//   node deploy/telemetry-report.mjs --file events.json    (S3 не нужен вообще)

import { readFile } from 'node:fs/promises';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const PREFIX = 'telemetry/';
const FETCH_CONCURRENCY = 16;

// Порядок фаз = порядок в жизни страницы; так читается как водопад.
const PHASES = [
  ['html', 'index.html'],
  ['deps', 'зависимости'],
  ['catalog', 'каталог'],
  ['glbWait', 'пауза до .glb'],
  ['glbTtfb', '.glb первый байт'],
  ['glbDownload', '.glb скачивание'],
  ['glbParse', 'разбор glTF'],
  ['firstFrame', 'первый кадр'],
  ['total', 'ИТОГО'],
];

const {
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT = 'https://storage.yandexcloud.net',
  S3_REGION = 'ru-central1',
} = process.env;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

function argString(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

const days = argValue('--days', 7);
const slowestCount = argValue('--slowest', 10);
const raw = process.argv.includes('--raw');
const fromFile = argString('--file');
const onlyTag = argString('--tag');
const noTag = process.argv.includes('--no-tag');

if (!fromFile) {
  for (const [name, value] of Object.entries({ S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY })) {
    if (!value) {
      console.error(`✗ Не задана переменная ${name}.`);
      process.exit(1);
    }
  }
}

const s3 = fromFile ? null : new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

// Дни ключей — это UTC-даты (их ставит функция), так и фильтруем.
function sinceDay(n) {
  const d = new Date(Date.now() - (n - 1) * 86400000);
  return d.toISOString().slice(0, 10);
}

async function listKeys(from) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, Prefix: PREFIX, ContinuationToken: token,
    }));
    for (const obj of page.Contents || []) {
      const day = obj.Key.slice(PREFIX.length, PREFIX.length + 10);
      if (day >= from) keys.push(obj.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function readEvents(keys) {
  const events = [];
  let broken = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        events.push(JSON.parse(await res.Body.transformToString()));
      } catch {
        broken++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, keys.length) }, worker));
  return { events, broken };
}

// ── Счёт и вывод ────────────────────────────────────────────────────────────

function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const fmtMs = (v) => (v === undefined ? '—' : (v >= 1000 ? `${(v / 1000).toFixed(1)} с` : `${v} мс`));
const fmtKbps = (v) => (v === undefined ? '—' : (v >= 1000 ? `${(v / 1000).toFixed(1)} Мбит/с` : `${v} кбит/с`));
const fmtMb = (v) => (v ? `${(v / 1024 / 1024).toFixed(1)} МБ` : '—');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function countBy(events, keyFn) {
  const map = new Map();
  for (const e of events) {
    const key = keyFn(e) || '—';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map].sort((a, b) => b[1] - a[1]);
}

function phaseTable(events, title) {
  console.log(`\n${title} (${events.length} шт.)`);
  if (!events.length) return;
  console.log(`  ${pad('фаза', 20)}${padL('p50', 10)}${padL('p90', 10)}${padL('max', 10)}${padL('есть данные', 14)}`);
  for (const [key, label] of PHASES) {
    const values = events.map((e) => e.ms && e.ms[key]).filter((v) => typeof v === 'number');
    if (!values.length) continue;
    console.log(
      `  ${pad(label, 20)}${padL(fmtMs(percentile(values, 0.5)), 10)}` +
      `${padL(fmtMs(percentile(values, 0.9)), 10)}${padL(fmtMs(Math.max(...values)), 10)}` +
      `${padL(`${values.length}/${events.length}`, 14)}`
    );
  }
}

function speedTable(events) {
  const withSpeed = events.filter((e) => e.glbKbps);
  if (!withSpeed.length) return;
  const kbps = withSpeed.map((e) => e.glbKbps);
  const bytes = withSpeed.map((e) => e.glbBytes).filter(Boolean);
  console.log('\nСкорость скачивания .glb');
  console.log(`  p10 ${padL(fmtKbps(percentile(kbps, 0.1)), 14)}   (десятая часть пользователей качает медленнее)`);
  console.log(`  p50 ${padL(fmtKbps(percentile(kbps, 0.5)), 14)}`);
  console.log(`  p90 ${padL(fmtKbps(percentile(kbps, 0.9)), 14)}`);
  if (bytes.length) console.log(`  размер модели: медиана ${fmtMb(percentile(bytes, 0.5))}, максимум ${fmtMb(Math.max(...bytes))}`);
  const cached = events.filter((e) => e.glbCached).length;
  if (cached) console.log(`  из кэша браузера: ${cached} из ${events.length}`);
}

function breakdown(events, title, keyFn) {
  const rows = countBy(events, keyFn);
  if (rows.length <= 1 && rows[0] && rows[0][0] === '—') return;
  console.log(`\n${title}`);
  for (const [key, count] of rows) {
    const group = events.filter((e) => (keyFn(e) || '—') === key);
    const totals = group.map((e) => e.ms && e.ms.total).filter((v) => typeof v === 'number');
    console.log(`  ${pad(key, 24)}${padL(count, 6)}   медиана ИТОГО ${fmtMs(percentile(totals, 0.5))}`);
  }
}

function slowest(events, n) {
  const ranked = events
    .filter((e) => typeof (e.ms && e.ms.total) === 'number')
    .sort((a, b) => b.ms.total - a.ms.total)
    .slice(0, n);
  if (!ranked.length) return;

  console.log(`\nСамые долгие открытия (${ranked.length})`);
  for (const e of ranked) {
    const phases = PHASES
      .filter(([key]) => key !== 'total' && typeof (e.ms && e.ms[key]) === 'number')
      .map(([key, label]) => `${label} ${fmtMs(e.ms[key])}`)
      .join(', ');
    console.log(
      `  ${fmtMs(e.ms.total).padStart(8)}  ${pad(e.outcome || '—', 10)}` +
      `${pad(e.net && e.net.type ? e.net.type : '—', 6)}${pad(e.code || '—', 14)}${e.app || ''}`
    );
    console.log(`            ${phases}`);
    if (e.err) console.log(`            ошибка: ${e.err}`);
  }
}

async function loadFromFile(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('в файле ожидался массив событий (вывод --raw)');
  return { events: parsed, broken: 0 };
}

async function main() {
  let events;
  let broken;

  if (fromFile) {
    console.log(`→ Файл "${fromFile}" (бакет не нужен)`);
    ({ events, broken } = await loadFromFile(fromFile));
  } else {
    const from = sinceDay(days);
    console.log(`→ Бакет "${S3_BUCKET}", события с ${from} (последние ${days} дн.)`);

    const keys = await listKeys(from);
    if (!keys.length) {
      console.log('  Событий нет. Либо телеметрию ещё не деплоили, либо страницу никто не открывал.');
      return;
    }
    ({ events, broken } = await readEvents(keys));
  }

  if (!events.length) {
    console.log('  Событий нет.');
    return;
  }
  if (broken) console.log(`  ! не удалось прочитать событий: ${broken}`);

  // Фильтр по метке применяем и к --raw: дамп «только чужие» бывает нужен чаще отчёта.
  if (onlyTag || noTag) {
    const before = events.length;
    events = events.filter((e) => (onlyTag ? e.tag === onlyTag : !e.tag));
    console.log(`  фильтр по метке: ${onlyTag ? `tag=${onlyTag}` : 'без метки'}` +
      ` — осталось ${events.length} из ${before}`);
    if (!events.length) return;
  }

  if (raw) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  const ok = events.filter((e) => e.outcome === 'ok');
  const stuck = events.filter((e) => e.outcome === 'abandoned' || e.outcome === 'slow');

  console.log(`  событий: ${events.length}, уникальных открытий: ${new Set(events.map((e) => e.sid)).size}`);
  console.log(`  исходы: ${countBy(events, (e) => e.outcome).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('  «abandoned» — ушли, не дождавшись модели; «slow» — через минуту всё ещё грузилось.');

  phaseTable(ok, 'Фазы удачных загрузок');
  speedTable(ok);
  phaseTable(stuck, 'Фазы у тех, кто не дождался');
  breakdown(events, 'По метке браузера («—» = живой пользователь)', (e) => e.tag);
  breakdown(events, 'По типу соединения', (e) => e.net && e.net.type);
  breakdown(events, 'По версии сайта', (e) => e.app);
  breakdown(events, 'По коду модели', (e) => e.code);
  slowest(events, slowestCount);

  console.log('\nПодсказки:');
  console.log('  • «пауза до .glb» большая — время уходит до старта скачивания (резолв кода, 300 мс задержки).');
  console.log('  • «.glb скачивание» большое при малой скорости — упирается в канал: помогут CDN (п. 4) и сжатие модели (п. 6).');
  console.log('  • «разбор glTF» и «первый кадр» большие — упирается в устройство, сеть ни при чём.');
  console.log('  • Много «abandoned» с пустыми фазами после .glb — люди уходят прямо на скачивании.');
}

main().catch((err) => {
  console.error('✗ Ошибка:', err.message || err);
  process.exit(1);
});
