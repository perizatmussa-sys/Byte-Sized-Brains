"use strict";

// Рабочее пространство оценки: библиотека диалогов, транскрипт, AI / ручная оценка,
// итоговая панель, апелляции, ревью, аналитика и редактор чек-листа.

let allConversations = [];
let scores = {};
let allAppeals = [];
let activeConversationId = null;
let activeConversation = null;
let currentChecklist = null;
let draftCriteria = [];
let activeMode = "ai";          // вкладка «AI-оценка» / «Ручная оценка»
let pickedSource = null;        // источник итогового балла, выбранный пользователем
let activeView = "evaluate";
let appealFilter = "all";

const $ = (id) => document.getElementById(id);

// ---------- Общие помощники ----------
let noticeTimer = null;
function notify(message, kind = "") {
  const element = $("notice");
  element.textContent = message;
  element.className = kind ? `${kind} show` : "show";
  clearTimeout(noticeTimer);
  if (kind !== "error") noticeTimer = setTimeout(() => element.classList.remove("show"), 6000);
}

async function requestJson(url, options = undefined) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`Ответ сервера не JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`);
  return payload;
}

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function svg(markup) {
  const span = document.createElement("span");
  span.className = "ico";
  span.innerHTML = markup;
  return span;
}

const ICONS = {
  call: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  operator: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 13v-1a7 7 0 0114 0v1M5 13h2.5v5H6a1 1 0 01-1-1zm14 0h-2.5v5H18a1 1 0 001-1zM16.5 18c0 1.5-1.5 2.5-4.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  client: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  system: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bot: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  partial: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 7v6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  dash: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 12h10" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const KIND_LABEL = {call: "Звонок", chat: "Переписка"};
const SOURCE_LABEL = {final: "После апелляции", groq: "GroqCloud", gemini: "Gemini", manual: "Ручная"};
const kindOf = (c) => c.kind || (/call|voice|phone/i.test(c.channel || "") || c.has_audio ? "call" : "chat");
const downloadUrl = (id, format) => `/api/conversations/${encodeURIComponent(id)}/download?format=${format}`;
const fmtScore = (s) => s == null ? "—" : `${Math.round(Number(s))}%`;

function scoreTone(score) {
  if (score == null) return "none";
  if (score >= 80) return "good";
  if (score >= 65) return "mid";
  return "low";
}

function verdict(score, gross) {
  if (gross) return {tone: "low", text: "Грубое нарушение"};
  if (score == null) return {tone: "none", text: "Нет оценки"};
  if (score >= 80) return {tone: "good", text: "Соответствует"};
  if (score >= 65) return {tone: "mid", text: "Частично"};
  return {tone: "low", text: "Не соответствует"};
}

// Чаты: MM:SS; звонки: ISO 8601 с часовым поясом — показываем только время.
function formatStamp(stamp) {
  if (!stamp) return "";
  const text = String(stamp);
  const iso = text.match(/T(\d{2}:\d{2}:\d{2})/);
  return iso ? iso[1] : text;
}

function jumpToMessage(index) {
  const target = document.getElementById(`msg-${index}`);
  if (!target) return;
  target.scrollIntoView({behavior: "smooth", block: "center"});
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1600);
}

// ---------- Данные ----------
async function refresh() {
  const status = await requestJson("/api/status");
  allConversations = await requestJson("/api/conversations");
  updateCounts();
  await loadScores();
  await loadAppeals();
  return status;
}

async function loadScores() {
  try { scores = await requestJson("/api/scores"); }
  catch (error) { scores = {}; notify(`Баллы: ${error.message}`, "error"); }
  renderList();
  renderSummary();
  if (activeView === "analytics") renderAnalytics();
}

async function loadAppeals() {
  try { allAppeals = await requestJson("/api/appeals/all"); }
  catch { allAppeals = []; }
  const pending = allAppeals.filter(a => a.status === "pending").length;
  const badgeAll = $("badge-appeals"), badgeReview = $("badge-review");
  badgeAll.hidden = !allAppeals.length; badgeAll.textContent = String(allAppeals.length);
  badgeReview.hidden = !pending; badgeReview.textContent = String(pending);
  if (activeView === "appeals") renderAppealsTable();
  if (activeView === "review") renderReview();
}

function updateCounts() {
  const counts = {call: 0, chat: 0};
  for (const c of allConversations) counts[kindOf(c)] += 1;
  $("count").textContent = String(allConversations.length);
  $("kind-split").textContent = `${counts.call} / ${counts.chat}`;
  const languages = [...new Set(allConversations.map(c => c.language).filter(Boolean))].sort();
  const select = $("language-filter");
  const current = select.value;
  select.replaceChildren(new Option("Все", ""), ...languages.map(l => new Option(l, l)));
  select.value = languages.includes(current) ? current : "";
  const origins = [...new Set(allConversations.map(c => c.origin || "DEV"))].sort((a, b) => a === "DEV" ? -1 : b === "DEV" ? 1 : a.localeCompare(b));
  const originSelect = $("origin-filter");
  const currentOrigin = originSelect.value;
  originSelect.replaceChildren(new Option("Все", ""), ...origins.map(o => new Option(originLabel(o), o)));
  originSelect.value = origins.includes(currentOrigin) ? currentOrigin : "";
  $("origin-filter").closest("label").hidden = origins.length < 2;
}

const originLabel = (o) => o === "DEV" ? "DEV (65)" : o === "custom" ? "Мои диалоги" : o;

// ---------- Выбор скрипта ----------
function filteredConversations() {
  const channel = $("channel-filter").value;
  const language = $("language-filter").value;
  const origin = $("origin-filter").value;
  return allConversations.filter(c =>
    (!origin || (c.origin || "DEV") === origin) &&
    (channel === "all" || kindOf(c) === channel) &&
    (!language || c.language === language));
}

function renderList() {
  const select = $("script-select");
  const filtered = filteredConversations();
  $("list-count").textContent = String(filtered.length);
  select.replaceChildren(new Option(filtered.length
    ? `— Выберите готовый скрипт (${filtered.length}) —`
    : (allConversations.length ? "— Нет скриптов по фильтрам —" : "— Скрипты загружаются… —"), ""));
  const groups = [
    ["Мои диалоги и контрольные наборы", c => (c.origin || "DEV") !== "DEV"],
    ["Звонки", c => (c.origin || "DEV") === "DEV" && kindOf(c) === "call"],
    ["Переписки", c => (c.origin || "DEV") === "DEV" && kindOf(c) === "chat"],
  ];
  for (const [label, test] of groups) {
    const items = filtered.filter(test);
    if (!items.length) continue;
    const group = document.createElement("optgroup");
    group.label = `${label} (${items.length})`;
    for (const c of items) {
      const score = scores[c.conversation_id]?.score;
      const origin = (c.origin || "DEV") !== "DEV" ? ` · ${c.origin === "custom" ? "свой" : c.origin}` : "";
      const text = `${c.conversation_id} · ${c.language || "?"} · ${c.message_count} реплик${origin}${score != null ? " · " + fmtScore(score) : ""}`;
      group.append(new Option(text, c.conversation_id));
    }
    select.append(group);
  }
  // Если открытый диалог скрыт фильтром — всё равно показываем его в списке.
  if (activeConversationId && !filtered.some(c => c.conversation_id === activeConversationId)) {
    select.append(new Option(`${activeConversationId} (открыт)`, activeConversationId));
  }
  select.value = activeConversationId || "";
}

