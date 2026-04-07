import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, set, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyChsg1t0QKS_sSThC0KHZbluyNxMDkRlJo",
    authDomain: "kod-pobedy.firebaseapp.com",
    databaseURL: "https://kod-pobedy-default-rtdb.firebaseio.com",
    projectId: "kod-pobedy",
    storageBucket: "kod-pobedy.firebasestorage.app",
    messagingSenderId: "372401802248",
    appId: "1:372401802248:web:e2080dfbd9e335e30b55bd"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const STORAGE_BUCKET = String(firebaseConfig.storageBucket || "").startsWith("gs://")
    ? String(firebaseConfig.storageBucket)
    : `gs://${firebaseConfig.storageBucket}`;
const storage = getStorage(app, STORAGE_BUCKET);

document.addEventListener("contextmenu", (event) => event.preventDefault());

const PASS = "Tula33842";
const TIME_LIMIT = 60;
const OPTION_MARKS = ["A", "B", "C", "D", "E", "F"];
const DEFAULT_FACT_TEXT = "Историческая справка для этого вопроса пока не добавлена.";

let myGames = [];
let leaders = [];
let feedbacks = [];

let activeGame = null;
let currentQuestionIndex = 0;
let score = 0;
let currentEditingGameId = null;
let currentEditingQuestionIndex = null;
let pendingUploadUrl = "";

let timerInterval = null;
let timeLeft = 0;

let gameStartedAt = 0;
let lastGameDurationMs = 0;
let selectedLeaderboardGameId = "all";
let selectedAdminLeadersGameId = "all";

const VISITOR_ID_KEY = "kp_visitor_id";

