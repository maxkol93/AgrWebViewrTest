import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Объявление переменной до первого использования
let isHelpPanelVisible = false;

// Проверка совместимости с HTML функциями перенесена в основной блок инициализации

// Настройки Yandex Object Storage
let STORAGE_BASE_URL = '';
let API_BASE_URL = '';
let storageConfigured = false;

let fileUploadRequested = false; // Флаг запроса на загрузку файла пользователем

function initStorage() {
    const storageMeta = document.getElementById('storage-base-url');
    const apiMeta = document.getElementById('api-base-url');

    if (storageMeta && storageMeta.getAttribute('content')) {
        STORAGE_BASE_URL = storageMeta.getAttribute('content').replace(/\/+$/, '');
    }
    if (apiMeta && apiMeta.getAttribute('content')) {
        API_BASE_URL = apiMeta.getAttribute('content').replace(/\/+$/, '');
    }

    if (!STORAGE_BASE_URL || !API_BASE_URL ||
        STORAGE_BASE_URL.includes('PLACEHOLDER') || API_BASE_URL.includes('PLACEHOLDER')) {
        console.error('Конфигурация хранилища не настроена. Установите storage-base-url и api-base-url в мета-тегах.');
        storageConfigured = false;
        return false;
    }

    storageConfigured = true;
    console.log('Хранилище:', STORAGE_BASE_URL, 'API:', API_BASE_URL);
    return true;
}

function getAdminToken({ prompt: shouldPrompt = true } = {}) {
    let token = localStorage.getItem('agrAdminToken') || '';
    if (!token && shouldPrompt) {
        token = window.prompt('Введите пароль администратора для загрузки/удаления моделей:') || '';
        if (token) {
            localStorage.setItem('agrAdminToken', token);
            if (typeof updateAdminButtonVisibility === 'function') updateAdminButtonVisibility();
        }
    }
    return token;
}

function clearAdminToken() {
    localStorage.removeItem('agrAdminToken');
    if (typeof updateAdminButtonVisibility === 'function') updateAdminButtonVisibility();
}

async function apiRequest(path, { method = 'GET', body, admin = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) {
        const token = getAdminToken();
        if (!token) throw new Error('Пароль администратора не указан');
        headers['X-Admin-Token'] = token;
    }
    const action = path.replace(/^\/+/, '');
    const url = action ? `${API_BASE_URL}?action=${encodeURIComponent(action)}` : API_BASE_URL;
    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        clearAdminToken();
        throw new Error('Неверный пароль администратора');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

// ─── Телеметрия загрузки ────────────────────────────────────────────────────
// Меряем первую загрузку по фазам и шлём одним событием в Cloud Function
// (?action=telemetry). Без неё не отличить «медленный канал до бакета» от
// «слабое устройство долго разбирает glTF», а жалуются не все.
// См. docs/perf-loading-plan.md, п. 1.
//
// Меряется именно первая загрузка: смена версии в селекторе идёт уже по прогретому
// кэшу зависимостей и о проблеме холодного старта ничего не говорит.

const TELEMETRY_SCHEMA = 3;   // 2 — hiddenMs (вкладка в фоне); 3 — embed/ref (открытие в iframe)
const TELEMETRY_SLOW_MS = 60000;   // столько ждём конца, потом шлём промежуточное событие

const telemetry = {
    sid: Math.random().toString(36).slice(2, 10),
    marks: Object.create(null),
    glbBytes: 0,
    sent: false,
    slowSent: false,
    disabled: false,               // локальный файл или выключено пользователем
    slowTimer: null,
    hiddenMs: 0,                   // сколько вкладка суммарно провела в фоне
    hiddenSince: null,             // момент ухода в фон, null — вкладка на виду
    tag: null,                     // метка из ?tm=, если хранилище недоступно
};

// В стороннем iframe доступ к localStorage может быть запрещён — обращение к нему
// бросает SecurityError. Телеметрия из-за этого молча пропадать не должна, поэтому
// к хранилищу ходим только отсюда.
function lsGet(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function lsSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Нет хранилища — метка живёт до конца этого открытия, и этого достаточно.
    }
}

// Метку своего браузера ставим ссылкой, а не из консоли: ?tm=me помечает открытие
// и запоминается на будущее, ?tm=off выключает отправку. Во встроенном плеере это
// единственный работающий способ — хранилище там своё, отдельное от прямого сайта.
try {
    const tag = (new URLSearchParams(window.location.search).get('tm') || '').trim().slice(0, 20);
    if (tag) {
        telemetry.tag = tag;
        lsSet('agrTelemetry', tag);
    }
} catch {
    // Нет URLSearchParams или запрещён доступ к location — метки просто не будет.
}

// В скрытой вкладке браузер не планирует rAF, поэтому метка firstFrame ждёт
// возврата человека — на практике часами. Считаем время в фоне и шлём его
// полем hiddenMs: без него «первый кадр» и «ИТОГО» меряют не сайт, а то,
// когда пользователь вспомнил про вкладку.
telemetry.hiddenSince = document.visibilityState === 'hidden' ? 0 : null;
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        if (telemetry.hiddenSince === null) telemetry.hiddenSince = performance.now();
    } else if (telemetry.hiddenSince !== null) {
        telemetry.hiddenMs += performance.now() - telemetry.hiddenSince;
        telemetry.hiddenSince = null;
    }
});

// Уход со страницы сам по себе прячет вкладку, и последний отрезок «в фоне»
// длится доли миллисекунды — событие от этого фоновым не становится.
function hiddenMsNow() {
    const pending = telemetry.hiddenSince === null ? 0 : performance.now() - telemetry.hiddenSince;
    return Math.round(telemetry.hiddenMs + pending);
}

// Метка ставится один раз: повторные загрузки не должны переписывать первую.
function tMark(name) {
    if (telemetry.marks[name] === undefined) {
        telemetry.marks[name] = Math.round(performance.now());
    }
}

// Длительность фазы. undefined, если загрузка до неё не дошла, — такие поля
// просто не попадают в событие, и в отчёте видно, где именно всё встало.
function tSpan(from, to) {
    const a = telemetry.marks[from];
    const b = telemetry.marks[to];
    if (a === undefined || b === undefined) return undefined;
    return Math.max(0, b - a);
}

// Зависимости (vendor/* и сама сборка script.<hash>.js) лежат на своём домене,
// поэтому Resource Timing отдаёт по ним и размеры, и признак попадания в кэш.
function depsTiming() {
    let end = 0;
    let bytes = 0;
    let cached = 0;
    let count = 0;
    for (const entry of performance.getEntriesByType('resource')) {
        if (!/\/vendor\/|\/script\.[0-9a-f]+\.js(\?|$)/.test(entry.name)) continue;
        count++;
        end = Math.max(end, entry.responseEnd);
        bytes += entry.encodedBodySize || 0;
        // transferSize === 0 при непустом теле — ответ пришёл из кэша браузера.
        if (entry.transferSize === 0 && entry.decodedBodySize > 0) cached++;
    }
    return { end: count ? Math.round(end) : undefined, bytes, cached, count };
}

// Метка своего браузера. `agrTelemetry = 'off'` по-прежнему выключает отправку,
// любое другое значение уходит полем `tag`: свои открытия видно отдельно от
// пользовательских, но из отчёта они не выпадают — медленная загрузка у автора
// такой же интересный случай, как у всех остальных.
function telemetryTag() {
    const value = (telemetry.tag || lsGet('agrTelemetry') || '').trim();
    return value && value !== 'off' ? value.slice(0, 20) : undefined;
}

// Выключено пользователем. Смотрим и в память тоже: ?tm=off должен работать там,
// где хранилище недоступно.
function telemetryOff() {
    return telemetry.tag === 'off' || lsGet('agrTelemetry') === 'off';
}

// Сервис встраивают в чужие страницы, и открытия оттуда надо отличать от прямых.
// Из источника берём только хост: полный URL чужой страницы — уже слежка, а на
// вопрос «доходят ли события из iframe» отвечает и домен. Признак фрейма — это
// embed: ref заполняется у любого перехода по ссылке, не только из iframe.
function embedInfo() {
    let embed;
    try {
        embed = window.top !== window.self ? true : undefined;
    } catch {
        // Доступ к window.top закрыт — значит, точно не свой верхний уровень.
        embed = true;
    }
    let ref;
    try {
        if (document.referrer) ref = new URL(document.referrer).host.slice(0, 100);
    } catch {
        // Кривой referrer — не повод терять всё событие.
    }
    return { embed, ref };
}

function telemetryPayload(outcome, err) {
    const nav = performance.getEntriesByType('navigation')[0];
    const deps = depsTiming();
    const conn = navigator.connection || {};
    const versionEl = document.getElementById('app-version');
    const glbEntry = currentModelPath
        ? performance.getEntriesByName(currentModelPath).pop()
        : undefined;

    // html и deps считаем от разметки страницы, остальное — между своими метками.
    const htmlMs = nav ? Math.round(nav.responseEnd) : undefined;
    const depsMs = (deps.end !== undefined && htmlMs !== undefined)
        ? Math.max(0, deps.end - htmlMs)
        : undefined;
    const downloadMs = tSpan('glbFirstByte', 'glbDownloaded');
    const endMark = telemetry.marks.firstFrame ?? Math.round(performance.now());

    const ms = {
        html: htmlMs,
        deps: depsMs,
        catalog: tSpan('catalogStart', 'catalogEnd'),
        glbWait: tSpan('catalogEnd', 'glbStart'),
        glbTtfb: tSpan('glbStart', 'glbFirstByte'),
        glbDownload: downloadMs,
        glbParse: tSpan('glbDownloaded', 'glbParsed'),
        firstFrame: tSpan('glbParsed', 'firstFrame'),
        total: endMark,
    };
    for (const key of Object.keys(ms)) {
        if (ms[key] === undefined) delete ms[key];
    }

    return {
        v: TELEMETRY_SCHEMA,
        sid: telemetry.sid,
        ts: new Date().toISOString(),
        app: versionEl ? versionEl.textContent.trim() : '',
        tag: telemetryTag(),
        code: typeof getModelParam === 'function' ? (getModelParam() || '') : '',
        model: currentModelPath ? currentModelPath.split('/').pop().split('?')[0] : '',
        outcome,
        err: err ? String(err).slice(0, 300) : '',
        ms,
        glbBytes: telemetry.glbBytes || undefined,
        // bytes * 8 / ms — это ровно кбит/с, без лишних коэффициентов.
        glbKbps: (telemetry.glbBytes && downloadMs)
            ? Math.round(telemetry.glbBytes * 8 / downloadMs)
            : undefined,
        glbCached: glbEntry && glbEntry.transferSize === 0 && glbEntry.decodedBodySize > 0
            ? true : undefined,
        hiddenMs: hiddenMsNow() || undefined,
        ...embedInfo(),
        depsBytes: deps.bytes || undefined,
        depsCached: deps.cached || undefined,
        net: {
            type: conn.effectiveType || '',
            downlink: conn.downlink,
            rtt: conn.rtt,
            save: conn.saveData === true ? true : undefined,
        },
        dev: {
            mem: navigator.deviceMemory,
            cpu: navigator.hardwareConcurrency,
            dpr: window.devicePixelRatio,
            w: window.screen && window.screen.width,
            h: window.screen && window.screen.height,
            touch: navigator.maxTouchPoints > 0 ? true : undefined,
        },
        ua: navigator.userAgent,
    };
}

// outcome: ok | error | notfound | abandoned | slow.
// Итоговое событие одно на страницу; 'slow' — промежуточное, шлётся отдельно и
// склеивается с итоговым по sid (загрузка могла и не закончиться никогда).
function sendTelemetry(outcome, err) {
    try {
        if (telemetry.disabled || telemetry.sent) return;
        if (outcome === 'slow' && telemetry.slowSent) return;

        // Итог пришёл — промежуточное «slow» больше не нужно, даже если само событие
        // никуда не поедет.
        if (outcome !== 'slow' && telemetry.slowTimer) {
            clearTimeout(telemetry.slowTimer);
            telemetry.slowTimer = null;
        }

        // Причины не отправлять проверяем ДО того, как пометить событие отправленным:
        // иначе первая же осечка глушит телеметрию этого открытия навсегда.
        if (!API_BASE_URL || telemetryOff()) return;

        const url = `${API_BASE_URL}?action=telemetry`;
        // text/plain не вызывает preflight, а sendBeacon переживает закрытие вкладки —
        // именно брошенные загрузки и есть самый интересный случай.
        const blob = new Blob([JSON.stringify(telemetryPayload(outcome, err))],
            { type: 'text/plain;charset=UTF-8' });

        if (outcome === 'slow') telemetry.slowSent = true;
        else telemetry.sent = true;

        if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return;
        fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
    } catch (e) {
        console.warn('Телеметрия не отправлена:', e);
    }
}

function initTelemetry() {
    // Ушёл со страницы, не дождавшись модели, — это и есть жалоба, только молча.
    const flush = () => {
        if (!telemetry.sent) sendTelemetry('abandoned');
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}

// Вкладку могут просто оставить висеть — тогда события не будет вовсе.
function armTelemetrySlowTimer() {
    if (telemetry.slowTimer || telemetry.disabled) return;
    telemetry.slowTimer = setTimeout(() => sendTelemetry('slow'), TELEMETRY_SLOW_MS);
}

// Загрузка списка моделей из Object Storage (прямое чтение models.json)
async function fetchModels() {
    try {
        if (!storageConfigured && !initStorage()) {
            loadModelsFromLocalStorage();
            return;
        }

        document.querySelector('.loading').textContent = 'Загрузка списка моделей...';
        document.querySelector('.loading').style.display = 'block';

        // Параллельно тянем проекты, подпроекты и модели
        tMark('catalogStart');
        const [projectsData, subprojectsData, modelsData] = await Promise.all([
            fetchProjectsRaw(),
            fetchSubprojectsRaw(),
            fetchModelsRaw(),
        ]);
        tMark('catalogEnd');

        userProjects = ensureUnknownLocally(projectsData);
        userSubprojects = ensureUnknownCommonLocally(subprojectsData);
        userModels = modelsData.map(normalizeModelEntry);

        console.log('Получены модели:', userModels.length,
            'проектов:', userProjects.length, 'подпроектов:', userSubprojects.length);

        localStorage.setItem('userModels', JSON.stringify(userModels));
        localStorage.setItem('userProjects', JSON.stringify(userProjects));
        localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
        document.querySelector('.loading').style.display = 'none';
    } catch (error) {
        console.error('Ошибка при получении моделей:', error);
        document.querySelector('.loading').textContent = 'Ошибка загрузки моделей';
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 2000);
        loadModelsFromLocalStorage();
    }
}

// Чтение models.json напрямую из бакета
async function fetchModelsRaw() {
    const res = await fetch(`${STORAGE_BASE_URL}/models.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) return res.json();
    if (res.status === 404) return [];
    throw new Error(`HTTP ${res.status} при чтении models.json`);
}

// Чтение projects.json напрямую из бакета. Если файла нет, вернём [] — проект
// Unknown подмешает ensureUnknownLocally.
async function fetchProjectsRaw() {
    try {
        const res = await fetch(`${STORAGE_BASE_URL}/projects.json?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) return res.json();
        if (res.status === 404) return [];
        throw new Error(`HTTP ${res.status} при чтении projects.json`);
    } catch (e) {
        console.warn('Не удалось загрузить projects.json, использую дефолт:', e);
        return [];
    }
}

