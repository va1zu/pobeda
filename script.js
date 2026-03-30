import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, set, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

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

document.addEventListener("contextmenu", (event) => event.preventDefault());

const PASS = "Tula33842";
const TIME_LIMIT = 30;
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

let timerInterval = null;
let timeLeft = 0;

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

function scrollMainWrapToTop() {
    const wrap = document.querySelector(".main-wrap");
    if (wrap) wrap.scrollTo({ top: 0, behavior: "smooth" });
}

function updateMenuStats() {
    const gameCountEl = document.getElementById("menu-game-count");
    const leaderCountEl = document.getElementById("menu-leader-count");
    const timeLimitEl = document.getElementById("menu-time-limit");

    if (gameCountEl) gameCountEl.innerText = myGames.length;
    if (leaderCountEl) leaderCountEl.innerText = leaders.length;
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
    updateMenuStats();
});

onValue(ref(db, "feedback"), (snapshot) => {
    feedbacks = snapshot.exists() ? normalizeCollection(snapshot.val()) : [];
    renderFeedbackList();
});

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

function openAnswerModal({ title, status, correctAnswer, fact }) {
    const modal = document.getElementById("answer-modal");
    const wrap = document.querySelector(".main-wrap");
    if (!modal) return;

    document.getElementById("answer-modal-title").innerText = title;
    document.getElementById("answer-modal-status").innerText = status;
    document.getElementById("answer-modal-correct").innerText = correctAnswer;
    document.getElementById("answer-modal-fact").innerText = fact;

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
    const btnFeedback = document.getElementById("tab-feedback");
    const secGames = document.getElementById("admin-section-games");
    const secFeedback = document.getElementById("admin-section-feedback");

    if (tabName === "games") {
        btnGames.classList.add("tab-active");
        btnFeedback.classList.remove("tab-active");
        secGames.style.display = "block";
        secFeedback.style.display = "none";
        return;
    }

    btnFeedback.classList.add("tab-active");
    btnGames.classList.remove("tab-active");
    secFeedback.style.display = "block";
    secGames.style.display = "none";
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

function openEditor(index = null) {
    currentEditingQuestionIndex = index;

    const typeEl = document.getElementById("edit-type");
    const questionEl = document.getElementById("edit-q");
    const imageEl = document.getElementById("edit-img");
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
            if (supportText) supportText.innerText = "Неверно. Таймер остановлен, прочитайте объяснение и продолжите квиз.";
        }
    } else if (timedOut && supportText) {
        supportText.innerText = "Время вышло. Таймер остановлен, прочитайте объяснение и продолжите квиз.";
    }

    if (isCorrect) {
        window.setTimeout(goToNextQuestion, 1000);
        return;
    }

    if (!question) return;

    openAnswerModal({
        title: timedOut ? "Время вышло" : "Неверный ответ",
        status: timedOut
            ? "Отсчёт времени остановлен. Ознакомьтесь с правильным ответом и продолжите квиз."
            : "Отсчёт времени остановлен. Прочитайте пояснение, чтобы перейти к следующему вопросу.",
        correctAnswer: getCorrectAnswerText(question),
        fact: getQuestionFact(question)
    });
}

function finishGame() {
    switchScreen("result");

    const totalQuestions = activeGame?.questions?.length || 0;
    const result = getResultMessage(score, totalQuestions);

    document.getElementById("final-score").innerText = `${score} из ${totalQuestions}`;
    document.getElementById("result-title").innerText = result.title;
    document.getElementById("result-caption").innerText = result.text;
}

function submitScore() {
    if (!activeGame) return;

    const input = document.getElementById("player-name");
    const name = input.value.trim() || "Гость";

    leaders.push({
        name,
        score,
        game: activeGame.title
    });

    leaders = leaders
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

    set(ref(db, "leaders"), leaders);
    input.value = "";
    showLeaderboard();
}

function updateLeaderboardUI() {
    const container = document.getElementById("leader-data");
    const totalEl = document.getElementById("leaderboard-total");
    if (!container) return;

    const sortedLeaders = [...leaders].sort((a, b) => b.score - a.score).slice(0, 20);
    if (totalEl) totalEl.innerText = sortedLeaders.length;

    if (!sortedLeaders.length) {
        container.innerHTML = "<div class='empty-state'>Пока нет сохранённых результатов. Пройдите тему и станьте первым участником рейтинга.</div>";
        return;
    }

    container.innerHTML = sortedLeaders.map((leader, index) => {
        const rank = index + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

        return `
            <div class="leader-card" data-rank="${rank}">
                <div class="medal-icon">${medal}</div>
                <div class="leader-info">
                    <span class="leader-name">${escapeHtml(leader.name || "Гость")}</span>
                    <span class="leader-game">${escapeHtml(leader.game || "Без темы")}</span>
                </div>
                <div class="leader-score">${leader.score ?? 0}</div>
            </div>`;
    }).join("");
}

document.addEventListener("DOMContentLoaded", () => {
    updateMenuStats();
    updateLeaderboardUI();
    renderFeedbackList();
    toggleEditorFields();

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