function normalizeCollection(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).filter(Boolean);
    return [];
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncateText(value, maxLength) {
    const text = String(value ?? "").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function pluralize(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

function formatDurationSeconds(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

function formatDurationMs(ms) {
    const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return formatDurationSeconds(seconds);
}

function getOrCreateVisitorId() {
    try {
        const existing = window.localStorage.getItem(VISITOR_ID_KEY);
        if (existing) return existing;
        const id = (crypto?.randomUUID?.() || `v_${Date.now()}_${Math.random().toString(16).slice(2)}`).slice(0, 64);
        window.localStorage.setItem(VISITOR_ID_KEY, id);
        return id;
    } catch {
        return `v_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
}

async function trackVisit() {
    const visitorId = getOrCreateVisitorId();

    try {
        await runTransaction(ref(db, "stats/visitsTotal"), (value) => (Number(value) || 0) + 1);
    } catch (error) {
        console.warn("Не удалось обновить visitsTotal", error);
    }

    try {
        await runTransaction(ref(db, `stats/visitors/${visitorId}`), (value) => value || Date.now());
    } catch (error) {
        console.warn("Не удалось обновить visitors", error);
    }
}

async function trackQuizFinished() {
    const visitorId = getOrCreateVisitorId();

    try {
        await runTransaction(ref(db, "stats/quizzesFinishedTotal"), (value) => (Number(value) || 0) + 1);
    } catch (error) {
        console.warn("Не удалось обновить quizzesFinishedTotal", error);
    }

    try {
        await runTransaction(ref(db, `stats/quizFinishers/${visitorId}`), (value) => value || Date.now());
    } catch (error) {
        console.warn("Не удалось обновить quizFinishers", error);
    }
}

function getQuestionCountLabel(count) {
    return `${count} ${pluralize(count, "вопрос", "вопроса", "вопросов")}`;
}

function getDurationLabel(questionCount) {
    if (!questionCount) return "вопросы ещё не добавлены";

    const totalSeconds = questionCount * TIME_LIMIT;
    if (totalSeconds < 60) {
        return `примерно ${totalSeconds} сек`;
    }

    const totalMinutes = Math.ceil(totalSeconds / 60);
    return `примерно ${totalMinutes} ${pluralize(totalMinutes, "минута", "минуты", "минут")}`;
}

function getQuestionTypeLabel(type) {
    if (type === "choice") return "Угадай ответ";
    if (type === "photo") return "Угадай по фото";
    if (type === "date") return "Сопоставь дату";
    return "Найди историческую ошибку";
}

function getQuestionHint(type) {
    if (type === "choice") return "Выберите один правильный ответ и уложитесь во время.";
    if (type === "photo") return "Посмотрите на изображение и выберите один правильный ответ.";
    if (type === "date") return "Сопоставьте событие и нужную дату.";
    return "Выберите утверждение, в котором допущена историческая ошибка.";
}

function getQuestionCorrectIndex(question) {
    const rawIndex = Number(question?.correct);
    const options = normalizeCollection(question?.options);

    if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < options.length) {
        return rawIndex;
    }

    return 0;
}

function getQuestionFact(question) {
    const fact = String(question?.fact ?? question?.explanation ?? "").trim();
    return fact || DEFAULT_FACT_TEXT;
}

function getCorrectAnswerText(question) {
    const options = normalizeCollection(question?.options);
    return options[getQuestionCorrectIndex(question)] || "Правильный ответ не указан";
}

function getResultMessage(correctAnswers, totalQuestions) {
    if (!totalQuestions) {
        return {
            title: "Квиз завершён",
            text: "Результат пока нельзя оценить, потому что в теме нет вопросов."
        };
    }

    const percent = Math.round((correctAnswers / totalQuestions) * 100);

    if (percent === 100) {
        return {
            title: "Блестящий результат",
            text: "Вы ответили правильно на все вопросы. Такой результат точно заслуживает места на доске почёта."
        };
    }

    if (percent >= 75) {
        return {
            title: "Очень сильное прохождение",
            text: "Вы отлично ориентируетесь в материале. Осталось совсем немного, чтобы пройти тему без ошибок."
        };
    }

    if (percent >= 45) {
        return {
            title: "Хороший задел",
            text: "У вас уже есть база знаний. Попробуйте пройти тему ещё раз и улучшить итоговый счёт."
        };
    }

    return {
        title: "Есть куда расти",
        text: "Не страшно ошибаться. Можно вернуться в меню, выбрать тему заново и пройти её ещё раз."
    };
}

function getPhotoPlaceholder(label) {
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520">
            <defs>
                <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stop-color="#f4ecde"/>
                    <stop offset="100%" stop-color="#ded0bb"/>
                </linearGradient>
            </defs>
            <rect width="900" height="520" rx="36" fill="url(#bg)"/>
            <rect x="40" y="40" width="820" height="440" rx="28" fill="none" stroke="#8e7b69" stroke-opacity="0.45" stroke-width="3" stroke-dasharray="12 12"/>
            <circle cx="240" cy="190" r="48" fill="#c6ae85" fill-opacity="0.55"/>
            <path d="M180 370L310 230L420 330L515 260L650 370H180Z" fill="#9d8466" fill-opacity="0.55"/>
            <text x="450" y="440" text-anchor="middle" font-family="Verdana, sans-serif" font-size="32" font-weight="700" fill="#6b5745">${escapeHtml(label)}</text>
        </svg>
    `;

    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function shuffleArray(items) {
    const array = [...items];

    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

/* ИЗМЕНЕНО: Скроллим теперь активный экран, а не весь контейнер */
function scrollMainWrapToTop() {
    const activeScreen = document.querySelector(".screen.active");
    if (activeScreen) activeScreen.scrollTo({ top: 0, behavior: "smooth" });
}

function updateMenuStats() {
    const gameCountEl = document.getElementById("menu-game-count");
    const leaderCountEl = document.getElementById("menu-leader-count");
    const timeLimitEl = document.getElementById("menu-time-limit");

    if (gameCountEl) gameCountEl.innerText = myGames.length;
    if (leaderCountEl) leaderCountEl.innerText = String(getLeadersTotalCount(leaders));
    if (timeLimitEl) timeLimitEl.innerText = TIME_LIMIT;
}

function updateTimerVisual(seconds) {
    const timeDisplay = document.getElementById("timer-seconds");
    const timerContainer = document.querySelector(".timer-box");

    if (timeDisplay) timeDisplay.innerText = seconds;

    if (timerContainer) {
        const fill = Math.max(0, Math.min(100, (seconds / TIME_LIMIT) * 100));
        timerContainer.style.setProperty("--timer-fill", `${fill}%`);
    }
}

function updateGameProgress() {
    const fill = document.getElementById("game-progress-fill");
    const text = document.getElementById("game-progress-text");

    if (!activeGame || !activeGame.questions || !activeGame.questions.length) {
        if (fill) fill.style.width = "0%";
        if (text) text.innerText = "Прогресс: 0 из 0";
        return;
    }

    const percent = ((currentQuestionIndex + 1) / activeGame.questions.length) * 100;

    if (fill) fill.style.width = `${percent}%`;
    if (text) text.innerText = `Прогресс: ${currentQuestionIndex + 1} из ${activeGame.questions.length}`;
}

function getPlayerInitial(name) {
    return String(name || "А")
        .trim()
        .charAt(0)
        .toUpperCase() || "А";
}

onValue(ref(db, "games"), (snapshot) => {
    myGames = snapshot.exists() ? normalizeCollection(snapshot.val()) : [];
    renderGameList();
    renderAdminGames();
    updateMenuStats();

    if (currentEditingGameId) {
        const currentGame = myGames.find((game) => game.id === currentEditingGameId);
        if (currentGame) renderQuestionsList();
        else currentEditingGameId = null;
    }
});

onValue(ref(db, "leaders"), (snapshot) => {
    leaders = snapshot.exists() ? normalizeCollection(snapshot.val()) : [];
    updateLeaderboardUI();
    updateAdminLeadersUI();
    updateMenuStats();
});

onValue(ref(db, "feedback"), (snapshot) => {
    feedbacks = snapshot.exists() ? normalizeCollection(snapshot.val()) : [];
    renderFeedbackList();
});

onValue(ref(db, "stats"), (snapshot) => {
    const stats = snapshot.exists() ? snapshot.val() : {};
    updateAdminStatsUI(stats);
});

function updateAdminStatsUI(stats) {
    const visitsTotalEl = document.getElementById("admin-visits-total");
    const quizzesFinishedTotalEl = document.getElementById("admin-quizzes-finished-total");

    const visitsTotal = Number(stats?.visitsTotal) || 0;
    const quizzesFinishedTotal = Number(stats?.quizzesFinishedTotal) || 0;

    if (visitsTotalEl) visitsTotalEl.innerText = String(visitsTotal);
    if (quizzesFinishedTotalEl) quizzesFinishedTotalEl.innerText = String(quizzesFinishedTotal);
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;

    const timerContainer = document.querySelector(".timer-box");
    if (timerContainer) timerContainer.classList.remove("time-low");
}

function closeAnswerModal() {
    const modal = document.getElementById("answer-modal");
    const wrap = document.querySelector(".main-wrap");

    if (modal) modal.hidden = true;
    if (wrap) wrap.classList.remove("modal-open");
}

function openAnswerModal({ title, status, correctAnswer, fact, showCorrectAnswer = true }) {
    const modal = document.getElementById("answer-modal");
    const wrap = document.querySelector(".main-wrap");
    if (!modal) return;

    const correctBlock = document.getElementById("answer-modal-correct-block");
    document.getElementById("answer-modal-title").innerText = title;
    document.getElementById("answer-modal-status").innerText = status;
    document.getElementById("answer-modal-correct").innerText = correctAnswer;
    document.getElementById("answer-modal-fact").innerText = fact;
    if (correctBlock) correctBlock.hidden = !showCorrectAnswer;

    modal.hidden = false;
    if (wrap) wrap.classList.add("modal-open");
}

function goToNextQuestion() {
    closeAnswerModal();
    currentQuestionIndex += 1;

    if (activeGame && currentQuestionIndex < activeGame.questions.length) {
        showQuestion();
        return;
    }

    finishGame();
}

function switchScreen(screenId) {
    if (screenId !== "game") {
        closeAnswerModal();
        resetTimer();
    }

    const screens = document.querySelectorAll(".screen");
    screens.forEach((screen) => screen.classList.remove("active"));

    const targetScreen = document.getElementById(screenId);
    if (targetScreen) targetScreen.classList.add("active");

    scrollMainWrapToTop();
}

function showMenu() {
    switchScreen("menu");
}

function showLogin() {
    switchScreen("login");
}

function showLeaderboard() {
    updateLeaderboardUI();
    switchScreen("lider");
}

function showFeedbackScreen() {
    switchScreen("feedback-screen");
}

function applyScreenFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const screen = params.get("screen");
    if (!screen) return;

    const target = document.getElementById(screen);
    if (target && target.classList.contains("screen")) {
        switchScreen(screen);
    }
}

function applyFigmaExportMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("figma") !== "all") return;

    document.body.classList.add("figma-export");

    const wrap = document.querySelector(".main-wrap");
    if (wrap) wrap.classList.add("figma-export-wrap");

    const screens = document.querySelectorAll(".screen");
    screens.forEach((screen) => {
        screen.classList.add("active");
    });

    const modal = document.getElementById("answer-modal");
    if (modal) modal.hidden = false;
}

function submitFeedback() {
    const nameInput = document.getElementById("fb-name");
    const messageInput = document.getElementById("fb-message");
    const name = nameInput.value.trim() || "Анонимный пользователь";
    const message = messageInput.value.trim();

    if (!message) {
        alert("Пожалуйста, напишите сообщение.");
        return;
    }

    const newMessage = {
        name,
        message,
        date: new Date().toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        })
    };

    feedbacks.push(newMessage);
    set(ref(db, "feedback"), feedbacks);

    nameInput.value = "";
    messageInput.value = "";

    alert("Сообщение отправлено. Спасибо за обратную связь!");
    showMenu();
}

function checkLogin() {
    const input = document.getElementById("admin-pass");

    if (input.value === PASS) {
        input.value = "";
        switchScreen("admin");
        switchAdminTab("games");
        return;
    }

    alert("Неверный код доступа.");
}

function switchAdminTab(tabName) {
    const btnGames = document.getElementById("tab-games");
    const btnStats = document.getElementById("tab-stats");
    const btnFeedback = document.getElementById("tab-feedback");
    const secGames = document.getElementById("admin-section-games");
    const secStats = document.getElementById("admin-section-stats");
    const secFeedback = document.getElementById("admin-section-feedback");

    if (tabName === "games") {
        btnGames.classList.add("tab-active");
        if (btnStats) btnStats.classList.remove("tab-active");
        btnFeedback.classList.remove("tab-active");
        secGames.style.display = "block";
        if (secStats) secStats.style.display = "none";
        secFeedback.style.display = "none";
        return;
    }

    if (tabName === "stats") {
        btnGames.classList.remove("tab-active");
        if (btnStats) btnStats.classList.add("tab-active");
        btnFeedback.classList.remove("tab-active");
        secGames.style.display = "none";
        if (secStats) secStats.style.display = "block";
        secFeedback.style.display = "none";
        return;
    }

    btnFeedback.classList.add("tab-active");
    btnGames.classList.remove("tab-active");
    if (btnStats) btnStats.classList.remove("tab-active");
    secFeedback.style.display = "block";
    secGames.style.display = "none";
    if (secStats) secStats.style.display = "none";
}

function renderFeedbackList() {
    const countEl = document.getElementById("fb-count");
    const container = document.getElementById("admin-feedback-list");

    if (countEl) countEl.innerText = feedbacks.length;
    if (!container) return;

    if (!feedbacks.length) {
        container.innerHTML = "<div class='empty-state'>Пожеланий пока нет. Когда пользователи начнут оставлять сообщения, они появятся здесь.</div>";
        return;
    }

    let html = "";

    for (let i = feedbacks.length - 1; i >= 0; i--) {
        const feedback = feedbacks[i];
        const name = feedback.name || "Анонимный пользователь";

        html += `
            <article class="feedback-card">
                <div class="feedback-card__head">
                    <div class="feedback-avatar">${escapeHtml(getPlayerInitial(name))}</div>
                    <p class="fb-info"><strong>${escapeHtml(name)}</strong><br>${escapeHtml(feedback.date || "Без даты")}</p>
                </div>
                <p class="fb-text">${escapeHtml(feedback.message || "")}</p>
                <button type="button" class="fb-delete" onclick="window.deleteFeedback(${i})">Удалить сообщение</button>
            </article>`;
    }

    container.innerHTML = html;
}

function deleteFeedback(index) {
    if (!confirm("Удалить это сообщение?")) return;

    feedbacks.splice(index, 1);
    set(ref(db, "feedback"), feedbacks);
}

function renderAdminGames() {
    const container = document.getElementById("admin-games-list");
    if (!container) return;

    if (!myGames.length) {
        container.innerHTML = "<div class='empty-state'>Тем пока нет. Создайте первую тему и добавьте в неё вопросы.</div>";
        return;
    }

    container.innerHTML = myGames.map((game) => {
        const questions = normalizeCollection(game.questions);
        const questionCount = questions.length;

        return `
            <div class="list-item">
                <div class="list-item__meta">
                    <span class="list-item__title">${escapeHtml(game.title || "Без названия")}</span>
                    <span class="list-item__sub">${getQuestionCountLabel(questionCount)} • ${getDurationLabel(questionCount)}</span>
                </div>
                <div class="list-item__actions">
                    <button type="button" onclick="window.manageQuestions(${game.id})" class="mini-action btn-red">Вопросы</button>
                    <button type="button" onclick="window.deleteGame(${game.id})" class="mini-action btn-dark">Удалить</button>
                </div>
            </div>`;
    }).join("");
}

function createNewGame() {
    const title = prompt("Введите название новой темы:");
    if (!title) return;

    const cleanTitle = title.trim();
    if (!cleanTitle) {
        alert("Название темы не должно быть пустым.");
        return;
    }

    myGames.push({
        id: Date.now(),
        title: cleanTitle,
        questions: []
    });

    set(ref(db, "games"), myGames);
}

function deleteGame(id) {
    if (!confirm("Удалить эту тему?")) return;

    myGames = myGames.filter((game) => game.id !== id);

    if (currentEditingGameId === id) {
        currentEditingGameId = null;
        currentEditingQuestionIndex = null;
    }

    set(ref(db, "games"), myGames);
}

function manageQuestions(id) {
    currentEditingGameId = id;

    const game = myGames.find((item) => item.id === id);
    if (!game) return;

    document.getElementById("manager-title").innerText = game.title;
    document.getElementById("manager-current-theme").innerText = `Вы редактируете тему «${game.title}». Здесь собраны все вопросы и быстрые действия для них.`;

    renderQuestionsList();
    switchScreen("manager");
}

function renderQuestionsList() {
    const game = myGames.find((item) => item.id === currentEditingGameId);
    const container = document.getElementById("admin-questions-list");

    if (!container || !game) return;

    const questions = normalizeCollection(game.questions);

    if (!questions.length) {
        container.innerHTML = "<div class='empty-state'>В этой теме пока нет вопросов. Нажмите «Добавить вопрос», чтобы начать наполнение.</div>";
        return;
    }

    container.innerHTML = questions.map((question, index) => {
        const optionsCount = normalizeCollection(question.options).length;

        return `
            <div class="list-item">
                <div class="list-item__meta">
                    <span class="type-pill" data-type="${escapeHtml(question.type || "error")}">${escapeHtml(getQuestionTypeLabel(question.type))}</span>
                    <span class="list-item__title">${escapeHtml(truncateText(question.q || "Без текста вопроса", 72))}</span>
                    <span class="list-item__sub">${optionsCount} ${pluralize(optionsCount, "вариант", "варианта", "вариантов")} ответа</span>
                </div>
                <div class="list-item__actions">
                    <button type="button" onclick="window.openEditor(${index})" class="mini-action btn-red">Изменить</button>
                    <button type="button" onclick="window.deleteQuestion(${index})" class="mini-action btn-dark">Удалить</button>
                </div>
            </div>`;
    }).join("");
}

function toggleEditorFields() {
    const type = document.getElementById("edit-type").value;
    const imageBlock = document.getElementById("div-edit-img");
    const imageInput = document.getElementById("edit-img");
    const shouldShowImage = type === "photo";

    imageBlock.style.display = shouldShowImage ? "block" : "none";
    imageInput.disabled = !shouldShowImage;
}

function setUploadStatus(text) {
    const statusEl = document.getElementById("edit-img-status");
    if (statusEl) statusEl.innerText = text || "";
}

function withTimeout(promise, ms, message) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId) window.clearTimeout(timeoutId);
    });
}