// Чтение subprojects.json напрямую из бакета.
async function fetchSubprojectsRaw() {
    try {
        const res = await fetch(`${STORAGE_BASE_URL}/subprojects.json?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) return res.json();
        if (res.status === 404) return [];
        throw new Error(`HTTP ${res.status} при чтении subprojects.json`);
    } catch (e) {
        console.warn('Не удалось загрузить subprojects.json, использую дефолт:', e);
        return [];
    }
}

function ensureUnknownLocally(projects) {
    const arr = Array.isArray(projects) ? projects.slice() : [];
    if (!arr.some((p) => p && p.id === UNKNOWN_PROJECT_ID)) {
        arr.unshift({ id: UNKNOWN_PROJECT_ID, name: UNKNOWN_PROJECT_NAME, createdAt: new Date(0).toISOString() });
    }
    return arr;
}

function ensureUnknownCommonLocally(subprojects) {
    const arr = Array.isArray(subprojects) ? subprojects.slice() : [];
    if (!arr.some((s) => s && s.id === UNKNOWN_COMMON_ID)) {
        arr.unshift({
            id: UNKNOWN_COMMON_ID, code: 'unknown-common', projectId: UNKNOWN_PROJECT_ID,
            name: COMMON_NAME, isCommon: true, createdAt: new Date(0).toISOString(),
        });
    }
    return arr;
}

function normalizeModelEntry(model) {
    if (!model || typeof model !== 'object') return model;
    const m = { ...model };
    m.displayName = m.displayName || m.name || 'Без имени';
    // Обратная совместимость: старое поле projectId больше не используется.
    m.subprojectId = m.subprojectId || UNKNOWN_COMMON_ID;
    if (m.projectId !== undefined) delete m.projectId;
    m.modelDate = normalizeDateStr(m.modelDate, m.uploadedAt);
    m.versionName = m.versionName || '';
    m.comment = m.comment || '';
    return m;
}

// ─── Хелперы доменной модели ────────────────────────────────────────────────

function getProject(projectId) {
    return (userProjects || []).find((p) => p && p.id === projectId) || null;
}
function getProjectName(projectId) {
    const p = getProject(projectId);
    return p ? p.name : UNKNOWN_PROJECT_NAME;
}
function getSubproject(subprojectId) {
    return (userSubprojects || []).find((s) => s && s.id === subprojectId) || null;
}
function getSubprojectByCode(code) {
    const needle = String(code == null ? '' : code).trim();
    if (!needle) return null;
    return (userSubprojects || []).find((s) => s && String(s.code) === needle) || null;
}
function getProjectOfSubproject(sub) {
    return sub ? getProject(sub.projectId) : null;
}
function modelsOfSubproject(subprojectId) {
    return (userModels || [])
        .filter((m) => m && m.subprojectId === subprojectId)
        .sort((a, b) => String(b.modelDate).localeCompare(String(a.modelDate)));
}

// Дата в YYYY-MM-DD (внутренний формат).
function normalizeDateStr(v, fallbackIso) {
    if (typeof v === 'string') {
        const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    const d = fallbackIso ? new Date(fallbackIso) : new Date();
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
}
// Дата для показа: ДД.ММ.ГГГГ.
function formatDateRu(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}

// Статичный лейбл над селектором по согласованному правилу:
//  • Common-подпроект → имя проекта;
//  • имя подпроекта содержит имя проекта → имя подпроекта;
//  • иначе → «Проект — Подпроект».
function computeProjectLabel(sub) {
    if (!sub) return '';
    const project = getProjectOfSubproject(sub);
    const pName = project ? project.name : '';
    const sName = sub.name || '';
    if (sub.isCommon) return pName || sName;
    if (pName && sName.toLowerCase().includes(pName.toLowerCase())) return sName;
    if (!pName) return sName;
    return `${pName} — ${sName}`;
}

// Подпись версии в селекторе: «ДД.ММ.ГГГГ — versionName» (без versionName — только дата).
function formatVersionLabel(model) {
    const date = formatDateRu(model.modelDate);
    const vn = (model.versionName || '').trim();
    return vn ? `${date} — ${vn}` : date;
}

// Загрузка файла модели в Object Storage через подписанный URL от Cloud Function.
// meta: { displayName, subprojectId, versionName?, modelDate?, comment? }
async function uploadModel(file, meta) {
    try {
        if (!storageConfigured && !initStorage()) {
            throw new Error('Хранилище не настроено');
        }
        if (!meta || !meta.displayName) throw new Error('Не задано название модели');
        if (!meta.subprojectId) throw new Error('Не задан подпроект для модели');

        const format = file.name.split('.').pop().toLowerCase();
        if (format !== 'glb' && format !== 'gltf') {
            throw new Error(`Неподдерживаемый формат файла: ${format}. Поддерживаются только GLB и GLTF.`);
        }

        document.querySelector('.loading').textContent = 'Подготовка загрузки...';
        document.querySelector('.loading').style.display = 'block';

        const { uploadUrl, uploadHeaders, model } = await apiRequest('/upload', {
            method: 'POST',
            admin: true,
            body: {
                name: file.name,
                size: file.size,
                format,
                displayName: meta.displayName,
                subprojectId: meta.subprojectId,
                versionName: meta.versionName || '',
                modelDate: meta.modelDate || undefined,
                comment: meta.comment || '',
            },
        });

        document.querySelector('.loading').textContent = 'Загрузка модели на сервер...';

        const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: uploadHeaders || { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
        });
        if (!putRes.ok) throw new Error(`Ошибка загрузки в хранилище: HTTP ${putRes.status}`);

        await apiRequest('/commit', { method: 'POST', admin: true, body: { model } });

        const normalized = normalizeModelEntry(model);
        userModels.unshift(normalized);
        localStorage.setItem('userModels', JSON.stringify(userModels));

        // Обновляем открытые списки; пользовательский вид — если модель в текущем подпроекте.
        refreshAfterModelChange();

        document.querySelector('.loading').textContent = 'Модель успешно загружена!';
        setTimeout(() => { document.querySelector('.loading').style.display = 'none'; }, 1000);

        return normalized;
    } catch (error) {
        console.error('Ошибка при загрузке модели:', error);
        document.querySelector('.loading').textContent = `Ошибка загрузки: ${error.message}`;
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 3000);
        throw error;
    }
}

// Функция обработки выбора файла для загрузки
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Убираем проверку авторизации в Telegram - пользователи могут загружать сразу
    console.log('Начинаем загрузку файла без проверки подписки');

    // Обновляем отображаемое имя файла
    const fileNameElement = document.getElementById('file-name');
    if (fileNameElement) {
        fileNameElement.textContent = file.name;
    }

    // Проверяем размер файла (максимум 50 МБ)
    const maxSize = 1024 * 1024 * 1024; // 1024 в байтах
    if (file.size > maxSize) {
        alert('Файл слишком большой. Максимальный размер: 1024 МБ');
        return;
    }

    // Проверяем формат файла
    const format = file.name.split('.').pop().toLowerCase();
    if (format !== 'glb' && format !== 'gltf') {
        alert('Неподдерживаемый формат файла. Поддерживаются только GLB и GLTF.');
        return;
    }

    // Показываем сообщение о загрузке
    const loadingIndicator = document.querySelector('.loading');
    if (loadingIndicator) {
        loadingIndicator.textContent = 'Загрузка модели...';
        loadingIndicator.style.display = 'block';
    }

    // Проверяем, доступно ли облачное хранилище для загрузки на сервер
    let cloudConfigured = false;
    try {
        cloudConfigured = storageConfigured || initStorage();
    } catch (error) {
        console.error('Ошибка при инициализации хранилища:', error);
        cloudConfigured = false;
    }

    if (cloudConfigured) {
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        openUploadDialog(file).catch((err) => console.error('Ошибка диалога загрузки:', err));
    } else {
        console.log('Хранилище не настроено, загружаем модель локально');
        loadLocalModel(file);
    }
}

// Настраиваем обработчики событий для загрузки файла
function setupFileUploadHandlers() {
    // Удаляем существующие обработчики перед добавлением новых, чтобы избежать дублирования
    const fileInput = document.getElementById('custom-file-upload');
    const fileUploadBtn = document.getElementById('file-upload-btn');
    
    if (fileInput) {
        // Удаляем все существующие обработчики
        const newFileInput = fileInput.cloneNode(true);
        if (fileInput.parentNode) {
            fileInput.parentNode.replaceChild(newFileInput, fileInput);
        }
        
        // Добавляем новый обработчик
        newFileInput.addEventListener('change', handleFileSelectUpgraded);
    }
    
    if (fileUploadBtn) {
        // Удаляем все существующие обработчики
        const newFileUploadBtn = fileUploadBtn.cloneNode(true);
        if (fileUploadBtn.parentNode) {
            fileUploadBtn.parentNode.replaceChild(newFileUploadBtn, fileUploadBtn);
        }
        
        // Добавляем эффект нажатия
        newFileUploadBtn.addEventListener('mousedown', () => {
            newFileUploadBtn.classList.add('button-pressed');
        });

        newFileUploadBtn.addEventListener('mouseup', () => {
            newFileUploadBtn.classList.remove('button-pressed');
        });

        newFileUploadBtn.addEventListener('mouseleave', () => {
            newFileUploadBtn.classList.remove('button-pressed');
        });
        
        // Добавляем активное состояние при клике
        newFileUploadBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            
            // Убираем проверку авторизации и подписки - пользователи могут загружать сразу
            console.log('Открываем диалог выбора файла без проверки подписки');
            
            // Удаляем активное состояние со всех кнопок
            document.querySelectorAll('.control-btn, #share-model-btn, #file-upload-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            
            // Добавляем активное состояние текущей кнопке
            newFileUploadBtn.classList.add('active');
            
            // Убираем активное состояние через короткое время
            setTimeout(() => {
                newFileUploadBtn.classList.remove('active');
            }, 300);
            
            // Открываем диалог выбора файла
            const fileInput = document.getElementById('custom-file-upload');
            if (fileInput) {
                fileInput.click();
            }
        });

        // Обработчики для мобильных устройств
        newFileUploadBtn.addEventListener('touchstart', () => {
            newFileUploadBtn.classList.add('button-pressed');
            newFileUploadBtn.classList.add('active');
        }, { passive: true });

        newFileUploadBtn.addEventListener('touchend', () => {
            newFileUploadBtn.classList.remove('button-pressed');
            setTimeout(() => {
                newFileUploadBtn.classList.remove('active');
            }, 300);
        }, { passive: true });
    }
    
    // Проверяем видимость кнопок загрузки после настройки обработчиков
    setTimeout(function() {
        if (typeof checkAndHideUploadButton === 'function') {
            checkAndHideUploadButton();
        }
    }, 100);
}

// Делаем функцию loadModel доступной глобально
window.loadModel = loadModel;

// Константы доменной модели
const UNKNOWN_PROJECT_ID = 'unknown';
const UNKNOWN_PROJECT_NAME = 'Unknown';
const UNKNOWN_COMMON_ID = 'unknown-common';
const COMMON_NAME = 'Common';

// Переменные для проектов, подпроектов и моделей
let userModels = [];
let userProjects = [];
let userSubprojects = [];

// Текущий контекст пользовательского просмотра (по коду из URL)
let currentSubproject = null;      // объект подпроекта, открытого по коду
let currentSubprojectModels = [];  // его модели, отсортированы новые→старые

// Функция для загрузки данных из localStorage (резервный метод)
function loadModelsFromLocalStorage() {
    try {
        userProjects = ensureUnknownLocally(JSON.parse(localStorage.getItem('userProjects') || 'null'));
        userSubprojects = ensureUnknownCommonLocally(JSON.parse(localStorage.getItem('userSubprojects') || 'null'));
        const savedModels = localStorage.getItem('userModels');
        userModels = savedModels ? JSON.parse(savedModels).map(normalizeModelEntry) : [];
        console.log('Загружено из localStorage моделей:', userModels.length);
    } catch (error) {
        console.error('Ошибка при загрузке из localStorage:', error);
    }
}

// Показывает заглушку «Модель не найдена!» и прячет управление моделью.
function showModelNotFound() {
    currentSubproject = null;
    currentSubprojectModels = [];
    const stub = document.getElementById('model-not-found');
    if (stub) stub.style.display = 'flex';
    ['model-selector', 'project-label', 'model-comment', 'share-model-btn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const loading = document.querySelector('.loading');
    if (loading) loading.style.display = 'none';

    // Тупик резолвера: модели не будет, значит канал свободен — можно за HDR.
    loadEnvironmentHDR();
    sendTelemetry('notfound');
}

// Готовит пользовательский вид для подпроекта: лейбл, селектор версий, коммент.
// Возвращает URL модели по умолчанию (самая свежая) или null, если моделей нет.
function renderSubprojectView(subproject) {
    currentSubproject = subproject;
    const models = modelsOfSubproject(subproject.id);
    currentSubprojectModels = models;

    const stub = document.getElementById('model-not-found');
    if (stub) stub.style.display = 'none';

    // Статичный лейбл проекта/подпроекта
    const label = document.getElementById('project-label');
    if (label) {
        label.textContent = computeProjectLabel(subproject);
        label.style.display = label.textContent ? 'block' : 'none';
    }

    // Опции селектора = версии этого подпроекта (новые сверху)
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.innerHTML = '';
        models.forEach((m) => modelSelect.appendChild(buildVersionOption(m)));
        modelSelect.selectedIndex = models.length ? 0 : -1;
        // Сам выпадающий список нужен только при 2+ версиях
        modelSelect.style.display = models.length >= 2 ? '' : 'none';
    }

    // Карточка видна всегда, пока показан подпроект; скрываем только на «не найдено».
    const selector = document.getElementById('model-selector');
    if (selector) selector.style.display = 'flex';
    const share = document.getElementById('share-model-btn');
    if (share) share.style.display = '';

    updateModelComment();

    return models.length ? models[0].url : null;
}

function buildVersionOption(model) {
    const opt = document.createElement('option');
    opt.value = model.url;
    opt.text = formatVersionLabel(model);
    opt.dataset.format = model.format || '';
    opt.dataset.id = model.id || '';
    opt.dataset.comment = model.comment || '';
    return opt;
}

// Строка-подпись под селектором: комментарий выбранной версии (если есть).
function updateModelComment() {
    const el = document.getElementById('model-comment');
    if (!el) return;
    const modelSelect = document.getElementById('model-select');
    let comment = '';
    if (modelSelect && modelSelect.selectedIndex >= 0) {
        const opt = modelSelect.options[modelSelect.selectedIndex];
        comment = opt ? (opt.dataset.comment || '') : '';
    }
    el.textContent = comment;
    el.style.display = comment ? 'block' : 'none';
}

// Совместимость со старым кодом: перерисовать пользовательский вид по текущему подпроекту.
function rebuildModelSelector() {
    if (!currentSubproject) return;
    const sub = getSubproject(currentSubproject.id);
    if (sub) renderSubprojectView(sub);
}
function clearModelSelector() { rebuildModelSelector(); }
function addModelToSelector() { rebuildModelSelector(); }



// Функция для проверки и скрытия кнопки загрузки модели на мобильных устройствах
function checkAndHideUploadButton() {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    
    // Пробуем как старый, так и новый ID элемента
    const uploadBtns = [
        document.getElementById('custom-model-upload'),
        document.getElementById('upload-model-container')
    ];
    
    // Проверяем и обрабатываем оба возможных элемента
    uploadBtns.forEach(btn => {
        if (btn) {
            if (isMobile) {
                // На мобильных устройствах всегда скрываем
                btn.style.display = 'none';
                btn.style.visibility = 'hidden';
                btn.style.opacity = '0';
                console.log('Проверка: скрываем кнопку загрузки модели (мобильная версия):', btn.id);
            } else {
                // На десктопе показываем, если не открыта панель помощи
                if (isHelpPanelVisible) {
                    btn.style.display = 'none';
                    btn.style.visibility = 'hidden';
                    btn.style.opacity = '0';
                    console.log('Проверка: скрываем кнопку загрузки модели (панель помощи открыта):', btn.id);
                } else {
                    btn.style.display = btn.id === 'upload-model-container' ? 'flex' : 'block';
                    btn.style.visibility = 'visible';
                    btn.style.opacity = '1';
                    console.log('Проверка: показываем кнопку загрузки модели (десктопная версия):', btn.id);
                }
            }
        }
    });
    
    // Также используем класс help-visible для дополнительного скрытия через CSS
    const container = document.getElementById('container');
    if (container && isHelpPanelVisible) {
        container.classList.add('help-visible');
    } else if (container) {
        container.classList.remove('help-visible');
    }
}

// Обновленная функция восстановления интерфейса
function restoreInterfaceVisibility() {
    const modelSelector = document.getElementById('model-selector');
    const controls = document.getElementById('controls');
    const displayMode = document.getElementById('display-mode');
    
    // Проверяем и устанавливаем видимость кнопки загрузки
    checkAndHideUploadButton();
    
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    
    // В полноэкранном режиме на мобильных устройствах - нужно принудительное восстановление
    if (isFullscreenMode && isMobile) {
        if (!isHelpPanelVisible) {
            setTimeout(() => {
                if (modelSelector) modelSelector.setAttribute('style', 'display: flex !important');
                if (controls) controls.setAttribute('style', 'display: flex !important');
                if (displayMode) displayMode.setAttribute('style', 'display: flex !important');
            }, 10);
        }
        return;
    }
    
    // Обычное восстановление для десктопа или не полноэкранного режима
    if (modelSelector) modelSelector.style.display = 'flex';
    if (controls) controls.style.display = 'flex';
    if (displayMode) displayMode.style.display = 'flex';
}

// Модифицируем toggleHelpPanel для использования новой функции
function toggleHelpPanel() {
    const helpPanel = document.getElementById('help-panel');
    const modelSelector = document.getElementById('model-selector');
    const controls = document.getElementById('controls');
    const displayMode = document.getElementById('display-mode');
    const container = document.getElementById('container');
    
    if (!helpPanel) {
        console.error('Панель помощи не найдена');
        return;
    }
    
    isHelpPanelVisible = !isHelpPanelVisible;
    helpPanel.style.display = isHelpPanelVisible ? 'block' : 'none';
    
    console.log('Переключение панели помощи:', isHelpPanelVisible ? 'показать' : 'скрыть');
    
    // Обновляем класс для container для CSS-скрытия кнопки загрузки
    if (container) {
        if (isHelpPanelVisible) {
            container.classList.add('help-visible');
        } else {
            container.classList.remove('help-visible');
        }
    }
    
    // Проверяем и скрываем кнопку загрузки модели
    checkAndHideUploadButton();
    
    // Проверяем, является ли устройство мобильным
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    
    if (isMobile) {
        // На мобильных устройствах скрываем/показываем все остальные элементы интерфейса
        if (modelSelector) {
            modelSelector.style.display = isHelpPanelVisible ? 'none' : 'flex';
        }
        if (controls) {
            controls.style.display = isHelpPanelVisible ? 'none' : 'flex';
        }
        if (displayMode) {
            displayMode.style.display = isHelpPanelVisible ? 'none' : 'flex';
        }
        
        // Принудительно скрываем элементы даже в полноэкранном режиме
        if (isHelpPanelVisible) {
            const style = 'display: none !important; visibility: hidden !important;';
            if (modelSelector) modelSelector.setAttribute('style', style);
            if (controls) controls.setAttribute('style', style);
            if (displayMode) displayMode.setAttribute('style', style);
        } else if (isFullscreenMode) {
            // Если закрываем панель помощи в полноэкранном режиме, восстанавливаем видимость
            setTimeout(() => {
                if (modelSelector) modelSelector.setAttribute('style', 'display: flex !important');
                if (controls) controls.setAttribute('style', 'display: flex !important');
                if (displayMode) displayMode.setAttribute('style', 'display: flex !important');
            }, 10);
        }
    }
}

let container = document.getElementById('container');
let camera, scene, renderer, controls, model, envMap;

// Перспективная камера — основная; ортогональная создаётся лениво под вид сверху.
// Глобальная camera всегда указывает на активную: от неё зависят рендер, рейкасты и WASD.
let perspectiveCamera = null;
let orthoCamera = null;
let isTopView = false;
let customTextures = {};
let modelSelect; 

// Переменные для поддержки анимаций
let mixer, animations = [];
let mixers = [];
let clock = new THREE.Clock();

const originalMaterialProps = new Map();

const edgesGeometryCache = new Map();

let edgesMaterial = null;


let controlMode = 'orbit';

const keyState = {};
let moveSpeed = 5.0;
const MIN_MOVE_SPEED = 0.1;
const MAX_MOVE_SPEED = 10.0;
const MOVE_SPEED_STEP = 0.5;
const MOVE_SPEED_FINE_STEP = 0.1;

// Добавляем новые переменные для инерции движения
const ACCELERATION = 0.25;  // Скорость ускорения
const DECELERATION = 0.15;  // Скорость замедления
let currentVelocity = new THREE.Vector3(0, 0, 0);

let isMouseDown = false;
let mouseX = 0;
let mouseY = 0;
let targetRotationX = 0;
let targetRotationY = 0;
let mouseXOnMouseDown = 0;
let mouseYOnMouseDown = 0;
let targetRotationXOnMouseDown = 0;
let targetRotationYOnMouseDown = 0;
let windowHalfX = window.innerWidth / 2;
let windowHalfY = window.innerHeight / 2;

let initialCameraPosition;
let initialCameraQuaternion;
let initialTarget;

// Выносим обработчики клавиш в отдельные функции для лучшей организации кода
function handleKeyDown(e) {
    // Сначала устанавливаем состояние для любой клавиши
    const key = e.key.toLowerCase();
    keyState[key] = true;
    
    // Для клавиши Shift также устанавливаем обобщенный флаг для удобства проверки
    if (key === 'shift') {
        keyState['shift'] = true;
    }
    
    // Проверяем, не является ли элемент вводом текста
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }
    
    // Обработчик клавиши R для сброса камеры
    if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        console.log('Обработка клавиши R/К в script.js');
        
        // Сбрасываем камеру с анимацией (без параметра)
        resetCamera();
        
        // Включаем автовращение в стандартном режиме
        if (controlMode === 'orbit' && controls) {
            controls.autoRotate = true;
            console.log('Автовращение включено');
        }
    }
    
    // Обработчик клавиши G - переключение между обычным режимом и wasd управлением
    if (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П') {
        console.log('Переключение режима управления');
        toggleControlMode();
    }
    
    // Обработчик клавиши Shift - активируем режим ускорения/специальных возможностей
    if (key === 'shift' && controlMode === 'wasd') {
        // Сохраняем исходную скорость перед умножением
        const oldSpeed = moveSpeed;
        
        // Проверяем, нажаты ли Q/E для активации режима свободного полёта
        const isQEPressed = keyState['q'] || keyState['й'] || keyState['e'] || keyState['у'];
        
        if (isQEPressed) {
            // Если активирован режим свободного полёта, выводим подсказку
            console.log("Активирован режим свободного полёта (Shift+Q/E)");
            
            // Применяем более умеренное ускорение в режиме свободного полёта
            const FREE_FLIGHT_SPEED = 8.0;
            moveSpeed = Math.min(moveSpeed * 1.3, FREE_FLIGHT_SPEED);
        } else {
            // Обычное ускорение при движении с Shift
            const SHIFT_MAX_SPEED = 12.0; // Максимально допустимая скорость при Shift
            moveSpeed = Math.min(moveSpeed * 1.7, SHIFT_MAX_SPEED);
        }
        
        // Сохраняем значение для возврата в handleKeyUp
        keyState['lastSpeedBeforeShift'] = oldSpeed;
        
        updateSpeedIndicator();
    }
}

function handleKeyUp(e) {
    const key = e.key.toLowerCase();
    keyState[key] = false;
    
    // Сбрасываем обобщенный флаг Shift
    if (key === 'shift') {
        keyState['shift'] = false;
    }
    
    // Обработчик клавиши Shift - возврат к нормальной скорости
    if (key === 'shift' && controlMode === 'wasd') {
        // Восстанавливаем сохраненную скорость вместо деления на 2
        if (keyState['lastSpeedBeforeShift'] !== undefined) {
            moveSpeed = keyState['lastSpeedBeforeShift'];
            delete keyState['lastSpeedBeforeShift']; // Очищаем сохраненное значение
        } else {
            moveSpeed /= 1.7; // Запасной вариант, если значение не было сохранено
        }
        
        // Убедимся, что скорость в допустимых пределах
        moveSpeed = Math.round(moveSpeed * 100) / 100;
        updateSpeedIndicator();
    }
}

// Регистрируем глобальные обработчики клавиш
window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', handleKeyUp);

// Направление, с которого смотрим на модель по умолчанию. Дистанция вдоль него
// считается по габаритам и пропорциям окна (см. framingDistance), а не константой:
// на портретном экране кадр уже, и с фиксированной точки модель вылезала за края.
const DEFAULT_VIEW_DIRECTION = new THREE.Vector3(200, 100, 200).normalize();
const FALLBACK_VIEW_DISTANCE = 300;

// Минимальная дистанция, с которой вся модель попадает в кадр. Считаем по восьми углам
// bounding box: для каждого угла нужно, чтобы он уложился и по вертикали, и по горизонтали.
// Сфера дала бы более грубую оценку и отодвигала камеру дальше, чем нужно.
function framingDistance() {
    if (!model || !perspectiveCamera) return FALLBACK_VIEW_DISTANCE;

    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return FALLBACK_VIEW_DISTANCE;

    const center = box.getCenter(new THREE.Vector3());
    const forward = DEFAULT_VIEW_DIRECTION.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const aspect = perspectiveCamera.aspect || 1;
    const vTan = Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov) / 2);
    const hTan = vTan * aspect;

    let needed = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
        corner.set(
            (i & 1) ? box.max.x : box.min.x,
            (i & 2) ? box.max.y : box.min.y,
            (i & 4) ? box.max.z : box.min.z
        ).sub(center);

        const depth = corner.dot(forward);
        needed = Math.max(
            needed,
            Math.abs(corner.dot(up)) / vTan - depth,
            Math.abs(corner.dot(right)) / hTan - depth
        );
    }

    return needed * 1.06; // немного воздуха по краям
}

function setupInitialCameraState() {
    initialCameraPosition = DEFAULT_VIEW_DIRECTION.clone().multiplyScalar(framingDistance());
    initialTarget = new THREE.Vector3(0, 0, 0);
    
    const direction = new THREE.Vector3().subVectors(initialTarget, initialCameraPosition).normalize();
    initialCameraQuaternion = new THREE.Quaternion();
    
    const lookAtMatrix = new THREE.Matrix4();
    lookAtMatrix.lookAt(initialCameraPosition, initialTarget, new THREE.Vector3(0, 1, 0));
    
    initialCameraQuaternion.setFromRotationMatrix(lookAtMatrix);
}

function handleMouseWheel(event) {
    if (controlMode !== 'wasd') return;
    
    // Предотвращаем действие при наведении на UI элементы
    if (isUIElement(event.target)) return;
    
    // Предотвращаем стандартное поведение страницы при прокрутке
    event.preventDefault();
    
    // Определяем направление прокрутки
    const delta = Math.sign(event.deltaY);
    
    // ИСПРАВЛЕНИЕ: установим жесткое ограничение максимального значения скорости
    const ABSOLUTE_MAX_SPEED = 12.0; // Строгий верхний предел
    const ABSOLUTE_MIN_SPEED = 0.1;  // Строгий нижний предел
    
    // Определяем шаг изменения скорости в зависимости от режима
    // Значительно уменьшаем шаг при зажатом Shift для более точного контроля
    const fineStep = event.shiftKey ? MOVE_SPEED_FINE_STEP * 0.25 : MOVE_SPEED_FINE_STEP;
    const normalStep = event.shiftKey ? MOVE_SPEED_STEP * 0.25 : MOVE_SPEED_STEP;
    
    // Сохраняем текущую скорость для проверки изменений
    const oldSpeed = moveSpeed;
    
    if (delta < 0) {
        // Увеличение скорости (прокрутка от себя)
        if (moveSpeed < 0.5) {
            // Очень точное управление на низких скоростях
            const speedFactor = 1.0 + (moveSpeed * 1.5); // Снижен с 2.0 для более плавного изменения
            moveSpeed = Math.min(moveSpeed + fineStep * speedFactor, 0.5);
        } else {
            // Более плавное увеличение на средних скоростях
            const speedFactor = 1.0 + ((moveSpeed - 0.5) / MAX_MOVE_SPEED) * 0.7; // Снижен коэффициент
            moveSpeed = Math.min(moveSpeed + normalStep * speedFactor, MAX_MOVE_SPEED);
        }
    } else {
        // Уменьшение скорости (прокрутка к себе)
        if (moveSpeed > 0.5) {
            // Быстрое замедление на высоких скоростях
            const speedFactor = 1.0 + ((moveSpeed - 0.5) / MAX_MOVE_SPEED) * 1.5; // Снижен с 2.0
            moveSpeed = Math.max(moveSpeed - normalStep * speedFactor, 0.5);
        } else {
            // Плавное замедление на низких скоростях для точного контроля
            const speedFactor = 0.5 + moveSpeed * 0.8; // Снижен коэффициент
            moveSpeed = Math.max(moveSpeed - fineStep * speedFactor, MIN_MOVE_SPEED);
        }
    }
    
    // ИСПРАВЛЕНИЕ: Дополнительная проверка на выход значения за допустимые пределы
    moveSpeed = Math.max(ABSOLUTE_MIN_SPEED, Math.min(ABSOLUTE_MAX_SPEED, moveSpeed));
    
    // Округляем скорость до 2-х знаков после запятой для стабильности отображения
    moveSpeed = Math.round(moveSpeed * 100) / 100;
    
    // Логируем значительные изменения скорости (для контроля)
    if (Math.abs(moveSpeed - oldSpeed) > 0.3) {
        console.log(`Изменение скорости: ${oldSpeed.toFixed(2)} → ${moveSpeed.toFixed(2)}`);
    }
    
    // Обновляем индикатор скорости
    updateSpeedIndicator();
}

function updateSpeedIndicator() {
    const speedIndicator = document.getElementById('speed-indicator');
    if (speedIndicator) {
        speedIndicator.textContent = moveSpeed.toFixed(1);
        
        if (moveSpeed < 3) {
            speedIndicator.style.color = '#4CAF50';
        } else if (moveSpeed < 10) {
            speedIndicator.style.color = '#FFC107';
        } else {
            speedIndicator.style.color = '#F44336';
        }
    }
}

function toggleControlMode() {
    if (controlMode === 'orbit') {
        // Переключаемся в режим WASD
        controlMode = 'wasd';
        
        // В WASD летаем только перспективной камерой
        exitTopViewImmediate();
        
        // Показываем индикатор скорости
        const speedControl = document.getElementById('speed-control');
        if (speedControl) speedControl.style.display = 'inline-block';
        
        // Отключаем автовращение
        controls.autoRotate = false;
        
        // Сохраняем текущее состояние камеры для плавного перехода
        const currentCameraQuaternion = camera.quaternion.clone();
        const currentPosition = camera.position.clone();
        
        // Отключаем стандартные контролы и их ограничения
        controls.enabled = false;
        
        // Отключаем все полярные ограничения OrbitControls, чтобы они не влияли на WASD режим
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI;
        
        // Извлекаем Эйлеровы углы из текущей ориентации камеры
        // Используем порядок YXZ для правильной работы с камерой от первого лица
        const euler = new THREE.Euler().setFromQuaternion(currentCameraQuaternion, 'YXZ');
        
        // Устанавливаем начальные углы для WASD-режима
        targetRotationX = euler.y; // Поворот по горизонтали (рысканье)
        targetRotationY = euler.x; // Поворот по вертикали (тангаж)
        
        // Полностью обнуляем вектор скорости при переключении режима
        currentVelocity = new THREE.Vector3(0, 0, 0);
        

        
        // Добавляем обработчик для начального нажатия мыши, только на контейнер
        // Остальные обработчики (mousemove, mouseup) добавляются динамически в handleMouseDown
        // Это предотвращает конфликты и улучшает обработку событий мыши
        container.addEventListener('mousedown', handleMouseDown);
        
        // Добавляем обработчик колесика мыши для изменения скорости
        container.addEventListener('wheel', handleMouseWheel);
        
        // Настраиваем обработчики клавиатуры для WASD-режима
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        
        // Обновляем текст кнопки
        document.getElementById('toggle-control').textContent = 'Обычное управление';
        
        // Инициализируем точку, на которую смотрит камера
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        controls.target.copy(camera.position.clone().add(forward.multiplyScalar(100)));
    } else {
        // Переключаемся обратно в орбитальный режим
        controlMode = 'orbit';
        
        // Скрываем индикатор скорости
        const speedControl = document.getElementById('speed-control');
        if (speedControl) speedControl.style.display = 'none';
        
        // Полностью обнуляем вектор скорости
        currentVelocity = new THREE.Vector3(0, 0, 0);
        
        // Камеру оставляем там, где пользователь остановился: раньше здесь стоял
        // camera.position.copy(initialCameraPosition), и переключение режима отбрасывало
        // на старт всё, что человек прошёл пешком. Обратный переход позицию сохранял —
        // теперь оба направления ведут себя одинаково.
        
        // Включаем стандартные контролы
        controls.enabled = true;
        
        // Ограничения полюсов сняты и здесь — см. настройку контролов в init()
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI;
        
        // Цель орбиты — перед камерой, на комфортной дистанции обзора, чтобы вращение
        // началось вокруг того, на что человек смотрел в WASD, а не вокруг центра сцены.
        const forwardOnExit = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const exitTarget = camera.position.clone().add(forwardOnExit.multiplyScalar(100));
        controls.target.copy(exitTarget);
        
        // Автоповорот не включаем: человек пришёл сюда из ручного управления,
        // самопроизвольное вращение читается как потеря контроля.
        controls.autoRotate = false;
        
        // Обновляем контролы для применения изменений
        controls.update();
        
        // Удаляем обработчик событий мыши
        // Только mousedown нужно удалить, поскольку остальные добавляются/удаляются динамически
        container.removeEventListener('mousedown', handleMouseDown);
        
        // На всякий случай удаляем обработчики с document, если они были активны
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('mouseleave', onMouseUp);
        
        // Удаляем обработчик колесика мыши
        container.removeEventListener('wheel', handleMouseWheel);
        
        // Удаляем обработчики клавиатуры
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);
        
        // Обновляем текст кнопки
        document.getElementById('toggle-control').textContent = 'WASD управление';
    }
}

function handleMouseDown(event) {
    if (!isUIElement(event.target) && controlMode === 'wasd') {
        event.preventDefault();
        isMouseDown = true;
        
        // Сохраняем начальные координаты мыши для последующих расчетов движения
        mouseXOnMouseDown = event.clientX - windowHalfX;
        mouseYOnMouseDown = event.clientY - windowHalfY;
        
        // Сохраняем текущую ориентацию камеры как основу для новой
        targetRotationXOnMouseDown = targetRotationX;
        targetRotationYOnMouseDown = targetRotationY;
        
        // Добавляем обработчики на document для надежного отслеживания мыши
        // даже если курсор уходит за пределы контейнера
        document.addEventListener('mousemove', onMouseMove, { passive: false });
        document.addEventListener('mouseup', onMouseUp, { passive: false });
        document.addEventListener('mouseleave', onMouseUp, { passive: false });
    }
}

function isUIElement(element) {
    while (element) {
        if (element.id === 'model-selector' || 
            element.id === 'controls' || 
            element.id === 'display-mode' ||
            element.id === 'display-mode-buttons' ||
            element.id === 'help-icon' || 
            element.id === 'help-panel' ||
            element.id === 'model-select' ||
                            element.id === 'share-model-btn' ||
            element.id === 'reset-camera' ||
            element.id === 'toggle-control' ||
            element.id === 'speed-control' ||
            element.id === 'skipHDR' ||
            element.classList.contains('control-btn') ||
            element.classList.contains('display-mode-btn') ||
            element.classList.contains('help-row') ||
            element.classList.contains('help-section') ||
            element.tagName === 'BUTTON' ||
            element.tagName === 'SELECT' || 
            element.tagName === 'OPTION' ||
            element.tagName === 'LABEL' ||
            element.tagName === 'INPUT') {
            return true;
        }
        element = element.parentElement;
    }
    return false;
}

function onMouseMove(event) {
    if (controlMode !== 'wasd' || !isMouseDown) return;
    
    if (isUIElement(event.target)) return;
    
    // Получаем текущие координаты мыши
    mouseX = event.clientX - windowHalfX;
    mouseY = event.clientY - windowHalfY;
    
    // Определяем, насколько мышь сдвинулась с начала нажатия
    const movementX = mouseX - mouseXOnMouseDown;
    const movementY = mouseY - mouseYOnMouseDown;
    
    // Устанавливаем чувствительность вращения по запросу пользователя
    const rotationSpeedX = 0.0045; // Установлено точное значение по запросу
    const rotationSpeedY = 0.0045; // Установлено точное значение по запросу
    
    // Обновляем ТОЛЬКО значения targetRotation без ограничений
    targetRotationX = targetRotationXOnMouseDown - movementX * rotationSpeedX;
    targetRotationY = targetRotationYOnMouseDown - movementY * rotationSpeedY;
    
    // Нормализуем горизонтальный угол по модулю 2π
    targetRotationX = ((targetRotationX % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    
    // Отменяем ВСЕ ограничения на вертикальный угол
    // Разрешаем полный диапазон -π до +π (от -180° до +180°)
    

}

function onMouseUp() {
    if (controlMode !== 'wasd') return;
    
    // Снимаем флаг нажатия мыши
    isMouseDown = false;
    
    // Очищаем обработчики, добавленные в handleMouseDown
    // Это предотвращает накопление дублирующихся обработчиков
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('mouseleave', onMouseUp);
}

function updateWASDControls() {
    if (!camera || !controls) return;
    if (controlMode !== 'wasd') return;
    
    // ===== ПОЛНОСТЬЮ ПЕРЕПИСАННАЯ СИСТЕМА ВРАЩЕНИЯ КАМЕРЫ =====
    if (camera) {
        // Защита от NaN значений
        if (isNaN(targetRotationY) || !isFinite(targetRotationY)) {
            targetRotationY = 0;
        }
        
        if (isNaN(targetRotationX) || !isFinite(targetRotationX)) {
            targetRotationX = 0;
        }
        
        // Горизонтальное вращение может превышать 360°, нормализуем для предотвращения проблем
        targetRotationX = ((targetRotationX % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        
        // ===== РАДИКАЛЬНОЕ РЕШЕНИЕ: ПОЛНОЕ ОТСУТСТВИЕ ОГРАНИЧЕНИЙ =====
        // Разрешаем поворот камеры на любые углы - даже больше 180°
        // Вместо Эйлеровых углов, переключаемся на прямое применение кватернионов
        
        // Создаем вращения отдельно для каждой оси
        const quaternionX = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),  // Ось Y - горизонтальное вращение
            targetRotationX
        );
        
        const quaternionY = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0),  // Ось X - вертикальное вращение
            targetRotationY
        );
        
        // Комбинируем оба кватерниона, применяя сначала горизонтальный поворот, затем вертикальный
        const combinedQuaternion = new THREE.Quaternion().multiplyQuaternions(quaternionX, quaternionY);
        
        // Устанавливаем кватернион камеры напрямую
        camera.quaternion.copy(combinedQuaternion);
        
        // Обновляем точку, на которую смотрит камера
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        controls.target.copy(camera.position).add(forward.multiplyScalar(100));
    }
    
    // ===== Обработка движения камеры =====
    // Получаем направления движения на основе текущей ориентации камеры
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0); // Мировой вектор "вверх"
    
    // Нормализуем векторы направления для корректных расчетов
    forward.normalize();
    right.normalize();
    
    // Целевой вектор движения на основе нажатых клавиш
    const targetMoveVector = new THREE.Vector3(0, 0, 0);
    
    // Обрабатываем нажатия клавиш WASD и их аналоги на русской клавиатуре
    // Теперь движение W/S происходит точно в направлении взгляда камеры (включая вверх/вниз)
    if (keyState['w'] || keyState['ц']) {
        targetMoveVector.add(forward); // Используем полный вектор направления
    }
    if (keyState['s'] || keyState['ы']) {
        targetMoveVector.sub(forward); // Используем полный вектор направления
    }
    
    // Боковое движение A/D остается в горизонтальной плоскости для удобства управления
    if (keyState['a'] || keyState['ф']) {
        targetMoveVector.sub(right);
    }
    if (keyState['d'] || keyState['в']) {
        targetMoveVector.add(right);
    }
    
    // Вертикальное движение при нажатии Q и E
    if (keyState['q'] || keyState['й']) {
        targetMoveVector.y -= 1;
    }
    if (keyState['e'] || keyState['у']) {
        targetMoveVector.y += 1;
    }
    
    // Проверка на диагональное движение
    if (targetMoveVector.length() > 0) {
        // Нормализуем вектор движения и применяем скорость
        targetMoveVector.normalize().multiplyScalar(moveSpeed);
    }
    
    // ===== Система инерции движения =====
    // Применяем плавное ускорение/замедление с интерполяцией
    // Улучшенная версия с асимптотической интерполяцией
    
    // Обновляем компоненты скорости с различными факторами для разных осей
    // X и Z (горизонтальное движение)
    if (Math.abs(targetMoveVector.x - currentVelocity.x) > 0.001) {
        if (Math.abs(targetMoveVector.x) > Math.abs(currentVelocity.x)) {
            // Более плавное ускорение с учетом текущей скорости для естественного разгона
            const accelFactor = ACCELERATION * (1 - Math.abs(currentVelocity.x / moveSpeed) * 0.5);
            currentVelocity.x += (targetMoveVector.x - currentVelocity.x) * accelFactor;
        } else {
            // Торможение зависит от скорости - быстрее останавливаемся на высоких скоростях
            const decelFactor = DECELERATION * (1 + Math.abs(currentVelocity.x / moveSpeed) * 1.5);
            currentVelocity.x += (targetMoveVector.x - currentVelocity.x) * decelFactor;
        }
    } else {
        // Если разница минимальна, просто устанавливаем целевое значение
        currentVelocity.x = targetMoveVector.x;
    }
    
    // Z компонента (вперед/назад)
    if (Math.abs(targetMoveVector.z - currentVelocity.z) > 0.001) {
        if (Math.abs(targetMoveVector.z) > Math.abs(currentVelocity.z)) {
            const accelFactor = ACCELERATION * (1 - Math.abs(currentVelocity.z / moveSpeed) * 0.5);
            currentVelocity.z += (targetMoveVector.z - currentVelocity.z) * accelFactor;
        } else {
            const decelFactor = DECELERATION * (1 + Math.abs(currentVelocity.z / moveSpeed) * 1.5);
            currentVelocity.z += (targetMoveVector.z - currentVelocity.z) * decelFactor;
        }
    } else {
        currentVelocity.z = targetMoveVector.z;
    }
    
    // Y компонента (вверх/вниз)
    // Вертикальное движение имеет особую обработку для предотвращения "флоатинга"
    if (Math.abs(targetMoveVector.y - currentVelocity.y) > 0.001) {
        if (Math.abs(targetMoveVector.y) > Math.abs(currentVelocity.y)) {
            // Более быстрое ускорение по вертикали для лучшей отзывчивости
            currentVelocity.y += (targetMoveVector.y - currentVelocity.y) * (ACCELERATION * 1.2);
        } else {
            // Более быстрое замедление по вертикали для предотвращения "флоатинга"
            currentVelocity.y += (targetMoveVector.y - currentVelocity.y) * (DECELERATION * 1.5);
        }
    } else {
        currentVelocity.y = targetMoveVector.y;
    }
    
    // ===== Применение движения с улучшенной обработкой коллизий =====
    // Если скорость достаточна для движения
    if (currentVelocity.lengthSq() > 0.0001) {
        // Сохраняем текущую позицию для проверки коллизий и возможного отката
        const originalPosition = camera.position.clone();
        
        // Создаем временную позицию после применения скорости
        const newPosition = originalPosition.clone().add(currentVelocity);
        
        // УДАЛЯЕМ ограничение минимальной высоты
        // Теперь камера может свободно перемещаться вниз без ограничений
        
        // Улучшенная пошаговая проверка коллизий для предотвращения "прохождения сквозь стены"
        // Проверяем каждую ось отдельно, что позволяет лучше обрабатывать углы и узкие проходы
        
        // 1. Сначала проверяем вертикальное движение (ось Y)
        let tempPosition = originalPosition.clone();
        tempPosition.y = newPosition.y;
        tempPosition = checkCollisions(originalPosition, tempPosition);
        
        // 2. Затем проверяем горизонтальное движение (оси X и Z) из позиции с уже примененной вертикальной коррекцией
        // Проверяем X и Z по отдельности для лучшей обработки углов
        let finalPosition = tempPosition.clone();
        
        // 2.1 Проверка оси X
        let xPosition = tempPosition.clone();
        xPosition.x = newPosition.x;
        xPosition = checkCollisions(tempPosition, xPosition);
        
        // 2.2 Проверка оси Z из позиции с уже примененной X-коррекцией
        finalPosition = xPosition.clone();
        finalPosition.z = newPosition.z;
        finalPosition = checkCollisions(xPosition, finalPosition);
        
        // Если после всех проверок позиция отличается от исходной
        if (!finalPosition.equals(originalPosition)) {
            // Рассчитываем фактический вектор движения после коллизий
            const actualMovement = new THREE.Vector3().subVectors(finalPosition, originalPosition);
            
            // Применяем перемещение к камере
            camera.position.copy(finalPosition);
            
            // Обновляем цель для контроллера
            controls.target.copy(controls.target.clone().add(actualMovement));
            
            // Добавляем более интеллектуальную корректировку скорости на основе фактического движения
            // Для каждой оси проверяем, насколько фактическое движение меньше ожидаемого
            const movementFractionX = Math.abs(currentVelocity.x) < 0.001 ? 1 : 
                                     Math.abs(actualMovement.x) / Math.abs(currentVelocity.x);
            const movementFractionY = Math.abs(currentVelocity.y) < 0.001 ? 1 : 
                                     Math.abs(actualMovement.y) / Math.abs(currentVelocity.y);
            const movementFractionZ = Math.abs(currentVelocity.z) < 0.001 ? 1 : 
                                     Math.abs(actualMovement.z) / Math.abs(currentVelocity.z);
            
            // Если движение по оси было ограничено коллизией более чем на 20%,
            // значительно уменьшаем скорость по этой оси
            if (movementFractionX < 0.8) currentVelocity.x *= 0.1;
            if (movementFractionY < 0.8) currentVelocity.y *= 0.1;
            if (movementFractionZ < 0.8) currentVelocity.z *= 0.1;
        }
    }
}

let currentModelPath = '';

// Ставится при первом жесте по сцене: после него автоматическое кадрирование
// (в onWindowResize) больше не двигает камеру за пользователя.
let userMovedCamera = false;

const USE_HDR = true;
// Список HDR карт (лежат в Object Storage под префиксом environments/)
const HDR_MAPS = [
    { name: 'Закат', path: 'sunset.hdr' },
    { name: 'День',  path: 'day.hdr' },
    { name: 'Ночь',  path: 'night.hdr' }
];

let currentHdrIndex = 0;

function getHdrUrl(path) {
    if (!storageConfigured && !initStorage()) {
        throw new Error('Хранилище не настроено, невозможно получить URL HDR');
    }
    return `${STORAGE_BASE_URL}/environments/${path}`;
}

// Плотность пикселей: выше двойки разница уже не видна, а на телефоне с dpr 3 это
// в 2.25 раза больше работы на каждый кадр.
function cappedPixelRatio() {
    const limit = window.matchMedia('(max-width: 768px)').matches ? 1.5 : 2;
    return Math.min(window.devicePixelRatio || 1, limit);
}

// Инициализация 3D сцены перенесена в основной блок DOMContentLoaded

async function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.15); // Уменьшено с 0.3
    scene.add(hemiLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.1); // Уменьшено с 0.2
    scene.add(ambientLight);
    
    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.25); // Уменьшено с 0.5
    directionalLight1.position.set(1, 1, 1);
    scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.15); // Уменьшено с 0.3
    directionalLight2.position.set(-1, 0.5, -1);
    scene.add(directionalLight2);
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    perspectiveCamera = camera;
    
    setupInitialCameraState();
    camera.position.copy(initialCameraPosition);
    
    renderer = new THREE.WebGLRenderer({ 
        antialias: true,
        alpha: false,  // Отключаем alpha-канал - как в оригинальной версии
        preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(cappedPixelRatio());
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    
    // Ни один источник не отбрасывает тени, поэтому карта теней сейчас только числится
    // включённой. Настоящие тени — этап B (статическая карта), там же и включим.
    renderer.shadowMap.enabled = false;
    
    // Базовые настройки для прозрачности - как в оригинальной версии
    renderer.sortObjects = true;
    // Удаляем установку clearColor, чтобы использовать scene.background
    
    renderer.autoClearColor = true;
    renderer.autoClear = true;
    renderer.autoClearDepth = true;
    
    container.appendChild(renderer.domElement);
    
    container.addEventListener('wheel', function(event) {
        event.preventDefault();
    }, { passive: false });
    
    container.addEventListener('contextmenu', function(event) {
        event.preventDefault();
    });
    
    container.addEventListener('mousedown', function(event) {
        if (event.button === 1) {
            event.preventDefault();
        }
    });
    
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = true;
    // Модель нормализована в куб 200 единиц (см. loadModel), поэтому границы заданы
    // от этого габарита: 0.2 — вплотную к детали, 1200 — вся сцена с запасом.
    controls.minDistance = 0.2;
    controls.maxDistance = 1200;
    // Полюса не ограничиваем: нужен и вид сверху (план площадки), и взгляд снизу.
    // OrbitControls сам клампит полюс на EPS, отдельная защита не нужна.
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    controls.enableZoom = true;
    controls.zoomSpeed = 0.9; // Шаг колеса: 0.55 был слишком мелким
    controls.rotateSpeed = 1.0;
    controls.panSpeed = 0.5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.0;
    
    // Включаем зум к курсору только для колесика мыши
    controls.zoomToCursor = true;

    // ЛКМ таскает, ПКМ вращает: люди привыкли перемещать левой. Вращение правой
    // кнопкой обрабатываем сами (см. beginCursorRotate) — ему нужен центр под
    // курсором, а OrbitControls всегда центрирует цель через lookAt(target).
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: -1
    };

    // На тач-экране та же логика: один палец — перемещение, два — вращение с зумом.
    // Свой pinch-обработчик убран (он двигал camera.position параллельно с DOLLY_PAN).
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    
    // Оставляем стандартное поведение OrbitControls для средней кнопки мыши
    
    // capture: наш обработчик должен успеть переставить цель до того, как
    // OrbitControls запомнит стартовую сферу вращения
    renderer.domElement.addEventListener('pointerdown', updateOrbitPivot, true);
    renderer.domElement.addEventListener('dblclick', handlePivotDoubleClick);
    renderer.domElement.addEventListener('pointerdown', beginCursorRotate);
    renderer.domElement.addEventListener('pointermove', moveCursorRotate);
    renderer.domElement.addEventListener('pointerup', endCursorRotate);
    renderer.domElement.addEventListener('pointercancel', endCursorRotate);
    renderer.domElement.addEventListener('pointerdown', () => { cameraFlightCancelled = true; });

    container.addEventListener('mousedown', disableAutoRotate);
    container.addEventListener('wheel', disableAutoRotate);
    container.addEventListener('touchstart', disableAutoRotate);
    
    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    
    window.addEventListener('resize', onWindowResize);

    createEnvironment();
    
    // Загрузка модели по URL параметру теперь происходит только в DOMContentLoaded
    
    loadModel();
}

function createEnvironment() {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const skipHDRButton = document.getElementById('skipHDR');
    if (skipHDRButton) {
        skipHDRButton.style.display = 'none'; // Всегда скрываем кнопку пропуска HDR
    }

    // Стартуем на базовом окружении: оно считается на месте, без сети.
    // HDR (несжатый RGBE, несколько МБ) подтягиваем уже после модели —
    // иначе он выгрызает канал ровно тогда, когда качается .glb.
    // См. docs/perf-loading-plan.md, п. 5.
    createBasicEnvironment(pmremGenerator);
}

// Материалы модели берут освещение из scene.environment (свой envMap им никто
// не присваивает), поэтому подмена карты после загрузки видна сразу.
let hdrRequested = false;

function loadEnvironmentHDR() {
    if (!USE_HDR || hdrRequested || !renderer) return;
    hdrRequested = true;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const rgbeLoader = new RGBELoader();
    rgbeLoader.setDataType(THREE.HalfFloatType);

    loadHDR(getHdrUrl(HDR_MAPS[currentHdrIndex].path), pmremGenerator, rgbeLoader, true);
}

function loadHDR(hdrPath, pmremGenerator, rgbeLoader, hdrLoading) {
    const skipHDRButton = document.getElementById('skipHDR');
    
    rgbeLoader.load(hdrPath, function(texture) {
        if (!hdrLoading) return;
        
        document.getElementById('skipHDR').style.display = 'none';
        
        // Увеличиваем интенсивность HDR текстуры
        texture.intensity = 1.0; // Увеличиваем с 0.5 для более яркого освещения от HDR
        
        const pmremGeneratorOptions = pmremGenerator.fromEquirectangular(texture);
        envMap = pmremGeneratorOptions.texture;
        
        scene.environment = envMap;
        scene.background = new THREE.Color(0x1a1a1a);
        
        // Настраиваем тональное отображение для баланса яркости
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0; // Увеличиваем с 0.7 для более яркого общего освещения
        
        texture.dispose();
        pmremGenerator.dispose();
        
        // Скрываем индикатор загрузки если это инициализация страницы
        const loadingElement = document.querySelector('.loading');
        if (loadingElement && loadingElement.textContent.includes('Загрузка карты окружения')) {
            loadingElement.textContent = 'Загрузка модели...';
        }
        
    }, 
    function(xhr) {
        // Скрываем процесс загрузки HDR
        // Не показываем процент загрузки пользователю
    },
    function(error) {
        if (!hdrLoading) return;
        console.error('Ошибка загрузки HDR:', error);
        skipHDRButton.style.display = 'none';
        createBasicEnvironment(pmremGenerator);
    });
}

// Функция для смены HDR карты
function changeHDR(index) {
    if (index < 0 || index >= HDR_MAPS.length) return;
    
    currentHdrIndex = index;
    hdrRequested = true; // выбор пользователя важнее отложенной автозагрузки

    // Обновляем UI, чтобы отметить активную карту
    updateHDRInterface();

    // Загружаем новую HDR карту
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    
    const rgbeLoader = new RGBELoader();
    rgbeLoader.setDataType(THREE.HalfFloatType);
    
    // Загружаем HDR без отображения процесса загрузки
    loadHDR(getHdrUrl(HDR_MAPS[currentHdrIndex].path), pmremGenerator, rgbeLoader, true);
}

// Функция для создания интерфейса HDR
function setupHDRInterface() {
    // Получаем существующий контейнер режимов отображения
    const displayModeContainer = document.getElementById('display-mode');
    if (!displayModeContainer) return;
    
    // Полностью очищаем контейнер перед добавлением новых элементов
    displayModeContainer.innerHTML = '';
    
    // Устанавливаем явные стили для контейнера
    displayModeContainer.style.display = 'flex';
    displayModeContainer.style.flexDirection = 'row';
    displayModeContainer.style.width = 'auto';
    displayModeContainer.style.minWidth = '480px';
    displayModeContainer.style.maxWidth = '550px';
    displayModeContainer.style.gap = '20px';
    displayModeContainer.style.padding = '15px';
    
    // Создаем правую часть для HDR кнопок
    const displayModeRight = document.createElement('div');
    displayModeRight.className = 'display-mode-right';
    displayModeRight.style.display = 'flex';
    displayModeRight.style.flexDirection = 'column';
    displayModeRight.style.gap = '12px';
    displayModeRight.style.flex = '1';
    
    // Добавляем заголовок для освещения
    const hdrTitle = document.createElement('div');
    hdrTitle.textContent = 'Освещение';
    hdrTitle.style.fontSize = '14px';
    hdrTitle.style.fontWeight = '500';
    hdrTitle.style.marginBottom = '10px';
    hdrTitle.style.textAlign = 'center';
    hdrTitle.style.width = '100%';
    hdrTitle.style.color = 'white';
    displayModeRight.appendChild(hdrTitle);
    
    // Добавляем контейнер для кнопок HDR
    const hdrButtons = document.createElement('div');
    hdrButtons.id = 'hdr-buttons';
    hdrButtons.style.display = 'flex';
    hdrButtons.style.flexDirection = 'column';
    hdrButtons.style.gap = '8px';
    hdrButtons.style.width = '100%';
    displayModeRight.appendChild(hdrButtons);
    
    // Добавляем кнопки для каждой HDR карты
    HDR_MAPS.forEach((hdr, index) => {
        const button = document.createElement('button');
        button.className = 'display-mode-btn hdr-btn';
        button.dataset.hdrIndex = index;
        button.textContent = hdr.name;
        
        // Добавляем класс active для текущей HDR карты
        if (index === currentHdrIndex) {
            button.classList.add('active');
        }
        
        // Добавляем обработчик клика
        button.addEventListener('click', function() {
            const currentHdrButton = hdrButtons.querySelector('.hdr-btn.active');
            if (currentHdrButton) {
                currentHdrButton.classList.remove('active');
            }
            
            button.classList.add('active');
            changeHDR(index);
        });
        
        hdrButtons.appendChild(button);
    });
    
    // Колонка «Отображение» удалена вместе с режимами; осталось освещение
    displayModeContainer.appendChild(displayModeRight);
    
    // Добавляем обработку нажатия клавиш для переключения HDR
    document.addEventListener('keydown', function(e) {
        // Клавиши 4, 5, 6 для переключения HDR
        if (e.key >= '4' && e.key <= '6') {
            const index = parseInt(e.key) - 4;
            if (index >= 0 && index < HDR_MAPS.length) {
                // Находим и симулируем клик на соответствующей кнопке
                const hdrBtn = document.querySelector(`.hdr-btn[data-hdr-index="${index}"]`);
                if (hdrBtn) hdrBtn.click();
            }
        }
    });
    
    // Добавляем информацию в панель помощи
    updateHelpPanel();
}

// Функция для обновления панели помощи
function updateHelpPanel() {
    const helpPanel = document.getElementById('help-panel');
    if (!helpPanel) return;
    
    // Проверяем, существует ли уже раздел с HDR
    let hdrSection = Array.from(helpPanel.querySelectorAll('h4')).find(h4 => h4.textContent === 'Освещение');
    
    if (!hdrSection) {
        // Создаем новый раздел для HDR
        const section = document.createElement('div');
        section.className = 'help-section';
        
        const title = document.createElement('h4');
        title.textContent = 'Освещение';
        section.appendChild(title);
        
        // Добавляем описания для каждой HDR карты
        HDR_MAPS.forEach((hdr, index) => {
            const row = document.createElement('div');
            row.className = 'help-row';
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = hdr.name;
            
            const keySpan = document.createElement('span');
            keySpan.textContent = (index + 4).toString();
            
            row.appendChild(nameSpan);
            row.appendChild(keySpan);
            
            section.appendChild(row);
        });
    }
}

function createBasicEnvironment(pmremGenerator) {
    
    const envScene = new THREE.Scene();
    
    // Увеличиваем яркость полусферического освещения для лучшей детализации
    const envLight = new THREE.HemisphereLight(0xffffff, 0x444444, 3.2); // Увеличено с 2.5
    envScene.add(envLight);
    
    // Настраиваем более теплый основной свет
    const light1 = new THREE.DirectionalLight(0xffeedd, 2.5); // Изменяем цвет на более теплый и увеличиваем интенсивность
    light1.position.set(5, 5, 5);
    envScene.add(light1);
    
    // Добавляем голубоватый заполняющий свет для баланса
    const light2 = new THREE.DirectionalLight(0xaaccff, 1.8); // Увеличено с 1.5
    light2.position.set(-5, 5, -5);
    envScene.add(light2);
    
    // Добавляем дополнительный мягкий свет снизу для лучшей детализации в тенях
    const fillLight = new THREE.DirectionalLight(0xffffee, 0.5);
    fillLight.position.set(0, -5, 0);
    envScene.add(fillLight);
    

    envMap = pmremGenerator.fromScene(envScene).texture;
    scene.environment = envMap;
    

    pmremGenerator.dispose();
    

    document.querySelector('.loading').textContent = 'Загрузка модели...';
}

function animateFirstView() {

    if (controlMode === 'wasd') {
        

        camera.position.copy(initialCameraPosition);
        camera.quaternion.copy(initialCameraQuaternion);
        

        const euler = new THREE.Euler().setFromQuaternion(initialCameraQuaternion, 'YXZ');
        targetRotationX = euler.y;
        targetRotationY = euler.x;
        
        
        return;
    }
    


    let animationCancelled = false;
    

    const targetPosition = initialCameraPosition.clone();
    

    const startPosition = new THREE.Vector3(0, 300, 0);
    camera.position.copy(startPosition);
    

    camera.lookAt(0, 0, 0);
    
    const duration = 2000; // ms - время анимации
    const startTime = performance.now();
    

    if (controlMode === 'orbit') {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 2.0;
        
    }
    

    const cancelAnimation = () => {
        if (!animationCancelled) {
            animationCancelled = true;
            
            

            if (controlMode === 'orbit') {
                controls.autoRotateSpeed = 1.0;
            }
        }
    };
    

    container.addEventListener('mousedown', cancelAnimation, { once: true });
    container.addEventListener('touchstart', cancelAnimation, { once: true });
    window.addEventListener('keydown', cancelAnimation, { once: true });
    

    const wheelHandler = () => cancelAnimation();
    container.addEventListener('wheel', wheelHandler, { once: true });
    
    function animateCamera(time) {
        if (animationCancelled) return;
        
        const elapsed = time - startTime;
        const progress = Math.min(elapsed / duration, 1);
        

        const easeProgress = 1 - Math.pow(1 - progress, 3); // cubic ease out
        

        camera.position.lerpVectors(startPosition, targetPosition, easeProgress);
        

        controls.target.set(0, 0, 0);
        controls.update();
        

        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        } else {

            if (controlMode === 'orbit') {
                controls.autoRotateSpeed = 1.0;
                
            }
            
            controls.target.copy(initialTarget);
            controls.update();
            

            container.removeEventListener('mousedown', cancelAnimation);
            container.removeEventListener('touchstart', cancelAnimation);
            window.removeEventListener('keydown', cancelAnimation);
            container.removeEventListener('wheel', wheelHandler);
        }
    }
    
    requestAnimationFrame(animateCamera);
}

// Добавляем перехватчик для FBXLoader перед функцией loadModel
// Освобождает GPU-ресурсы (геометрии и текстуры) объекта, который не попал на сцену.
function disposeObject3D(root) {
    if (!root || typeof root.traverse !== 'function') return;
    root.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.geometry) obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
        materials.forEach((mat) => {
            if (!mat) return;
            if (mat.map) mat.map.dispose();
            if (mat.normalMap) mat.normalMap.dispose();
            if (mat.metalnessMap) mat.metalnessMap.dispose();
            if (mat.roughnessMap) mat.roughnessMap.dispose();
            mat.dispose();
        });
    });
}

// Токен поколения загрузки: защищает от гонки при параллельных вызовах loadModel().
// Каждый вызов захватывает свой токен; если стартовала более новая загрузка,
// устаревшая игнорирует свой прогресс и не трогает сцену.
let currentLoadToken = 0;

async function loadModel() {
    // Проверяем что scene инициализирован
    if (!scene) {
        console.error('Scene не инициализирован. Загрузка модели отменена.');
        return null;
    }

    // Захватываем идентичность этой загрузки: свой токен и путь на момент старта.
    const loadToken = ++currentLoadToken;
    const pathToLoad = currentModelPath;

    // Пустой путь: сцена стартует без модели (модель покажет резолвер по коду).
    // HDR тут не трогаем: через 300 мс резолвер начнёт качать .glb, и HDR
    // отобрал бы у него канал — ровно то, от чего мы уходим.
    if (!pathToLoad) {
        const loading = document.querySelector('.loading');
        if (loading) loading.style.display = 'none';
        return null;
    }

    // Определяем формат файла более безопасным способом
    let fileFormat = '';

    try {
        // Получаем формат из расширения URL более надежным способом
        if (pathToLoad && typeof pathToLoad === 'string') {
            // Удаляем все параметры URL и hash
            const cleanPath = pathToLoad.split('?')[0].split('#')[0];
            // Получаем последнюю часть пути (имя файла)
            const fileName = cleanPath.split('/').pop();
            
            if (fileName && fileName.includes('.')) {
                // Получаем расширение файла
                fileFormat = fileName.split('.').pop().toLowerCase();
                console.log('Определен формат файла из URL:', fileFormat);
            }
        }
        
        // Если формат не определен из URL, проверяем есть ли информация в элементе select
        if (!fileFormat || (fileFormat !== 'glb' && fileFormat !== 'gltf')) {
            const modelSelect = document.getElementById('model-select');
            if (modelSelect) {
                const selectedOption = modelSelect.options[modelSelect.selectedIndex];
                if (selectedOption && selectedOption.dataset.format) {
                    fileFormat = selectedOption.dataset.format.toLowerCase();
                    console.log('Определен формат файла из data-атрибута:', fileFormat);
                }
            }
        }
        
        const isLocalFile = pathToLoad.startsWith('blob:');

        // Свой файл с диска про сеть ничего не говорит — телеметрию для него не шлём.
        if (isLocalFile) telemetry.disabled = true;

        document.querySelector('.loading').textContent = isLocalFile
            ? 'Загрузка пользовательской модели...' 
            : 'Загрузка модели...';
        document.querySelector('.loading').style.display = 'block';
        
        let loadedModel;
        
        // Проверяем, что формат поддерживается (только GLB/GLTF)
        if (fileFormat !== 'glb' && fileFormat !== 'gltf') {
            console.error(`Определен формат файла: "${fileFormat}"`);
            throw new Error(`Формат ${fileFormat || 'неизвестный'} не поддерживается. Используйте только GLB или GLTF.`);
        }

        // Используем GLTFLoader для GLTF/GLB
        const loader = new GLTFLoader();
        const dracoLoader = new DRACOLoader();
        // Декодер лежит рядом с сайтом, а не на www.gstatic.com: при недоступном
        // gstatic .glb докачивался до 100% и намертво вставал на декодировании.
        dracoLoader.setDecoderPath('./vendor/draco/');
        loader.setDRACOLoader(dracoLoader);
        
        tMark('glbStart');
        armTelemetrySlowTimer();

        const gltf = await loader.loadAsync(pathToLoad, function(xhr) {
            // Игнорируем прогресс устаревшей загрузки, чтобы проценты не «скакали»
            // между двумя параллельными скачиваниями.
            if (loadToken !== currentLoadToken) return;
            tMark('glbFirstByte');
            if (xhr.total) {
                telemetry.glbBytes = xhr.total;
                if (xhr.loaded >= xhr.total) tMark('glbDownloaded');
            }
            if (isLocalFile) {
                const loaded = xhr.loaded / (1024 * 1024);
                document.querySelector('.loading').textContent = `Загрузка: ${loaded.toFixed(2)} МБ`;
            } else {
                const percent = Math.floor((xhr.loaded / xhr.total) * 100);
                document.querySelector('.loading').textContent = `Загрузка GLTF/GLB: ${percent}%`;
            }
        });

        tMark('glbParsed');

        // Если пока мы скачивали, стартовала более новая загрузка — эта устарела.
        // Освобождаем ресурсы скачанной модели и выходим, не трогая сцену.
        if (loadToken !== currentLoadToken) {
            console.log('Загрузка устарела, результат отброшен:', pathToLoad);
            disposeObject3D(gltf.scene);
            return null;
        }

        loadedModel = gltf.scene;

        // Если в сцене уже есть модель, удаляем ее и очищаем ресурсы
        if (model && scene) {
            scene.remove(model);
            
            // Очищаем аниматоры
            mixers = [];
            animations = [];

            model.traverse((obj) => {
                if (obj.isMesh) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach(mat => {
                                if (mat.map) mat.map.dispose();
                                if (mat.normalMap) mat.normalMap.dispose();
                                if (mat.metalnessMap) mat.metalnessMap.dispose();
                                if (mat.roughnessMap) mat.roughnessMap.dispose();
                                mat.dispose();
                            });
                        } else {
                            if (obj.material.map) obj.material.map.dispose();
                            if (obj.material.normalMap) obj.material.normalMap.dispose();
                            if (obj.material.metalnessMap) obj.material.metalnessMap.dispose();
                            if (obj.material.roughnessMap) obj.material.roughnessMap.dispose();
                            obj.material.dispose();
                        }
                    }
                }
            });
            
            clearEdgesCache();
        }
        
        // Устанавливаем загруженную модель в качестве текущей
        model = loadedModel;
        
        // Обработка анимаций
        if (gltf.animations && gltf.animations.length > 0) {
            animations = gltf.animations;
            mixer = new THREE.AnimationMixer(model);
            mixers.push(mixer);
            
            console.log(`Загружено ${animations.length} анимаций`);
            
            // Запускаем первую анимацию по умолчанию в циклическом режиме
            if (animations.length > 0) {
                const action = mixer.clipAction(animations[0]);
                action.loop = THREE.LoopRepeat;  // Включаем циклическое воспроизведение
                action.play();
                console.log('Воспроизводится анимация в циклическом режиме:', animations[0].name || 'Безымянная');
            }
        } else {
            console.log('Анимации в модели не найдены');
        }
        
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 200 / maxDim;
        model.scale.set(scale, scale, scale);
        
        model.position.x = -center.x * scale;
        model.position.y = -center.y * scale;
        model.position.z = -center.z * scale;
        
        // Оптимизируем обработку прозрачных объектов
        // Создаем список объектов для разделения прозрачных и непрозрачных частей
        let transparentObjects = [];
        let opaqueObjects = [];
        
        model.traverse((object) => {
            if (object.isMesh) {
                // Проверяем прозрачность материала
                if (Array.isArray(object.material)) {
                    // Для мешей с несколькими материалами
                    let hasTransparent = false;
                    object.material.forEach(mat => {
                        if (mat.transparent || (mat.opacity && mat.opacity < 1.0)) {
                            hasTransparent = true;
                        }
                    });
                    
                    if (hasTransparent) {
                        // Для мешей с прозрачными материалами
                        transparentObjects.push(object);
                        object.renderOrder = 1; // Рендерим после непрозрачных
                    } else {
                        opaqueObjects.push(object);
                        object.renderOrder = 0;
                    }
                } else if (object.material) {
                    // Для мешей с одним материалом
                    if (object.material.transparent || (object.material.opacity && object.material.opacity < 1.0)) {
                        transparentObjects.push(object);
                        // Упрощаем настройки для прозрачных объектов, как в оригинальной версии
                        object.renderOrder = 1;
                        
                        // Упрощаем настройки для прозрачных материалов
                        object.material.depthWrite = true;
                        object.material.depthTest = true;
                        object.material.alphaTest = 0.5;
                    } else {
                        opaqueObjects.push(object);
                        object.renderOrder = 0;
                    }
                }
                
                // Удаляем специальную обработку прозрачных объектов если она есть
                if (object.hasOwnProperty('onBeforeRender')) {
                    delete object.onBeforeRender;
                }
            }
        });
        
        // Добавляем модель на сцену (с проверками)
        if (scene && model) {
            scene.add(model);

            // Первый кадр с моделью: двойной rAF, чтобы метка встала уже после
            // того, как кадр отрисован, а не перед ним.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                tMark('firstFrame');
                sendTelemetry('ok');
            }));

            // Гарантируем одностороннее отображение всех материалов
            forceFrontSideMaterials();
            
            // Устанавливаем одинаковую интенсивность отражений для всех материалов
            model.traverse((node) => {
            if (node.isMesh && node.material) {
                if (Array.isArray(node.material)) {
                    node.material.forEach(mat => {
                        if (typeof mat.envMapIntensity !== 'undefined') {
                            mat.envMapIntensity = 0.5; // Контролируем интенсивность отражений
                        }
                    });
                } else if (typeof node.material.envMapIntensity !== 'undefined') {
                    node.material.envMapIntensity = 0.5; // Контролируем интенсивность отражений
                }
            }
        });
        
        saveOriginalMaterialsState();
        
        // Новая модель — новое кадрирование: до первого жеста им снова управляем мы
        userMovedCamera = false;
        setupInitialCameraState();
        
        if (controlMode === 'wasd') {
            camera.position.copy(initialCameraPosition);
            camera.quaternion.copy(initialCameraQuaternion);
            
            const euler = new THREE.Euler().setFromQuaternion(initialCameraQuaternion, 'YXZ');
            targetRotationX = euler.y;
            targetRotationY = euler.x;
            
            document.querySelector('.loading').style.display = 'none';
            
        } else {
            document.querySelector('.loading').style.display = 'none';
            animateFirstView();
        }
        
        document.querySelector('.loading').style.display = 'none';
        
        // Если это локальный файл, обновляем выпадающий список и добавляем пользовательскую опцию
        if (isLocalFile) {
            const fileName = pathToLoad.split('/').pop().split('#')[0];
            
            // Проверка наличия пользовательской опции в селекте
            let customOption = Array.from(modelSelect.options).find(option => option.value === 'custom');
            
            if (!customOption) {
                customOption = document.createElement('option');
                customOption.value = 'custom';
                customOption.text = 'Пользовательская модель';
                modelSelect.add(customOption, 0);
            }
            
            // Устанавливаем выбранную опцию
            modelSelect.value = 'custom';
        }
        } else {
            console.error('Scene или model не определены при добавлении на сцену');
        }
        
        return model;
    } catch (error) {
        console.error('Ошибка при загрузке модели:', error);
        document.querySelector('.loading').textContent = 'Ошибка загрузки модели: ' + error.message;
        sendTelemetry('error', error && error.message);

        // Кнопка загрузки модели заменена на кнопку "Поделиться"
    } finally {
        // Модель своё уже скачала (или упала) — теперь можно занять канал под HDR.
        if (loadToken === currentLoadToken) loadEnvironmentHDR();
    }
}

function processEmbeddedMaterial(material, meshName) {
    const processedMaterial = material.clone();

    processedMaterial.envMap = envMap;
    processedMaterial.envMapIntensity = 0.5; // Уменьшаем с 1.0 для снижения интенсивности отражений
    processedMaterial.side = THREE.FrontSide;
    processedMaterial.transparent = material.transparent;
    processedMaterial.depthWrite = true;
    
    // Настройки для прозрачных материалов - из оригинальной версии
    if (material.transparent) {
        processedMaterial.alphaTest = 0.5;
        processedMaterial.depthWrite = true;
    }
    
    // Базовые настройки для всех типов материалов
    if (processedMaterial.map) {
        processedMaterial.map.colorSpace = THREE.SRGBColorSpace;
        processedMaterial.map.minFilter = THREE.LinearFilter;
        processedMaterial.map.magFilter = THREE.LinearFilter;
        processedMaterial.map.generateMipmaps = true;
    }
    
    // Улучшенная обработка карт нормалей и других текстур
    if (processedMaterial.normalMap) {
        processedMaterial.normalMap.colorSpace = THREE.NoColorSpace;
        processedMaterial.normalMap.minFilter = THREE.LinearFilter;
        processedMaterial.normalMap.magFilter = THREE.LinearFilter;
    }
            
    if (processedMaterial.metalnessMap) {
        processedMaterial.metalnessMap.colorSpace = THREE.NoColorSpace;
        processedMaterial.metalnessMap.minFilter = THREE.LinearFilter;
        processedMaterial.metalnessMap.magFilter = THREE.LinearFilter;
    }
            
    if (processedMaterial.roughnessMap) {
        processedMaterial.roughnessMap.colorSpace = THREE.NoColorSpace;
        processedMaterial.roughnessMap.minFilter = THREE.LinearFilter;
        processedMaterial.roughnessMap.magFilter = THREE.LinearFilter;
    }

    // Если у материала нет карты шероховатости, увеличиваем базовую шероховатость 
    // для дальнейшего снижения резкости отражений
    if (!processedMaterial.roughnessMap && typeof processedMaterial.roughness !== 'undefined') {
        const currentRoughness = processedMaterial.roughness;
        processedMaterial.roughness = Math.min(currentRoughness + 0.15, 1.0);
    }

    processedMaterial.needsUpdate = true;
    
    return processedMaterial;
}

function onWindowResize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    if (perspectiveCamera) {
        perspectiveCamera.aspect = width / height;
        perspectiveCamera.updateProjectionMatrix();
    }
    updateOrthoFrustum();
    
    // Кэп повторяем и здесь: при переносе окна между экранами devicePixelRatio меняется
    renderer.setPixelRatio(cappedPixelRatio());
    renderer.setSize(width, height);
    
    // Пока пользователь не трогал камеру, держим модель вписанной в кадр: поворот
    // телефона в портрет иначе обрезает её по краям. После первого жеста не вмешиваемся.
    if (!userMovedCamera && !isTopView && controlMode === 'orbit' && model && controls) {
        setupInitialCameraState();
        camera.position.copy(initialCameraPosition);
        controls.target.copy(initialTarget);
        controls.update();
    }
    

    windowHalfX = width / 2;
    windowHalfY = height / 2;
}

function animate() {
    requestAnimationFrame(animate);

    // Обновляем все аниматоры
    const delta = clock.getDelta();
    if (mixers.length > 0) {
        for (const mixer of mixers) {
            mixer.update(delta);
        }
    }

    updateCursorRotateGlide();

    if (controls) controls.update();

    updateWASDControls();

    if (renderer && scene && camera) renderer.render(scene, camera);
}

// Добавляем функциональность UI элементов
function setupUI() {
    console.log('Инициализация UI...');
    // Получаем элементы управления
    const topViewButton = document.getElementById('top-view');
    if (topViewButton) {
        topViewButton.addEventListener('click', toggleTopView);
        updateTopViewButton();
    }
    
    const resetCameraButton = document.getElementById('reset-camera');
    const toggleControlButton = document.getElementById('toggle-control');
    const helpIcon = document.getElementById('help-icon');
    const helpPanel = document.getElementById('help-panel');
    modelSelect = document.getElementById('model-select'); // Присваиваем глобальной переменной
    // Кнопка загрузки модели заменена на кнопку "Поделиться"
    
    // Получаем кнопку загрузки пользовательской модели (проверяем оба ID)
    const customUploadButtons = [
        document.getElementById('custom-model-upload'),
        document.getElementById('upload-model-container')
    ];
    
    // Проверяем существование контейнера
    const container = document.getElementById('container');
    if (container) {
        // Инициализируем класс help-visible в соответствии с текущим состоянием
        if (isHelpPanelVisible) {
            container.classList.add('help-visible');
        } else {
            container.classList.remove('help-visible');
        }
    }
    
    // Проверяем наличие кнопок интерфейса и регистрируем ошибки
    if (!helpIcon) {
        console.error('Кнопка помощи не найдена!');
    } else {
        console.log('Кнопка помощи найдена, привязываем обработчики...');
    }
    
    if (!helpPanel) {
        console.error('Панель помощи не найдена!');
    }
    
    // Запускаем проверку и установку видимости кнопки загрузки модели
    checkAndHideUploadButton();
    
    // Настраиваем кнопку "Поделиться моделью"
    setupShareButton();
    
    // Обработчик кнопки загрузки модели убран - модели теперь выбираются автоматически при клике в списке
    
    // Сброс камеры
    resetCameraButton.addEventListener('click', function() {
        // Принудительно сбрасываем состояние всех кнопок
        resetButtonStates();
        
        // Добавляем активное состояние (только подсветка)
        this.classList.add('active');
        
        // Добавляем визуальное нажатие
        this.classList.add('button-pressed');
        
        // Принудительно запрашиваем перерисовку DOM
        this.offsetHeight;
        
        // Сбрасываем камеру
        resetCamera();
        
        // Включаем автовращение при сбросе камеры в обычном режиме
        if (controlMode === 'orbit') {
            controls.autoRotate = true;
        }
        
        // Удаляем эффект нажатия и активное состояние через короткое время
        setTimeout(() => {
            this.classList.remove('button-active-animation');
            this.classList.remove('button-pressed');
            this.classList.remove('active');
            
            // Принудительно возвращаем яркий цвет
            this.style.backgroundColor = '#4285f4';
        }, 300);
    });
    
    // Вспомогательная функция для сброса состояния всех кнопок
    function resetButtonStates() {
        // Сбрасываем состояние кнопок управления (убираем только анимацию)
        document.querySelectorAll('.control-btn, #share-model-btn').forEach(btn => {
            btn.classList.remove('button-active-animation');
            btn.classList.remove('button-pressed');
            // Возвращаем яркий цвет
            btn.style.backgroundColor = '#4285f4';
        });
    }
    
    // Добавляем функцию для переключения активных кнопок
    function setActiveButton(button) {
        // Удаляем класс active со всех кнопок
        document.querySelectorAll('.control-btn, #share-model-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Добавляем класс active только на нажатую кнопку
        button.classList.add('active');
    }
    
    // Переключение режима управления
    toggleControlButton.addEventListener('click', toggleControlMode);
    
    // Полностью переписываем обработчик для кнопки вопроса
    if (helpIcon) {
        // Удаляем все существующие обработчики
        const helpIconClone = helpIcon.cloneNode(true);
        if (helpIcon.parentNode) {
            helpIcon.parentNode.replaceChild(helpIconClone, helpIcon);
        }
        
        // Обновляем ссылку на кнопку
        const newHelpIcon = document.getElementById('help-icon');
        if (newHelpIcon) {
            console.log('Привязываем новый обработчик клика для кнопки помощи');
            
            // Добавляем простой обработчик клика
            newHelpIcon.onclick = function(event) {
                console.log('Клик по кнопке помощи (desktop)');
                event.preventDefault();
                event.stopPropagation();
                toggleHelpPanel();
                // Проверяем видимость кнопки загрузки после переключения панели помощи
                setTimeout(checkAndHideUploadButton, 50);
                return false;
            };
        } else {
            console.error('Не удалось найти клонированную кнопку помощи!');
        }
    }
    
    // Кнопка загрузки файлов настраивается в setupFileUploadHandlers()
    
    // Проверяем видимость кнопки загрузки в конце настройки UI
    setTimeout(checkAndHideUploadButton, 100);
    
    // Добавляем интерфейс HDR
    setupHDRInterface();
    
    // Настраиваем кнопки управления анимацией
    setupAnimationControls();
}



if (document.readyState === 'loading') {
    // Убрано дублирование DOMContentLoaded - вся инициализация в основном блоке
}

function loadSelectedModel() {
    const selectedModelPath = modelSelect.value;
    if (selectedModelPath && selectedModelPath !== currentModelPath) {


        if (model) {
            scene.remove(model);

            model.traverse((obj) => {
                if (obj.isMesh) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach(mat => {
                                if (mat.map) mat.map.dispose();
                                if (mat.normalMap) mat.normalMap.dispose();
                                if (mat.metalnessMap) mat.metalnessMap.dispose();
                                if (mat.roughnessMap) mat.roughnessMap.dispose();
                                mat.dispose();
                            });
                        } else {
                            if (obj.material.map) obj.material.map.dispose();
                            if (obj.material.normalMap) obj.material.normalMap.dispose();
                            if (obj.material.metalnessMap) obj.material.metalnessMap.dispose();
                            if (obj.material.roughnessMap) obj.material.roughnessMap.dispose();
                            obj.material.dispose();
                        }
                    }
                }
            });
            

            clearEdgesCache();
        }
        

        document.querySelector('.loading').textContent = 'Загрузка модели...';
        document.querySelector('.loading').style.display = 'block';
        

        // Блокировка кнопки загрузки модели убрана - кнопка заменена на "Поделиться"
        

        currentModelPath = selectedModelPath;
        
        // Проверяем что scene инициализирован
        if (!scene) {
            console.error('Scene не инициализирован, не можем загрузить модель');
            return;
        }

        if (controlMode === 'orbit') {
            controls.autoRotate = true;
            
        }
        

        loadModel().then(() => {
            
            

            // Кнопка loadModelButton заменена на кнопку "Поделиться"
            

        }).catch(error => {
            console.error('Ошибка при загрузке модели:', error);
            

            // Кнопка loadModelButton заменена на кнопку "Поделиться"
        });
    }
}

function resetCamera(immediate = false) {
    // Сброс всегда возвращает в обычную перспективу: иначе «Сброс камеры» в ортовиде
    // выглядит так, будто он не сработал. Без перелёта — дальше своя анимация сброса.
    exitTopViewImmediate();

    const resetPos = () => {
        // Сохраняем оригинальную позицию и ориентацию
        camera.position.copy(initialCameraPosition);
        
        if (controlMode === 'wasd') {
            // Сбрасываем скорость движения для предотвращения дрейфа после сброса
            currentVelocity.set(0, 0, 0);
            
            // Сбрасываем ориентацию камеры через кватернион
            camera.quaternion.copy(initialCameraQuaternion);
            
            // Извлекаем Эйлеровы углы из кватерниона для обновления целевых углов
            const euler = new THREE.Euler().setFromQuaternion(initialCameraQuaternion, 'YXZ');
            targetRotationX = euler.y;
            targetRotationY = euler.x;
            
            // Обновляем точку взгляда
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            controls.target.copy(camera.position.clone().add(forward.multiplyScalar(100)));
        } else {
            // Для режима орбитальной камеры
            controls.target.copy(initialTarget);
            controls.update();
            
            // Включаем автовращение в режиме orbit
            controls.autoRotate = true;
            console.log('Автовращение включено при мгновенном сбросе камеры');
        }
        
        // Сбрасываем анимации модели
        resetAnimation();
    };
    
    if (immediate) {

        resetPos();
        return;
    }
    

    const currentPosition = camera.position.clone();
    const currentQuaternion = camera.quaternion.clone();
    const currentTarget = controls.target.clone();
    

    let animationCancelled = false;
    

    const cancelAnimation = () => {
        if (!animationCancelled) {
            animationCancelled = true;
            
        }
    };
    

    container.addEventListener('mousedown', cancelAnimation, { once: true });
    container.addEventListener('touchstart', cancelAnimation, { once: true });
    window.addEventListener('keydown', cancelAnimation, { once: true });
    

    const wheelHandler = () => cancelAnimation();
    container.addEventListener('wheel', wheelHandler, { once: true });
    
    const duration = 800; // ms
    const startTime = performance.now();
    
    function animateReset(time) {
        if (animationCancelled) {

            container.removeEventListener('mousedown', cancelAnimation);
            container.removeEventListener('touchstart', cancelAnimation);
            window.removeEventListener('keydown', cancelAnimation);
            container.removeEventListener('wheel', wheelHandler);
            return;
        }
        
        const elapsed = time - startTime;
        const progress = Math.min(elapsed / duration, 1);
        

        const easeProgress = 1 - Math.pow(1 - progress, 3); // cubic ease out
        

        camera.position.lerpVectors(currentPosition, initialCameraPosition, easeProgress);
        
        if (controlMode === 'wasd') {

            camera.quaternion.slerpQuaternions(
                currentQuaternion,
                initialCameraQuaternion,
                easeProgress
            );
            

            const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
            targetRotationX = euler.y;
            targetRotationY = euler.x;
        } else {

            controls.target.lerpVectors(currentTarget, initialTarget, easeProgress);
            controls.update();
        }
        
        if (progress < 1) {
            requestAnimationFrame(animateReset);
        } else {
            // Достигли конца анимации
            camera.position.copy(initialCameraPosition);
            
            if (controlMode === 'wasd') {
                camera.quaternion.copy(initialCameraQuaternion);
                const euler = new THREE.Euler().setFromQuaternion(initialCameraQuaternion, 'YXZ');
                targetRotationX = euler.y;
                targetRotationY = euler.x;
            } else {
                controls.target.copy(initialTarget);
                controls.update();
            }
            

            container.removeEventListener('mousedown', cancelAnimation);
            container.removeEventListener('touchstart', cancelAnimation);
            window.removeEventListener('keydown', cancelAnimation);
            container.removeEventListener('wheel', wheelHandler);
            
            // Явно включаем автовращение в режиме orbit
            if (controlMode === 'orbit' && controls) {
                controls.autoRotate = true;
                console.log('Автовращение включено после анимации сброса камеры');
            }
            
            // Сбрасываем анимацию при завершении анимации сброса камеры
            resetAnimation();
        }
    }
    
    requestAnimationFrame(animateReset);
}

// ─── K3. Центр орбиты по геометрии ─────────────────────────────────────────────
// Раньше controls.target всегда стоял в центре модели, поэтому вблизи стены радиус
// орбиты был огромен относительно того, что видно на экране, — камера «улетала».
// Теперь на каждое нажатие один рейкаст под курсором: цель ставится на ось взгляда
// на глубине попадания. Ось важна: OrbitControls в update() делает lookAt(target),
// и цель в стороне от оси развернула бы камеру рывком. На оси разворот нулевой,
// а радиус орбиты берётся от реальной геометрии — что и требовалось.

const pivotRaycaster = new THREE.Raycaster();
const pivotPointer = new THREE.Vector2();

function pointerToNDC(event, out) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    out.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    out.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return true;
}

function raycastModel(event) {
    if (!model || !camera) return null;
    if (!pointerToNDC(event, pivotPointer)) return null;
    pivotRaycaster.setFromCamera(pivotPointer, camera);
    const hits = pivotRaycaster.intersectObject(model, true);
    return hits.length ? hits[0] : null;
}

function updateOrbitPivot(event) {
    if (controlMode !== 'orbit' || isTopView || !controls || !controls.enabled) return;
    if (isUIElement(event.target)) return;
    // Второй палец — это жест зума OrbitControls, пивот по нему не двигаем
    if (event.pointerType === 'touch' && event.isPrimary === false) return;

    const hit = raycastModel(event);
    if (!hit) return;

    const forward = camera.getWorldDirection(new THREE.Vector3());
    controls.target.copy(camera.position).addScaledVector(forward, hit.distance);
    controls.update();
}

// ─── Вращение вокруг точки под курсором ────────────────────────────────────────
// OrbitControls вращает вокруг controls.target и каждым update() делает lookAt(target),
// поэтому «честный» центр под курсором с ним недостижим: цель в стороне от оси взгляда
// разворачивает камеру. Здесь вращение своё: камера поворачивается ВОКРУГ точки
// попадания, сохраняя направление взгляда относительно сцены — как в Blender.
// После поворота цель возвращается на ось взгляда, чтобы OrbitControls (пан, зум)
// продолжал работать и ничего не разворачивал.

const ROTATE_SPEED = 0.005;   // радиан на пиксель
const ROTATE_GLIDE_DECAY = 0.88;
const ROTATE_GLIDE_MIN = 0.0002;

const cursorRotate = {
    active: false,
    pointerId: null,
    pivot: new THREE.Vector3(),
    lastX: 0,
    lastY: 0,
    velocityX: 0,
    velocityY: 0,
    gliding: false
};

// Поворот камеры вокруг pivot: рыскание вокруг мировой Y, тангаж вокруг оси «вправо»
// самой камеры. У полюсов тангаж отбрасываем, иначе взгляд схлопывается на ось.
function orbitAroundPivot(yaw, pitch) {
    if (!camera || !controls) return;

    const pivot = cursorRotate.pivot;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).normalize();

    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(right, pitch);
    const rotation = yawQuat.multiply(pitchQuat);

    const direction = camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(rotation);
    if (Math.abs(direction.y) > 0.995) {
        // слишком близко к полюсу — оставляем только рыскание
        rotation.copy(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    }

    const offset = camera.position.clone().sub(pivot).applyQuaternion(rotation);
    camera.position.copy(pivot).add(offset);
    camera.quaternion.premultiply(rotation);

    // Цель — строго на оси взгляда, на расстоянии до точки вращения: тогда lookAt
    // внутри OrbitControls ничего не меняет, а пан и зум остаются осмысленными.
    const distance = Math.max(camera.position.distanceTo(pivot), controls.minDistance);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    controls.target.copy(camera.position).addScaledVector(forward, distance);
    controls.update();
}

function beginCursorRotate(event) {
    if (event.button !== 2) return;                       // только ПКМ
    if (controlMode !== 'orbit' || isTopView) return;     // в ортовиде вращение заблокировано
    if (!controls || !controls.enabled) return;
    if (isUIElement(event.target)) return;

    const hit = raycastModel(event);
    cursorRotate.pivot.copy(hit ? hit.point : controls.target);
    cursorRotate.active = true;
    cursorRotate.gliding = false;
    cursorRotate.pointerId = event.pointerId;
    cursorRotate.lastX = event.clientX;
    cursorRotate.lastY = event.clientY;
    cursorRotate.velocityX = 0;
    cursorRotate.velocityY = 0;
    userMovedCamera = true;
    controls.autoRotate = false;

    if (renderer.domElement.setPointerCapture) {
        renderer.domElement.setPointerCapture(event.pointerId);
    }
}

function moveCursorRotate(event) {
    if (!cursorRotate.active || event.pointerId !== cursorRotate.pointerId) return;

    const dx = event.clientX - cursorRotate.lastX;
    const dy = event.clientY - cursorRotate.lastY;
    cursorRotate.lastX = event.clientX;
    cursorRotate.lastY = event.clientY;

    cursorRotate.velocityX = -dx * ROTATE_SPEED;
    cursorRotate.velocityY = -dy * ROTATE_SPEED;
    orbitAroundPivot(cursorRotate.velocityX, cursorRotate.velocityY);
}

function endCursorRotate(event) {
    if (!cursorRotate.active) return;
    if (event && event.pointerId !== cursorRotate.pointerId) return;

    cursorRotate.active = false;
    cursorRotate.pointerId = null;

    // Небольшой выбег после отпускания — чтобы вращение не обрывалось резко,
    // как оно вело себя с затуханием OrbitControls.
    if (Math.abs(cursorRotate.velocityX) > ROTATE_GLIDE_MIN ||
        Math.abs(cursorRotate.velocityY) > ROTATE_GLIDE_MIN) {
        cursorRotate.gliding = true;
    }
}

// Вызывается из animate(): доигрывает инерцию вращения
function updateCursorRotateGlide() {
    if (!cursorRotate.gliding) return;

    if (controlMode !== 'orbit' || isTopView) {
        cursorRotate.gliding = false;
        return;
    }

    cursorRotate.velocityX *= ROTATE_GLIDE_DECAY;
    cursorRotate.velocityY *= ROTATE_GLIDE_DECAY;

    if (Math.abs(cursorRotate.velocityX) < ROTATE_GLIDE_MIN &&
        Math.abs(cursorRotate.velocityY) < ROTATE_GLIDE_MIN) {
        cursorRotate.gliding = false;
        return;
    }

    orbitAroundPivot(cursorRotate.velocityX, cursorRotate.velocityY);
}

// Двойной клик — подлёт к точке: камера приближается к тому, по чему щёлкнули,
// как «зум к выделению» в Blender. Просто переносить сюда центр вращения смысла
// мало — центр и так встаёт под курсор при каждом нажатии.
let cameraFlightCancelled = false;

function flyCameraTo(point) {
    if (!controls || !camera) return;

    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const forward = camera.getWorldDirection(new THREE.Vector3());

    // Подлетаем примерно на треть нынешней дистанции, но не ближе разумного
    const currentDistance = startPosition.distanceTo(point);
    const endDistance = Math.max(currentDistance * 0.35, controls.minDistance * 5);
    const endPosition = point.clone().addScaledVector(forward, -endDistance);

    const duration = 450;
    const startTime = performance.now();
    cameraFlightCancelled = false;

    function step(time) {
        if (cameraFlightCancelled) return;
        const progress = Math.min((time - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);

        camera.position.lerpVectors(startPosition, endPosition, eased);
        controls.target.lerpVectors(startTarget, point, eased);
        controls.update();

        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function handlePivotDoubleClick(event) {
    if (controlMode !== 'orbit' || isTopView || !controls || !controls.enabled) return;
    if (isUIElement(event.target)) return;

    const hit = raycastModel(event);
    if (!hit) return;

    controls.autoRotate = false;
    userMovedCamera = true;
    flyCameraTo(hit.point.clone());
}

// ─── K2. Ортогональный вид сверху ──────────────────────────────────────────────
// OrbitControls умеет работать с обеими камерами, достаточно подменить controls.object.
// Ортокамера создаётся лениво, фрустум считается от габарита модели и пропорций окна.

function modelViewRadius() {
    if (!model) return 150;
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return 150;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return sphere.radius > 0 ? sphere.radius : 150;
}

function updateOrthoFrustum() {
    if (!orthoCamera) return;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const half = modelViewRadius() * 1.1;
    const halfWidth = half * (width / height);

    orthoCamera.left = -halfWidth;
    orthoCamera.right = halfWidth;
    orthoCamera.top = half;
    orthoCamera.bottom = -half;
    orthoCamera.updateProjectionMatrix();
}

function ensureOrthoCamera() {
    if (!orthoCamera) {
        orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
        // Вверх экрана смотрит -Z: иначе up окажется параллелен направлению взгляда
        orthoCamera.up.set(0, 0, -1);
    }
    updateOrthoFrustum();
    return orthoCamera;
}

// Переход в вид сверху и обратно: сначала перспективная камера плавно взлетает над
// моделью, и только в конце подменяется ортогональной — переключение «в лоб» читается
// как телепорт и теряется ориентация. Возврат идёт тем же путём назад.
let topViewTransition = false;
let savedPerspectiveView = null;

function topViewPosition() {
    const height = Math.max(modelViewRadius() * 4, 500);
    return new THREE.Vector3(controls.target.x, controls.target.y + height, controls.target.z);
}

function flyPerspectiveTo(endPosition, onDone) {
    const startPosition = perspectiveCamera.position.clone();
    const duration = 550;
    const startTime = performance.now();

    function step(time) {
        const progress = Math.min((time - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);

        perspectiveCamera.position.lerpVectors(startPosition, endPosition, eased);
        controls.update();

        if (progress < 1) {
            requestAnimationFrame(step);
        } else if (onDone) {
            onDone();
        }
    }
    requestAnimationFrame(step);
}

// Мгновенный выход без перелёта: нужен там, где сразу следом идёт своя анимация
// (сброс камеры) или смена режима управления — иначе две анимации тянут камеру врозь.
function exitTopViewImmediate() {
    if (!isTopView || !controls) return;

    // Позицию оставляем ту, что на экране: следом всё равно идёт своя анимация,
    // и возврат в сохранённый вид дал бы лишний скачок.
    if (orthoCamera) perspectiveCamera.position.copy(orthoCamera.position);

    camera = perspectiveCamera;
    controls.object = camera;
    controls.enableRotate = true;
    controls.update();

    isTopView = false;
    topViewTransition = false;
    updateTopViewButton();
}

function setTopView(enabled) {
    if (!controls || enabled === isTopView || topViewTransition) return;

    // В WASD ортокамера смысла не имеет — возвращаемся в орбитальный режим
    if (enabled && controlMode === 'wasd') toggleControlMode();

    cameraFlightCancelled = true;
    cursorRotate.gliding = false;
    userMovedCamera = true;
    topViewTransition = true;

    if (enabled) {
        savedPerspectiveView = {
            position: perspectiveCamera.position.clone(),
            target: controls.target.clone()
        };

        // Взлетаем перспективной камерой, затем подменяем её ортогональной
        flyPerspectiveTo(topViewPosition(), () => {
            const ortho = ensureOrthoCamera();
            ortho.position.copy(perspectiveCamera.position);
            ortho.lookAt(controls.target);

            camera = ortho;
            controls.object = camera;
            // Сверху вращать нечего: это план площадки, наклон его только ломает
            controls.enableRotate = false;
            controls.update();

            isTopView = true;
            topViewTransition = false;
            updateTopViewButton();
        });
        return;
    }

    // Возврат: сперва отдаём управление перспективной камере в той же точке
    perspectiveCamera.position.copy(orthoCamera ? orthoCamera.position : perspectiveCamera.position);
    camera = perspectiveCamera;
    controls.object = camera;
    controls.enableRotate = true;
    controls.update();

    isTopView = false;
    updateTopViewButton();

    const back = savedPerspectiveView ? savedPerspectiveView.position : initialCameraPosition;
    if (savedPerspectiveView) controls.target.copy(savedPerspectiveView.target);

    flyPerspectiveTo(back.clone(), () => {
        topViewTransition = false;
    });
}

function toggleTopView() {
    setTopView(!isTopView);
}

function updateTopViewButton() {
    const button = document.getElementById('top-view');
    if (!button) return;
    button.textContent = isTopView ? 'Обычный вид' : 'Вид сверху';
    button.classList.toggle('active', isTopView);
}

function disableAutoRotate(event) {
    if (isUIElement(event.target)) return;
    
    userMovedCamera = true;
    
    if (controlMode === 'orbit' && controls.autoRotate) {
        controls.autoRotate = false;
    }
}

// Добавляем функцию для сброса анимации
function resetAnimation() {
    if (animations.length > 0 && mixer) {
        mixer.stopAllAction();
        
        // Запускаем первую анимацию заново
        const action = mixer.clipAction(animations[0]);
        action.loop = THREE.LoopRepeat;
        action.reset();
        action.play();
        console.log('Анимация сброшена');
    }
}

// Подсистема режимов отображения («Обычный / Каркас / Скетч») удалена: кнопки не
// использовались, а фоновая инициализация кэша через 5 секунд после загрузки клонировала
// каждый материал трижды и пересобирала EdgesGeometry по всей модели. Рёбра (addEdgeLines)
// и восстановление материалов оставлены — на них стоит этап B.

// От прежней clearDisplayModesCache() осталась только та часть, что относится к рёбрам
// и снимку исходных материалов: кэш материалов режимов больше не существует.
function clearEdgesCache() {
    if (edgesGeometryCache.size > 0) {
        edgesGeometryCache.forEach((geometry) => {
            if (geometry && geometry.dispose) geometry.dispose();
        });
        edgesGeometryCache.clear();
    }

    if (edgesMaterial) {
        edgesMaterial.dispose();
        edgesMaterial = null;
    }

    originalMaterialProps.clear();
}

function addEdgeLines() {
    console.log('Добавляем ребра в режиме Скетч');
    
    // Удаляем старые ребра, если они есть
    removeHelperObjects();
    
    // Создаем материал для линий
    if (!edgesMaterial) {
        edgesMaterial = new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1
        });
    }
    
    let added = 0;
    
    // Проходим по всем мешам модели
    model.traverse((node) => {
        if (node.isMesh) {
            // Сначала безопасно удаляем onBeforeRender, если он есть
            if (node.hasOwnProperty('onBeforeRender')) {
                delete node.onBeforeRender;
            }
            
            // Проверяем, нет ли уже wireframeHelper
            if (!node.userData.wireframeHelper) {
                let edgesGeometry;
                
                // Используем кэшированную геометрию, если доступна
                if (edgesGeometryCache.has(node.geometry)) {
                    edgesGeometry = edgesGeometryCache.get(node.geometry);
                } else {
                    // Создаем новую геометрию ребер
                    try {
                        // Используем порог в 30 градусов для определения ребер (по умолчанию 1 градус)
                        // Это улучшит визуальный вид, выделив только явные ребра
                        edgesGeometry = new THREE.EdgesGeometry(node.geometry, 30 * Math.PI / 180);
                        edgesGeometryCache.set(node.geometry, edgesGeometry);
                    } catch (error) {
                        console.warn(`Не удалось создать геометрию ребер: ${error.message}`);
                        return; // Пропускаем этот меш при ошибке
                    }
                }
                
                // Проверка, не пустая ли геометрия ребер
                if (edgesGeometry.attributes.position.count === 0) {
                    return; // Пропускаем меши без выраженных ребер
                }
                
                // Создаем сегменты линий из геометрии ребер
                const wireframe = new THREE.LineSegments(edgesGeometry, edgesMaterial);
                
                // Добавляем wireframe как дочерний объект меша
                node.add(wireframe);
                
                // Сохраняем ссылку для возможности последующего удаления
                node.userData.wireframeHelper = wireframe;
                
                added++;
            }
        }
    });
    
    console.log(`Добавлено ребер в режиме Скетч: ${added}`);
}

function collectMaterials() {
    const materials = new Set();
    let meshCount = 0;
    
    
    
    if (!model) {
        console.error('Модель не инициализирована!');
        return materials;
    }
    
    model.traverse((node) => {
        if (node.isMesh) {
            meshCount++;
            if (node.material) {
                if (Array.isArray(node.material)) {

                    
                    node.material.forEach(mat => {
                        materials.add(mat);
                    });
                } else {

                    
                    materials.add(node.material);
                }
            } else {
                console.warn(`Меш ${node.name || 'Безымянный'} не имеет материала`);
            }
        }
    });
    
    
    

    if (materials.size === 0 && meshCount > 0) {
        console.error('Не удалось собрать материалы, хотя в модели есть меши!');
    }
    
    return materials;
}

function saveOriginalMaterialProps(material) {
    originalMaterialProps.set(material, {
        wireframe: material.wireframe,
        side: THREE.FrontSide, // Принудительно сохраняем как одностороннее отображение
        map: material.map,
        normalMap: material.normalMap,
        roughnessMap: material.roughnessMap,
        metalnessMap: material.metalnessMap,
        aoMap: material.aoMap,
        emissiveMap: material.emissiveMap,
        transparent: material.transparent,
        opacity: material.opacity,
        color: material.color.clone(),
        emissive: material.emissive ? material.emissive.clone() : null,
        metalness: material.metalness,
        roughness: material.roughness,
        flatShading: material.flatShading,
        polygonOffset: material.polygonOffset,
        polygonOffsetFactor: material.polygonOffsetFactor,
        polygonOffsetUnits: material.polygonOffsetUnits
    });
}

function restoreOriginalMaterials() {

    if (originalMaterialProps.size === 0) {
        
        return;
    }
    
    
    const startTime = performance.now();
    

    const currentMaterials = new Map();
    model.traverse((node) => {
        if (node.isMesh && node.material) {
            if (Array.isArray(node.material)) {
                node.material.forEach(mat => {
                    currentMaterials.set(mat, true);
                });
            } else {
                currentMaterials.set(node.material, true);
            }
            
            // Удаляем onBeforeRender, если он есть
            if (node.hasOwnProperty('onBeforeRender')) {
                delete node.onBeforeRender;
            }
        }
    });
    
    let appliedCount = 0;
    

    originalMaterialProps.forEach((originalProps, material) => {

        if (!material || !currentMaterials.has(material)) {
            return;
        }
        

        material.wireframe = originalProps.wireframe;
        // Всегда используем одностороннее отображение
        material.side = THREE.FrontSide;

        material.map = originalProps.map;
        material.normalMap = originalProps.normalMap;
        material.roughnessMap = originalProps.roughnessMap;
        material.metalnessMap = originalProps.metalnessMap;
        material.aoMap = originalProps.aoMap;
        material.emissiveMap = originalProps.emissiveMap;
        

        material.transparent = originalProps.transparent;
        material.opacity = originalProps.opacity;
        

        if (originalProps.color) {
            material.color.copy(originalProps.color);
        }
        
        if (material.emissive && originalProps.emissive) {
            material.emissive.copy(originalProps.emissive);
        }
        

        if (originalProps.metalness !== undefined) {
            material.metalness = originalProps.metalness;
        }
        if (originalProps.roughness !== undefined) {
            material.roughness = originalProps.roughness;
        }
        if (originalProps.flatShading !== undefined) {
            material.flatShading = originalProps.flatShading;
        }
        

        material.polygonOffset = originalProps.polygonOffset;
        material.polygonOffsetFactor = originalProps.polygonOffsetFactor;
        material.polygonOffsetUnits = originalProps.polygonOffsetUnits;
        

        material.needsUpdate = true;
        appliedCount++;
    });
    
    const endTime = performance.now();
    
    

    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

function removeHelperObjects() {
    if (!model) {
        
        return;
    }
    
    
    let removed = 0;
    

    model.traverse((node) => {
        // Безопасное удаление onBeforeRender
        if (node.isMesh) {
            if (node.hasOwnProperty('onBeforeRender')) {
                delete node.onBeforeRender;
            }
            
            if (node.userData.wireframeHelper) {
                node.remove(node.userData.wireframeHelper);
                
                if (node.userData.wireframeHelper.geometry) {
                    node.userData.wireframeHelper.geometry.dispose();
                }
                if (node.userData.wireframeHelper.material) {
                    node.userData.wireframeHelper.material.dispose();
                }
                
                node.userData.wireframeHelper = null;
                removed++;
            }
        }
    });
    
    
}

// Инициализация кнопок перенесена в основной блок DOMContentLoaded

function saveOriginalMaterialsState() {
    
    const materials = collectMaterials();
    

    originalMaterialProps.clear();
    

    materials.forEach(material => {
        saveOriginalMaterialProps(material);
    });
    
    
}

let touchStartX, touchStartY;
let isTouching = false;
let touchIdentifier = null;
let pinchStartDistance = 0;
let isPinching = false;

function handleTouchStart(event) {
    if (isUIElement(event.target)) {
        return;
    }
    
    event.preventDefault();
    
    if (event.touches.length === 2) {
        // Два пальца в орбитальном режиме — забота OrbitControls, сюда не вмешиваемся.
        if (controlMode !== 'wasd') {
            isTouching = false;
            return;
        }
        
        const dx = event.touches[0].clientX - event.touches[1].clientX;
        const dy = event.touches[0].clientY - event.touches[1].clientY;
        pinchStartDistance = Math.sqrt(dx * dx + dy * dy);
        isPinching = true;
        
        isTouching = false;
        return;
    }
    
    if (event.touches.length === 1 && !isTouching) {
        const touch = event.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        isTouching = true;
        touchIdentifier = touch.identifier;
        
        if (controlMode === 'wasd') {
            isMouseDown = true;
            mouseXOnMouseDown = touch.clientX - windowHalfX;
            mouseYOnMouseDown = touch.clientY - windowHalfY;
            targetRotationXOnMouseDown = targetRotationX;
            targetRotationYOnMouseDown = targetRotationY;
        }
    }
}

function handleTouchMove(event) {
    if (isUIElement(event.target)) {
        return;
    }
    
    event.preventDefault();
    
    // Обработка масштабирования двумя пальцами (pinch-to-zoom) — только режим WASD
    if (isPinching && controlMode === 'wasd' && event.touches.length === 2) {
        const dx = event.touches[0].clientX - event.touches[1].clientX;
        const dy = event.touches[0].clientY - event.touches[1].clientY;
        const pinchDistance = Math.sqrt(dx * dx + dy * dy);
        
        const pinchDelta = pinchDistance - pinchStartDistance;
        
        // Только WASD: здесь жест меняет скорость полёта. В орбитальном режиме два пальца
        // обрабатывает сам OrbitControls (controls.touches), своего зума тут больше нет.
        const pinchFactor = Math.sign(pinchDelta) * Math.min(0.5, Math.abs(pinchDelta) / 50);
        moveSpeed = Math.max(MIN_MOVE_SPEED, 
                    Math.min(MAX_MOVE_SPEED, 
                        moveSpeed + pinchFactor));
        updateSpeedIndicator();
        
        pinchStartDistance = pinchDistance;
        return;
    }
    
    // Обработка вращения одним пальцем
    if (isTouching) {
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            if (touch.identifier === touchIdentifier) {
                
                if (controlMode === 'wasd' && isMouseDown) {
                    // Получаем текущие координаты касания
                    mouseX = touch.clientX - windowHalfX;
                    mouseY = touch.clientY - windowHalfY;
                    
                    // Определяем, насколько сдвинулось касание с начала
                    const movementX = mouseX - mouseXOnMouseDown;
                    const movementY = mouseY - mouseYOnMouseDown;
                    
                    // Настраиваем скорость вращения с учетом размера экрана
                    const isMobile = window.innerWidth < 768;
                    
                    // Адаптивная чувствительность в зависимости от устройства и размера экрана
                    const screenSize = Math.max(window.innerWidth, window.innerHeight);
                    // Для маленьких экранов увеличиваем чувствительность, для больших - уменьшаем
                    const adaptiveFactor = 768 / Math.max(screenSize, 1);
                    const sensitivityFactor = isMobile ? 1.2 * adaptiveFactor : 1.0;
                    const rotationSpeed = 0.004 * sensitivityFactor;
                    
                    // Устанавливаем подходящую чувствительность для сенсорного ввода
                    // Для сенсорных экранов важно иметь более плавное вращение
                    const touchRotationSpeed = rotationSpeed * 0.8;
                    
                    // Напрямую применяем повороты без каких-либо ограничений
                    targetRotationX = targetRotationXOnMouseDown - movementX * touchRotationSpeed;
                    targetRotationY = targetRotationYOnMouseDown - movementY * touchRotationSpeed;
                    
                    // Убираем ВСЕ проверки и ограничения вертикального угла
                }
                break;
            }
        }
    }
}

function handleTouchEnd(event) {
    // Раньше здесь стоял ранний выход по isUIElement: если палец уходил с холста на
    // кнопку, isTouching/isPinching оставались взведёнными до следующего касания.
    // Состояние жеста сбрасываем всегда, в том числе по touchcancel.
    if (isPinching) {
        isPinching = false;
        pinchStartDistance = 0;
    }
    
    for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        if (touch.identifier === touchIdentifier) {
            isTouching = false;
            touchIdentifier = null;
            
            if (controlMode === 'wasd') {
                isMouseDown = false;
            }
            break;
        }
    }
}

function setupMobileButtonHandlers() {
    console.log('Настройка обработчиков мобильных кнопок...');
            const touchableElements = document.querySelectorAll('.control-btn, .display-mode-btn, #share-model-btn, #help-icon');
    
    console.log('Найдено элементов для мобильных обработчиков:', touchableElements.length);
    
    touchableElements.forEach(element => {
        if (element.id === 'help-icon' && !window.matchMedia('(hover: none)').matches) {
            console.log('Пропускаем добавление мобильных обработчиков для кнопки помощи на десктопе');
            return;
        }
        
        // Улучшаем обработку касаний для кнопок
        element.addEventListener('touchstart', function(event) {
            event.stopPropagation();
            
            // Добавляем визуальный эффект нажатия
            this.classList.add('active-touch');
            
            if (element.id === 'help-icon') {
                console.log('Касание кнопки помощи (mobile)');
                toggleHelpPanel();
                
                this.classList.add('active');
                setTimeout(() => {
                    this.classList.remove('active');
                    this.classList.remove('active-touch');
                }, 300);
            } else {
                // Для других кнопок сохраняем активное состояние дольше
                setTimeout(() => {
                    this.classList.remove('active-touch');
                }, 150);
            }
        }, { passive: true });
        
        element.addEventListener('touchmove', (event) => {
            event.stopPropagation();
            element.classList.remove('active-touch');
        }, { passive: false });
        
        element.addEventListener('touchend', (event) => {
            event.stopPropagation();
            element.classList.remove('active-touch');
            
            if (element.id === 'help-icon') {
                event.preventDefault();
            }
        }, { passive: false });
    });
}

const handleButtonTouch = function(event) {
    event.stopPropagation();
    
    if (this.id === 'help-icon') {
        console.log('Касание кнопки помощи (mobile)');
        toggleHelpPanel();
        
        this.classList.add('active');
        setTimeout(() => {
            this.classList.remove('active');
        }, 150);
        
        return;
    }
};

// Обработчики кнопки помощи перенесены в основной блок инициализации

// ─── API-обёртки ────────────────────────────────────────────────────────────

async function apiCreateProject(name) {
    return apiRequest('/project-create', { method: 'POST', admin: true, body: { name } });
}
async function apiRenameProject(id, name) {
    const { project } = await apiRequest('/project-rename', { method: 'POST', admin: true, body: { id, name } });
    return project;
}
async function apiDeleteProject(id) {
    await apiRequest('/project-delete', { method: 'POST', admin: true, body: { id } });
}
async function apiCreateSubproject(projectId, name, code) {
    const { subproject } = await apiRequest('/subproject-create', { method: 'POST', admin: true, body: { projectId, name, code } });
    return subproject;
}
async function apiUpdateSubproject(id, patch) {
    const { subproject } = await apiRequest('/subproject-update', { method: 'POST', admin: true, body: { id, ...patch } });
    return subproject;
}
async function apiDeleteSubproject(id) {
    await apiRequest('/subproject-delete', { method: 'POST', admin: true, body: { id } });
}
async function apiUpdateModel(id, patch) {
    const { model } = await apiRequest('/update', { method: 'POST', admin: true, body: { id, ...patch } });
    return model;
}

// ─── Модалки: общие хелперы ────────────────────────────────────────────────

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('visible');
}
function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('visible');
}
function setModalError(id, msg) {
    const el = document.getElementById(id);
    if (el) el.textContent = msg || '';
}
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '—';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Кнопка-иконка для строк админки.
function makeIconBtn(glyph, title) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
}

// Ссылка на подпроект по коду.
function subprojectLink(code) {
    return `${window.location.origin}${window.location.pathname}?model=${encodeURIComponent(code)}`;
}

// Копирование текста в буфер обмена + уведомление.
async function copyToClipboard(text, okMsg = 'Ссылка скопирована! 🔗') {
    try {
        await navigator.clipboard.writeText(text);
        showNotification(okMsg, 'success');
    } catch (e) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showNotification(okMsg, 'success');
        } catch (e2) {
            showNotification('Не удалось скопировать ❌', 'error');
        }
    }
}

// Заполняет <select> проектами. Возвращает выбранный id.
function fillProjectSelect(select, selectedId) {
    if (!select) return '';
    select.innerHTML = '';
    const projects = [...(userProjects || [])].sort(projectSort);
    projects.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.text = p.name;
        select.appendChild(opt);
    });
    if (selectedId && projects.some((p) => p.id === selectedId)) select.value = selectedId;
    return select.value;
}
// Заполняет <select> подпроектами выбранного проекта (Common сверху с пометкой).
function fillSubprojectSelect(select, projectId, selectedId) {
    if (!select) return '';
    select.innerHTML = '';
    const subs = (userSubprojects || [])
        .filter((s) => s.projectId === projectId)
        .sort(subprojectSort);
    subs.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.text = s.isCommon ? `${s.name} (общий)` : `${s.name} · ${s.code}`;
        select.appendChild(opt);
    });
    if (selectedId && subs.some((s) => s.id === selectedId)) select.value = selectedId;
    return select.value;
}
// Сортировки: Unknown/Common — в конце, остальное по алфавиту.
function projectSort(a, b) {
    const au = a.id === UNKNOWN_PROJECT_ID, bu = b.id === UNKNOWN_PROJECT_ID;
    if (au !== bu) return au ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '', 'ru');
}
function subprojectSort(a, b) {
    if (!!a.isCommon !== !!b.isCommon) return a.isCommon ? -1 : 1; // Common первым
    return (a.name || '').localeCompare(b.name || '', 'ru');
}

// ─── Единая модалка модели (загрузка / редактирование) ──────────────────────

// mode: 'upload' (нужен file) или 'edit' (нужен model). Возвращает Promise<boolean>.
function openModelForm({ mode, file = null, model = null }) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('model-form-modal');
        const title = document.getElementById('model-form-title');
        const fileInfo = document.getElementById('model-form-file-info');
        const projectSel = document.getElementById('model-form-project');
        const subSel = document.getElementById('model-form-subproject');
        const displayInput = document.getElementById('model-form-display');
        const versionInput = document.getElementById('model-form-version');
        const dateInput = document.getElementById('model-form-date');
        const commentInput = document.getElementById('model-form-comment');
        const confirmBtn = document.getElementById('model-form-confirm');

        setModalError('model-form-error', '');
        title.textContent = mode === 'upload' ? 'Загрузка модели' : 'Редактирование модели';

        // Стартовые значения
        let startProjectId, startSubId, startDisplay, startVersion, startDate, startComment;
        if (mode === 'edit' && model) {
            startSubId = model.subprojectId;
            const sub = getSubproject(startSubId);
            startProjectId = sub ? sub.projectId : UNKNOWN_PROJECT_ID;
            startDisplay = model.displayName || model.name || '';
            startVersion = model.versionName || '';
            startDate = normalizeDateStr(model.modelDate, model.uploadedAt);
            startComment = model.comment || '';
            fileInfo.style.display = 'none';
        } else {
            // upload: подставим текущий подпроект (если открыт) как удобный дефолт
            startSubId = currentSubproject ? currentSubproject.id : UNKNOWN_COMMON_ID;
            const sub = getSubproject(startSubId);
            startProjectId = sub ? sub.projectId : UNKNOWN_PROJECT_ID;
            startDisplay = file ? file.name.replace(/\.[^.]+$/, '') : '';
            startVersion = '';
            startDate = new Date().toISOString().slice(0, 10);
            startComment = '';
            fileInfo.style.display = 'block';
            fileInfo.textContent = file ? `Файл: ${file.name} (${formatBytes(file.size)})` : '';
        }

        fillProjectSelect(projectSel, startProjectId);
        fillSubprojectSelect(subSel, projectSel.value, startSubId);
        displayInput.value = startDisplay;
        versionInput.value = startVersion;
        dateInput.value = startDate;
        commentInput.value = startComment;

        function onProjectChange() { fillSubprojectSelect(subSel, projectSel.value, null); }
        projectSel.addEventListener('change', onProjectChange);

        async function onConfirm() {
            setModalError('model-form-error', '');
            const displayName = (displayInput.value || '').trim();
            const subprojectId = subSel.value;
            const versionName = (versionInput.value || '').trim();
            const modelDate = (dateInput.value || '').trim() || new Date().toISOString().slice(0, 10);
            const comment = (commentInput.value || '').trim();
            if (!displayName) { setModalError('model-form-error', 'Введите название модели'); return; }
            if (!subprojectId) { setModalError('model-form-error', 'Выберите подпроект'); return; }

            confirmBtn.disabled = true;
            try {
                if (mode === 'upload') {
                    await uploadModel(file, { displayName, subprojectId, versionName, modelDate, comment });
                } else {
                    const updated = await apiUpdateModel(model.id, { displayName, subprojectId, versionName, modelDate, comment });
                    replaceModelInState(updated);
                    refreshAfterModelChange();
                }
                cleanup();
                resolve(true);
            } catch (e) {
                setModalError('model-form-error', e.message || 'Ошибка');
                confirmBtn.disabled = false;
            }
        }
        function onCancel() { cleanup(); resolve(false); }
        function cleanup() {
            confirmBtn.removeEventListener('click', onConfirm);
            projectSel.removeEventListener('change', onProjectChange);
            overlay.querySelectorAll('[data-modal-close="model-form-modal"]').forEach((b) => b.removeEventListener('click', onCancel));
            closeModal('model-form-modal');
            confirmBtn.disabled = false;
        }

        confirmBtn.addEventListener('click', onConfirm);
        overlay.querySelectorAll('[data-modal-close="model-form-modal"]').forEach((b) => b.addEventListener('click', onCancel));
        openModal('model-form-modal');
        setTimeout(() => displayInput.focus(), 50);
    });
}

// Совместимость: старый вход в диалог загрузки.
function openUploadDialog(file) { return openModelForm({ mode: 'upload', file }); }

// После изменения модели: обновить админ-списки и пользовательский вид.
function refreshAfterModelChange() {
    if (document.getElementById('admin-modal')?.classList.contains('visible')) {
        renderAdminModels();
        renderAdminCatalog();
    }
    rebuildModelSelector();
}

// ─── Админ-панель ──────────────────────────────────────────────────────────

function updateAdminButtonVisibility() {
    const btn = document.getElementById('admin-settings-btn');
    if (!btn) return;
    const hasToken = !!localStorage.getItem('agrAdminToken');
    btn.classList.toggle('visible', hasToken);
}

function setupAdminButton() {
    const btn = document.getElementById('admin-settings-btn');
    if (!btn) return;
    btn.addEventListener('click', () => openAdminPanel());
    updateAdminButtonVisibility();
}

async function openAdminPanel() {
    // Требуем токен: без него сразу спрашиваем пароль.
    if (!getAdminToken()) return;

    setModalError('admin-error', '');
    // Освежаем данные из бакета
    try {
        const [projectsData, subprojectsData, modelsData] = await Promise.all([
            fetchProjectsRaw(), fetchSubprojectsRaw(), fetchModelsRaw(),
        ]);
        userProjects = ensureUnknownLocally(projectsData);
        userSubprojects = ensureUnknownCommonLocally(subprojectsData);
        userModels = modelsData.map(normalizeModelEntry);
        localStorage.setItem('userModels', JSON.stringify(userModels));
        localStorage.setItem('userProjects', JSON.stringify(userProjects));
        localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
    } catch (e) {
        console.warn('Не удалось обновить данные перед открытием админки:', e);
    }

    setupAdminTabs();
    setupAdminCloseHandlers();
    setupAdminUploadButton();
    setupAdminModelSearch();
    setupAdminCreateProject();
    setupAdminExportButton();
    renderAdminModels();
    renderAdminCatalog();
    openModal('admin-modal');
    updateAdminButtonVisibility();
}

function rebindClick(id, handler) {
    const el = document.getElementById(id);
    if (!el) return null;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    const fresh = document.getElementById(id);
    fresh.addEventListener('click', handler);
    return fresh;
}

function setupAdminTabs() {
    document.querySelectorAll('.admin-tab').forEach((tab) => {
        const clone = tab.cloneNode(true);
        tab.parentNode.replaceChild(clone, tab);
    });
    document.querySelectorAll('.admin-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.adminTab;
            document.getElementById('admin-tab-models').style.display = which === 'models' ? '' : 'none';
            document.getElementById('admin-tab-catalog').style.display = which === 'catalog' ? '' : 'none';
        });
    });
}

function setupAdminCloseHandlers() {
    document.querySelectorAll('[data-modal-close="admin-modal"]').forEach((btn) => {
        const clone = btn.cloneNode(true);
        btn.parentNode.replaceChild(clone, btn);
    });
    document.querySelectorAll('[data-modal-close="admin-modal"]').forEach((btn) => {
        btn.addEventListener('click', () => closeModal('admin-modal'));
    });
}

function setupAdminUploadButton() {
    const btn = rebindClick('admin-upload-btn', () => {
        const input = document.getElementById('admin-file-input');
        if (input) input.click();
    });
    const input = document.getElementById('admin-file-input');
    if (input) {
        const clone = input.cloneNode(true);
        input.parentNode.replaceChild(clone, input);
        document.getElementById('admin-file-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;
            const format = file.name.split('.').pop().toLowerCase();
            if (format !== 'glb' && format !== 'gltf') {
                setModalError('admin-error', 'Поддерживаются только GLB и GLTF');
                return;
            }
            await openModelForm({ mode: 'upload', file });
        });
    }
    void btn;
}

let adminModelQuery = '';
function setupAdminModelSearch() {
    const input = document.getElementById('admin-model-search');
    if (!input) return;
    const clone = input.cloneNode(true);
    input.parentNode.replaceChild(clone, input);
    const fresh = document.getElementById('admin-model-search');
    fresh.value = adminModelQuery;
    fresh.addEventListener('input', () => { adminModelQuery = fresh.value; renderAdminModels(); });
}

// Плоский список моделей, сгруппированный по проекту→подпроекту, с поиском.
function renderAdminModels() {
    const container = document.getElementById('admin-models');
    if (!container) return;
    container.innerHTML = '';

    const q = (adminModelQuery || '').trim().toLowerCase();
    const models = [...(userModels || [])].sort((a, b) => {
        const sa = getSubproject(a.subprojectId), sb = getSubproject(b.subprojectId);
        const pa = sa ? getProjectName(sa.projectId) : '', pb = sb ? getProjectName(sb.projectId) : '';
        const cmp = pa.localeCompare(pb, 'ru');
        if (cmp !== 0) return cmp;
        const sn = (sa ? sa.name : '').localeCompare(sb ? sb.name : '', 'ru');
        if (sn !== 0) return sn;
        return String(b.modelDate).localeCompare(String(a.modelDate));
    });

    let shown = 0;
    let lastGroupKey = '';
    models.forEach((m) => {
        const sub = getSubproject(m.subprojectId);
        const proj = sub ? getProject(sub.projectId) : null;
        const projName = proj ? proj.name : UNKNOWN_PROJECT_NAME;
        const subName = sub ? sub.name : '—';
        const code = sub ? (sub.code || '') : '';
        if (q) {
            const hay = `${projName} ${subName} ${code} ${m.displayName} ${m.versionName || ''}`.toLowerCase();
            if (!hay.includes(q)) return;
        }
        shown += 1;

        // Заголовок группы (проект — подпроект · код)
        const groupKey = `${projName}|${subName}|${code}`;
        if (groupKey !== lastGroupKey) {
            lastGroupKey = groupKey;
            const header = document.createElement('div');
            header.className = 'admin-group';
            header.textContent = sub && sub.isCommon
                ? `${projName} — ${subName}`
                : `${projName} — ${subName}${code ? ` · ${code}` : ''}`;
            container.appendChild(header);
        }

        const row = document.createElement('div');
        row.className = 'admin-row';
        const main = document.createElement('div');
        main.className = 'row-main';
        main.title = `Файл: ${m.name}`;
        const ver = (m.versionName || '').trim();
        main.textContent = `${formatDateRu(m.modelDate)}${ver ? ` — ${ver}` : ''} · ${m.displayName || m.name}`;
        row.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'row-actions';

        const editBtn = makeIconBtn('✎', 'Изменить');
        editBtn.addEventListener('click', async () => {
            await openModelForm({ mode: 'edit', model: m });
        });
        actions.appendChild(editBtn);

        const shareBtn = makeIconBtn('🔗', 'Скопировать ссылку');
        shareBtn.addEventListener('click', () => {
            if (sub && sub.code) copyToClipboard(subprojectLink(sub.code));
            else showNotification('У подпроекта нет кода', 'error');
        });
        actions.appendChild(shareBtn);

        const delBtn = makeIconBtn('🗑', 'Удалить');
        delBtn.className = 'icon-btn danger';
        delBtn.addEventListener('click', async () => {
            if (!window.confirm(`Удалить модель "${m.displayName || m.name}" (${formatDateRu(m.modelDate)})?`)) return;
            try {
                const ok = await deleteModel(m.id);
                if (ok !== false) { setModalError('admin-error', ''); renderAdminModels(); renderAdminCatalog(); }
            } catch (e) { setModalError('admin-error', e.message); }
        });
        actions.appendChild(delBtn);

        row.appendChild(actions);
        container.appendChild(row);
    });

    if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'admin-row';
        empty.style.color = '#888';
        empty.textContent = q ? 'Ничего не найдено' : 'Моделей пока нет';
        container.appendChild(empty);
    }
}

function setupAdminCreateProject() {
    rebindClick('admin-create-project-btn', async () => {
        const input = document.getElementById('admin-new-project-name');
        const name = (input.value || '').trim();
        if (!name) { setModalError('admin-error', 'Введите название проекта'); return; }
        try {
            const { project } = await apiCreateProject(name);
            // Проект и его Common подтянем свежими из бакета
            userSubprojects = ensureUnknownCommonLocally(await fetchSubprojectsRaw());
            if (project && !userProjects.some((p) => p.id === project.id)) userProjects.push(project);
            localStorage.setItem('userProjects', JSON.stringify(userProjects));
            localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
            input.value = '';
            setModalError('admin-error', '');
            renderAdminCatalog();
        } catch (e) {
            setModalError('admin-error', e.message);
        }
    });
}

// Каталог: проекты с вложенными подпроектами (коды, действия).
function renderAdminCatalog() {
    const container = document.getElementById('admin-projects');
    if (!container) return;
    container.innerHTML = '';

    const projects = [...(userProjects || [])].sort(projectSort);
    projects.forEach((p) => {
        const block = document.createElement('div');
        block.className = 'admin-project-block';

        const head = document.createElement('div');
        head.className = 'admin-row';
        const main = document.createElement('div');
        main.className = 'row-main';
        main.style.fontWeight = '600';
        main.textContent = p.name;
        head.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'row-actions';
        if (p.id !== UNKNOWN_PROJECT_ID) {
            const renameBtn = document.createElement('button');
            renameBtn.textContent = 'Имя';
            renameBtn.addEventListener('click', async () => {
                const next = window.prompt('Новое название проекта:', p.name);
                if (!next || next.trim() === p.name) return;
                try {
                    const updated = await apiRenameProject(p.id, next.trim());
                    const idx = userProjects.findIndex((x) => x.id === p.id);
                    if (idx >= 0) userProjects[idx] = updated;
                    localStorage.setItem('userProjects', JSON.stringify(userProjects));
                    setModalError('admin-error', ''); renderAdminCatalog(); renderAdminModels(); rebuildModelSelector();
                } catch (e) { setModalError('admin-error', e.message); }
            });
            actions.appendChild(renameBtn);

            const delBtn = document.createElement('button');
            delBtn.textContent = 'Удалить';
            delBtn.className = 'danger';
            delBtn.addEventListener('click', async () => {
                if (!window.confirm(`Удалить проект "${p.name}" со всеми подпроектами?`)) return;
                try {
                    await apiDeleteProject(p.id);
                    userProjects = userProjects.filter((x) => x.id !== p.id);
                    userSubprojects = userSubprojects.filter((s) => s.projectId !== p.id);
                    localStorage.setItem('userProjects', JSON.stringify(userProjects));
                    localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
                    setModalError('admin-error', ''); renderAdminCatalog();
                } catch (e) { setModalError('admin-error', e.message); }
            });
            actions.appendChild(delBtn);
        }
        head.appendChild(actions);
        block.appendChild(head);

        // Подпроекты
        const subs = (userSubprojects || []).filter((s) => s.projectId === p.id).sort(subprojectSort);
        subs.forEach((s) => {
            const row = document.createElement('div');
            row.className = 'admin-row admin-subrow';
            const sm = document.createElement('div');
            sm.className = 'row-main';
            const count = modelsOfSubproject(s.id).length;
            sm.textContent = s.isCommon
                ? `${s.name} (общий) · ${count} мод.`
                : `${s.name} · ${s.code} · ${count} мод.`;
            row.appendChild(sm);

            const sa = document.createElement('div');
            sa.className = 'row-actions';
            if (!s.isCommon) {
                const editBtn = document.createElement('button');
                editBtn.textContent = 'Изм.';
                editBtn.title = 'Изменить имя/код';
                editBtn.addEventListener('click', async () => {
                    const name = window.prompt('Название подпроекта:', s.name);
                    if (name === null) return;
                    const code = window.prompt('Код подпроекта:', s.code);
                    if (code === null) return;
                    try {
                        const updated = await apiUpdateSubproject(s.id, { name: name.trim(), code: code.trim() });
                        const idx = userSubprojects.findIndex((x) => x.id === s.id);
                        if (idx >= 0) userSubprojects[idx] = updated;
                        localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
                        setModalError('admin-error', ''); renderAdminCatalog(); renderAdminModels(); rebuildModelSelector();
                    } catch (e) { setModalError('admin-error', e.message); }
                });
                sa.appendChild(editBtn);

                const delBtn = document.createElement('button');
                delBtn.textContent = 'Удл.';
                delBtn.className = 'danger';
                delBtn.addEventListener('click', async () => {
                    if (!window.confirm(`Удалить подпроект "${s.name}" (${s.code})?`)) return;
                    try {
                        await apiDeleteSubproject(s.id);
                        userSubprojects = userSubprojects.filter((x) => x.id !== s.id);
                        localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
                        setModalError('admin-error', ''); renderAdminCatalog();
                    } catch (e) { setModalError('admin-error', e.message); }
                });
                sa.appendChild(delBtn);
            }
            row.appendChild(sa);
            block.appendChild(row);
        });

        // Добавление подпроекта
        const addRow = document.createElement('div');
        addRow.className = 'admin-row admin-subrow admin-add-sub';
        const nameIn = document.createElement('input');
        nameIn.type = 'text'; nameIn.placeholder = 'Новый подпроект'; nameIn.className = 'admin-input';
        const codeIn = document.createElement('input');
        codeIn.type = 'text'; codeIn.placeholder = 'Код'; codeIn.className = 'admin-input admin-input-code';
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Добавить';
        addBtn.addEventListener('click', async () => {
            const name = (nameIn.value || '').trim();
            const code = (codeIn.value || '').trim();
            if (!name || !code) { setModalError('admin-error', 'Укажите название и код подпроекта'); return; }
            try {
                const sub = await apiCreateSubproject(p.id, name, code);
                userSubprojects.push(sub);
                localStorage.setItem('userSubprojects', JSON.stringify(userSubprojects));
                setModalError('admin-error', ''); renderAdminCatalog();
            } catch (e) { setModalError('admin-error', e.message); }
        });
        addRow.appendChild(nameIn);
        addRow.appendChild(codeIn);
        addRow.appendChild(addBtn);
        block.appendChild(addRow);

        container.appendChild(block);
    });
}

function replaceModelInState(updated) {
    if (!updated || !updated.id) return;
    const norm = normalizeModelEntry(updated);
    const idx = userModels.findIndex((m) => m.id === norm.id);
    if (idx >= 0) userModels[idx] = { ...userModels[idx], ...norm };
    else userModels.unshift(norm);
    localStorage.setItem('userModels', JSON.stringify(userModels));
}

// Удаление модели из Object Storage через Cloud Function
async function deleteModel(modelId) {
    try {
        if (!storageConfigured && !initStorage()) throw new Error('Хранилище не настроено');
        if (!modelId) throw new Error('ID модели не указан');

        document.querySelector('.loading').textContent = 'Удаление модели...';
        document.querySelector('.loading').style.display = 'block';

        await apiRequest('/delete', { method: 'POST', admin: true, body: { id: modelId } });

        const removed = userModels.find((m) => m.id === modelId);
        userModels = userModels.filter((m) => m.id !== modelId);
        localStorage.setItem('userModels', JSON.stringify(userModels));

        // Если удалили модель из текущего пользовательского вида — перерисуем его.
        if (currentSubproject && removed && removed.subprojectId === currentSubproject.id) {
            const urlToLoad = renderSubprojectView(getSubproject(currentSubproject.id));
            if (urlToLoad && urlToLoad !== currentModelPath) { currentModelPath = urlToLoad; loadModel(); }
            else if (!urlToLoad) showModelNotFound();
        }

        document.querySelector('.loading').textContent = 'Модель успешно удалена';
        setTimeout(() => { document.querySelector('.loading').style.display = 'none'; }, 1500);
        return true;
    } catch (error) {
        console.error('Ошибка при удалении модели:', error);
        document.querySelector('.loading').textContent = `Ошибка удаления: ${error.message}`;
        setTimeout(() => { document.querySelector('.loading').style.display = 'none'; }, 3000);
        return false;
    }
}


// Функция для показа/скрытия кнопки управления моделью
function toggleModelManageButton(show) {
    // Функция больше не нужна
    return;
}

// Функция для принудительной установки всех материалов как односторонних
function forceFrontSideMaterials() {
    if (!model) return;
    
    console.log('Применение одностороннего отображения для всех материалов...');
    
    model.traverse((node) => {
        if (node.isMesh && node.material) {
            if (Array.isArray(node.material)) {
                node.material.forEach(material => {
                    material.side = THREE.FrontSide;
                    material.needsUpdate = true;
                });
            } else {
                node.material.side = THREE.FrontSide;
                node.material.needsUpdate = true;
            }
        }
    });
}

// ─── Выгрузка таблицы моделей в .xlsx ───────────────────────────────────────
// Браузерная копия deploy/models-table.mjs (эталон там же): те же колонки, тот же
// порядок строк, тот же формат файла. Меняешь колонки или правила — правь оба места.
//
// Порядок строк держит Google-таблица, но её CSV-экспорт не отдаёт CORS, поэтому
// из браузера он недоступен. Скрипт при каждом прогоне кладёт в бакет table-order.json
// со списком кодов — кнопка читает его. Нет файла — раскладываем по каталогу.

const TABLE_ORDER_KEY = 'table-order.json';
const TABLE_SEPARATOR = '— Модели без проекта —';
const TABLE_HEADER = [
    'код СУИП', 'ПРОЕКТ', 'ОЧЕРЕДЬ\\ЭТАП',
    'МОДЕЛЬ', 'ССЫЛКА', 'ССЫЛКА (ДЕВ)', 'ДАТА', 'ЗАГРУЖЕНО', 'КОРОТКОЕ ИМЯ', 'КОММЕНТАРИЙ', 'ФАЙЛ',
];
const TABLE_COL_WIDTHS = [12, 24, 34, 9, 46, 46, 12, 13, 34, 40, 30];
const TABLE_DATE_COLS = new Set(['ДАТА', 'ЗАГРУЖЕНО'].map((h) => TABLE_HEADER.indexOf(h)));

/** Имя бакета — последний сегмент публичного префикса хранилища. */
function storageBucketName(base) {
    const m = String(base || '').replace(/\/+$/, '').match(/\/([^/]+)$/);
    return m ? m[1] : '';
}

function websiteBaseFor(bucket) {
    return bucket ? `https://${bucket}.website.yandexcloud.net/` : '';
}

async function fetchJsonFromStorage(base, key) {
    const res = await fetch(`${base}/${key}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** Порядок кодов из table-order.json; нет файла — пустой список и порядок каталога. */
async function fetchTableOrder() {
    try {
        const data = await fetchJsonFromStorage(STORAGE_BASE_URL, TABLE_ORDER_KEY);
        const codes = Array.isArray(data && data.codes) ? data.codes.map((c) => String(c).trim()) : [];
        return { codes, siteBase: data.siteBase || '', devSiteBase: data.devSiteBase || '', updatedAt: data.updatedAt || '' };
    } catch (e) {
        console.warn(`table-order.json не прочитан (${e.message}) — порядок строк возьмём из каталога.`);
        return { codes: [], siteBase: '', devSiteBase: '', updatedAt: '' };
    }
}

/**
 * Коды подпроектов, у которых на соседнем (дев) стенде реально есть модель.
 * На деве моделей меньше, поэтому ссылка не должна вести в пустоту.
 */
async function fetchDevStandCodes() {
    const bucket = storageBucketName(STORAGE_BASE_URL);
    if (!bucket || /-dev$/.test(bucket)) return null; // сами на деве — колонку не заполняем
    const devBase = `${STORAGE_BASE_URL.replace(/\/+$/, '')}-dev`;
    try {
        const [subprojects, models] = await Promise.all([
            fetchJsonFromStorage(devBase, 'subprojects.json'),
            fetchJsonFromStorage(devBase, 'models.json'),
        ]);
        const byId = new Map((subprojects || []).map((s) => [s.id, s]));
        const codes = new Set();
        (models || []).forEach((m) => {
            const sub = byId.get(m.subprojectId);
            if (sub && sub.code) codes.add(String(sub.code));
        });
        return { codes, base: websiteBaseFor(`${bucket}-dev`) };
    } catch (e) {
        console.warn(`Дев-стенд не прочитан (${e.message}) — колонка «ССЫЛКА (ДЕВ)» будет пустой.`);
        return null;
    }
}

function tableIsoDate(model) {
    const m = String(model.modelDate || model.uploadedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// «ДАТА» правится руками и часто отражает не загрузку, а состояние съёмки, поэтому момент
// появления модели в сервисе живёт отдельной колонкой. uploadedAt ставит бэкенд при коммите
// и правки модели его не трогают — колонка полностью автоматическая.
function tableUploadedDate(model) {
    const m = String(model.uploadedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function tableShortName(model) {
    const base = model.displayName || model.name || '';
    return model.versionName ? `${base} — ${model.versionName}` : base;
}

/** Строит содержимое листа: [шапка, ...строки]. Зеркало buildRows из deploy/models-table.mjs. */
function buildModelsTableRows(orderCodes, siteBase, dev) {
    const projects = userProjects || [];
    const subprojects = userSubprojects || [];
    const models = userModels || [];

    const projectById = new Map(projects.map((p) => [p.id, p]));
    const subById = new Map(subprojects.map((s) => [s.id, s]));

    const modelsBySub = new Map();
    const orphans = [];
    models.forEach((m) => {
        if (!subById.has(m.subprojectId)) { orphans.push(m); return; }
        if (!modelsBySub.has(m.subprojectId)) modelsBySub.set(m.subprojectId, []);
        modelsBySub.get(m.subprojectId).push(m);
    });

    // Пустой Common есть у каждого проекта по умолчанию — таблицу он не засоряет.
    const catalogSubs = subprojects.filter((s) => s.projectId !== UNKNOWN_PROJECT_ID
        && (!s.isCommon || (modelsBySub.get(s.id) || []).length > 0));
    const unknownSubs = subprojects.filter((s) => s.projectId === UNKNOWN_PROJECT_ID);
    const subByCode = new Map(catalogSubs.map((s) => [String(s.code), s]));

    // 1) коды из сохранённого порядка — как были; 2) новые — в конец блока своего проекта
    const ordered = [];
    const placed = new Set();
    (orderCodes || []).forEach((code) => {
        const key = String(code);
        if (!key || placed.has(key)) return;
        const sub = subByCode.get(key);
        if (!sub) return;
        ordered.push(sub);
        placed.add(key);
    });
    const added = [];
    catalogSubs.forEach((sub) => {
        if (placed.has(String(sub.code))) return;
        let insertAt = -1;
        for (let i = ordered.length - 1; i >= 0; i -= 1) {
            if (ordered[i].projectId === sub.projectId) { insertAt = i + 1; break; }
        }
        if (insertAt === -1) ordered.push(sub); else ordered.splice(insertAt, 0, sub);
        placed.add(String(sub.code));
        added.push(String(sub.code));
    });

    const link = (code) => `${siteBase}?model=${encodeURIComponent(code)}`;
    const devLink = (code) => (dev && dev.codes.has(String(code))
        ? `${dev.base}?model=${encodeURIComponent(code)}` : '');

    const sortedModels = (list) => [...list].sort((a, b) => {
        const d = String(b.modelDate || '').localeCompare(String(a.modelDate || ''));
        return d !== 0 ? d : String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''));
    });

    const rowsForSub = (sub, projectName) => {
        const list = sortedModels(modelsBySub.get(sub.id) || []);
        const head = [String(sub.code), projectName, sub.isCommon ? COMMON_NAME : sub.name];
        const onDev = devLink(sub.code);
        if (list.length === 0) return [[...head, 'нет', '', onDev, '', '', '', '', '']];
        return list.map((m) => [
            ...head, 'да', link(sub.code), onDev, tableIsoDate(m), tableUploadedDate(m),
            tableShortName(m), m.comment || '', m.name || '',
        ]);
    };

    const rows = [TABLE_HEADER];
    let withModel = 0;
    ordered.forEach((sub) => {
        const project = projectById.get(sub.projectId);
        const subRows = rowsForSub(sub, project ? project.name : '');
        if (subRows[0][3] === 'да') withModel += subRows.length;
        rows.push(...subRows);
    });

    // Низ таблицы: модели без проекта
    const bottom = [];
    unknownSubs.forEach((sub) => {
        if (!(modelsBySub.get(sub.id) || []).length) return;
        bottom.push(...rowsForSub(sub, UNKNOWN_PROJECT_NAME));
    });
    orphans.forEach((m) => {
        bottom.push(['', UNKNOWN_PROJECT_NAME, '(подпроект удалён)', 'да', '', '',
            tableIsoDate(m), tableUploadedDate(m), tableShortName(m), m.comment || '', m.name || '']);
    });
    if (bottom.length) {
        rows.push(new Array(TABLE_HEADER.length).fill(''));
        rows.push([TABLE_SEPARATOR, ...new Array(TABLE_HEADER.length - 1).fill('')]);
        rows.push(...bottom);
        withModel += bottom.length;
    }

    return { rows, stats: { dataRows: rows.length - 1, withModel, added, unknownRows: bottom.length } };
}

// ── сборка .xlsx: минимальный OOXML, тот же, что пишет deploy/models-table.mjs ──

const TABLE_CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();

function tableCrc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i += 1) c = TABLE_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** deflate-raw, если браузер умеет (Chrome умеет); иначе кладём без сжатия. */
async function tableDeflate(bytes) {
    if (typeof CompressionStream !== 'function') return { data: bytes, method: 0 };
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return { data: new Uint8Array(await new Response(stream).arrayBuffer()), method: 8 };
    } catch (e) {
        return { data: bytes, method: 0 };
    }
}

async function tableZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const body = encoder.encode(file.data);
        const { data, method } = await tableDeflate(body);
        const crc = tableCrc32(body);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // имена в UTF-8
        local.setUint16(8, method, true);
        local.setUint16(12, 0x21, true);  // фиксированная дата — файл воспроизводим
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, body.length, true);
        local.setUint16(26, nameBytes.length, true);
        chunks.push(new Uint8Array(local.buffer), nameBytes, data);

        const dir = new DataView(new ArrayBuffer(46));
        dir.setUint32(0, 0x02014b50, true);
        dir.setUint16(4, 20, true);
        dir.setUint16(6, 20, true);
        dir.setUint16(8, 0x0800, true);
        dir.setUint16(10, method, true);
        dir.setUint16(14, 0x21, true);
        dir.setUint32(16, crc, true);
        dir.setUint32(20, data.length, true);
        dir.setUint32(24, body.length, true);
        dir.setUint16(28, nameBytes.length, true);
        dir.setUint32(42, offset, true);
        central.push(new Uint8Array(dir.buffer), nameBytes);

        offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
}

function tableEsc(value) {
    return String(value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tableColName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

// Excel считает дни от 1899-12-30.
function tableDateSerial(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
    return Number.isFinite(days) ? days : null;
}

/** Собирает .xlsx (Blob) из массива строк; первая строка — шапка. */
async function buildModelsTableXlsx(rows, sheetName = 'Модели') {
    const hyperlinks = [];
    const body = rows.map((row, r) => {
        const cells = [];
        for (let c = 0; c < TABLE_HEADER.length; c += 1) {
            const raw = row[c] == null ? '' : String(row[c]);
            if (raw === '') continue;
            const ref = `${tableColName(c)}${r + 1}`;
            if (r === 0) { cells.push(`<c r="${ref}" s="1" t="inlineStr"><is><t>${tableEsc(raw)}</t></is></c>`); continue; }
            if (TABLE_DATE_COLS.has(c)) {
                const serial = tableDateSerial(raw);
                if (serial !== null) { cells.push(`<c r="${ref}" s="2"><v>${serial}</v></c>`); continue; }
            }
            if (/^https?:\/\//.test(raw)) {
                hyperlinks.push({ ref, target: raw });
                cells.push(`<c r="${ref}" s="3" t="inlineStr"><is><t>${tableEsc(raw)}</t></is></c>`);
                continue;
            }
            // Числовые коды пишем числом — как в исходной таблице (кроме ведущих нулей).
            if (c === 0 && /^[1-9]\d{0,14}$/.test(raw)) { cells.push(`<c r="${ref}"><v>${raw}</v></c>`); continue; }
            cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${tableEsc(raw)}</t></is></c>`);
        }
        return `<row r="${r + 1}">${cells.join('')}</row>`;
    }).join('');

    const lastRef = `${tableColName(TABLE_HEADER.length - 1)}${rows.length}`;
    const cols = TABLE_COL_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const linkRels = hyperlinks.map((h, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${tableEsc(h.target)}" TargetMode="External"/>`).join('');
    const linkTags = hyperlinks.length
        ? `<hyperlinks>${hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>`
        : '';

    const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

    const files = [
        {
            name: '[Content_Types].xml',
            data: `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                + '</Types>',
        },
        {
            name: '_rels/.rels',
            data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
                + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        },
        {
            name: 'xl/workbook.xml',
            data: `${xmlHead}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>`
                + `<sheet name="${tableEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
                + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
                + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
        },
        {
            name: 'xl/styles.xml',
            data: `${xmlHead}<styleSheet xmlns="${MAIN}">`
                + '<numFmts count="1"><numFmt numFmtId="164" formatCode="DD.MM.YYYY"/></numFmts>'
                + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
                + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
                + '<font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts>'
                + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
                + '<fill><patternFill patternType="gray125"/></fill></fills>'
                + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
                + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
                + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
                + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
        },
        {
            name: 'xl/worksheets/sheet1.xml',
            data: `${xmlHead}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
                + `<dimension ref="A1:${lastRef}"/>`
                + '<sheetViews><sheetView workbookViewId="0">'
                + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                + '<sheetFormatPr defaultRowHeight="15"/>'
                + `<cols>${cols}</cols><sheetData>${body}</sheetData>`
                + `<autoFilter ref="A1:${lastRef}"/>${linkTags}</worksheet>`,
        },
    ];
    if (hyperlinks.length) {
        files.push({
            name: 'xl/worksheets/_rels/sheet1.xml.rels',
            data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${linkRels}</Relationships>`,
        });
    }
    return tableZip(files);
}