function openRandom() {
  const pool = filteredConversations().filter(c => c.conversation_id !== activeConversationId);
  if (!pool.length) { notify("Нет скриптов по выбранным фильтрам.", "error"); return; }
  openConversation(pool[Math.floor(Math.random() * pool.length)].conversation_id);
}

function updateExportLinks() {
  const channel = $("channel-filter").value;
  $("export-label").textContent = {all: "все", call: "звонки", chat: "переписки"}[channel];
  $("export-txt").href = `/api/export?kind=${channel}&format=txt`;
  $("export-json").href = `/api/export?kind=${channel}&format=json`;
}

// ---------- Транскрипт ----------
async function openConversation(conversationId) {
  try {
    const conversation = await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}`);
    activeConversationId = conversationId;
    activeConversation = conversation;
    pickedSource = null;
    const kind = kindOf(conversation);
    $("conversation-title").textContent = `${KIND_LABEL[kind]} ${conversationId}`;
    $("conversation-meta").textContent = `${conversation.language || "?"} · ${conversation.channel || "?"} · ${conversation.transcript.length} реплик`;
    $("empty-state").hidden = true;
    $("download-actions").hidden = false;
    $("download-txt").href = downloadUrl(conversationId, "txt");
    $("download-json").href = downloadUrl(conversationId, "json");

    const messages = $("messages");
    messages.replaceChildren();
    for (const [index, message] of conversation.transcript.entries()) {
      const speaker = String(message.speaker || "").toLowerCase();
      const role = ["operator", "bot", "system"].includes(speaker) ? speaker : "client";
      const block = node("article", "", `message ${role}`);
      block.id = `msg-${index}`;
      const avatar = svg(ICONS[role]);
      avatar.classList.add("msg-avatar");
      const body = node("div", "", "msg-body");
      const roleName = {operator: "Оператор", bot: "Бот", client: "Клиент", system: "Система"}[role];
      const time = formatStamp(message.timestamp);
      const info = node("div", `${roleName}${time ? " · " + time : ""} · #${index + 1}`, "info");
      if (message.timestamp) info.title = String(message.timestamp);
      body.append(info, node("p", message.text || ""));
      block.append(avatar, body);
      messages.append(block);
    }

    const audioArea = $("audio-area");
    audioArea.replaceChildren();
    if (typeof conversation.audio_url === "string" && /^https?:\/\//i.test(conversation.audio_url)) {
      const player = node("div", "", "audio-player");
      const audio = document.createElement("audio");
      audio.controls = true; audio.preload = "none"; audio.src = conversation.audio_url;
      player.append(audio);
      audioArea.append(player);
    }

    renderList();
    renderSummary();
    await renderAssessment();
    document.dispatchEvent(new CustomEvent("cqa:conversation-opened", {detail: {conversationId}}));
  } catch (error) { notify(`Ошибка открытия диалога: ${error.message}`, "error"); }
}

function resetConversationView() {
  activeConversationId = null; activeConversation = null;
  for (const id of ["messages", "audio-area", "assessment-area", "appeals-panel"]) $(id).replaceChildren();
  $("empty-state").hidden = false;
  $("download-actions").hidden = true;
  $("conversation-title").textContent = "Транскрипт диалога";
  $("conversation-meta").textContent = "Выберите готовый скрипт выше или добавьте свой.";
  renderSummary();
}

// ---------- Итоговая панель ----------
function defaultSource(sources) {
  const order = activeMode === "manual" ? ["manual", "final", "groq", "gemini"] : ["final", "groq", "gemini", "manual"];
  return order.find(k => sources[k]) || null;
}

function renderSummary() {
  const entry = activeConversationId ? scores[activeConversationId] : null;
  const sources = entry?.sources || {};
  const key = pickedSource && sources[pickedSource] ? pickedSource : defaultSource(sources);
  const result = key ? sources[key] : null;
  const scoreEl = $("summary-score"), badge = $("summary-badge");
  const v = verdict(result?.score, result?.gross_violation);
  scoreEl.textContent = result ? fmtScore(result.score) : "—";
  scoreEl.className = `tone-${scoreTone(result?.score)}`;
  badge.className = `status-badge ${v.tone}`;
  badge.replaceChildren();
  if (v.tone === "good") badge.append(svg(ICONS.check));
  badge.append(document.createTextNode(v.text));

  const chips = $("summary-sources");
  chips.replaceChildren();
  for (const k of ["final", "groq", "gemini", "manual"]) {
    if (!sources[k]) continue;
    const chip = node("button", `${SOURCE_LABEL[k]} · ${fmtScore(sources[k].score)}`, "source-chip");
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(k === key));
    chip.addEventListener("click", () => { pickedSource = k; renderSummary(); });
    chips.append(chip);
  }
  $("summary-note").textContent = !activeConversationId ? "Откройте диалог и оцените его с AI или вручную."
    : !result ? (activeMode === "ai" ? "Нажмите «Оценить с AI», чтобы получить балл." : "Заполните ручную оценку ниже.")
    : `Источник: ${SOURCE_LABEL[key]}${result.gross_violation ? " · найдено грубое нарушение" : ""}${
      currentChecklist && result.checklist_version != null && result.checklist_version !== currentChecklist.version
        ? ` · оценка по чек-листу v${result.checklist_version}, текущий v${currentChecklist.version} — оцените заново, чтобы применить изменения` : ""}`;

  const list = $("summary-criteria");
  list.replaceChildren();
  const criteria = result?.criteria || (currentChecklist?.criteria || []).map(c => ({id: c.id, name: c.name, type: c.type, percent: undefined}));
  $("summary-count").textContent = String(criteria.length);
  for (const row of criteria) {
    const li = node("li");
    const button = node("button", "", "criterion-row");
    button.type = "button";
    let tone = "none", icon = ICONS.dash, label = "—";
    if (row.type === "flag" && row.value != null) {
      tone = row.value === "yes" ? "low" : "good"; icon = row.value === "yes" ? ICONS.cross : ICONS.check;
      label = row.value === "yes" ? "Да" : "Нет";
    } else if (row.value === "na") { label = "N/A"; }
    else if (row.percent != null) {
      tone = row.percent >= 100 ? "good" : row.percent > 0 ? "mid" : "low";
      icon = row.percent >= 100 ? ICONS.check : row.percent > 0 ? ICONS.partial : ICONS.cross;
      label = `${Math.round(row.percent)}%`;
    }
    const mark = svg(icon); mark.classList.add("crit-icon", tone);
    const currentName = currentChecklist?.criteria?.find(c => c.id === row.id)?.name;
    button.append(mark, node("span", currentName || row.name, "crit-name"), node("span", label, `crit-pill ${tone}`), svg(ICONS.chevron));
    if (row.reason) button.title = row.reason;
    if (Number.isInteger(row.evidence_index)) button.addEventListener("click", () => jumpToMessage(row.evidence_index));
    else button.disabled = true;
    li.append(button);
    list.append(li);
  }
}

// ---------- Режимы оценки ----------
function setMode(mode) {
  activeMode = mode;
  pickedSource = null;
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  document.querySelectorAll("[data-mode-pane]").forEach(p => p.hidden = p.dataset.modePane !== mode);
  renderSummary();
}

async function afterAssessmentChange(conversationId) {
  await loadScores();
  document.dispatchEvent(new CustomEvent("cqa:assessment-changed", {detail: {conversationId}}));
}

function answerOptions(criterion) {
  const list = criterion.type === "scale" ? criterion.scale.map(s => [String(s), `${s} из ${criterion.scale.at(-1)}`]) :
    [["yes", "Да"], ["no", "Нет"]];
  if (criterion.allow_na) list.push(["na", "N/A — неприменимо"]);
  return list;
}