function resetImageUploadState() {
    pendingUploadUrl = "";
    const fileInput = document.getElementById("edit-img-file");
    const uploadBtn = document.getElementById("edit-img-upload");
    if (fileInput) fileInput.value = "";
    if (uploadBtn) uploadBtn.disabled = false;
    setUploadStatus("");
}

async function uploadSelectedImage() {
    const type = document.getElementById("edit-type")?.value;
    if (type !== "photo") return;

    const fileInput = document.getElementById("edit-img-file");
    const uploadBtn = document.getElementById("edit-img-upload");
    const urlInput = document.getElementById("edit-img");

    const file = fileInput?.files?.[0];
    if (!file) {
        setUploadStatus("Выберите файл изображения для загрузки.");
        return;
    }

    if (!currentEditingGameId) {
        setUploadStatus("Сначала выберите тему (редактор должен быть открыт из темы).");
        return;
    }

    try {
        if (uploadBtn) uploadBtn.disabled = true;
        setUploadStatus("Загрузка фото...");

        const safeName = String(file.name || "photo")
            .replace(/[^\w.\-]+/g, "_")
            .slice(0, 80);
        const path = `question-images/${currentEditingGameId}/${Date.now()}_${safeName}`;
        const objRef = storageRef(storage, path);

        await withTimeout(uploadBytes(objRef, file, {
            contentType: file.type || "image/*"
        }), 25000, "Время ожидания загрузки истекло");

        const url = await withTimeout(getDownloadURL(objRef), 10000, "Не удалось получить ссылку на загруженное фото");
        pendingUploadUrl = url;
        if (urlInput) urlInput.value = url;
        setUploadStatus("Фото загружено и привязано к вопросу.");
    } catch (error) {
        console.error(error);
        const code = String(error?.code || "");
        if (code.includes("storage/unauthorized") || code.includes("storage/unauthenticated")) {
            setUploadStatus("Нет доступа к Storage. Проверьте Firebase Storage Rules.");
        } else if (code.includes("storage/canceled")) {
            setUploadStatus("Загрузка отменена.");
        } else if (code.includes("storage/retry-limit-exceeded") || String(error?.message || "").includes("Время ожидания")) {
            setUploadStatus("Сервер не ответил вовремя. Проверьте интернет и bucket в Firebase.");
        } else {
            setUploadStatus("Не удалось загрузить фото. Проверьте Firebase Storage Rules, bucket и подключение.");
        }
    } finally {
        if (uploadBtn) uploadBtn.disabled = false;
    }
}