/** Кнопка «Выгрузить таблицу»: собирает .xlsx из текущих данных и отдаёт на скачивание. */
async function exportModelsTable(btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Собираю…'; }
    setModalError('admin-error', '');
    try {
        const [order, dev] = await Promise.all([fetchTableOrder(), fetchDevStandCodes()]);
        const siteBase = (order.siteBase || websiteBaseFor(storageBucketName(STORAGE_BASE_URL))
            || `${location.origin}/`).replace(/\/*$/, '/');
        const devStand = dev && order.devSiteBase
            ? { codes: dev.codes, base: order.devSiteBase.replace(/\/*$/, '/') }
            : dev;

        const { rows, stats } = buildModelsTableRows(order.codes, siteBase, devStand);
        const blob = await buildModelsTableXlsx(rows);

        const stamp = new Date().toISOString().slice(0, 10);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `модели-${stamp}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        console.log(`Таблица: строк ${stats.dataRows}, с моделью ${stats.withModel}`
            + `${order.codes.length ? '' : ' (порядок строк — по каталогу: нет table-order.json)'}`);
        if (stats.added.length) console.log(`  кодов вне сохранённого порядка: ${stats.added.length} (${stats.added.slice(0, 10).join(', ')})`);
    } catch (e) {
        console.error('Не удалось собрать таблицу:', e);
        setModalError('admin-error', `Не удалось собрать таблицу: ${e.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

function setupAdminExportButton() {
    rebindClick('admin-export-table-btn', (e) => exportModelsTable(e.currentTarget));
}

// Функция для определения объектов с прозрачными плоскостями (деревья, растительность)
function detectTransparentBillboards() {
    // Функция отключена
    return [];
}

// Оптимизация прозрачных плоскостей (деревья, растительность и т.д.)
function optimizeBillboardMaterials(billboards) {
    // Функция отключена
    return;
}

window.addEventListener('resize', () => {
    onWindowResize();
    
    // Проверяем, открыта ли панель помощи
    if (isHelpPanelVisible) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const modelSelector = document.getElementById('model-selector');
        const controls = document.getElementById('controls');
        const displayMode = document.getElementById('display-mode');
        
        // Обновляем видимость элементов в зависимости от типа устройства
        if (isMobile) {
            if (modelSelector) modelSelector.style.display = 'none';
            if (controls) controls.style.display = 'none';
            if (displayMode) displayMode.style.display = 'none';
        } else {
            if (modelSelector) modelSelector.style.display = 'flex';
            if (controls) controls.style.display = 'flex';
            if (displayMode) displayMode.style.display = 'flex';
        }
    }
    
    // Проверяем и скрываем кнопку загрузки при изменении размера окна
    checkAndHideUploadButton();
});
// Заменим обработчик клика на документе, чтобы избежать конфликтов
var documentClickHandlerAdded = false;

function documentClickHandler(event) {
    const helpPanel = document.getElementById('help-panel');
    const helpIcon = document.getElementById('help-icon');
    
    // Если панель помощи открыта и клик был не по панели и не по иконке
    if (isHelpPanelVisible && 
        helpPanel && 
        !helpPanel.contains(event.target) && 
        helpIcon && 
        !helpIcon.contains(event.target)) {
        
        console.log('Закрываем панель помощи по клику вне нее');
        isHelpPanelVisible = false;
        helpPanel.style.display = 'none';
        restoreInterfaceVisibility();
    }
}

// Добавим обработчик только один раз
if (!documentClickHandlerAdded) {
    document.addEventListener('click', documentClickHandler);
    documentClickHandlerAdded = true;
}

// Добавляем функции для управления полноэкранным режимом
let isFullscreenMode = false;

// Функция для включения полноэкранного режима
function enterFullscreenMode() {
    const container = document.getElementById('container');
    
    // Добавляем класс для стилей полноэкранного режима
    container.classList.add('fullscreen-mode');
    isFullscreenMode = true;
    
    // Обновляем видимость кнопок загрузки модели
    const uploadBtns = [
        document.getElementById('custom-model-upload'),
        document.getElementById('upload-model-container')
    ];
    
    uploadBtns.forEach(btn => {
        if (btn) {
            btn.style.display = 'none';
            btn.style.visibility = 'hidden';
            btn.style.opacity = '0';
        }
    });
    
    // Меняем видимость кнопок
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const exitFullscreenBtn = document.getElementById('exit-fullscreen-btn');
    
    if (fullscreenBtn) fullscreenBtn.style.display = 'none';
    if (exitFullscreenBtn) exitFullscreenBtn.style.display = 'flex';
    
    // Если панель помощи открыта, скрываем элементы интерфейса, даже если мы в полноэкранном режиме
    if (isHelpPanelVisible) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
            const modelSelector = document.getElementById('model-selector');
            const controls = document.getElementById('controls');
            const displayMode = document.getElementById('display-mode');
            
            const style = 'display: none !important; visibility: hidden !important;';
            if (modelSelector) modelSelector.setAttribute('style', style);
            if (controls) controls.setAttribute('style', style);
            if (displayMode) displayMode.setAttribute('style', style);
        }
    }
    
    // Если находимся на десктопе, запускаем нативный полноэкранный режим
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    
    if (!isMobile) {
        try {
            const element = document.documentElement;
            
            if (element.requestFullscreen) {
                element.requestFullscreen();
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
            } else if (element.msRequestFullscreen) {
                element.msRequestFullscreen();
            }
        } catch (error) {
            console.log("Ошибка запуска нативного полноэкранного режима:", error);
        }
    }
    
    // Добавляем обработчики для разных браузеров
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    
    // Обновляем размеры рендерера
    setTimeout(onWindowResize, 100);
}

function handleFullscreenChange() {
    if (!document.fullscreenElement && 
        !document.webkitFullscreenElement && 
        !document.mozFullScreenElement &&
        !document.msFullscreenElement && 
        isFullscreenMode) {
        // При выходе из полноэкранного режима браузерами средствами
        exitFullscreenMode();
    }
}

// Функция для выхода из полноэкранного режима
function exitFullscreenMode() {
    const container = document.getElementById('container');
    
    // Удаляем класс для стилей полноэкранного режима
    container.classList.remove('fullscreen-mode');
    isFullscreenMode = false;
    
    // Обновляем видимость кнопок загрузки модели - только если панель помощи закрыта
    if (!isHelpPanelVisible) {
        const uploadBtns = [
            document.getElementById('custom-model-upload'),
            document.getElementById('upload-model-container')
        ];
        
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        
        uploadBtns.forEach(btn => {
            if (btn && !isMobile) {
                btn.style.display = btn.id === 'upload-model-container' ? 'flex' : 'block';
                btn.style.visibility = 'visible';
                btn.style.opacity = '1';
            }
        });
    }
    
    // Меняем видимость кнопок
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const exitFullscreenBtn = document.getElementById('exit-fullscreen-btn');
    
    if (fullscreenBtn) fullscreenBtn.style.display = 'flex';
    if (exitFullscreenBtn) exitFullscreenBtn.style.display = 'none';
    
    // Если панель помощи открыта, принудительно сохраняем скрытие элементов интерфейса
    // даже после выхода из полноэкранного режима
    if (isHelpPanelVisible) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
            const modelSelector = document.getElementById('model-selector');
            const controls = document.getElementById('controls');
            const displayMode = document.getElementById('display-mode');
            
            setTimeout(() => {
                const style = 'display: none !important; visibility: hidden !important;';
                if (modelSelector) modelSelector.setAttribute('style', style);
                if (controls) controls.setAttribute('style', style);
                if (displayMode) displayMode.setAttribute('style', style);
            }, 10);
        }
    }
    
    // Выходим из полноэкранного режима браузера, если он активен
    if (document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement) {
        try {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        } catch (error) {
            console.log("Ошибка выхода из полноэкранного режима:", error);
        }
    }
    
    // Удаляем обработчики событий
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
    document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    
    // Обновляем размеры рендерера
    setTimeout(onWindowResize, 100);
}

// Настройка полноэкранного режима перенесена в основной блок инициализации

// Обработчик клавиши ESC для выхода из полноэкранного режима
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isFullscreenMode) {
        exitFullscreenMode();
    }
    
    // Добавляем поддержку клавиши F для входа в полноэкранный режим
    if ((e.key === 'f' || e.key === 'F') && !isFullscreenMode) {
        enterFullscreenMode();
    }

    // Добавляем поддержку русской буквы А для входа в полноэкранный режим
    if ((e.key === 'а' || e.key === 'А') && !isFullscreenMode) {
        console.log('Нажата русская клавиша А, входим в полноэкранный режим');
        enterFullscreenMode();
    }

    // Клавиша U (и русская Г на той же клавише) — переключение режима админа.
    // Только десктоп; не срабатывает при вводе в поля.
    if (e.key === 'u' || e.key === 'U' || e.key === 'г' || e.key === 'Г') {
        const tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
        if (window.matchMedia('(max-width: 768px)').matches) return; // мобилка — пропускаем
        e.preventDefault();
        toggleAdminMode();
    }
});

// Переключает пользовательский/админский режим. Без токена сразу спрашивает пароль.
function toggleAdminMode() {
    const modal = document.getElementById('admin-modal');
    if (modal && modal.classList.contains('visible')) {
        closeModal('admin-modal');
    } else {
        openAdminPanel();
    }
}

// Вызываем проверку видимости кнопки загрузки модели
checkAndHideUploadButton();



// Периодическая проверка подписки больше не используется - подписка проверяется при каждом действии

// Экспортируем необходимые функции в глобальное пространство имен
function exportFunctions() {
    window.resetCamera = resetCamera;  // Добавляем экспорт resetCamera
    window.controlMode = controlMode;  // Добавляем экспорт controlMode
    window.initialCameraPosition = initialCameraPosition;  // Добавляем экспорт initialCameraPosition
    window.initialCameraQuaternion = initialCameraQuaternion;  // Добавляем экспорт initialCameraQuaternion
    window.initialTarget = initialTarget;  // Добавляем экспорт initialTarget
    window.controls = controls;  // Добавляем экспорт controls
    
    // Экспортируем функции полноэкранного режима
    window.enterFullscreenMode = enterFullscreenMode;
    window.exitFullscreenMode = exitFullscreenMode;
    window.isFullscreenMode = isFullscreenMode;
    
    // Экспортируем функции шаринга моделей
    window.getModelParam = getModelParam;
    window.createSafeModelParam = createSafeModelParam;
    window.updateUrlWithModel = updateUrlWithModel;
    window.getCurrentModelLink = getCurrentModelLink;
    window.copyModelLink = copyModelLink;
    window.showNotification = showNotification;
    window.setupShareButton = setupShareButton;
    window.loadModelFromUrlParam = loadModelFromUrlParam;
    window.handleUrlModelLoading = handleUrlModelLoading;
}

// Инициализируем обработчики после загрузки DOM
document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 Инициализация 3D просмотрщика...');
    
    // Проверяем совместимость с HTML функциями
    if (typeof window.toggleHelpPanel === 'function') {
        console.log('Используем функцию toggleHelpPanel из HTML скрипта');
        toggleHelpPanel = window.toggleHelpPanel;
    }
    
    if (typeof window.checkAndHideUploadButton === 'function') {
        console.log('Используем функцию checkAndHideUploadButton из HTML скрипта');
        checkAndHideUploadButton = window.checkAndHideUploadButton;
    }
    
    if (typeof window.isHelpPanelVisible !== 'undefined') {
        console.log('Используем значение isHelpPanelVisible из HTML скрипта:', window.isHelpPanelVisible);
        isHelpPanelVisible = window.isHelpPanelVisible;
    }
    
    // Экспортируем функции
    exportFunctions();
    
    // Telegram функции авторизации и проверки подписки удалены
    
    initTelemetry();

    // Инициализируем хранилище и дожидаемся загрузки списка моделей,
    // чтобы 3D-сцена инициализировалась уже с готовым списком
    if (initStorage()) {
        await fetchModels();
    } else {
        loadModelsFromLocalStorage();
    }
    
    // Настраиваем UI
    setupUI();
    setupMobileButtonHandlers();
    checkAndHideUploadButton();
    setupFileUploadHandlers();
    setupAdminButton();

    // Инициализация цветов кнопок
    document.querySelectorAll('.control-btn, #load-model-btn').forEach(btn => {
        btn.style.backgroundColor = '#4285f4';
    });
    
    // Настройка кнопки помощи
    const helpIcon = document.getElementById('help-icon');
    const helpPanel = document.getElementById('help-panel');
    
    if (helpIcon && helpPanel) {
        helpPanel.style.display = 'none';
        
        // Очищаем существующие обработчики
        const helpIconClone = helpIcon.cloneNode(true);
        helpIcon.parentNode.replaceChild(helpIconClone, helpIcon);
        
        // Получаем новую ссылку на иконку
        const newHelpIcon = document.getElementById('help-icon');
        
        // Функция для обработки нажатия 
        function handleHelpIconPress(e) {
            console.log('Обработка нажатия кнопки вопроса');
            e.preventDefault();
            e.stopPropagation();
            toggleHelpPanel();
            return false;
        }
        
        // Добавляем обработчик клика для десктопной версии
        newHelpIcon.addEventListener('click', handleHelpIconPress);
        
        // Специальные обработчики для мобильных устройств
        newHelpIcon.addEventListener('touchend', function(e) {
            console.log('Touch end на кнопке вопроса');
            e.preventDefault();
            e.stopPropagation();
            toggleHelpPanel();
        }, { passive: false });
        
        newHelpIcon.addEventListener('touchstart', function(e) {
            console.log('Touch start на кнопке вопроса');
        }, { passive: true });
    }
    
    // Настройка полноэкранного режима
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const exitFullscreenBtn = document.getElementById('exit-fullscreen-btn');
    
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', enterFullscreenMode);
    }
    
    if (exitFullscreenBtn) {
        exitFullscreenBtn.addEventListener('click', exitFullscreenMode);
    }
    
    // Проверяем поддержку полноэкранного режима
    if (!document.fullscreenEnabled && 
        !document.webkitFullscreenEnabled && 
        !document.mozFullScreenEnabled &&
        !document.msFullscreenEnabled) {
        
        // Если полноэкранный режим не поддерживается, скрываем кнопку
        if (fullscreenBtn) {
            fullscreenBtn.style.display = 'none';
        }
    }
    
    // Добавляем обработчик для изменения размера окна
    window.addEventListener('resize', () => {
        checkAndHideUploadButton();
    });
    
    // Обработчик смены версии в селекторе: код (URL) не меняется, обновляем
    // только комментарий и подгружаем выбранную версию.
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            updateModelComment();
            loadSelectedModel();
        });
    }

    // Инициализация 3D сцены (пустой) и резолв по коду из URL.
    // Сцена всегда стартует пустой; конкретную модель грузит резолвер по коду.
    currentModelPath = '';
    init();
    animate();

    setTimeout(() => {
        loadModelFromUrlParam().catch((error) => {
            console.error('Ошибка при загрузке модели по коду:', error);
            showModelNotFound();
        });
    }, 300);

    console.log('✅ Инициализация завершена');
});

// Функция для обновления интерфейса (больше не требует авторизации)
function updateAuthUI() {
    // Получаем элемент статуса
    const statusContainer = document.getElementById('subscription-status-container');
    if (!statusContainer) return;
    
    // Создаем элемент статуса авторизации
    const authStatusElement = document.createElement('p');
    authStatusElement.id = 'auth-status';
    authStatusElement.style.fontSize = '14px';
    authStatusElement.style.fontWeight = 'bold';
    authStatusElement.style.color = '#4CAF50';
    authStatusElement.style.marginTop = '10px';
    authStatusElement.style.textAlign = 'center';
    
    // Авторизация через Telegram больше не требуется
    authStatusElement.textContent = 'Загрузка файлов доступна всем пользователям';
    
    // Добавляем в контейнер
    statusContainer.innerHTML = '';
    statusContainer.appendChild(authStatusElement);
}



// Функция для обновления интерфейса HDR
function updateHDRInterface() {
    const hdrButtons = document.querySelectorAll('.hdr-btn');
    
    hdrButtons.forEach((button, index) => {
        if (index === currentHdrIndex) {
            button.classList.add('active');
        } else {
            button.classList.remove('active');
        }
    });
}

// Проверяет, есть ли уже модель с таким же именем (по локальному списку userModels).
// Бэкенд тоже проверяет и вернёт 409 при гонке — это лишь предварительная проверка.
function checkModelDuplicate(fileName) {
    return Array.isArray(userModels) && userModels.some(m => m && m.name === fileName);
}



// УСТАРЕВШЕЕ: локальная загрузка своей модели отключена (модели идут только
// через админку в облако и привязываются к подпроектам). Оставлено как no-op.
function loadLocalModel(file) {
    console.warn('Локальная загрузка модели отключена в этой версии.');
    return null;
}

// Переименовываем дублирующуюся функцию
function handleFileSelectUpgraded(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        // Убираем проверку авторизации в Telegram - пользователи могут загружать сразу
        console.log('Начинаем загрузку файла без проверки подписки');

        // Обновляем отображаемое имя файла
        const fileNameElement = document.getElementById('file-name');
        if (fileNameElement) {
            fileNameElement.textContent = file.name;
        }

        // Проверяем размер файла (максимум 1024 МБ)
        const maxSize = 1024 * 1024 * 1024; // 1024 МБ в байтах
        if (file.size > maxSize) {
            alert('Файл слишком большой. Максимальный размер: 1024 МБ');
            return;
        }

        // Правильное определение формата файла
        let format = '';
        const fileNameParts = file.name.split('.');
        
        // Проверяем, что есть хотя бы одна точка в имени файла
        if (fileNameParts.length > 1) {
            format = fileNameParts.pop().toLowerCase();
        }
        
        console.log('Определен формат файла при выборе:', format);
        
        // Проверяем, что формат поддерживается
        if (format !== 'glb' && format !== 'gltf') {
            alert('Неподдерживаемый формат файла. Поддерживаются только GLB и GLTF.');
            return;
        }

        // Показываем сообщение о загрузке
        const loadingIndicator = document.querySelector('.loading');
        if (loadingIndicator) {
            loadingIndicator.textContent = 'Загрузка модели...';
            loadingIndicator.style.display = 'block';
        }

        let cloudConfigured = false;
        try {
            cloudConfigured = storageConfigured || initStorage();
        } catch (error) {
            console.error('Ошибка при инициализации хранилища:', error);
            cloudConfigured = false;
        }

        // Скрываем индикатор загрузки — он включится после подтверждения в модалке
        if (loadingIndicator) loadingIndicator.style.display = 'none';

        if (cloudConfigured) {
            console.log('Хранилище настроено, открываем диалог параметров');
            // Показываем модалку — там пользователь укажет displayName и проект.
            openUploadDialog(file).catch((err) => {
                console.error('Ошибка диалога загрузки:', err);
            });
        } else {
            console.log('Хранилище не настроено, загружаем модель локально');
            loadLocalModel(file);
        }
    } catch (error) {
        console.error('Ошибка при обработке файла:', error);
        alert(`Ошибка при обработке файла: ${error.message}`);
    } finally {
        // Сбрасываем значение, чтобы повторный выбор того же файла снова срабатывал
        if (event.target) event.target.value = '';
    }
}

// Функция для управления анимацией
// Функция не используется, т.к. анимация проигрывается циклически автоматически
function setupAnimationControls() {
    // Функция оставлена для совместимости
    console.log('Анимация настроена на автоматическое циклическое воспроизведение');
}

// Функция для создания списка анимаций
function showAnimationsList() {
    // Эта функция оставлена для совместимости
    if (animations && animations.length > 0) {
        console.log('Доступные анимации (воспроизводятся автоматически циклически):');
        animations.forEach((anim, index) => {
            console.log(`${index + 1}. ${anim.name || 'Анимация ' + (index + 1)}`);
        });
    } else {
        console.log('Анимации в модели не найдены');
    }
}

// Добавим глобальную переменную для хранения коллайдеров сцены
let sceneColliders = [];

// Улучшенная функция проверки коллизий с более надежным алгоритмом
function checkCollisions(position, newPosition) {
    // === ОПТИМИЗИРОВАННАЯ СИСТЕМА КОЛЛИЗИЙ ===
    const CAMERA_RADIUS = 1.0;      // Уменьшенный радиус коллизии камеры
    const COLLISION_MARGIN = 0.5;   // Небольшой отступ от стен
    
    // === Проверка отсутствия движения - для оптимизации ===
    const moveDirection = new THREE.Vector3().subVectors(newPosition, position);
    const moveDistance = moveDirection.length();
    
    // Если перемещение слишком маленькое, просто разрешаем его (оптимизация)
    if (moveDistance < 0.001) return newPosition;
    
    // Нормализуем вектор движения
    moveDirection.normalize();
    
    // === ОПТИМИЗИРОВАННАЯ ПРОВЕРКА КОЛЛИЗИЙ ===
    // Ограничиваемся только 2 ключевыми направлениями для повышения производительности
    
    // 1. Проверка в направлении движения
    const raycastDistance = moveDistance + CAMERA_RADIUS;
    const mainRaycaster = new THREE.Raycaster(position, moveDirection, 0, raycastDistance);
    
    // 2. Проверка в направлении взгляда (только если смотрим вперед)
    const lookDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const lookRaycaster = new THREE.Raycaster(position, lookDirection, 0, CAMERA_RADIUS * 2);
    
    // Массивы для хранения пересечений
    const moveIntersects = [];
    const lookIntersects = [];
    
    // Кэширование результатов при обходе сцены
    const sceneObjects = [];
    let sceneTraversed = false;
    
    // Проходим сцену только один раз и собираем объекты для проверки коллизий
    function getSceneObjects() {
        if (!sceneTraversed && scene) {
            scene.traverse(function(object) {
                // Пропускаем объекты, с которыми не должно быть коллизий
                if (object === camera) return;
                if (!object.visible) return;
                if (object.userData && object.userData.noCollision) return;
                
                // Проверяем только меши с геометрией
                if (object.isMesh && object.geometry) {
                    // Пропускаем прозрачные объекты
                    let isTransparent = false;
                    if (object.material) {
                        if (Array.isArray(object.material)) {
                            isTransparent = object.material.every(mat => 
                                mat.transparent && mat.opacity < 0.3);
                        } else {
                            isTransparent = object.material.transparent && 
                                object.material.opacity < 0.3;
                        }
                    }
                    if (!isTransparent) {
                        sceneObjects.push(object);
                    }
                }
            });
            sceneTraversed = true;
        }
        return sceneObjects;
    }
    
    // Выполняем проверки коллизий
    const objects = getSceneObjects();
    
    // Проверка в направлении движения
    moveIntersects.push(...mainRaycaster.intersectObjects(objects, false));
    
    // Проверка в направлении взгляда
    // Вычисляем угол между направлением движения и взглядом
    const lookMoveDot = lookDirection.dot(moveDirection);
    
    // Только если двигаемся примерно в направлении взгляда (в пределах 45°)
    // или если взгляд направлен в сторону движения
    if (lookMoveDot > 0.7 || lookDirection.dot(moveDirection) > 0) {
        lookIntersects.push(...lookRaycaster.intersectObjects(objects, false));
    }
    
    // === ОБРАБОТКА РЕЗУЛЬТАТОВ КОЛЛИЗИИ ===
    
    // 1. Обработка коллизий в направлении движения
    if (moveIntersects.length > 0) {
        const collision = moveIntersects[0]; // Ближайшее пересечение
        
        // Если пересечение ближе, чем конечная позиция
        if (collision.distance < moveDistance + CAMERA_RADIUS) {
            // Вычисляем безопасное расстояние
            const safeDistance = Math.max(0, collision.distance - COLLISION_MARGIN);
            
            if (safeDistance > 0) {
                // Перемещаемся до безопасной позиции
                const safePosition = position.clone().add(
                    moveDirection.clone().multiplyScalar(safeDistance)
                );
                return safePosition;
            } else {
                // Слишком близко - не двигаемся
                return position.clone();
            }
        }
    }
    
    // 2. Обработка коллизий в направлении взгляда
    if (lookIntersects.length > 0 && lookMoveDot > 0.7) {
        const collision = lookIntersects[0]; // Ближайшее пересечение
        
        // Если объект находится очень близко к камере в направлении взгляда
        if (collision.distance < CAMERA_RADIUS * 1.5) {
            // Ограничиваем движение пропорционально близости к объекту
            const proximityFactor = collision.distance / (CAMERA_RADIUS * 2);
            const limitedDistance = moveDistance * proximityFactor;
            
            // Только если движение в сторону объекта и объект близко
            if (limitedDistance < moveDistance && lookMoveDot > 0) {
                const limitedPosition = position.clone().add(
                    moveDirection.clone().multiplyScalar(limitedDistance)
                );
                return limitedPosition;
            }
        }
    }
    
    // Если коллизий нет или они не требуют корректировки - разрешаем движение
    return newPosition;
}

// Функция для обработки URL и загрузки модели по имени (УСТАРЕВШАЯ - НЕ ИСПОЛЬЗУЕТСЯ)
async function handleUrlModelLoading() {
    console.log('⚠️ Внимание: используется устаревшая функция handleUrlModelLoading()');
    console.log('Используйте вместо неё loadModelFromUrlParam()');
    return false;
}

// ====== СИСТЕМА ШАРИНГА МОДЕЛЕЙ ЧЕРЕЗ URL ПАРАМЕТРЫ ======

// Функция для получения параметра модели из URL
function getModelParam() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('model');
    } catch (error) {
        console.error('Ошибка при получении параметра модели:', error);
        return null;
    }
}

// Функция для создания безопасного имени для URL параметра
function createSafeModelParam(modelName) {
    if (!modelName) return null;
    
    // Заменяем символы которые могут вызвать проблемы в URL
    let safeName = modelName
        .replace(/[^\w\s\u0400-\u04FF-]/g, '') // Оставляем только буквы, цифры, пробелы, дефисы и кириллицу
        .replace(/\s+/g, '-') // Заменяем пробелы на дефисы
        .replace(/-+/g, '-') // Убираем множественные дефисы
        .replace(/^-+|-+$/g, '') // Убираем дефисы в начале и конце
        .toLowerCase();
    
    return safeName || null;
}

// Функция для обновления URL с параметром модели (без перезагрузки)
function updateUrlWithModel(modelName) {
    try {
        const safeParam = createSafeModelParam(modelName);
        if (!safeParam) return;
        
        const url = new URL(window.location);
        url.searchParams.set('model', safeParam);
        
        // Обновляем URL без перезагрузки страницы
        window.history.replaceState(null, '', url.toString());
    } catch (error) {
        console.error('Ошибка при обновлении URL:', error);
    }
}

// Ссылка на текущий подпроект: базовый URL + код (?model=<код>).
function getCurrentModelLink() {
    const baseUrl = window.location.origin + window.location.pathname;
    if (!currentSubproject || !currentSubproject.code) return baseUrl;
    return `${baseUrl}?model=${encodeURIComponent(currentSubproject.code)}`;
}

// Функция для копирования ссылки на модель в буфер обмена
async function copyModelLink() {
    try {
        const link = getCurrentModelLink();
        await navigator.clipboard.writeText(link);
        
        showNotification('Ссылка на модель скопирована! 🔗', 'success');
        console.log('Скопирована ссылка:', link);
    } catch (error) {
        console.error('Ошибка при копировании через Clipboard API:', error);
        
        // Fallback для старых браузеров
        try {
            const textArea = document.createElement('textarea');
            textArea.value = getCurrentModelLink();
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            
            showNotification('Ссылка на модель скопирована! 🔗', 'success');
        } catch (fallbackError) {
            showNotification('Не удалось скопировать ссылку ❌', 'error');
            console.error('Fallback также не сработал:', fallbackError);
        }
    }
}

// Функция для показа уведомлений
function showNotification(message, type = 'info') {
    // Удаляем предыдущие уведомления
    const existingNotifications = document.querySelectorAll('.share-notification');
    existingNotifications.forEach(notif => notif.remove());
    
    // Создаем новое уведомление
    const notification = document.createElement('div');
    notification.className = 'share-notification';
    notification.textContent = message;
    
    // Стили уведомления
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: 'Unbounded', sans-serif;
        font-size: 14px;
        font-weight: 500;
        color: white;
        background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#F44336' : '#2196F3'};
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transform: translateX(100%);
        transition: transform 0.3s ease;
        cursor: pointer;
    `;
    
    document.body.appendChild(notification);
    
    // Анимация появления
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 10);
    
    // Клик для быстрого закрытия
    notification.addEventListener('click', () => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => notification.remove(), 300);
    });
    
    // Автоудаление через 4 секунды
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => notification.remove(), 300);
        }
    }, 4000);
}

// Функция для настройки кнопки "Поделиться моделью"
function setupShareButton() {
    const shareButton = document.getElementById('share-model-btn');
    if (!shareButton) {
        console.error('Кнопка share-model-btn не найдена в HTML');
        return;
    }
    
    // Стили кнопки уже заданы в CSS
    
    // Обработчик клика
    shareButton.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Визуальная обратная связь
        this.style.transform = 'scale(0.95)';
        this.style.boxShadow = '0 1px 4px rgba(102, 126, 234, 0.5)';
        
        // Копируем ссылку
        copyModelLink();
        
        // Возвращаем стили
        setTimeout(() => {
            this.style.transform = 'scale(1)';
            this.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.3)';
        }, 150);
    });
    
    // Эффекты при наведении
    shareButton.addEventListener('mouseenter', function() {
        this.style.transform = 'translateY(-2px)';
        this.style.boxShadow = '0 4px 16px rgba(102, 126, 234, 0.4)';
    });
    
    shareButton.addEventListener('mouseleave', function() {
        this.style.transform = 'translateY(0)';
        this.style.boxShadow = '0 2px 8px rgba(102, 126, 234, 0.3)';
    });
    

}

// Резолвит подпроект по коду из URL (?model=<код>) и показывает его модели.
// Возвращает true, если модель загружена; иначе показывает «Модель не найдена!».
async function loadModelFromUrlParam() {
    try {
        const param = getModelParam();
        if (!param) { showModelNotFound(); return false; }

        console.log('Параметр модели в URL:', param);

        // Строгий поиск подпроекта по коду
        let sub = getSubprojectByCode(param);

        // Фолбэк для старых ссылок ?model=<имя> (устаревший нечёткий поиск)
        if (!sub) {
            const legacy = legacyFindModelByName(param);
            if (legacy) {
                sub = getSubproject(legacy.subprojectId);
                console.log('Старая ссылка по имени, подпроект:', sub && sub.name);
            }
        }

        if (!sub) { console.log('Код не найден:', param); showModelNotFound(); return false; }

        const urlToLoad = renderSubprojectView(sub);
        if (!urlToLoad) { console.log('В подпроекте нет моделей:', sub.name); showModelNotFound(); return false; }

        if (!scene) { console.error('Scene не инициализирован'); return false; }

        currentModelPath = urlToLoad;
        await loadModel();
        return true;
    } catch (error) {
        console.error('Ошибка при загрузке модели по коду:', error);
        showModelNotFound();
        return false;
    }
}

// УСТАРЕВШЕЕ: поиск модели по имени — только чтобы старые ссылки вида
// ?model=<имя-модели> продолжали работать. Строго ТОЧНОЕ совпадение (по displayName
// или имени файла), никаких подстрок — иначе неизвестный код мог бы подхватить
// случайную модель. Новые ссылки используют код подпроекта.
function legacyFindModelByName(modelParam) {
    if (!Array.isArray(userModels) || userModels.length === 0) return null;
    const safeNeedle = (createSafeModelParam(modelParam) || '').toLowerCase();
    if (!safeNeedle) return null;
    for (const model of userModels) {
        if (!model) continue;
        const safeDisplay = (createSafeModelParam(model.displayName) || '').toLowerCase();
        const safeName = (createSafeModelParam(model.name) || '').toLowerCase();
        if (safeDisplay === safeNeedle || safeName === safeNeedle) return model;
    }
    return null;
}