async function renderAssessment() {
  const area = $("assessment-area");
  area.replaceChildren();
  if (!activeConversation) return;
  if (!currentChecklist) currentChecklist = await requestJson("/api/checklist");
  const conversationId = activeConversationId;

  // ===== Вкладка «AI-оценка» =====
  const aiPane = node("div", "", "mode-pane");
  aiPane.dataset.modePane = "ai";
  const aiPanel = node("div", "", "ai-panel");
  aiPanel.append(node("h3", "Автоматическая AI-оценка"));
  const aiStatus = node("p", "Проверяем ключи...", "muted small");
  aiPanel.append(aiStatus);
  const aiControls = node("div", "", "ai-controls");
  const selectLabel = node("label", "", "edit-field");
  selectLabel.append(node("span", "Режим"));
  const providerSelect = document.createElement("select");
  for (const [value, label] of [["auto", "Авто: Groq → Gemini при ошибке"], ["groq", "Только GroqCloud · Qwen"], ["gemini", "Только Gemini · Flash-Lite"]]) {
    providerSelect.append(new Option(label, value));
  }
  selectLabel.append(providerSelect);
  const freshLabel = node("label", "", "checkline");
  const forceCheckbox = document.createElement("input");
  forceCheckbox.type = "checkbox";
  freshLabel.append(forceCheckbox, node("span", "Оценить заново (новый запрос к AI)"));
  const buttons = node("div", "", "actions start");
  const aiButton = node("button", "Оценить с AI", "primary"); aiButton.type = "button"; aiButton.disabled = true;
  const compareButton = node("button", "Сравнить Groq и Gemini", "secondary"); compareButton.type = "button"; compareButton.disabled = true;
  buttons.append(aiButton, compareButton);
  aiControls.append(selectLabel, freshLabel, buttons);
  aiPanel.append(aiControls);
  const aiResultBox = node("div", "", "ai-results");
  aiPane.append(aiPanel, aiResultBox);

  async function displayStored() {
    aiResultBox.replaceChildren();
    let results;
    try { results = await requestJson(`/api/ai/evaluations/${encodeURIComponent(conversationId)}`); }
    catch (error) { if (String(error.message).includes("ещё не оценён AI")) return; throw error; }
    renderCompare(aiResultBox, results);
    for (const id of ["groq", "gemini"]) {
      if (results[id]) {
        const box = node("details", "", "result-card");
        renderResult(box, results[id]);
        aiResultBox.append(box);
      }
    }
  }

  try {
    const status = await requestJson("/api/ai/status");
    const available = (status.providers || []).filter(p => p.configured);
    aiStatus.textContent = available.length
      ? `Подключено: ${available.map(p => p.name + " (" + p.model + ")").join("; ")}.`
      : "Нет API-ключей. Добавьте GROQ_API_KEY и/или GEMINI_API_KEY в .env и перезапустите сервер.";
    aiButton.disabled = !available.length;
    compareButton.disabled = !available.length;
    await displayStored();
  } catch (error) { aiStatus.textContent = `Не удалось проверить AI: ${error.message}`; }

  aiButton.addEventListener("click", async () => {
    if (activeConversationId !== conversationId) return;
    aiButton.disabled = true; compareButton.disabled = true;
    aiButton.textContent = "AI анализирует...";
    try {
      const provider = encodeURIComponent(providerSelect.value);
      const force = forceCheckbox.checked ? "true" : "false";
      const result = await requestJson(`/api/ai/evaluations/${encodeURIComponent(conversationId)}?provider=${provider}&force=${force}`, {method: "POST"});
      const fromCache = result.cached ? " (из сохранённой оценки, без нового запроса)" : "";
      const fallback = result.fallback_used ? "; использован резервный AI" : "";
      notify(`Готово: ${result.provider}, ${result.score ?? "N/A"}/100${fromCache}${fallback}.`, "success");
      pickedSource = result.provider;
      await displayStored();
      await afterAssessmentChange(conversationId);
    } catch (error) { notify(`AI: ${error.message}`, "error"); }
    finally { aiButton.disabled = false; compareButton.disabled = false; aiButton.textContent = "Оценить с AI"; }
  });

  compareButton.addEventListener("click", async () => {
    if (activeConversationId !== conversationId) return;
    aiButton.disabled = true; compareButton.disabled = true;
    compareButton.textContent = "Сравниваем...";
    try {
      const force = forceCheckbox.checked ? "true" : "false";
      const comparison = await requestJson(`/api/ai/compare/${encodeURIComponent(conversationId)}?force=${force}`, {method: "POST"});
      await displayStored();
      await afterAssessmentChange(conversationId);
      const errors = Object.values(comparison.errors || {}).join("; ");
      notify(errors ? `Сравнение частично готово: ${errors}` :
        `Обе оценки готовы. Разница итогов: ${comparison.score_difference ?? "не рассчитывается"} балла.`, errors ? "error" : "success");
    } catch (error) { notify(`Сравнение: ${error.message}`, "error"); }
    finally { aiButton.disabled = false; compareButton.disabled = false; compareButton.textContent = "Сравнить Groq и Gemini"; }
  });

  // ===== Вкладка «Ручная оценка» =====
  const manualPane = node("div", "", "mode-pane");
  manualPane.dataset.modePane = "manual";
  let lastResult = null;
  try { lastResult = await requestJson(`/api/evaluations/${encodeURIComponent(conversationId)}`); }
  catch (e) { if (!String(e.message).includes("ещё не оценён")) notify(`Оценка: ${e.message}`, "error"); }
  manualPane.append(node("h3", "Ручная оценка"));
  manualPane.append(node("p", "Оцените диалог сами — Python проверит правила и посчитает итог. Удобно для сравнения с AI.", "muted small"));
  if (lastResult) {
    const resultContainer = node("details", "", "result-card");
    renderResult(resultContainer, lastResult);
    manualPane.append(resultContainer);
  }
  const form = node("form", "", "score-form");
  const controls = {};
  for (const criterion of currentChecklist.criteria) {
    const row = node("fieldset", "", "score-criterion");
    row.append(node("legend", `${criterion.name} · вес ${criterion.weight}`));
    row.append(node("p", criterion.rule, "muted small"));
    if (criterion.allow_na) row.append(node("p", `N/A: ${criterion.na_rule}`, "muted small"));
    const select = document.createElement("select");
    for (const [v, name] of [["", "Выберите оценку"], ...answerOptions(criterion)]) select.append(new Option(name, v));
    const previous = lastResult?.criteria?.find(c => c.id === criterion.id);
    if (previous && previous.value != null) select.value = String(previous.value);
    const reason = document.createElement("textarea");
    reason.rows = 2; reason.placeholder = "Почему такой ответ? Для N/A укажите условие неприменимости.";
    reason.value = previous?.reason || "";
    const evidence = document.createElement("select");
    activeConversation.transcript.forEach((m, idx) => evidence.append(new Option(`#${idx + 1} · ${m.speaker} · ${String(m.text || "").slice(0, 100)}`, String(idx))));
    if (previous?.evidence_index != null) evidence.value = String(previous.evidence_index);
    row.append(select, reason, node("p", "Реплика-доказательство:", "muted small"), evidence);
    controls[criterion.id] = {select, reason, evidence, criterion};
    form.append(row);
  }
  const submit = node("button", "Сохранить оценку и посчитать баллы", "primary"); submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const answers = {};
    for (const [id, c] of Object.entries(controls)) {
      const raw = c.select.value;
      if (!raw) { notify(`Выберите оценку для «${c.criterion.name}».`, "error"); c.select.focus(); return; }
      answers[id] = {value: c.criterion.type === "scale" && raw !== "na" ? Number(raw) : raw,
        reason: c.reason.value.trim(), evidence_index: Number(c.evidence.value)};
    }
    submit.disabled = true;
    try {
      const result = await requestJson(`/api/evaluations/${encodeURIComponent(conversationId)}`, {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({answers})
      });
      notify(`Оценка сохранена: ${result.score == null ? "не рассчитана" : result.score + "/100"}.`, "success");
      pickedSource = "manual";
      await renderAssessment();
      await afterAssessmentChange(conversationId);
    } catch (error) { notify(`Ошибка оценки: ${error.message}`, "error"); }
    finally { submit.disabled = false; }
  });
  manualPane.append(form);

  if (activeConversationId !== conversationId) return;
  area.append(aiPane, manualPane);
  setMode(activeMode);
}

