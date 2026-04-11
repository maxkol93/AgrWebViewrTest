import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Объявление переменной до первого использования
let isHelpPanelVisible = false;

// Проверка совместимости с HTML функциями перенесена в основной блок инициализации

// Настройки Supabase
let SUPABASE_URL = 'https://ваш-проект-url.supabase.co';
let SUPABASE_ANON_KEY = 'ваш-публичный-ключ';
let supabase = null;

let fileUploadRequested = false; // Флаг запроса на загрузку файла пользователем



// Инициализация Supabase
function initSupabase() {
    if (!window.supabase) {
        console.error('Библиотека Supabase не загружена');
        return false;
    }
    
    // Получаем URL и ключ из мета-тегов, если они есть
    const urlElement = document.getElementById('supabase-url');
    const keyElement = document.getElementById('supabase-key');
    
    if (urlElement && urlElement.getAttribute('content')) {
        SUPABASE_URL = urlElement.getAttribute('content');
    }
    
    if (keyElement && keyElement.getAttribute('content')) {
        SUPABASE_ANON_KEY = keyElement.getAttribute('content');
    }
    
    // Проверяем наличие значений по умолчанию или пустых значений
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || 
        SUPABASE_URL === 'https://ваш-проект-url.supabase.co' || 
        SUPABASE_ANON_KEY === 'ваш-публичный-ключ') {
        console.error('Конфигурация Supabase не настроена. Установите значения в мета-тегах supabase-url и supabase-key.');
        return false;
    }
    
    try {
        console.log('Инициализируем Supabase с URL:', SUPABASE_URL, 'и ключом:', SUPABASE_ANON_KEY.substring(0, 10) + '...');
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false
            }
        });
        console.log('Supabase успешно инициализирован');
        return true;
    } catch (error) {
        console.error('Ошибка при инициализации Supabase:', error);
        return false;
    }
}

// Функция для получения списка моделей из Supabase
async function fetchModelsFromSupabase() {
    try {
        if (!supabase) {
            if (!initSupabase()) {
                throw new Error('Не удалось инициализировать Supabase');
            }
        }

        document.querySelector('.loading').textContent = 'Загрузка списка моделей...';
        document.querySelector('.loading').style.display = 'block';

        // Получаем список моделей из таблицы models
        const { data, error } = await supabase
            .from('models')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            throw error;
        }

        console.log('Получены модели из Supabase:', data.length);

        // Очищаем существующий список моделей
        clearModelSelector();

        if (data.length === 0) {
            document.querySelector('.loading').style.display = 'none';
            return;
        }

        // Преобразуем данные в формат userModels
        const models = data.map(model => {
            // Формируем полный URL для файла из Supabase Storage
            const fileUrl = supabase.storage.from('models').getPublicUrl(model.file_path).data.publicUrl;
            
            return {
                id: model.id,
                url: fileUrl,
                name: model.name || model.file_path.split('/').pop(),
                uploadedAt: model.created_at,
                size: model.size || 0,
                format: model.format
            };
        });

        // Добавляем модели в выпадающий список
        models.forEach(model => {
            addModelToSelector(model);
        });

        // Обновляем массив userModels
        userModels = models;

        // Сохраняем в localStorage как резервную копию
        localStorage.setItem('userModels', JSON.stringify(userModels));

        document.querySelector('.loading').style.display = 'none';
        
        // Загрузка модели по URL параметру теперь происходит только в DOMContentLoaded

    } catch (error) {
        console.error('Ошибка при получении моделей из Supabase:', error);
        document.querySelector('.loading').textContent = 'Ошибка загрузки моделей';
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 2000);
        
        // Пробуем загрузить модели из localStorage как запасной вариант
        loadModelsFromLocalStorage();
    }
}