function openEditor(index = null) {
    currentEditingQuestionIndex = index;

    const typeEl = document.getElementById("edit-type");
    const questionEl = document.getElementById("edit-q");
    const imageEl = document.getElementById("edit-img");
    const fileEl = document.getElementById("edit-img-file");
    const uploadBtn = document.getElementById("edit-img-upload");
    const correctEl = document.getElementById("edit-correct");
    const factEl = document.getElementById("edit-fact");
    const opt0 = document.getElementById("edit-opt0");
    const opt1 = document.getElementById("edit-opt1");
    const opt2 = document.getElementById("edit-opt2");
    const opt3 = document.getElementById("edit-opt3");
    const editorTitle = document.getElementById("editor-title");

    if (index !== null) {
        const game = myGames.find((item) => item.id === currentEditingGameId);
        if (!game) return;

        const question = normalizeCollection(game.questions)[index];
        if (!question) return;

        typeEl.value = question.type || "choice";
        questionEl.value = question.q || "";
        imageEl.value = question.img || "";
        resetImageUploadState();
        correctEl.value = String(getQuestionCorrectIndex(question));
        factEl.value = getQuestionFact(question) === DEFAULT_FACT_TEXT ? "" : getQuestionFact(question);
        opt0.value = question.options?.[0] || "";
        opt1.value = question.options?.[1] || "";
        opt2.value = question.options?.[2] || "";
        opt3.value = question.options?.[3] || "";
        editorTitle.innerText = "Редактирование вопроса";
    } else {
        typeEl.value = "choice";
        questionEl.value = "";
        imageEl.value = "";
        resetImageUploadState();
        correctEl.value = "0";
        factEl.value = "";
        opt0.value = "";
        opt1.value = "";
        opt2.value = "";
        opt3.value = "";
        editorTitle.innerText = "Новый вопрос";
    }

    toggleEditorFields();
    switchScreen("editor");

    if (fileEl) {
        fileEl.onchange = () => {
            pendingUploadUrl = "";
            setUploadStatus(fileEl.files?.[0] ? "Файл выбран. Нажмите «Загрузить фото»." : "");
        };
    }

    if (uploadBtn) {
        uploadBtn.onclick = uploadSelectedImage;
    }
}