function renderCompare(parent, results) {
  if (!results.groq || !results.gemini) return;
  const groq = results.groq, gemini = results.gemini;
  const comparison = node("div", "", "compare-panel");
  comparison.append(node("h3", "Сравнение двух AI"));
  comparison.append(node("p", `Итог Groq: ${groq.score ?? "N/A"}/100 · Gemini: ${gemini.score ?? "N/A"}/100. Это две независимые оценки, не окончательная истина.`, "muted small"));
  const table = node("table", "", "compare-table");
  const head = node("tr");
  ["Критерий", "Groq", "Gemini"].forEach(x => head.append(node("th", x)));
  table.append(head);
  for (const c of groq.criteria || []) {
    const match = (gemini.criteria || []).find(g => g.id === c.id);
    const row = node("tr");
    const differ = match && String(match.value) !== String(c.value);
    [c.name, String(c.value), match ? String(match.value) : "—"].forEach(v => row.append(node("td", v)));
    if (differ) row.className = "differ";
    table.append(row);
  }
  comparison.append(table);
  parent.append(comparison);
}

function renderResult(parent, result) {
  const score = result.score == null ? "Нет применимых критериев" : `${Number(result.score).toFixed(2)} / 100`;
  const isAi = result.mode === "ai";
  const aiName = result.provider === "groq" ? "GroqCloud" : result.provider === "gemini" ? "Google Gemini" : "AI";
  const summary = node("summary");
  summary.append(node("strong", `${isAi ? aiName : "Ручная оценка"}: ${score}`), node("span", "Обоснования по критериям", "muted small"));
  parent.append(summary);
  parent.append(node("p", `Режим: ${isAi ? "AI" : "ручной"}${isAi ? " · Модель: " + (result.model || "?") : ""} · Чек-лист версия ${result.checklist_version} · Грубая ошибка: ${result.gross_violation ? "ДА" : "нет"}`, "muted small"));
  const sections = Object.entries(result.sections || {}).map(([k, v]) => `${k}: ${v}/100`).join(" · ");
  if (sections) parent.append(node("p", sections, "small"));
  for (const item of result.criteria) {
    const box = node("div", "", "result-line");
    const answer = item.value === "yes" ? "Да" : item.value === "no" ? "Нет" : item.value === "na" ? "N/A" : item.value;
    box.append(node("strong", `${item.name}: ${answer}${item.points_before_redistribution != null ? ` (${item.points_before_redistribution} баллов до N/A)` : ""}`));
    box.append(node("p", item.reason, "small"));
    const proof = node("button", `К реплике #${item.evidence_index + 1}`, "link-button"); proof.type = "button";
    proof.addEventListener("click", () => jumpToMessage(item.evidence_index));
    box.append(proof);
    parent.append(box);
  }
}

// ---------- Разделы (вид) ----------
const VIEW_TITLES = {
  evaluate: "Оценка диалогов", add: "Добавить свои диалоги", appeals: "Апелляции", review: "Ревью",
  analytics: "Аналитика", checklist: "Чек-лист", case: "Карточка апелляции",
};
let previousView = "review";