// Функция для загрузки файла модели в Supabase Storage
async function uploadModelToSupabase(file) {
    try {
        if (!supabase) {
            if (!initSupabase()) {
                throw new Error('Не удалось инициализировать Supabase');
            }
        }

        document.querySelector('.loading').textContent = 'Проверка дубликатов моделей...';
        document.querySelector('.loading').style.display = 'block';

        // Проверяем наличие дубликата модели с таким же именем
        let isDuplicate = false;
        try {
            isDuplicate = await checkModelDuplicate(file.name);
        } catch (err) {
            console.warn('Ошибка при проверке дубликатов:', err);
            // Продолжаем выполнение даже при ошибке проверки дубликатов
        }
        
        if (isDuplicate) {
            throw new Error(`Модель с именем "${file.name}" уже существует в базе данных. Пожалуйста, переименуйте файл и попробуйте снова.`);
        }

        document.querySelector('.loading').textContent = 'Загрузка модели на сервер...';
        document.querySelector('.loading').style.display = 'block';

        // Генерируем уникальное имя файла с использованием timestamp для уникальности
        const timestamp = Date.now();
        const safeFileName = file.name.replace(/[^\w\d.-]/g, '_'); // заменяем небезопасные символы
        const fileName = `${timestamp}_${safeFileName}`;
        const filePath = `public/${fileName}`;
        
        console.log('Загружаем файл в Supabase Storage:', filePath);

        // Загружаем файл в хранилище
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('models')
            .upload(filePath, file, {
                cacheControl: '3600',
                contentType: file.type || 'application/octet-stream',
                upsert: false
            });

        if (uploadError) {
            console.error('Ошибка загрузки в Storage:', uploadError);
            throw uploadError;
        }

        console.log('Загрузка в Storage успешна, получаем публичный URL');

        // Получаем публичный URL файла
        const { data: urlData } = supabase.storage
            .from('models')
            .getPublicUrl(filePath);

        if (!urlData || !urlData.publicUrl) {
            throw new Error('Не удалось получить публичный URL для загруженного файла');
        }

        console.log('Получен публичный URL:', urlData.publicUrl);

        // Извлекаем расширение файла
        const format = file.name.split('.').pop().toLowerCase();

        // Проверяем формат файла
        if (format !== 'glb' && format !== 'gltf') {
            throw new Error(`Неподдерживаемый формат файла: ${format}. Поддерживаются только GLB и GLTF.`);
        }

        // Создаем объект с данными модели
        const modelDataObj = {
            name: file.name,
            file_path: filePath,
            format: format,
            size: file.size,
            url: urlData.publicUrl
        };



        console.log('Добавляем запись о модели в базу данных:', modelDataObj);

        // Добавляем запись о модели в базу данных
        const { data: modelData, error: modelError } = await supabase
            .from('models')
            .insert([modelDataObj])
            .select();

        if (modelError) {
            console.error('Ошибка при добавлении записи в базу данных:', modelError);
            
            // Если не удалось добавить запись в базу, попытаемся удалить загруженный файл
            try {
                await supabase.storage.from('models').remove([filePath]);
                console.log('Загруженный файл удален после ошибки');
            } catch (removeError) {
                console.warn('Не удалось удалить загруженный файл:', removeError);
            }
            
            throw modelError;
        }

        if (!modelData || modelData.length === 0) {
            throw new Error('База данных не вернула информацию о созданной модели');
        }

        console.log('Модель успешно загружена в базу данных:', modelData[0]);

        // Создаем информацию о модели
        const modelInfo = {
            id: modelData[0].id,
            url: urlData.publicUrl,
            name: file.name,
            uploadedAt: new Date().toISOString(),
            size: file.size,
            format: format
        };

        // Добавляем модель в список и загружаем
        userModels.unshift(modelInfo);
        addModelToSelector(modelInfo, true);
        
        // Выбираем новую модель в селекторе
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
            modelSelect.value = modelInfo.url;
        }

        // Загружаем новую модель
        currentModelPath = modelInfo.url;
        
        // Сохраняем обновленный список в localStorage
        localStorage.setItem('userModels', JSON.stringify(userModels));

        document.querySelector('.loading').textContent = 'Модель успешно загружена!';
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
            loadModel();
        }, 1000);

        return modelInfo;

    } catch (error) {
        console.error('Ошибка при загрузке модели в Supabase:', error);
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

    // Проверяем, доступен ли Supabase для загрузки на сервер
    let supabaseConfigured = false;
    try {
        supabaseConfigured = initSupabase();
    } catch (error) {
        console.error('Ошибка при инициализации Supabase:', error);
        supabaseConfigured = false;
    }

    if (supabaseConfigured) {
        console.log('Supabase инициализирован, пытаемся загрузить модель на сервер');
        
        // Загружаем модель через Supabase
        uploadModelToSupabase(file)
            .then(modelInfo => {
                // Успешно загружено, модель уже добавлена в селектор
                console.log('Модель успешно загружена через Supabase:', modelInfo);
            })
            .catch(error => {
                console.error('Ошибка загрузки через Supabase:', error);
                // Пробуем загрузить локально как запасной вариант
                console.log('Переходим к локальной загрузке модели');
                loadLocalModel(file);
            });
    } else {
        // Если Supabase не настроен, загружаем модель локально
        console.log('Supabase не настроен, загружаем модель локально');
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
// Переменная для хранения загружаемых пользовательских моделей
let userModels = [];

// Функция для загрузки моделей из localStorage (резервный метод)
function loadModelsFromLocalStorage() {
    try {
        const savedModels = localStorage.getItem('userModels');
        if (savedModels) {
            userModels = JSON.parse(savedModels);
            
            // Очищаем существующий список моделей
            clearModelSelector();
            
            // Добавляем сохраненные модели в выпадающий список
            userModels.forEach(model => {
                addModelToSelector(model);
            });
            
            console.log('Загружено моделей из localStorage:', userModels.length);
        }
    } catch (error) {
        console.error('Ошибка при загрузке моделей из localStorage:', error);
    }
}

// Функция для очистки выпадающего списка моделей
function clearModelSelector() {
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect) return;
    
    // Удаляем все опции с пользовательскими моделями
    Array.from(modelSelect.options).forEach(option => {
        if (option.dataset.userModel === 'true') {
            modelSelect.removeChild(option);
        }
    });
}

// Функция для добавления модели в выпадающий список
function addModelToSelector(modelInfo, addToTop = false) {
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect) return;
    
    // Проверяем, есть ли уже такая модель в списке
    let existingOption = Array.from(modelSelect.options).find(option => option.value === modelInfo.url);
    if (existingOption) return;
    
    // Создаем новый элемент option
    const newOption = document.createElement('option');
    newOption.value = modelInfo.url;
    newOption.text = `${modelInfo.name}`;
    newOption.dataset.userModel = 'true';
    newOption.dataset.format = modelInfo.format || '';
    newOption.dataset.id = modelInfo.id || '';
    
    // Добавляем в начало или конец списка в зависимости от параметра
    if (addToTop) {
    modelSelect.insertBefore(newOption, modelSelect.firstChild);
    } else {
        modelSelect.appendChild(newOption);
    }
}



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
let customTextures = {};
let modelSelect; 

// Переменные для поддержки анимаций
let mixer, animations = [];
let mixers = [];
let clock = new THREE.Clock();

let currentDisplayMode = 'normal';

const originalMaterialProps = new Map();

const displayModesCache = {
    normal: null,      
    wireframe: null,   
    'wireframe-solid': null  
};

const edgesGeometryCache = new Map();

let edgesMaterial = null;