function saveQuestion() {
    const game = myGames.find((item) => item.id === currentEditingGameId);
    if (!game) return;

    if (!game.questions) game.questions = [];

    const type = document.getElementById("edit-type").value;
    const questionText = document.getElementById("edit-q").value.trim();
    const imagePath = document.getElementById("edit-img").value.trim();
    const factText = document.getElementById("edit-fact").value.trim();
    const correctIndex = Number(document.getElementById("edit-correct").value);

    const optionsArray = [];
    for (let i = 0; i <= 3; i++) {
        const value = document.getElementById(`edit-opt${i}`).value.trim();
        if (value) optionsArray.push(value);
    }

    if (!questionText) {
        alert("Введите текст вопроса.");
        return;
    }

    if (type === "photo" && !imagePath) {
        alert("Для вопроса «Угадай по фото» добавьте ссылку на изображение или загрузите фото.");
        return;
    }

    if (!factText) {
        alert("Добавьте исторический факт для окна объяснения.");
        return;
    }

    if (optionsArray.length < 2) {
        alert("Добавьте минимум два варианта ответа.");
        return;
    }

    const loweredOptions = optionsArray.map((item) => item.toLowerCase());
    if (new Set(loweredOptions).size !== loweredOptions.length) {
        alert("Варианты ответа должны отличаться друг от друга.");
        return;
    }

    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionsArray.length) {
        alert("Выберите корректный номер правильного варианта.");
        return;
    }

    const newQuestion = {
        type,
        q: questionText,
        img: imagePath,
        options: optionsArray,
        correct: correctIndex,
        fact: factText
    };

    if (currentEditingQuestionIndex !== null) {
        game.questions[currentEditingQuestionIndex] = newQuestion;
    } else {
        game.questions.push(newQuestion);
    }

    renderQuestionsList();
    set(ref(db, "games"), myGames);
    switchScreen("manager");
}

function deleteQuestion(index) {
    if (!confirm("Удалить этот вопрос?")) return;

    const game = myGames.find((item) => item.id === currentEditingGameId);
    if (!game || !game.questions) return;

    game.questions.splice(index, 1);
    renderQuestionsList();
    set(ref(db, "games"), myGames);
}