function showView(view) {
  if (!VIEW_TITLES[view]) view = "evaluate";
  if (view === "case" && activeView !== "case") previousView = activeView;
  activeView = view;
  const navView = view === "case" ? previousView : view;
  document.querySelectorAll(".side-nav [data-view]").forEach(b => {
    if (b.dataset.view === navView) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-view-panel]").forEach(p => p.hidden = p.dataset.viewPanel !== view);
  $("view-title").textContent = VIEW_TITLES[view];
  $("filters").hidden = view !== "evaluate";
  $("view-sub").hidden = view !== "evaluate";
  if (view === "appeals") { renderAppealsTable(); loadAppeals(); }
  if (view === "review") { renderReview(); loadAppeals(); }
  if (view === "analytics") renderAnalytics();
  if (view === "add") renderCustomList();
}

// Показать верх окна приложения, не прокручивая страницу вниз.
function keepWindowInView() {
  const top = document.querySelector(".app-window").getBoundingClientRect().top;
  if (top < 0) window.scrollTo({top: window.scrollY + top - 12, behavior: "auto"});
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ru-RU", {day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
}

function statePill(status) {
  return node("span", status === "pending" ? "Открыта" : "Решена", `appeal-state ${status === "pending" ? "pending" : "resolved"}`);
}

function renderAppealsTable() {
  document.querySelectorAll("[data-appeal-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.appealFilter === appealFilter)));
  const wrap = $("appeals-table");
  wrap.replaceChildren();
  const rows = allAppeals.filter(a => appealFilter === "all" || a.status === appealFilter);
  if (!rows.length) {
    wrap.append(emptyBlock(allAppeals.length ? "Нет апелляций с таким статусом." : "Апелляций пока нет. Откройте оценённый диалог и оспорьте критерий."));
    return;
  }
  const table = node("table", "", "data-table");
  const head = node("tr");
  ["Дата", "Диалог", "Источник", "Критерий", "Комментарий", "Статус", "Балл"].forEach(h => head.append(node("th", h)));
  table.append(head);
  for (const a of rows) {
    const tr = node("tr");
    tr.tabIndex = 0;
    const scoreText = a.final_score != null ? `${fmtScore(a.original_score)} → ${fmtScore(a.final_score)}` : fmtScore(a.original_score);
    const names = (a.items || []).map(i => i.criterion_name).filter(Boolean).join(", ") || a.criterion_name;
    const cells = [formatDate(a.created_at), a.conversation_id, SOURCE_LABEL[a.source] || a.source, names, a.comment];
    cells.forEach((v, i) => { const td = node("td", v || "—"); if (i === 4) td.className = "clip"; if (i === 1) td.className = "mono"; tr.append(td); });
    const st = node("td"); st.append(statePill(a.status)); tr.append(st);
    tr.append(node("td", scoreText, "mono"));
    const open = () => openCase(a.id);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
    table.append(tr);
  }
  wrap.append(table);
}

function renderReview() {
  const grid = $("review-queue");
  grid.replaceChildren();
  const pending = allAppeals.filter(a => a.status === "pending");
  if (!pending.length) { grid.append(emptyBlock("Очередь пуста — все апелляции рассмотрены.")); return; }
  for (const a of pending) {
    const card = node("article", "", "review-card");
    const head = node("div", "", "review-head");
    head.append(node("strong", a.conversation_id, "mono"), statePill(a.status));
    card.append(head);
    card.append(node("p", `${SOURCE_LABEL[a.source] || a.source} · исходный балл ${fmtScore(a.original_score)}`, "muted small"));
    const chips = node("div", "", "crit-chips");
    for (const item of a.items || []) chips.append(node("span", item.criterion_name, "crit-chip"));
    card.append(chips);
    card.append(node("p", `«${a.comment}»`, "review-comment"));
    const foot = node("div", "", "review-foot");
    foot.append(node("span", formatDate(a.created_at), "muted small"));
    const go = node("button", "Рассмотреть", "primary"); go.type = "button";
    go.addEventListener("click", () => openCase(a.id));
    foot.append(go);
    card.append(foot);
    grid.append(card);
  }
}

function emptyBlock(text) {
  const box = node("div", "", "empty-state");
  box.append(node("p", text));
  return box;
}

// ---------- Карточка апелляции (страница проверяющего) ----------
const valueText = (v) => v === "yes" ? "Да" : v === "no" ? "Нет" : v === "na" ? "N/A" : v == null ? "—" : String(v);

async function openCase(appealId) {
  showView("case");
  keepWindowInView();
  const page = $("case-page");
  page.replaceChildren(node("p", "Загружаем апелляцию...", "muted"));
  try {
    const appeal = await requestJson(`/api/appeals/${encodeURIComponent(appealId)}`);
    const conversation = await requestJson(`/api/conversations/${encodeURIComponent(appeal.conversation_id)}`);
    if (activeView !== "case") return;
    renderCase(appeal, conversation);
  } catch (error) {
    page.replaceChildren(node("p", `Не удалось открыть апелляцию: ${error.message}`, "muted"));
  }
}

function renderCase(appeal, conversation) {
  const page = $("case-page");
  page.replaceChildren();
  const resolved = appeal.status === "resolved";
  const base = appeal.original_result || {};
  const snapshot = appeal.checklist_snapshot || currentChecklist || {criteria: []};

  // Верхняя панель
  const top = node("div", "", "case-top");
  const back = node("button", `← ${VIEW_TITLES[previousView] || "Назад"}`, "btn btn-ghost btn-sm");
  back.type = "button";
  back.addEventListener("click", () => showView(previousView || "review"));
  const titleBox = node("div", "", "case-title");
  const h = node("h3", `Апелляция · ${appeal.conversation_id}`);
  h.append(statePill(appeal.status));
  titleBox.append(h, node("p", `${SOURCE_LABEL[appeal.source] || appeal.source} · создана ${formatDate(appeal.created_at)}${resolved ? " · решена " + formatDate(appeal.decided_at) : ""}`, "muted small"));
  const scoreBox = node("div", "", "case-score");
  scoreBox.append(node("span", "Исходный итог", "muted small"), node("strong", fmtScore(appeal.original_score), `tone-${scoreTone(appeal.original_score)}`));
  if (resolved) {
    scoreBox.append(node("span", "→", "case-arrow"));
    const fin = node("div");
    fin.append(node("span", "Финальный итог", "muted small"), node("strong", fmtScore(appeal.final_score), `tone-${scoreTone(appeal.final_score)}`));
    scoreBox.append(fin);
  }
  const openDialog = node("button", "Открыть диалог", "btn btn-ghost btn-sm");
  openDialog.type = "button";
  openDialog.addEventListener("click", async () => { showView("evaluate"); await openConversation(appeal.conversation_id); keepWindowInView(); });
  top.append(back, titleBox, scoreBox, openDialog);
  page.append(top);
  if (appeal.comment) page.append(node("p", `Комментарий пользователя: «${appeal.comment}»`, "case-comment"));

  const grid = node("div", "", "case-grid");
  // Транскрипт (прокручивается внутри, страница не двигается)
  const tCol = node("section", "", "col case-transcript");
  tCol.append(node("h4", `Транскрипт · ${conversation.transcript.length} реплик`));
  const box = node("div", "", "messages case-messages");
  conversation.transcript.forEach((message, index) => {
    const speaker = String(message.speaker || "").toLowerCase();
    const role = ["operator", "bot", "system"].includes(speaker) ? speaker : "client";
    const block = node("article", "", `message ${role}`);
    block.id = `case-msg-${index}`;
    const avatar = svg(ICONS[role]); avatar.classList.add("msg-avatar");
    const body = node("div", "", "msg-body");
    const time = formatStamp(message.timestamp);
    body.append(node("div", `${{operator: "Оператор", bot: "Бот", client: "Клиент", system: "Система"}[role]}${time ? " · " + time : ""} · #${index + 1}`, "info"), node("p", message.text || ""));
    block.append(avatar, body);
    box.append(block);
  });
  tCol.append(box);
  const jump = (index) => {
    const target = document.getElementById(`case-msg-${index}`);
    if (!target) return;
    box.scrollTo({top: target.offsetTop - box.offsetTop - 60, behavior: "smooth"});
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1600);
  };
  if (conversation.audio_url) {
    const player = node("div", "", "audio-player");
    const audio = document.createElement("audio");
    audio.controls = true; audio.preload = "none"; audio.src = conversation.audio_url;
    player.append(audio);
    tCol.insertBefore(player, box);
  }

  // Критерии апелляции
  const iCol = node("section", "", "case-items");
  iCol.append(node("h4", `Оспоренные критерии (${appeal.items.length})`));
  const controls = [];
  for (const item of appeal.items) {
    const row = (base.criteria || []).find(c => c.id === item.criterion_id) || {};
    const criterion = (snapshot.criteria || []).find(c => c.id === item.criterion_id);
    const card = node("article", "", "case-item");
    const head = node("div", "", "case-item-head");
    head.append(node("strong", item.criterion_name || item.criterion_id), node("span", `вес ${row.weight ?? criterion?.weight ?? "—"}`, "muted small"));
    card.append(head);
    const orig = node("p", "", "small");
    orig.append(node("span", "Исходная оценка: ", "muted"), node("strong", valueText(row.value)));
    if (Number.isInteger(row.evidence_index)) {
      const proof = node("button", `реплика #${row.evidence_index + 1}`, "link-button");
      proof.type = "button"; proof.addEventListener("click", () => jump(row.evidence_index));
      orig.append(document.createTextNode(" · "), proof);
    }
    card.append(orig);
    if (row.reason) card.append(node("p", `Обоснование оценки: ${row.reason}`, "muted small"));
    if (item.comment) card.append(node("p", `«${item.comment}»`, "case-user-comment"));

    if (resolved || item.decision) {
      const d = item.decision || {};
      const res = node("div");
      res.className = `case-decision ${d.action === "change" ? "changed" : "confirmed"}`;
      res.append(node("strong", d.action === "change" ? `Изменено: ${valueText(d.old_value)} → ${valueText(d.new_value)}` : "Оценка подтверждена"));
      if (d.reason) res.append(node("p", `Причина: ${d.reason}`, "small"));
      if (d.action === "change" && Number.isInteger(d.evidence_index)) {
        const proof = node("button", `Доказательство проверяющего · #${d.evidence_index + 1}`, "link-button");
        proof.type = "button"; proof.addEventListener("click", () => jump(d.evidence_index));
        res.append(proof);
      }
      card.append(res);
    } else {
      const form = node("div", "", "case-form");
      const actions = node("div", "", "seg-tabs small-tabs");
      const confirmBtn = node("button", "Подтвердить", ""); confirmBtn.type = "button";
      const changeBtn = node("button", "Изменить", ""); changeBtn.type = "button";
      actions.append(confirmBtn, changeBtn);
      const changeBox = node("div", "", "form-row two");
      changeBox.hidden = true;
      const valueField = node("label", "", "edit-field"); valueField.append(node("span", "Новая оценка"));
      const valueSelect = document.createElement("select");
      for (const [v, label] of (criterion ? answerOptions(criterion) : [["yes", "Да"], ["no", "Нет"]])) {
        if (String(v) !== String(row.value)) valueSelect.append(new Option(label, v));
      }
      valueField.append(valueSelect);
      const evField = node("label", "", "edit-field"); evField.append(node("span", "Реплика-доказательство"));
      const evSelect = document.createElement("select");
      conversation.transcript.forEach((m, idx) => evSelect.append(new Option(`#${idx + 1} · ${m.speaker} · ${String(m.text || "").slice(0, 70)}`, String(idx))));
      if (Number.isInteger(row.evidence_index)) evSelect.value = String(row.evidence_index);
      evSelect.addEventListener("change", () => jump(Number(evSelect.value)));
      evField.append(evSelect);
      changeBox.append(valueField, evField);
      const reason = document.createElement("textarea");
      reason.rows = 2; reason.maxLength = 2000; reason.placeholder = "Причина решения (обязательно)";
      const state = {action: null};
      const setAction = (a) => {
        state.action = a;
        confirmBtn.setAttribute("aria-selected", String(a === "confirm"));
        changeBtn.setAttribute("aria-selected", String(a === "change"));
        changeBox.hidden = a !== "change";
      };
      confirmBtn.addEventListener("click", () => setAction("confirm"));
      changeBtn.addEventListener("click", () => setAction("change"));
      form.append(actions, changeBox, reason);
      card.append(form);
      controls.push({item, criterion, state, valueSelect, evSelect, reason});
    }
    iCol.append(card);
  }

  if (!resolved) {
    const msg = node("p", "", "appeal-inline-msg");
    const save = node("button", appeal.items.length > 1 ? "Сохранить решение по всем критериям" : "Сохранить решение", "primary");
    save.type = "button";
    save.addEventListener("click", async () => {
      msg.textContent = "";
      const decisions = [];
      for (const c of controls) {
        if (!c.state.action) { msg.textContent = `Выберите «Подтвердить» или «Изменить» для «${c.item.criterion_name}».`; return; }
        if (c.reason.value.trim().length < 3) { msg.textContent = `Укажите причину решения для «${c.item.criterion_name}».`; c.reason.focus({preventScroll: true}); return; }
        const d = {criterion_id: c.item.criterion_id, action: c.state.action, reason: c.reason.value.trim()};
        if (c.state.action === "change") {
          const raw = c.valueSelect.value;
          d.new_value = c.criterion?.type === "scale" && raw !== "na" ? Number(raw) : raw;
          d.evidence_index = Number(c.evSelect.value);
        }
        decisions.push(d);
      }
      save.disabled = true; save.textContent = "Сохраняем...";
      try {
        const updated = await requestJson(`/api/appeals/${encodeURIComponent(appeal.id)}/decision`, {
          method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({decisions})});
        notify(`Решение сохранено. Итог: ${fmtScore(updated.original_score)} → ${fmtScore(updated.final_score)}.`, "success");
        renderCase(updated, conversation);
        document.dispatchEvent(new CustomEvent("cqa:appeals-changed", {detail: {conversationId: appeal.conversation_id, fromCase: true}}));
      } catch (error) { msg.textContent = `Ошибка: ${error.message}`; save.disabled = false; save.textContent = "Сохранить решение"; }
    });
    const foot = node("div", "", "case-save");
    foot.append(msg, save);
    iCol.append(foot);
  } else {
    const fin = node("div", "", "case-final");
    fin.append(node("span", "Финальный результат", "muted small"), node("strong", fmtScore(appeal.final_score), `tone-${scoreTone(appeal.final_score)}`));
    const v = verdict(appeal.final_score, appeal.final_result?.gross_violation);
    fin.append(node("span", v.text, `status-badge ${v.tone}`));
    iCol.append(fin);
  }
  grid.append(tCol, iCol);
  page.append(grid);
}

// ---------- Свои диалоги ----------
function setupAddView() {
  document.querySelectorAll("[data-add-tab]").forEach(tab => tab.addEventListener("click", () => {
    document.querySelectorAll("[data-add-tab]").forEach(t => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll("[data-add-pane]").forEach(p => p.hidden = p.dataset.addPane !== tab.dataset.addTab);
  }));

  $("add-text-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter || event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const body = {text: $("add-text").value, channel: $("add-channel").value, language: $("add-language").value,
        conversation_id: $("add-id").value.trim() || undefined, audio_url: $("add-audio").value.trim() || undefined};
      const result = await requestJson("/api/conversations", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      $("add-text").value = ""; $("add-id").value = ""; $("add-audio").value = "";
      notify(`Диалог ${result.added[0]} добавлен.`, "success");
      await refresh();
      showView("evaluate");
      await openConversation(result.added[0]);
      keepWindowInView();
    } catch (error) { notify(`Не удалось добавить: ${error.message}`, "error"); }
    finally { button.disabled = false; }
  });

  const input = $("add-files");
  const zone = $("dropzone");
  input.addEventListener("change", () => uploadFiles([...input.files]).finally(() => { input.value = ""; }));
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); });

  $("add-group-form").addEventListener("submit", async event => {
    event.preventDefault();
    const groupId = $("group-id").value.trim();
    const button = event.submitter || event.target.querySelector("button[type=submit]");
    button.disabled = true;
    notify(`Загружаем набор ${groupId}...`, "");
    try {
      const result = await requestJson(`/api/import?group_id=${encodeURIComponent(groupId)}`, {method: "POST"});
      await refresh();
      renderCustomList();
      notify(`Набор ${result.group_id}: добавлено ${result.count} диалогов. Нажмите «Оценить с AI все…», чтобы обработать их.`, "success");
    } catch (error) { notify(`Набор ${groupId}: ${error.message}`, "error"); }
    finally { button.disabled = false; }
  });

  $("batch-ai").addEventListener("click", batchEvaluate);
}