let isCacheInitialized = false;
let isCacheInitializing = false;

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
    
    // Обработчик клавиши 1 - переключение в обычный режим
    if (e.key === '1') {
        console.log('Переключение в обычный режим');
        setDisplayMode('normal');
        updateDisplayModeUI('normal');
    }
    
    // Обработчик клавиши 2 - переключение в режим каркас
    if (e.key === '2') {
        console.log('Переключение в режим каркас');
        setDisplayMode('wireframe');
        updateDisplayModeUI('wireframe');
    }
    
    // Обработчик клавиши 3 - переключение в режим Скетч
    if (e.key === '3') {
        console.log('Переключение в режим Скетч');
        setDisplayMode('wireframe-solid');
        updateDisplayModeUI('wireframe-solid');
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

function setupInitialCameraState() {
    initialCameraPosition = new THREE.Vector3(200, 100, 200);
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
        
        // Возвращаем камеру в начальное положение
        camera.position.copy(initialCameraPosition);
        
        // Включаем стандартные контролы
        controls.enabled = true;
        
        // Восстанавливаем ограничения для Orbit-режима
        controls.maxPolarAngle = Math.PI / 1.5;
        controls.minPolarAngle = Math.PI / 6;
        
        // Устанавливаем точку обзора в начальное положение
        controls.target.copy(initialTarget);
        
        // Включаем автовращение
        controls.autoRotate = true;
        
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

const USE_HDR = true;
// Список HDR карт (файлы лежат в Supabase Storage, бакет "environments")
const HDR_MAPS = [
    { name: 'Закат', path: 'sunset.hdr' },
    { name: 'День',  path: 'day.hdr' },
    { name: 'Ночь',  path: 'night.hdr' }
];

let currentHdrIndex = 0;

function getHdrUrl(path) {
    if (!supabase && !initSupabase()) {
        throw new Error('Supabase не инициализирован, невозможно получить URL HDR');
    }
    return supabase.storage.from('environments').getPublicUrl(path).data.publicUrl;
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
    
    setupInitialCameraState();
    camera.position.copy(initialCameraPosition);
    
    renderer = new THREE.WebGLRenderer({ 
        antialias: true,
        alpha: false,  // Отключаем alpha-канал - как в оригинальной версии
        preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
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
    controls.minDistance = 50;
    controls.maxDistance = 500;
    controls.maxPolarAngle = Math.PI / 1.5;
    controls.minPolarAngle = Math.PI / 6;
    controls.enableZoom = true;
    controls.zoomSpeed = 0.55; // Единая скорость зума для всех вариантов
    controls.rotateSpeed = 1.0;
    controls.panSpeed = 0.5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.0;
    
    // Включаем зум к курсору только для колесика мыши
    controls.zoomToCursor = true;
    
    // Оставляем стандартное поведение OrbitControls для средней кнопки мыши
    
    container.addEventListener('mousedown', disableAutoRotate);
    container.addEventListener('wheel', disableAutoRotate);
    container.addEventListener('touchstart', disableAutoRotate);
    
    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    
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
    
    let hdrLoading = false;
    
    if (USE_HDR) {
        hdrLoading = true;
        const rgbeLoader = new RGBELoader();
        rgbeLoader.setDataType(THREE.HalfFloatType);
        
        document.querySelector('.loading').textContent = 'Загрузка карты окружения...';
        
        // Удаляем таймер показа кнопки пропуска HDR
        
        // Сохраняем обработчик, но он не будет виден
        skipHDRButton.onclick = function() {
            if (hdrLoading) {
                hdrLoading = false;
                createBasicEnvironment(pmremGenerator);
            }
        };
        
        loadHDR(getHdrUrl(HDR_MAPS[currentHdrIndex].path), pmremGenerator, rgbeLoader, hdrLoading);
    } else {
        createBasicEnvironment(pmremGenerator);
    }
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
    
    // Создаем левую часть для режимов отображения
    const displayModeLeft = document.createElement('div');
    displayModeLeft.className = 'display-mode-left';
    displayModeLeft.style.display = 'flex';
    displayModeLeft.style.flexDirection = 'column';
    displayModeLeft.style.gap = '12px';
    displayModeLeft.style.borderRight = '1px solid rgba(255, 255, 255, 0.2)';
    displayModeLeft.style.paddingRight = '20px';
    displayModeLeft.style.flex = '1';
    
    // Создаем заголовок для режимов отображения
    const displayModeTitle = document.createElement('div');
    displayModeTitle.textContent = 'Отображение';
    displayModeTitle.style.fontSize = '14px';
    displayModeTitle.style.fontWeight = '500';
    displayModeTitle.style.marginBottom = '10px';
    displayModeTitle.style.textAlign = 'center';
    displayModeTitle.style.width = '100%';
    displayModeTitle.style.color = 'white';
    displayModeLeft.appendChild(displayModeTitle);
    
    // Создаем контейнер для кнопок режимов отображения
    const displayModeButtons = document.createElement('div');
    displayModeButtons.id = 'display-mode-buttons';
    displayModeButtons.style.display = 'flex';
    displayModeButtons.style.flexDirection = 'column';
    displayModeButtons.style.gap = '8px';
    displayModeButtons.style.width = '100%';
    
    // Добавляем кнопки режимов отображения
    const modes = [
        { name: 'Обычный', mode: 'normal' },
        { name: 'Каркас', mode: 'wireframe' },
        { name: 'Скетч', mode: 'wireframe-solid' }
    ];
    
    modes.forEach(item => {
        const button = document.createElement('button');
        button.className = 'display-mode-btn';
        button.dataset.mode = item.mode;
        button.textContent = item.name;
        
        // Определяем, является ли этот режим текущим
        if (typeof currentDisplayMode !== 'undefined' && currentDisplayMode === item.mode) {
            button.classList.add('active');
        } else if (item.mode === 'normal' && (typeof currentDisplayMode === 'undefined' || !currentDisplayMode)) {
            button.classList.add('active');
        }
        
        // Добавляем обработчик клика
        button.addEventListener('click', function() {
            // Находим текущий выбранный режим
            const currentModeButton = displayModeButtons.querySelector('.display-mode-btn.active');
            if (currentModeButton) {
                currentModeButton.classList.remove('active');
            }
            
            // Устанавливаем новый режим активным
            button.classList.add('active');
            
            // Применяем режим отображения
            if (typeof setDisplayMode === 'function') {
                setDisplayMode(item.mode);
            }
        });
        
        displayModeButtons.appendChild(button);
    });
    
    // Добавляем кнопки в левую часть
    displayModeLeft.appendChild(displayModeButtons);
    
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
    
    // Добавляем левую и правую части в контейнер
    displayModeContainer.appendChild(displayModeLeft);
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
        
        // Клавиши 1, 2, 3 для переключения режимов отображения
        if (e.key >= '1' && e.key <= '3') {
            const modeIndex = parseInt(e.key) - 1;
            const modes = ['normal', 'wireframe', 'wireframe-solid'];
            if (modeIndex >= 0 && modeIndex < modes.length) {
                // Находим и симулируем клик на соответствующей кнопке
                const modeBtn = document.querySelector(`.display-mode-btn[data-mode="${modes[modeIndex]}"]`);
                if (modeBtn) modeBtn.click();
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
async function loadModel() {
    // Проверяем что scene инициализирован
    if (!scene) {
        console.error('Scene не инициализирован. Загрузка модели отменена.');
        return null;
    }
    
    // Определяем формат файла более безопасным способом
    let fileFormat = '';
    
    try {
        // Получаем формат из расширения URL более надежным способом
        if (currentModelPath && typeof currentModelPath === 'string') {
            // Удаляем все параметры URL и hash
            const cleanPath = currentModelPath.split('?')[0].split('#')[0];
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
        
        const isLocalFile = currentModelPath.startsWith('blob:');
        
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
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        loader.setDRACOLoader(dracoLoader);
        
        const gltf = await loader.loadAsync(currentModelPath, function(xhr) {
            if (isLocalFile) {
                const loaded = xhr.loaded / (1024 * 1024);
                document.querySelector('.loading').textContent = `Загрузка: ${loaded.toFixed(2)} МБ`;
            } else {
                const percent = Math.floor((xhr.loaded / xhr.total) * 100);
                document.querySelector('.loading').textContent = `Загрузка GLTF/GLB: ${percent}%`;
            }
        });
        
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
            
            clearDisplayModesCache();
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
        
        if (currentDisplayMode !== 'normal') {
            setTimeout(() => {
                applyDisplayModeToNewModel(currentDisplayMode);
            }, 300);
        } else {
            document.querySelector('.loading').style.display = 'none';
            
            let idleTimer = null;
            
            const startIdleInitialization = () => {
                if (idleTimer) clearTimeout(idleTimer);
                
                idleTimer = setTimeout(() => {
                    if (!isCacheInitialized && !isCacheInitializing) {
                        initDisplayModesCacheAsync();
                        
                        document.removeEventListener('mousemove', startIdleInitialization);
                        document.removeEventListener('keydown', startIdleInitialization);
                        document.removeEventListener('click', startIdleInitialization);
                        document.removeEventListener('wheel', startIdleInitialization);
                    }
                }, 5000);
            };
            
            document.addEventListener('mousemove', startIdleInitialization);
            document.addEventListener('keydown', startIdleInitialization);
            document.addEventListener('click', startIdleInitialization);
            document.addEventListener('wheel', startIdleInitialization);
            
            startIdleInitialization();
        }
        
        // Если это локальный файл, обновляем выпадающий список и добавляем пользовательскую опцию
        if (isLocalFile) {
            const fileName = currentModelPath.split('/').pop().split('#')[0];
            
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
        
        // Кнопка загрузки модели заменена на кнопку "Поделиться"
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
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    
    renderer.setSize(width, height);
    

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

    if (controls) controls.update();

    updateWASDControls();

    if (renderer && scene && camera) renderer.render(scene, camera);
}

// Добавляем функциональность UI элементов
function setupUI() {
    console.log('Инициализация UI...');
    // Получаем элементы управления
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
    
    // Настройка кнопок режимов отображения
    const modeButtons = document.querySelectorAll('.display-mode-btn');
    
    // Подсвечиваем активный режим отображения при запуске
    updateDisplayModeUI(currentDisplayMode);
    
    // Добавляем обработчики для всех кнопок режима отображения
    modeButtons.forEach(button => {
        button.addEventListener('click', function() {
            const mode = this.getAttribute('data-mode');
            setDisplayMode(mode);
            // Обновляем визуально кнопки
            updateDisplayModeUI(mode);
        });
    });
    
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

// Функция для обновления UI режима отображения
function updateDisplayModeUI(mode) {
    const modeButtons = document.querySelectorAll('.display-mode-btn');
    
    // Сбрасываем активный класс для всех кнопок
    modeButtons.forEach(button => {
        button.classList.remove('active');
        // Удаляем любые дополнительные выделения
        button.style.border = '';
        button.style.boxShadow = '';
        button.style.backgroundColor = '';
        button.style.color = '';
        button.style.fontWeight = '';
    });
    
    // Устанавливаем активный класс для выбранной кнопки
    const activeButton = document.querySelector(`.display-mode-btn[data-mode="${mode}"]`);
    if (activeButton) {
        activeButton.classList.add('active');
        
        // Проверяем, на мобильном ли устройстве (через медиа-запрос)
        const isMobile = window.matchMedia('(hover: none)').matches;
        
        // Если на мобильном устройстве, добавляем дополнительные стили
        if (isMobile) {
            // Явно устанавливаем стили для активной кнопки
            activeButton.style.backgroundColor = '#4285f4';
            activeButton.style.color = 'white';
            activeButton.style.fontWeight = 'bold';
            activeButton.style.boxShadow = '0 0 12px rgba(66, 133, 244, 0.8)';
            activeButton.style.border = '2px solid white';
            
            // Принудительная перерисовка DOM для применения стилей
            activeButton.offsetHeight;
        }
    }
}

if (document.readyState === 'loading') {
    // Убрано дублирование DOMContentLoaded - вся инициализация в основном блоке
}

function loadSelectedModel() {
    const selectedModelPath = modelSelect.value;
    if (selectedModelPath && selectedModelPath !== currentModelPath) {

        const savedDisplayMode = currentDisplayMode;
        
        

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
            

            clearDisplayModesCache();
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
            

            if (savedDisplayMode !== 'normal') {

                setTimeout(() => {
                    applyDisplayModeToNewModel(savedDisplayMode);
                }, 300);
            }
        }).catch(error => {
            console.error('Ошибка при загрузке модели:', error);
            

            // Кнопка loadModelButton заменена на кнопку "Поделиться"
        });
    }
}

function resetCamera(immediate = false) {
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

function disableAutoRotate(event) {
    if (isUIElement(event.target)) return;
    
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

let isWireframeMode = false;

function initDisplayModesCacheAsync() {
    if (!model || isCacheInitialized || isCacheInitializing) return Promise.resolve();
    
    
    isCacheInitializing = true;
    
    return new Promise((resolve) => {

        setTimeout(() => {
            const startTime = performance.now();
            

            initDisplayModesCache();
            
            const endTime = performance.now();
            
            
            isCacheInitializing = false;
            resolve();
        }, 10); // Минимальная задержка для обеспечения асинхронности
    });
}

function applyDisplayModeToNewModel(mode) {

    if (mode === 'normal') {
        updateDisplayModeUI(mode);
        return Promise.resolve();
    }
    

    const loadingElement = document.querySelector('.loading');
    loadingElement.textContent = `Настройка режима отображения...`;
    loadingElement.style.display = 'block';
    

    return new Promise((resolve) => {
        setTimeout(() => {

            initDisplayModeCacheLazy(mode);
            

            setDisplayMode(mode);
            

            loadingElement.style.display = 'none';
            

            updateDisplayModeUI(mode);
            resolve();
        }, 50); // Небольшая задержка для обновления UI
    });
}

function initDisplayModesCache() {
    if (!model || isCacheInitialized) return;
    
    
    

    const currentMode = currentDisplayMode;
    

    const materials = collectMaterials();
    
    if (materials.size === 0) {
        console.warn('Не найдены материалы для кэширования режимов отображения');
        return;
    }
    
    // Безопасное удаление onBeforeRender со всех мешей
    model.traverse((node) => {
        if (node.isMesh && node.hasOwnProperty('onBeforeRender')) {
            delete node.onBeforeRender;
        }
    });

    displayModesCache.normal = new Map();
    materials.forEach(material => {
        displayModesCache.normal.set(material, material.clone());
    });
    
    

    // Wireframe режим
    displayModesCache.wireframe = new Map();
    materials.forEach(material => {
        const wireframeMaterial = material.clone();
        wireframeMaterial.wireframe = true;
        wireframeMaterial.transparent = true;
        wireframeMaterial.opacity = 0.6;
        wireframeMaterial.color.set(0xdddddd);
        if (wireframeMaterial.emissive) wireframeMaterial.emissive.set(0x000000);
        wireframeMaterial.side = THREE.FrontSide; // Используем одностороннее отображение
        wireframeMaterial.map = null;
        wireframeMaterial.normalMap = null;
        wireframeMaterial.roughnessMap = null;
        wireframeMaterial.metalnessMap = null;
        wireframeMaterial.aoMap = null;
        wireframeMaterial.emissiveMap = null;
        displayModesCache.wireframe.set(material, wireframeMaterial);
    });
    
    


    // Wireframe-solid режим
    displayModesCache['wireframe-solid'] = new Map();
    materials.forEach(material => {
        const solidMaterial = material.clone();
        solidMaterial.wireframe = false;
        solidMaterial.transparent = false;
        solidMaterial.opacity = 1.0;
        solidMaterial.color.set(0xdddddd);
        if (solidMaterial.emissive) solidMaterial.emissive.set(0x000000);
        solidMaterial.side = THREE.FrontSide; // Используем одностороннее отображение
        solidMaterial.map = null;
        solidMaterial.normalMap = null;
        solidMaterial.roughnessMap = null;
        solidMaterial.metalnessMap = null;
        solidMaterial.aoMap = null;
        solidMaterial.emissiveMap = null;
        solidMaterial.metalness = 0;
        solidMaterial.roughness = 1;
        solidMaterial.flatShading = true;
        solidMaterial.polygonOffset = true;
        solidMaterial.polygonOffsetFactor = 1;
        solidMaterial.polygonOffsetUnits = 1;
        displayModesCache['wireframe-solid'].set(material, solidMaterial);
    });
    
    

    if (!edgesMaterial) {
        edgesMaterial = new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1
        });
    }
    

    let edgesCount = 0;
    
    model.traverse((node) => {
        if (node.isMesh && node.geometry) {

            if (!edgesGeometryCache.has(node.geometry)) {

                try {
                    const edgesGeometry = new THREE.EdgesGeometry(node.geometry);
                    edgesGeometryCache.set(node.geometry, edgesGeometry);
                    edgesCount++;
                } catch (error) {
                    console.warn(`Ошибка при создании геометрии ребер: ${error.message}`);
                }
            }
        }
    });
    
    

    isCacheInitialized = true;
    
    

    setDisplayMode(currentMode);
}

function initDisplayModeCacheLazy(mode) {
    if (!model || (displayModesCache[mode] && displayModesCache[mode].size > 0)) return;
    
    
    

    const materials = collectMaterials();
    
    if (materials.size === 0) {
        console.warn('Не найдены материалы для кэширования режима отображения');
        return;
    }
    
    // Безопасное удаление onBeforeRender со всех мешей
    model.traverse((node) => {
        if (node.isMesh && node.hasOwnProperty('onBeforeRender')) {
            delete node.onBeforeRender;
        }
    });

    switch (mode) {
        case 'normal':
            if (!displayModesCache.normal) displayModesCache.normal = new Map();
            materials.forEach(material => {
                displayModesCache.normal.set(material, material.clone());
            });
            
            break;
            
        case 'wireframe':
            if (!displayModesCache.wireframe) displayModesCache.wireframe = new Map();
            materials.forEach(material => {
                const wireframeMaterial = material.clone();
                wireframeMaterial.wireframe = true;
                wireframeMaterial.transparent = true;
                wireframeMaterial.opacity = 0.6;
                wireframeMaterial.color.set(0xdddddd);
                if (wireframeMaterial.emissive) wireframeMaterial.emissive.set(0x000000);
                wireframeMaterial.side = THREE.FrontSide; // Используем одностороннее отображение
                wireframeMaterial.map = null;
                wireframeMaterial.normalMap = null;
                wireframeMaterial.roughnessMap = null;
                wireframeMaterial.metalnessMap = null;
                wireframeMaterial.aoMap = null;
                wireframeMaterial.emissiveMap = null;
                displayModesCache.wireframe.set(material, wireframeMaterial);
            });
            
            break;
            
        case 'wireframe-solid':
            if (!displayModesCache['wireframe-solid']) displayModesCache['wireframe-solid'] = new Map();
            

            materials.forEach(material => {
                const solidMaterial = material.clone();
                solidMaterial.wireframe = false;
                solidMaterial.transparent = false;
                solidMaterial.opacity = 1.0;
                solidMaterial.color.set(0xdddddd);
                if (solidMaterial.emissive) solidMaterial.emissive.set(0x000000);
                solidMaterial.side = THREE.FrontSide; // Используем одностороннее отображение
                solidMaterial.map = null;
                solidMaterial.normalMap = null;
                solidMaterial.roughnessMap = null;
                solidMaterial.metalnessMap = null;
                solidMaterial.aoMap = null;
                solidMaterial.emissiveMap = null;
                solidMaterial.metalness = 0;
                solidMaterial.roughness = 1;
                solidMaterial.flatShading = true;
                solidMaterial.polygonOffset = true;
                solidMaterial.polygonOffsetFactor = 1;
                solidMaterial.polygonOffsetUnits = 1;
                displayModesCache['wireframe-solid'].set(material, solidMaterial);
            });
            
            

            if (!edgesMaterial) {
                edgesMaterial = new THREE.LineBasicMaterial({
                    color: 0x000000,
                    linewidth: 1
                });
            }
            

            let edgesCount = 0;
            model.traverse((node) => {
                if (node.isMesh && node.geometry && !edgesGeometryCache.has(node.geometry)) {

                    try {
                        const edgesGeometry = new THREE.EdgesGeometry(node.geometry);
                        edgesGeometryCache.set(node.geometry, edgesGeometry);
                        edgesCount++;
                    } catch (error) {
                        console.warn(`Ошибка при создании геометрии ребер: ${error.message}`);
                    }
                }
            });
            
            

            break;
    }
}

function setDisplayMode(mode) {
    if (!model) {
        
        currentDisplayMode = mode; // Сохраняем для применения после загрузки

        updateDisplayModeUI(mode);
        return;
    }

    const startTime = performance.now();

    if (currentDisplayMode === 'wireframe-solid' && mode !== 'wireframe-solid') {
        removeHelperObjects();
    }

    if (!displayModesCache[mode] || displayModesCache[mode].size === 0) {

        initDisplayModeCacheLazy(mode);
    }

    if (currentDisplayMode !== 'normal' && mode !== currentDisplayMode) {
        if (mode !== 'wireframe-solid') {
            restoreOriginalMaterials();
        }
    }

    currentDisplayMode = mode;

    switch (mode) {
        case 'normal':
            restoreOriginalMaterials();
            removeHelperObjects();
            break;
            
        case 'wireframe':
            if (originalMaterialProps.size === 0) {
                const materials = collectMaterials();
                materials.forEach(material => {
                    saveOriginalMaterialProps(material);
                });
            }

            if (displayModesCache.wireframe && displayModesCache.wireframe.size > 0) {
                applyMaterialsFromCache('wireframe');
            } else {
                applyWireframeMode();
            }
            
            break;
            
        case 'wireframe-solid':
            if (originalMaterialProps.size === 0) {
                const materials = collectMaterials();
                materials.forEach(material => {
                    saveOriginalMaterialProps(material);
                });
            }

            if (displayModesCache['wireframe-solid'] && displayModesCache['wireframe-solid'].size > 0) {
                applyMaterialsFromCache('wireframe-solid');
            } else {
                applyWireframeSolidModeNoCache();
            }

            if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }

            requestAnimationFrame(() => {
                addEdgeLines();

                if (renderer && scene && camera) {
                    renderer.render(scene, camera);
                }
            });
            
            break;
    }
    
    // Принудительно устанавливаем одностороннее отображение для всех материалов
    forceFrontSideMaterials();

    // Принудительное обновление UI с таймаутом для гарантированного применения
    setTimeout(() => {
        updateDisplayModeUI(mode);
    }, 0);

    const endTime = performance.now();
    
}

function applyMaterialsFromCache(mode) {
    if (!displayModesCache[mode]) return;
    
    
    const startTime = performance.now();
    

    const materialMap = new Map();
    let appliedCount = 0;
    

    model.traverse((node) => {
        if (node.isMesh && node.material) {
            if (Array.isArray(node.material)) {

                node.material.forEach((material, index) => {
                    if (displayModesCache[mode].has(material)) {


                        const cachedMaterial = displayModesCache[mode].get(material);
                        materialMap.set(material, cachedMaterial);
                    }
                });
            } else if (displayModesCache[mode].has(node.material)) {

                const cachedMaterial = displayModesCache[mode].get(node.material);
                materialMap.set(node.material, cachedMaterial);
            }
            
            // Безопасное удаление свойства onBeforeRender, если оно есть
            if (node.hasOwnProperty('onBeforeRender')) {
                delete node.onBeforeRender;
            }
        }
    });
    

    materialMap.forEach((cachedMaterial, material) => {
        material.wireframe = cachedMaterial.wireframe;
        material.transparent = cachedMaterial.transparent;
        material.opacity = cachedMaterial.opacity;
        // Всегда используем одностороннее отображение, независимо от кэша
        material.side = THREE.FrontSide;
        material.color.copy(cachedMaterial.color);
        if (material.emissive && cachedMaterial.emissive) {
            material.emissive.copy(cachedMaterial.emissive);
        }
        

        material.map = cachedMaterial.map;
        material.normalMap = cachedMaterial.normalMap;
        material.roughnessMap = cachedMaterial.roughnessMap;
        material.metalnessMap = cachedMaterial.metalnessMap;
        material.aoMap = cachedMaterial.aoMap;
        material.emissiveMap = cachedMaterial.emissiveMap;
        

        if (cachedMaterial.metalness !== undefined) {
            material.metalness = cachedMaterial.metalness;
        }
        if (cachedMaterial.roughness !== undefined) {
            material.roughness = cachedMaterial.roughness;
        }
        if (cachedMaterial.flatShading !== undefined) {
            material.flatShading = cachedMaterial.flatShading;
        }
        

        material.polygonOffset = cachedMaterial.polygonOffset;
        material.polygonOffsetFactor = cachedMaterial.polygonOffsetFactor;
        material.polygonOffsetUnits = cachedMaterial.polygonOffsetUnits;
        

        material.needsUpdate = true;
        appliedCount++;
    });
    
    const endTime = performance.now();
    
    

    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

function resetDisplayMode() {

    if (isCacheInitialized && displayModesCache.normal) {
        applyMaterialsFromCache('normal');
    } else {

        restoreOriginalMaterials();
    }
    

    removeHelperObjects();
    

    if (!isCacheInitialized) {
        originalMaterialProps.clear();
    }
    
    
}

function clearDisplayModesCache() {

    for (const mode in displayModesCache) {
        if (displayModesCache[mode]) {
            if (displayModesCache[mode] instanceof Map) {

                displayModesCache[mode].forEach((cacheMaterial) => {
                    if (cacheMaterial && cacheMaterial.dispose) {
                        if (cacheMaterial.map) cacheMaterial.map.dispose();
                        if (cacheMaterial.normalMap) cacheMaterial.normalMap.dispose();
                        if (cacheMaterial.metalnessMap) cacheMaterial.metalnessMap.dispose();
                        if (cacheMaterial.roughnessMap) cacheMaterial.roughnessMap.dispose();
                        cacheMaterial.dispose();
                    }
                });
                displayModesCache[mode].clear();
            }
            displayModesCache[mode] = null;
        }
    }
    

    if (edgesGeometryCache.size > 0) {
        edgesGeometryCache.forEach((geometry) => {
            if (geometry && geometry.dispose) {
                geometry.dispose();
            }
        });
        edgesGeometryCache.clear();
        
    }
    

    if (edgesMaterial) {
        edgesMaterial.dispose();
        edgesMaterial = null;
        
    }
    

    isCacheInitialized = false;
    

    originalMaterialProps.clear();
    
    
}

function applyWireframeMode() {
    const materials = collectMaterials();
    
    let appliedCount = 0;

    materials.forEach(material => {
        saveOriginalMaterialProps(material);

        material.wireframe = true;

        disableTextures(material);

        material.transparent = true;
        material.opacity = 0.6;

        material.color.set(0xdddddd); // Светло-серый цвет
        if (material.emissive) material.emissive.set(0x000000); // Убираем эмиссию
        
        material.side = THREE.FrontSide; // Используем одностороннее отображение

        material.needsUpdate = true;
        appliedCount++;
    });
}

function applyWireframeSolidModeNoCache() {
    const materials = collectMaterials();

    materials.forEach(material => {
        saveOriginalMaterialProps(material);

        material.wireframe = false;

        disableTextures(material);

        material.transparent = false;
        material.opacity = 1.0;

        if (material.type !== 'MeshBasicMaterial') {
            originalMaterialProps.get(material).materialType = material.type;

            material.metalness = 0;
            material.roughness = 1;
            material.flatShading = true;
        }

        material.color.set(0xdddddd); // Светло-серый цвет для полигонов
        if (material.emissive) material.emissive.set(0x000000);

        material.polygonOffset = true;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
        
        material.side = THREE.FrontSide; // Используем одностороннее отображение

        material.needsUpdate = true;
    });
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

function disableTextures(material) {
    material.map = null;
    material.normalMap = null;
    material.roughnessMap = null;
    material.metalnessMap = null;
    material.aoMap = null;
    material.emissiveMap = null;
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
    
    // Обработка масштабирования двумя пальцами (pinch-to-zoom)
    if (isPinching && event.touches.length === 2) {
        const dx = event.touches[0].clientX - event.touches[1].clientX;
        const dy = event.touches[0].clientY - event.touches[1].clientY;
        const pinchDistance = Math.sqrt(dx * dx + dy * dy);
        
        const pinchDelta = pinchDistance - pinchStartDistance;
        
        if (controlMode === 'wasd') {
            // Более плавное изменение скорости в зависимости от силы жеста
            const pinchFactor = Math.sign(pinchDelta) * Math.min(0.5, Math.abs(pinchDelta) / 50);
            moveSpeed = Math.max(MIN_MOVE_SPEED, 
                        Math.min(MAX_MOVE_SPEED, 
                            moveSpeed + pinchFactor));
            updateSpeedIndicator();
        } else {
            // Более плавное масштабирование для обычного режима
            const zoomFactor = 0.01;
            const movementVector = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
            
            if (pinchDelta > 0) {
                camera.position.addScaledVector(movementVector, pinchDelta * zoomFactor);
            } else {
                camera.position.addScaledVector(movementVector, pinchDelta * zoomFactor);
            }
            
            controls.update();
        }
        
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
                    // Дебаг: выводим текущие углы для отладки
                    console.log(`Сенсорное вращение: X: ${(targetRotationX * 180 / Math.PI).toFixed(1)}°, Y: ${(targetRotationY * 180 / Math.PI).toFixed(1)}°`);
                }
                break;
            }
        }
    }
}

function handleTouchEnd(event) {
    if (isUIElement(event.target)) {
        return;
    }
    
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

// Функция для удаления модели из Supabase
async function deleteModelFromSupabase(modelId, filePath) {
    try {
        if (!supabase) {
            if (!initSupabase()) {
                throw new Error('Не удалось инициализировать Supabase');
            }
        }

        if (!modelId) {
            throw new Error('ID модели не указан');
        }

        document.querySelector('.loading').textContent = 'Удаление модели...';
        document.querySelector('.loading').style.display = 'block';

        // Сначала удаляем запись из базы данных
        const { error: dbError } = await supabase
            .from('models')
            .delete()
            .eq('id', modelId);

        if (dbError) {
            throw dbError;
        }

        // Затем удаляем файл из хранилища, если указан путь
        if (filePath) {
            const { error: storageError } = await supabase.storage
                .from('models')
                .remove([filePath]);

            if (storageError) {
                console.error('Ошибка удаления файла из хранилища:', storageError);
                // Продолжаем выполнение, так как запись в БД уже удалена
            }
        }

        // Удаляем модель из локального массива и localStorage
        userModels = userModels.filter(model => model.id !== modelId);
        localStorage.setItem('userModels', JSON.stringify(userModels));

        // Удаляем модель из селектора
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
            Array.from(modelSelect.options).forEach(option => {
                if (option.dataset.id === modelId) {
                    modelSelect.removeChild(option);
                }
            });

            // Если есть другие модели, выбираем первую
            if (modelSelect.options.length > 0) {
                modelSelect.selectedIndex = 0;
                currentModelPath = modelSelect.value;
                loadModel();
            }
        }

        document.querySelector('.loading').textContent = 'Модель успешно удалена';
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 1500);

        return true;

    } catch (error) {
        console.error('Ошибка при удалении модели из Supabase:', error);
        document.querySelector('.loading').textContent = `Ошибка удаления: ${error.message}`;
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 3000);
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
});

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
document.addEventListener('DOMContentLoaded', function() {
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
    
    // Инициализируем Supabase
    if (initSupabase()) {
        fetchModelsFromSupabase();
    } else {
        loadModelsFromLocalStorage();
    }
    
    // Настраиваем UI
    setupUI();
    setupMobileButtonHandlers();
    checkAndHideUploadButton();
    setupFileUploadHandlers();
    
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
    
    // Добавляем обработчик изменения выбранной модели
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            const selectedOption = modelSelect.options[modelSelect.selectedIndex];
            const modelName = selectedOption.textContent;
            
            console.log('Выбрана модель:', modelName);
            
            // Обновляем URL с параметром выбранной модели
            updateUrlWithModel(modelName);
            
            // Загружаем выбранную модель
            loadSelectedModel();
        });
    }
    
    // Инициализация 3D сцены
    if (modelSelect && modelSelect.options.length > 0) {
        // Сначала инициализируем 3D движок
        currentModelPath = modelSelect.options[0].value;
        init();
        animate();
        
        // Затем проверяем, есть ли параметр модели в URL
        setTimeout(() => {
            loadModelFromUrlParam().then(urlModelLoaded => {
                if (!urlModelLoaded) {
                    // Если модель не была загружена по URL, обновляем URL для первой модели
                    const firstModelName = modelSelect.options[0].textContent;
                    updateUrlWithModel(firstModelName);
                }
            }).catch(error => {
                console.error('Ошибка при загрузке модели по URL:', error);
            });
        }, 500); // Даем время на инициализацию сцены
    } else {
        console.error('Не удалось найти список моделей или список пуст');
        currentModelPath = 'https://ucarecdn.com/ef29366f-638f-4131-8b83-78ee40120967/';
        init();
        animate();
    }

    // Отложенная инициализация режимов отображения
    setTimeout(() => {
        if (currentDisplayMode && currentDisplayMode !== 'normal') {
            updateDisplayModeUI(currentDisplayMode);
        }
    }, 1000);
    
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

// Функция для проверки наличия дубликата модели в базе данных
async function checkModelDuplicate(fileName) {
    try {
        if (!supabase) {
            if (!initSupabase()) {
                throw new Error('Не удалось инициализировать Supabase');
            }
        }

        // Проверяем наличие модели с таким же именем в базе данных
        const { data, error } = await supabase
            .from('models')
            .select('id, name')
            .eq('name', fileName);

        if (error) {
            console.error('Ошибка при проверке дубликатов модели:', error);
            return false; // В случае ошибки разрешаем загрузку
        }

        // Если найдена модель с таким же именем, возвращаем true (дубликат существует)
        return data && data.length > 0;
    } catch (error) {
        console.error('Ошибка при проверке дубликатов модели:', error);
        return false; // В случае ошибки разрешаем загрузку
    }
}



// Функция для локальной загрузки модели (если Supabase недоступен)
function loadLocalModel(file) {
    try {
        console.log('Начинаем локальную загрузку модели:', file.name);
        
        // Правильное определение формата файла
        let format = '';
        const fileNameParts = file.name.split('.');
        
        // Проверяем, что есть хотя бы одна точка в имени файла
        if (fileNameParts.length > 1) {
            format = fileNameParts.pop().toLowerCase();
        }
        
        console.log('Определен формат файла:', format);
        
        // Проверяем, что формат поддерживается
        if (format !== 'glb' && format !== 'gltf') {
            throw new Error(`Формат ${format || 'неизвестный'} не поддерживается. Используйте только GLB или GLTF.`);
        }
        
        // Создаем локальный URL для файла
        const objectUrl = URL.createObjectURL(file);
        
        document.querySelector('.loading').textContent = 'Локальная загрузка модели...';
        document.querySelector('.loading').style.display = 'block';
        
        // Обновляем отображаемое имя файла
        const fileNameElement = document.getElementById('file-name');
        if (fileNameElement) {
            fileNameElement.textContent = file.name;
        }
        
        // Создаем информацию о модели
        const modelInfo = {
            url: objectUrl,
            name: file.name,
            format: format, // Добавляем формат для будущих проверок
            isLocalFile: true
        };
        
        // Добавляем модель в селектор с указанием формата
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
            const option = document.createElement('option');
            option.value = objectUrl;
            option.text = file.name;
            option.dataset.format = format; // Важно: указываем формат в data-атрибуте
            modelSelect.add(option, 0);
            modelSelect.selectedIndex = 0;
            
            // Устанавливаем как текущий путь
            currentModelPath = objectUrl;
            
            // Загружаем модель
            setTimeout(() => {
                loadModel().catch(error => {
                    console.error('Ошибка при загрузке локальной модели:', error);
                });
            }, 100);
        } else {
            // Если нет селектора, просто добавляем в список
            addModelToSelector(modelInfo, true);
        }
        
        return modelInfo;
    } catch (error) {
        console.error('Ошибка при локальной загрузке модели:', error);
        document.querySelector('.loading').textContent = `Ошибка локальной загрузки: ${error.message}`;
        setTimeout(() => {
            document.querySelector('.loading').style.display = 'none';
        }, 3000);
        return null;
    }
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

        // Проверяем, доступен ли Supabase для загрузки на сервер
        let supabaseConfigured = false;
        try {
            supabaseConfigured = initSupabase();
        } catch (error) {
            console.error('Ошибка при инициализации Supabase:', error);
            supabaseConfigured = false;
        }

        if (supabaseConfigured) {
            console.log('Supabase инициализирован, пытаемся загрузить модель на сервер');
            
            // Загружаем модель через Supabase
            uploadModelToSupabase(file)
                .then(modelInfo => {
                    // Успешно загружено, модель уже добавлена в селектор
                    console.log('Модель успешно загружена через Supabase:', modelInfo);
                })
                .catch(error => {
                    console.error('Ошибка загрузки через Supabase:', error);
                    // Пробуем загрузить локально как запасной вариант
                    console.log('Переходим к локальной загрузке модели');
                    loadLocalModel(file);
                });
        } else {
            // Если Supabase не настроен, загружаем модель локально
            console.log('Supabase не настроен, загружаем модель локально');
            loadLocalModel(file);
        }
    } catch (error) {
        console.error('Ошибка при обработке файла:', error);
        alert(`Ошибка при обработке файла: ${error.message}`);
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

// Функция для получения ссылки на текущую модель
function getCurrentModelLink() {
    // Получаем базовый URL страницы
    const baseUrl = window.location.origin + window.location.pathname;
    
    // Получаем текущую выбранную модель
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect || modelSelect.selectedIndex === -1) {
        return baseUrl; // Возвращаем базовую ссылку если модель не выбрана
    }
    
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const modelName = selectedOption.textContent;
    const safeParam = createSafeModelParam(modelName);
    
    if (!safeParam) {
        return baseUrl;
    }
    
    return `${baseUrl}?model=${encodeURIComponent(safeParam)}`;
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

// Функция для загрузки модели по URL параметру
async function loadModelFromUrlParam() {
    try {
        const modelParam = getModelParam();
        if (!modelParam) {
            return false; // Тихо возвращаем false, если параметра нет
        }
        
        console.log('Найден параметр модели в URL:', modelParam);
        
        // Инициализируем Supabase если нужно
        if (!supabase) {
            if (!initSupabase()) {
                console.error('Не удалось инициализировать Supabase для загрузки модели');
                return false;
            }
        }
        
        // Ищем модель в базе данных разными способами
        console.log('Поиск модели в базе данных:', modelParam);
        
        // Создаем варианты поиска для разных случаев
        const searchVariants = [
            modelParam, // Исходный параметр: 0612_prdpervyivarshavskyi_vl_1_a_01fbxglb
        ];
        
        // Добавляем варианты с точками перед расширениями
        const extensions = ['glb', 'gltf', 'obj', 'fbx', 'dae', 'ply', 'stl'];
        
        // Простые случаи - одно расширение в конце
        extensions.forEach(ext => {
            const pattern = new RegExp(`([a-z\\d])${ext}$`, 'i');
            if (pattern.test(modelParam)) {
                searchVariants.push(modelParam.replace(pattern, `$1.${ext}`));
            }
        });
        
        // Сложные случаи - двойные расширения (fbxglb, objgltf и т.д.)
        extensions.forEach(firstExt => {
            extensions.forEach(secondExt => {
                if (firstExt !== secondExt) {
                    const doublePattern = new RegExp(`([a-z\\d])${firstExt}${secondExt}$`, 'i');
                    if (doublePattern.test(modelParam)) {
                        // Варианты: .fbx.glb, .fbxglb, fbx.glb
                        searchVariants.push(modelParam.replace(doublePattern, `$1.${firstExt}.${secondExt}`));
                        searchVariants.push(modelParam.replace(doublePattern, `$1.${firstExt}${secondExt}`));
                        searchVariants.push(modelParam.replace(doublePattern, `$1${firstExt}.${secondExt}`));
                    }
                }
            });
        });
        
        // Удаляем дубликаты
        const uniqueVariants = [...new Set(searchVariants)];
        
        // Строим условие поиска OR для всех вариантов
        const searchConditions = uniqueVariants.map(variant => 
            `name.ilike.%${variant}%,file_path.ilike.%${variant}%`
        ).join(',');
        
        const { data, error } = await supabase
            .from('models')
            .select('*')
            .or(searchConditions)
            .limit(10);
        
        if (error) {
            console.error('Ошибка при поиске модели в Supabase:', error);
            return false;
        }
        
        if (!data || data.length === 0) {
            console.log(`Модель "${modelParam}" не найдена в базе данных`);
            return false;
        }
        
        // Выбираем лучшее совпадение
        let bestMatch = data[0];
        
        // Ищем лучшее совпадение несколькими способами
        for (const model of data) {
            const safeModelName = createSafeModelParam(model.name);
            const safeFilePath = createSafeModelParam(model.file_path.split('/').pop());
            
            // Точное совпадение по безопасному имени
            if (safeModelName === modelParam) {
                bestMatch = model;
                break;
            }
            
            // Точное совпадение по безопасному имени файла
            if (safeFilePath === modelParam) {
                bestMatch = model;
                break;
            }
            
            // Если имя файла содержит искомый параметр
            if (model.file_path.toLowerCase().includes(modelParam.toLowerCase())) {
                bestMatch = model;
                // Не прерываем, может найдется более точное совпадение
            }
        }
        
        console.log('Найдена модель:', bestMatch.name);
        
        // Получаем URL файла
        const fileUrl = supabase.storage.from('models').getPublicUrl(bestMatch.file_path).data.publicUrl;
        
        // Обновляем селектор модели
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
            // Ищем соответствующую опцию в селекторе
            for (let i = 0; i < modelSelect.options.length; i++) {
                const option = modelSelect.options[i];
                if (option.value === fileUrl || option.textContent.includes(bestMatch.name)) {
                    modelSelect.selectedIndex = i;
                    break;
                }
            }
        }
        
        // Проверяем что scene инициализирован перед загрузкой модели
        if (!scene) {
            console.error('Scene не инициализирован, не можем загрузить модель');
            return false;
        }
        
        // Загружаем модель
        currentModelPath = fileUrl;
        await loadModel();
        
        return true;
        
    } catch (error) {
        console.error('Ошибка при загрузке модели по URL параметру:', error);
        return false;
    }
}