function renderGameList() {
    const container = document.getElementById("game-list-container");
    if (!container) return;

    if (!myGames.length) {
        container.innerHTML = "<div class='empty-state'>Темы ещё не загружены или пока не созданы. Добавьте первую тему через админ-панель.</div>";
        return;
    }

    container.innerHTML = myGames.map((game, index) => {
        const questionCount = normalizeCollection(game.questions).length;
        const isLocked = questionCount === 0;

        return `
            <button type="button" onclick="window.playGame(${game.id})" class="theme-card ${isLocked ? "theme-card--locked" : ""}">
                <span class="theme-card__order">${String(index + 1).padStart(2, "0")}</span>
                <span class="theme-card__content">
                    <strong class="theme-card__title">${escapeHtml(game.title || "Без названия")}</strong>
                    <span class="theme-card__description">${getQuestionCountLabel(questionCount)} • ${getDurationLabel(questionCount)}</span>
                </span>
                <span class="theme-card__arrow">${isLocked ? "Пусто" : "Начать"}</span>
            </button>`;
    }).join("");
}

function playGame(id) {
    activeGame = myGames.find((game) => game.id === id);

    if (!activeGame) return;
    if (!activeGame.questions || !activeGame.questions.length) {
        alert("В этой теме пока нет вопросов.");
        return;
    }

    currentQuestionIndex = 0;
    score = 0;
    gameStartedAt = Date.now();
    lastGameDurationMs = 0;
    closeAnswerModal();
    stopTimer();

    switchScreen("game");
    showQuestion();
}

function resetTimer() {
    stopTimer();
    timeLeft = TIME_LIMIT;
    updateTimerVisual(TIME_LIMIT);
}

function startTimer() {
    stopTimer();
    timeLeft = TIME_LIMIT;
    updateTimerVisual(timeLeft);

    const timerContainer = document.querySelector(".timer-box");

    timerInterval = setInterval(() => {
        timeLeft -= 1;
        updateTimerVisual(timeLeft);

        if (timeLeft <= 5 && timerContainer) {
            timerContainer.classList.add("time-low");
        }

        if (timeLeft <= 0) {
            stopTimer();
            timeOut();
        }
    }, 1000);
}

function timeOut() {
    checkAnswer(null, null, { timedOut: true });
}

function showQuestion() {
    const question = activeGame.questions[currentQuestionIndex];
    if (!question) {
        finishGame();
        return;
    }

    document.getElementById("game-title-display").innerText = activeGame.title;
    document.getElementById("game-step").innerText = `${currentQuestionIndex + 1} / ${activeGame.questions.length}`;
    document.getElementById("game-question").innerText = question.q;
    document.getElementById("game-support-text").innerText = getQuestionHint(question.type);

    updateGameProgress();
    closeAnswerModal();

    const badge = document.getElementById("game-format-label");
    badge.innerText = getQuestionTypeLabel(question.type);
    badge.dataset.type = question.type || "choice";

    const photoContainer = document.getElementById("photo-container");
    const photoEl = document.getElementById("game-photo");

    if (question.type === "photo") {
        photoContainer.style.display = "block";
        photoEl.src = question.img || getPhotoPlaceholder(question.photoLabel || "Фото скоро будет добавлено");
        photoEl.alt = question.q ? `Иллюстрация к вопросу: ${question.q}` : "Иллюстрация к вопросу";
    } else {
        photoContainer.style.display = "none";
    }

    const optionsContainer = document.getElementById("game-options");
    optionsContainer.innerHTML = "";

    const answers = shuffleArray(
        normalizeCollection(question.options).map((option, index) => ({
            text: option,
            isCorrect: index === getQuestionCorrectIndex(question)
        }))
    );

    answers.forEach((answer, index) => {
        const button = document.createElement("button");
        const mark = document.createElement("span");
        const text = document.createElement("span");

        button.type = "button";
        button.className = "btn-answer";
        button.dataset.correct = String(answer.isCorrect);
        button.dataset.answerText = answer.text;
        button.onclick = function () {
            checkAnswer(button, answer);
        };

        mark.className = "btn-answer__index";
        mark.innerText = OPTION_MARKS[index] || String(index + 1);

        text.className = "btn-answer__text";
        text.innerText = answer.text;

        button.append(mark, text);
        optionsContainer.appendChild(button);
    });

    startTimer();
}

function checkAnswer(clickedButton, answer, { timedOut = false } = {}) {
    stopTimer();
    const supportText = document.getElementById("game-support-text");
    const allButtons = document.getElementById("game-options").children;
    const question = activeGame?.questions?.[currentQuestionIndex];
    const isCorrect = Boolean(answer?.isCorrect);

    for (let i = 0; i < allButtons.length; i++) {
        allButtons[i].disabled = true;
        if (allButtons[i].dataset.correct === "true") {
            allButtons[i].classList.add("correct");
        }
    }

    if (clickedButton) {
        if (isCorrect) {
            score += 1;
            if (supportText) supportText.innerText = "Верно. Отличный ответ, переходим к следующему вопросу.";
        } else {
            clickedButton.classList.add("wrong");
            if (supportText) supportText.innerText = "Неверно. Таймер остановлен, прочитайте исторический факт и продолжите квиз.";
        }
    } else if (timedOut && supportText) {
        supportText.innerText = "Время вышло. Таймер остановлен, прочитайте исторический факт и продолжите квиз.";
    }

    if (isCorrect) {
        window.setTimeout(goToNextQuestion, 1000);
        return;
    }

    if (!question) return;

    openAnswerModal({
        title: timedOut ? "Время вышло" : "Неверный ответ",
        status: timedOut
            ? "Время истекло. Ответ не засчитан. Прочитайте исторический факт и продолжите квиз."
            : "Ответ неверный. Прочитайте исторический факт и продолжите квиз.",
        correctAnswer: getCorrectAnswerText(question),
        fact: getQuestionFact(question),
        showCorrectAnswer: false
    });
}