async function uploadFiles(files) {
  const status = $("file-status");
  if (!files.length) return;
  const records = [];
  try {
    for (const file of files) {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        let data;
        try { data = JSON.parse(text); } catch { throw new Error(`${file.name}: не удалось прочитать JSON.`); }
        if (data?.data?.records) data = data.data.records;
        else if (data?.records) data = data.records;
        records.push(...(Array.isArray(data) ? data : [data]));
      } else {
        const id = file.name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 80);
        records.push({conversation_id: id, text, channel: $("file-channel").value, language: $("file-language").value});
      }
    }
    status.textContent = `Загружаем ${records.length}...`;
    const result = await requestJson("/api/conversations", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(records)});
    status.textContent = `Добавлено: ${result.added.join(", ")}`;
    notify(`Добавлено диалогов: ${result.count}.`, "success");
    await refresh();
    renderCustomList();
  } catch (error) {
    status.textContent = `Ошибка: ${error.message}`;
    notify(`Загрузка файлов: ${error.message}`, "error");
  }
}

function renderCustomList() {
  const list = $("custom-list");
  const custom = allConversations.filter(c => (c.origin || "DEV") !== "DEV");
  $("custom-count").textContent = String(custom.length);
  list.replaceChildren();
  if (!custom.length) { list.append(node("p", "Пока нет — добавьте текст, файл или контрольный набор слева.", "muted small")); return; }
  for (const c of custom) {
    const row = node("div", "", "custom-row");
    const open = node("button", "", "custom-open"); open.type = "button";
    const score = scores[c.conversation_id]?.score;
    const t = node("span", "", "list-text");
    t.append(node("strong", c.conversation_id), node("span", `${originLabel(c.origin)} · ${KIND_LABEL[kindOf(c)]} · ${c.language || "?"} · ${c.message_count} реплик`));
    open.append(t, node("span", fmtScore(score), `score-badge ${scoreTone(score)}`));
    open.addEventListener("click", async () => { showView("evaluate"); await openConversation(c.conversation_id); keepWindowInView(); });
    const del = node("button", "", "icon-btn danger"); del.type = "button";
    del.title = `Удалить ${c.conversation_id}`; del.setAttribute("aria-label", del.title);
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener("click", async () => {
      if (!confirm(`Удалить диалог ${c.conversation_id}?`)) return;
      try {
        await requestJson(`/api/conversations/${encodeURIComponent(c.conversation_id)}`, {method: "DELETE"});
        if (activeConversationId === c.conversation_id) resetConversationView();
        await refresh(); renderCustomList();
      } catch (error) { notify(`Удаление: ${error.message}`, "error"); }
    });
    row.append(open, del);
    list.append(row);
  }
}

async function batchEvaluate() {
  const button = $("batch-ai"), status = $("batch-status");
  const todo = allConversations.filter(c => (c.origin || "DEV") !== "DEV" && scores[c.conversation_id]?.score == null);
  if (!todo.length) { status.textContent = "Все добавленные диалоги уже оценены."; return; }
  button.disabled = true;
  let ok = 0; const errors = [];
  for (const [i, c] of todo.entries()) {
    status.textContent = `Оцениваем ${i + 1} из ${todo.length}: ${c.conversation_id}...`;
    try {
      await requestJson(`/api/ai/evaluations/${encodeURIComponent(c.conversation_id)}?provider=auto&force=false`, {method: "POST"});
      ok += 1;
    } catch (error) { errors.push(`${c.conversation_id}: ${error.message}`); }
  }
  await loadScores();
  renderCustomList();
  status.textContent = `Готово: ${ok} из ${todo.length}.${errors.length ? " Ошибки: " + errors.slice(0, 3).join("; ") : ""}`;
  button.disabled = false;
}

// ---------- Аналитика ----------
function average(values) {
  const list = values.filter(v => v != null);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function barRow(label, value, extra = "", onClick = null) {
  const row = node(onClick ? "button" : "div", "", "bar-row");
  if (onClick) { row.type = "button"; row.addEventListener("click", onClick); }
  const track = node("span", "", "bar-track");
  const fill = node("span", "", `bar-fill ${scoreTone(value)}`);
  fill.style.width = `${Math.max(0, Math.min(100, value ?? 0))}%`;
  track.append(fill);
  row.append(node("span", label, "bar-label"), track, node("span", value == null ? "—" : `${Math.round(value)}%${extra}`, "bar-value"));
  return row;
}

function renderAnalytics() {
  const box = $("analytics");
  box.replaceChildren();
  const entries = Object.entries(scores);
  const scored = entries.filter(([, e]) => e.score != null);
  const results = entries.map(([id, e]) => ({id, entry: e, result: e.primary ? e.sources[e.primary] : null})).filter(x => x.result);
  const avg = average(scored.map(([, e]) => e.score));
  const passing = results.filter(x => x.result.score >= 80 && !x.result.gross_violation).length;
  const gross = results.filter(x => x.result.gross_violation).length;

  const kpis = node("div", "", "kpi-grid");
  for (const [label, value, sub, tone] of [
    ["Оценено диалогов", `${scored.length} / ${entries.length}`, "есть хотя бы одна оценка", ""],
    ["Средний балл", fmtScore(avg), "по основной оценке", `tone-${scoreTone(avg)}`],
    ["Соответствуют", results.length ? `${Math.round(passing / results.length * 100)}%` : "—", "балл ≥ 80 без нарушений", "tone-good"],
    ["Грубые нарушения", String(gross), "диалогов с критическим флагом", gross ? "tone-low" : ""],
  ]) {
    const card = node("div", "", "kpi");
    card.append(node("span", label, "muted small"), node("strong", value, tone), node("span", sub, "muted small"));
    kpis.append(card);
  }
  box.append(kpis);

  if (!results.length) {
    box.append(emptyBlock("Пока нет оценок. Оцените несколько диалогов с AI или вручную — здесь появится статистика."));
    return;
  }

  const grid = node("div", "", "analytics-grid");
  // Средний процент по каждому критерию
  const perCriterion = new Map();
  for (const {result} of results) for (const row of result.criteria) {
    if (row.percent == null) continue;
    if (!perCriterion.has(row.id)) perCriterion.set(row.id, {name: row.name, values: []});
    perCriterion.get(row.id).values.push(row.percent);
  }
  const critCard = node("div", "", "chart-card");
  critCard.append(node("h4", "Выполнение критериев"), node("p", "Средний процент по всем оценённым диалогам", "muted small"));
  [...perCriterion.values()].map(c => ({...c, avg: average(c.values)})).sort((a, b) => a.avg - b.avg)
    .forEach(c => critCard.append(barRow(c.name, c.avg)));
  grid.append(critCard);

  // Распределение баллов
  const buckets = [["80–100", 80, 101], ["65–79", 65, 80], ["50–64", 50, 65], ["0–49", 0, 50]];
  const distCard = node("div", "", "chart-card");
  distCard.append(node("h4", "Распределение баллов"), node("p", "Количество диалогов в диапазоне", "muted small"));
  for (const [label, lo, hi] of buckets) {
    const n = scored.filter(([, e]) => e.score >= lo && e.score < hi).length;
    const row = barRow(label, scored.length ? n / scored.length * 100 : 0);
    row.querySelector(".bar-fill").className = `bar-fill ${scoreTone(lo)}`;
    row.querySelector(".bar-value").textContent = String(n);
    distCard.append(row);
  }
  // По каналу и языку
  distCard.append(node("h4", "По каналу и языку", "chart-sub"));
  for (const kind of ["call", "chat"]) {
    const vals = scored.filter(([, e]) => e.kind === kind).map(([, e]) => e.score);
    distCard.append(barRow(`${KIND_LABEL[kind]} (${vals.length})`, average(vals)));
  }
  const languages = [...new Set(scored.map(([, e]) => e.language).filter(Boolean))].sort();
  for (const lang of languages) {
    const vals = scored.filter(([, e]) => e.language === lang).map(([, e]) => e.score);
    distCard.append(barRow(`${lang} (${vals.length})`, average(vals)));
  }
  grid.append(distCard);

  // Худшие диалоги
  const worstCard = node("div", "", "chart-card");
  worstCard.append(node("h4", "Требуют внимания"), node("p", "Диалоги с самым низким баллом — нажмите, чтобы открыть", "muted small"));
  scored.sort((a, b) => a[1].score - b[1].score).slice(0, 6).forEach(([id, e]) =>
    worstCard.append(barRow(id, e.score, "", () => { showView("evaluate"); openConversation(id); })));
  grid.append(worstCard);
  box.append(grid);
}

// ---------- Редактор чек-листа ----------
function labelWithInput(title, value, onchange, type = "text") {
  const label = node("label", "", "edit-field");
  label.append(node("span", title));
  const input = document.createElement(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  input.value = value ?? "";
  input.addEventListener("input", () => onchange(input.value));
  label.append(input);
  return label;
}

const TRANSLIT = {а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
  ә:"a",ғ:"g",қ:"q",ң:"n",ө:"o",ұ:"u",ү:"u",һ:"h",і:"i"};

function uniqueCriterionId(name, self) {
  const base = String(name || "").toLowerCase().split("").map(ch => TRANSLIT[ch] ?? ch).join("")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "criterion";
  let id = base, n = 2;
  while (draftCriteria.some(c => c !== self && c.id === id)) id = `${base}_${n++}`;
  return id;
}

async function loadChecklist() {
  currentChecklist = await requestJson("/api/checklist");
  draftCriteria = structuredClone(currentChecklist.criteria);
  renderEditor();
  renderSummary();
  if (activeConversation) await renderAssessment();
}

function renderEditor() {
  const area = $("criteria-editor");
  area.replaceChildren();
  draftCriteria.forEach((criterion, position) => {
    const card = node("div", "", "criterion-editor");
    const top = node("div", "", "panel-heading");
    const heading = node("div", "", "crit-heading");
    const headName = node("strong", `${position + 1}. ${criterion.name || "Без названия"}`);
    const headId = node("span", `ID: ${criterion.id}${criterion._new ? " · новый, ещё не сохранён" : ""}`, "muted small mono");
    heading.append(headName, headId);
    top.append(heading);
    const remove = node("button", "Удалить", "danger-outline");
    remove.type = "button";
    remove.addEventListener("click", () => { draftCriteria.splice(position, 1); renderEditor(); });
    top.append(remove);
    card.append(top);
    const fields = node("div", "", "editor-grid");
    fields.append(labelWithInput("Название", criterion.name, value => {
      criterion.name = value;
      // Новому (ещё не сохранённому) критерию ID подбирается по названию.
      if (criterion._new) criterion.id = uniqueCriterionId(value, criterion);
      headName.textContent = `${position + 1}. ${value.trim() || "Без названия"}`;
      headId.textContent = `ID: ${criterion.id}${criterion._new ? " · новый, ещё не сохранён" : ""}`;
    }));
    fields.append(labelWithInput("Секция", criterion.section, value => criterion.section = value));
    fields.append(labelWithInput("Вес", criterion.weight, value => criterion.weight = Number(value), "number"));
    const typeField = node("label", "", "edit-field");
    typeField.append(node("span", "Тип оценки"));
    const typeSelect = document.createElement("select");
    for (const [value, title] of [["yes_no", "Да / Нет"], ["scale", "Числовая шкала"], ["flag", "Флаг без баллов"]]) {
      const opt = new Option(title, value); opt.selected = criterion.type === value; typeSelect.append(opt);
    }
    typeSelect.addEventListener("change", () => {
      criterion.type = typeSelect.value;
      if (criterion.type === "flag") { criterion.weight = 0; criterion.allow_na = false; criterion.scale = []; }
      else if (criterion.weight === 0) criterion.weight = 10;
      if (criterion.type === "scale" && !criterion.scale.length) criterion.scale = [0, 5, 10];
      if (criterion.type !== "scale") criterion.scale = [];
      renderEditor();
    });
    typeField.append(typeSelect); fields.append(typeField);
    if (criterion.type === "scale") fields.append(labelWithInput("Шкала, через запятую", criterion.scale.join(", "), value => {
      criterion.scale = value.split(",").map(x => Number(x.trim())).filter(Number.isInteger);
    }));
    const naLabel = node("label", "", "checkline");
    const naCheck = document.createElement("input"); naCheck.type = "checkbox"; naCheck.checked = criterion.allow_na;
    naCheck.disabled = criterion.type === "flag";
    naCheck.addEventListener("change", () => { criterion.allow_na = naCheck.checked; renderEditor(); });
    naLabel.append(naCheck, node("span", "Разрешить N/A")); fields.append(naLabel);
    card.append(fields);
    card.append(labelWithInput("Правило оценки", criterion.rule, value => criterion.rule = value, "textarea"));
    if (criterion.allow_na) card.append(labelWithInput("Когда допускается N/A", criterion.na_rule, value => criterion.na_rule = value, "textarea"));
    area.append(card);
  });
}

// ---------- Импорт ----------
async function importDev() {
  const button = $("import-btn");
  button.disabled = true;
  notify("Загружаем 65 диалогов из DEV API...", "");
  try {
    const result = await requestJson("/api/import", {method: "POST"});
    await refresh();
    const languages = Object.entries(result.languages).map(([k, v]) => `${k}: ${v}`).join(", ");
    notify(`Загружено ${result.count} диалогов. Языки: ${languages}`, "success");
  } catch (error) { notify(`Ошибка загрузки: ${error.message}`, "error"); }
  finally { button.disabled = false; }
}

// ---------- События ----------
$("import-btn").addEventListener("click", importDev);
$("script-select").addEventListener("change", e => { if (e.target.value) openConversation(e.target.value); });
$("random-script").addEventListener("click", openRandom);
$("empty-random").addEventListener("click", openRandom);
$("empty-pick").addEventListener("click", () => {
  const select = $("script-select");
  select.focus();
  try { select.showPicker(); } catch { /* старые браузеры: достаточно фокуса */ }
});
$("language-filter").addEventListener("change", renderList);
$("channel-filter").addEventListener("change", () => { updateExportLinks(); renderList(); });
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll(".side-nav [data-view]").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
document.querySelectorAll("[data-appeal-filter]").forEach(b => b.addEventListener("click", () => { appealFilter = b.dataset.appealFilter; renderAppealsTable(); }));
document.addEventListener("cqa:show-view", e => showView(e.detail.view));
document.addEventListener("cqa:open-case", e => openCase(e.detail.id));
document.querySelectorAll("[data-open-view]").forEach(b => b.addEventListener("click", () => showView(b.dataset.openView)));
$("origin-filter").addEventListener("change", renderList);
setupAddView();
document.addEventListener("cqa:appeals-changed", async () => { await loadAppeals(); await loadScores(); });

$("load-checklist").addEventListener("click", async () => {
  try { await loadChecklist(); notify("Чек-лист загружен.", "success"); }
  catch (error) { notify(`Ошибка: ${error.message}`, "error"); }
});

$("add-criterion").addEventListener("click", () => {
  const fresh = {_new: true, id: "", section: "Дополнительно", name: "Новый критерий", weight: 5,
    type: "yes_no", allow_na: false, scale: [], rule: "Опишите, что значит Да.", na_rule: ""};
  fresh.id = uniqueCriterionId(fresh.name, fresh);
  draftCriteria.push(fresh);
  renderEditor();
  $("criteria-editor").lastElementChild?.querySelector("input")?.select();
  $("criteria-editor").lastElementChild?.scrollIntoView({behavior: "smooth", block: "center"});
});

$("save-checklist").addEventListener("click", async () => {
  try {
    currentChecklist = await requestJson("/api/checklist", {
      method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({name: currentChecklist?.name || "CQA Checklist", criteria: draftCriteria})
    });
    draftCriteria = structuredClone(currentChecklist.criteria);
    renderEditor();
    renderSummary();
    if (activeConversation) await renderAssessment();
    notify(`Чек-лист сохранён (версия ${currentChecklist.version}). Новые оценки используют его.`, "success");
  } catch (error) { notify(`Ошибка сохранения: ${error.message}`, "error"); }
});

refresh()
  .then(status => {
    // Диалоги ещё не загружены, но ссылка есть — загружаем DEV автоматически.
    if (!status.data_loaded && status.api_configured) return importDev();
    notify(status.data_loaded
      ? `Диалоги готовы: ${status.record_count}. Выберите скрипт для проверки.`
      : "Нет ссылки на DEV API: добавьте CQA_API_URL в файл .env и перезапустите сервер.", status.data_loaded ? "success" : "error");
  })
  .catch(error => notify(`Ошибка подключения к серверу: ${error.message}`, "error"));
loadChecklist().catch(error => notify(`Ошибка загрузки чек-листа: ${error.message}`, "error"));