function finishGame() {
    switchScreen("result");

    lastGameDurationMs = gameStartedAt ? Math.max(0, Date.now() - gameStartedAt) : 0;

    const totalQuestions = activeGame?.questions?.length || 0;
    const result = getResultMessage(score, totalQuestions);

    document.getElementById("final-score").innerText = `${score} из ${totalQuestions}`;
    document.getElementById("result-title").innerText = result.title;
    document.getElementById("result-caption").innerText = result.text;
    const timeEl = document.getElementById("final-time");
    if (timeEl) timeEl.innerText = `Время: ${formatDurationMs(lastGameDurationMs)}`;

    trackQuizFinished();
}

function submitScore() {
    if (!activeGame) return;

    const input = document.getElementById("player-name");
    const name = input.value.trim() || "Гость";

    const entry = {
        id: Date.now(),
        name,
        score,
        durationMs: lastGameDurationMs || 0,
        gameId: activeGame.id,
        game: activeGame.title,
        finishedAt: Date.now()
    };

    // В БД храним все результаты, чтобы в статистике были видны все прошедшие.
    // Топ-100 по темам формируем только при отображении.
    const nextLeaders = [...normalizeCollection(leaders), entry];
    set(ref(db, "leaders"), nextLeaders);
    input.value = "";
    showLeaderboard();
}

function getLeadersTotalCount(leadersValue) {
    return normalizeCollection(leadersValue).length;
}

function getGameTitleById(gameId) {
    const game = myGames.find((g) => String(g.id) === String(gameId));
    return game?.title || "";
}

function normalizeLeaderEntry(raw) {
    const scoreValue = Number(raw?.score) || 0;
    const durationMs = Number(raw?.durationMs);
    const durationOk = Number.isFinite(durationMs) && durationMs >= 0;
    const gameId = raw?.gameId ?? null;
    const gameTitle = String(raw?.game || raw?.gameTitle || "").trim();

    return {
        id: raw?.id ?? raw?.finishedAt ?? Date.now(),
        name: String(raw?.name || "Гость"),
        score: scoreValue,
        // Старые записи могли быть без времени.
        // Важно: в Firebase нельзя записывать Infinity/NaN, поэтому используем null.
        durationMs: durationOk ? durationMs : null,
        gameId: gameId ?? null,
        game: gameTitle || (gameId ? getGameTitleById(gameId) : "Без темы"),
        finishedAt: Number(raw?.finishedAt) || 0
    };
}

function getLeaderThemeKey(entry) {
    if (entry?.gameId !== null && entry?.gameId !== undefined) return `id:${String(entry.gameId)}`;
    const title = String(entry?.game || "").trim();
    return title ? `title:${title}` : "unknown";
}

function compareLeaders(a, b) {
    // score DESC, duration ASC, finishedAt ASC, name ASC
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    const durA = Number.isFinite(Number(a.durationMs)) ? Number(a.durationMs) : 1e18;
    const durB = Number.isFinite(Number(b.durationMs)) ? Number(b.durationMs) : 1e18;
    if (durA !== durB) return durA - durB;
    const fa = Number(a.finishedAt) || 0;
    const fb = Number(b.finishedAt) || 0;
    if (fa !== fb) return fa - fb;
    return String(a.name || "").localeCompare(String(b.name || ""), "ru");
}

function compactLeadersToTop100PerTheme(allLeaders, games) {
    const normalized = normalizeCollection(allLeaders).map(normalizeLeaderEntry);
    const byTheme = new Map();

    normalized.forEach((entry) => {
        const key = getLeaderThemeKey(entry);
        if (!byTheme.has(key)) byTheme.set(key, []);
        byTheme.get(key).push(entry);
    });

    const compacted = [];
    for (const [, items] of byTheme.entries()) {
        const sorted = items.sort(compareLeaders).slice(0, 100);
        compacted.push(...sorted);
    }

    // Лёгкая защита от бесконтрольного роста: ограничим общий объём (при большом числе тем).
    // Сохраняем только записи по известным темам/заголовкам + последние записи как fallback.
    if (compacted.length <= 5000) return compacted;

    const knownTitles = new Set(normalizeCollection(games).map((g) => String(g?.title || "").trim()).filter(Boolean));
    const filtered = compacted.filter((e) => knownTitles.has(String(e.game || "").trim()));
    return filtered.slice(0, 5000);
}

function updateLeaderboardUI() {
    const container = document.getElementById("leader-data");
    const totalEl = document.getElementById("leaderboard-total");
    const tabs = document.getElementById("leader-theme-tabs");
    if (!container) return;

    const normalized = normalizeCollection(leaders).map(normalizeLeaderEntry);

    const themeOptions = [
        { id: "all", title: "Все темы" },
        ...myGames.map((g) => ({ id: String(g.id), title: g.title || "Без названия" }))
    ];

    if (!themeOptions.some((t) => t.id === String(selectedLeaderboardGameId))) {
        selectedLeaderboardGameId = "all";
    }

    if (tabs) {
        tabs.innerHTML = themeOptions.map((opt) => `
            <button type="button"
                class="theme-tab ${String(selectedLeaderboardGameId) === String(opt.id) ? "is-active" : ""}"
                onclick="window.selectLeaderboardTheme('${String(opt.id).replace(/'/g, "\\'")}')"
            >${escapeHtml(opt.title)}</button>
        `).join("");
    }

    const isAllThemes = String(selectedLeaderboardGameId) === "all";
    const filtered = isAllThemes
        ? normalized
        : normalized.filter((e) => String(e.gameId) === String(selectedLeaderboardGameId) || String(e.game) === getGameTitleById(selectedLeaderboardGameId));

    const sortedAll = filtered.sort(compareLeaders);
    const sortedLeaders = isAllThemes ? sortedAll : sortedAll.slice(0, 100);
    if (totalEl) totalEl.innerText = String(sortedLeaders.length);

    if (!sortedLeaders.length) {
        container.innerHTML = "<div class='empty-state'>Пока нет сохранённых результатов. Пройдите тему и станьте первым участником рейтинга.</div>";
        return;
    }

    container.innerHTML = sortedLeaders.map((leader, index) => {
        const rank = index + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
        const timeLabel = Number.isFinite(Number(leader.durationMs)) ? formatDurationMs(leader.durationMs) : "—";

        return `
            <div class="leader-card" data-rank="${rank}">
                <div class="medal-icon">${medal}</div>
                <div class="leader-info">
                    <span class="leader-name">${escapeHtml(leader.name || "Гость")}</span>
                    <span class="leader-game">${escapeHtml(leader.game || "Без темы")}</span>
                </div>
                <div class="leader-metrics">
                    <div class="leader-score">${leader.score ?? 0}</div>
                    <div class="leader-time">Время: ${escapeHtml(timeLabel)}</div>
                </div>
            </div>`;
    }).join("");
}

function updateAdminLeadersUI() {
    const tabs = document.getElementById("admin-leader-tabs");
    const list = document.getElementById("admin-leader-list");
    if (!tabs || !list) return;

    const normalized = normalizeCollection(leaders).map(normalizeLeaderEntry);
    const themeOptions = [
        { id: "all", title: "Все темы" },
        ...myGames.map((g) => ({ id: String(g.id), title: g.title || "Без названия" }))
    ];

    if (!themeOptions.some((t) => t.id === String(selectedAdminLeadersGameId))) {
        selectedAdminLeadersGameId = "all";
    }

    tabs.innerHTML = themeOptions.map((opt) => `
        <button type="button"
            class="theme-tab ${String(selectedAdminLeadersGameId) === String(opt.id) ? "is-active" : ""}"
            onclick="window.selectAdminLeadersTheme('${String(opt.id).replace(/'/g, "\\'")}')"
        >${escapeHtml(opt.title)}</button>
    `).join("");

    const filtered = String(selectedAdminLeadersGameId) === "all"
        ? normalized
        : normalized.filter((e) => String(e.gameId) === String(selectedAdminLeadersGameId) || String(e.game) === getGameTitleById(selectedAdminLeadersGameId));

    // В админке показываем всех (сортировка по "сильнее/быстрее").
    // Чтобы не перегружать DOM при очень большом количестве записей — ограничим рендер 2000.
    const sorted = filtered.sort(compareLeaders);
    const render = sorted.slice(0, 2000);

    if (!render.length) {
        list.innerHTML = "<div class='empty-state'>Результатов пока нет.</div>";
        return;
    }

    list.innerHTML = render.map((leader, index) => {
        const timeLabel = Number.isFinite(Number(leader.durationMs)) ? formatDurationMs(leader.durationMs) : "—";
        const title = leader.game || "Без темы";
        const subtitle = `#${index + 1} • ${leader.score ?? 0} правильных • Время: ${timeLabel}`;

        return `
            <div class="list-item">
                <div class="list-item__meta">
                    <span class="list-item__title">${escapeHtml(leader.name || "Гость")}</span>
                    <span class="list-item__sub">${escapeHtml(title)} • ${escapeHtml(subtitle)}</span>
                </div>
                <div class="list-item__actions">
                    <span class="type-pill" data-type="choice">${escapeHtml(String(leader.score ?? 0))}</span>
                </div>
            </div>`;
    }).join("");
}

document.addEventListener("DOMContentLoaded", () => {
    updateMenuStats();
    updateLeaderboardUI();
    renderFeedbackList();
    toggleEditorFields();
    applyScreenFromQuery();
    applyFigmaExportMode();
    trackVisit();

    const adminPass = document.getElementById("admin-pass");
    if (adminPass) {
        adminPass.addEventListener("keydown", (event) => {
            if (event.key === "Enter") checkLogin();
        });
    }

    const continueButton = document.getElementById("answer-modal-continue");
    if (continueButton) {
        continueButton.addEventListener("click", goToNextQuestion);
    }
});

window.showMenu = showMenu;
window.showLogin = showLogin;
window.showLeaderboard = showLeaderboard;
window.showFeedbackScreen = showFeedbackScreen;
window.checkLogin = checkLogin;
window.switchAdminTab = switchAdminTab;
window.createNewGame = createNewGame;
window.deleteGame = deleteGame;
window.manageQuestions = manageQuestions;
window.openEditor = openEditor;
window.deleteQuestion = deleteQuestion;
window.toggleEditorFields = toggleEditorFields;
window.saveQuestion = saveQuestion;
window.switchScreen = switchScreen;
window.playGame = playGame;
window.checkAnswer = checkAnswer;
window.submitScore = submitScore;
window.submitFeedback = submitFeedback;
window.deleteFeedback = deleteFeedback;
window.selectLeaderboardTheme = function (id) {
    selectedLeaderboardGameId = String(id || "all");
    updateLeaderboardUI();
};

window.selectAdminLeadersTheme = function (id) {
    selectedAdminLeadersGameId = String(id || "all");
    updateAdminLeadersUI();
};