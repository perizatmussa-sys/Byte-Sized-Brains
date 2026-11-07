"use strict";

let allConversations = [];
let activeConversationId = null;
let activeConversation = null;
let currentChecklist = null;
let draftCriteria = [];

const $ = (id) => document.getElementById(id);

function notify(message, kind = "") {
  const element = $("notice");
  element.textContent = message;
  element.className = kind;
}

async function requestJson(url, options = undefined) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`Ответ сервера не JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}

function renderList() {
  const container = $("conversation-list");
  const search = $("search").value.trim().toLowerCase();
  const filtered = allConversations.filter(c => (c.conversation_id || "").toLowerCase().includes(search));
  container.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = allConversations.length ? "Ничего не найдено." : "Пока нет диалогов. Нажмите «Загрузить DEV из API».";
    container.append(empty);
    return;
  }
  for (const conversation of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    if (conversation.conversation_id === activeConversationId) button.className = "selected";
    const title = document.createElement("strong");
    title.textContent = conversation.conversation_id || "Без ID";
    const meta = document.createElement("span");
    meta.textContent = `${conversation.language || "?"} · ${conversation.channel || "?"} · ${conversation.message_count} реплик`;
    button.append(title, meta);
    button.addEventListener("click", () => openConversation(conversation.conversation_id));
    container.append(button);
  }
}

async function openConversation(conversationId) {
  try {
    const conversation = await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}`);
    activeConversationId = conversationId;
    activeConversation = conversation;
    $("conversation-title").textContent = `Диалог ${conversationId}`;
    $("conversation-meta").textContent = `${conversation.language || "?"} · ${conversation.channel || "?"} · ${conversation.transcript.length} реплик`;
    const messages = $("messages");
    messages.replaceChildren();
    for (const [index, message] of conversation.transcript.entries()) {
      const indexId = `msg-${index}`;
      const block = document.createElement("article");
      block.className = `message ${message.speaker === "operator" ? "operator" : ""}`;
      block.id = indexId;
      const info = document.createElement("div");
      info.className = "info";
      info.textContent = `${message.speaker || "unknown"} · ${message.timestamp || ""}`;
      const text = document.createElement("p");
      text.textContent = message.text || "";
      block.append(info, text);
      messages.append(block);
    }
    const audioArea = $("audio-area");
    audioArea.replaceChildren();
    if (typeof conversation.audio_url === "string" && /^https?:\/\//i.test(conversation.audio_url)) {
      const link = document.createElement("a");
      link.href = conversation.audio_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Открыть запись звонка";
      audioArea.append(link);
    }
    renderList();
    await renderAssessment();
  } catch (error) { notify(`Ошибка открытия диалога: ${error.message}`, "error"); }
}

async function refresh() {
  const status = await requestJson("/api/status");
  $("api-status").textContent = status.api_configured ? "Настроен" : "Нет ссылки";
  $("count").textContent = String(status.record_count);
  allConversations = await requestJson("/api/conversations");
  renderList();
  return status;
}

async function importDev() {
  const button = $("import-btn");
  button.disabled = true;
  notify("Загружаем диалоги с API...", "");
  try {
    const result = await requestJson("/api/import", {method: "POST"});
    await refresh();
    const languages = Object.entries(result.languages).map(([k,v]) => `${k}: ${v}`).join(", ");
    notify(`Загружено ${result.count} диалогов. Языки: ${languages}`, "success");
  } catch (error) { notify(`Ошибка загрузки: ${error.message}`, "error"); }
  finally { button.disabled = false; }
}

$("import-btn").addEventListener("click", importDev);
$("search").addEventListener("input", renderList);
refresh()
  .then(status => notify(status.data_loaded
    ? `Диалоги готовы: ${status.record_count}. Выберите разговор слева.`
    : "Вставьте API-ссылку в .env, перезапустите сервер и нажмите «Загрузить DEV из API»."))
  .catch(error => notify(`Ошибка подключения к серверу: ${error.message}`, "error"));


// ЭТАП 2: РЕДАКТИРУЕМЫЙ ЧЕК-ЛИСТ И РУЧНОЙ ТЕСТ ОЦЕНКИ.
// AI здесь ещё НЕТ: вся логика ручной формы явно маркирована.
function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

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

async function loadChecklist() {
  currentChecklist = await requestJson("/api/checklist");
  draftCriteria = structuredClone(currentChecklist.criteria);
  renderEditor();
  if (activeConversation) await renderAssessment();
}

function renderEditor() {
  const area = $("criteria-editor");
  area.replaceChildren();
  draftCriteria.forEach((criterion, position) => {
    const card = node("div", "", "criterion-editor");
    const top = node("div", "", "panel-heading");
    top.append(node("strong", `${position + 1}. ${criterion.id}`));
    const remove = node("button", "Удалить", "danger-outline");
    remove.type = "button";
    remove.addEventListener("click", () => { draftCriteria.splice(position, 1); renderEditor(); });
    top.append(remove);
    card.append(top);
    const fields = node("div", "", "editor-grid");
    fields.append(labelWithInput("Название", criterion.name, value => criterion.name = value));
    fields.append(labelWithInput("Секция", criterion.section, value => criterion.section = value));
    fields.append(labelWithInput("Вес", criterion.weight, value => criterion.weight = Number(value), "number"));
    const typeField = node("label", "", "edit-field");
    typeField.append(node("span", "Тип оценки"));
    const typeSelect = document.createElement("select");
    for (const [value, title] of [["yes_no", "Да / Нет"], ["scale", "Числовая шкала"], ["flag", "Флаг без баллов"]]) {
      const opt = node("option", title); opt.value = value; opt.selected = criterion.type === value; typeSelect.append(opt);
    }
    typeSelect.addEventListener("change", () => {
      criterion.type = typeSelect.value;
      if (criterion.type === "flag") {criterion.weight = 0; criterion.allow_na = false; criterion.scale = [];}
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
    naCheck.addEventListener("change", () => {criterion.allow_na = naCheck.checked; renderEditor();});
    naLabel.append(naCheck, node("span", "Разрешить N/A")); fields.append(naLabel);
    card.append(fields);
    card.append(labelWithInput("Правило оценки", criterion.rule, value => criterion.rule = value, "textarea"));
    if (criterion.allow_na) card.append(labelWithInput("Когда допускается N/A", criterion.na_rule, value => criterion.na_rule = value, "textarea"));
    area.append(card);
  });
}

$("load-checklist").addEventListener("click", async () => {
  try {await loadChecklist(); notify("Чек-лист загружен.", "success");}
  catch (error) {notify(`Ошибка: ${error.message}`, "error");}
});

$("add-criterion").addEventListener("click", () => {
  let counter = 1;
  while (draftCriteria.some(c => c.id === `extra_${counter}`)) counter += 1;
  draftCriteria.push({id: `extra_${counter}`, section: "Дополнительно", name: "Новый критерий", weight: 5,
    type: "yes_no", allow_na: false, scale: [], rule: "Опишите, что значит Да.", na_rule: ""});
  renderEditor();
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
    if (activeConversation) await renderAssessment();
    notify(`Чек-лист сохранён (версия ${currentChecklist.version}). Новые оценки используют его.`, "success");
  } catch (error) {notify(`Ошибка сохранения: ${error.message}`, "error");}
});

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
  area.append(node("h2", "Оценка диалога"));
  area.append(node("p", "Ручной тест расчёта: выберите ответы, объяснения и реплики. AI будет подключён следующим этапом.", "muted"));
  let lastResult = null;
  try { lastResult = await requestJson(`/api/evaluations/${encodeURIComponent(activeConversationId)}`); }
  catch (e) { if (!String(e.message).includes("ещё не оценён")) notify(`Оценка: ${e.message}`, "error"); }
  if (lastResult) {
    const resultContainer = node("div", "", "result-card");
    renderResult(resultContainer, lastResult);
    area.append(resultContainer);
  }
  const form = node("form", "", "score-form");
  const controls = {};
  for (const criterion of currentChecklist.criteria) {
    const row = node("fieldset", "", "score-criterion");
    const legend = node("legend", `${criterion.name} · вес ${criterion.weight}`);
    row.append(legend);
    row.append(node("p", criterion.rule, "muted small"));
    if (criterion.allow_na) row.append(node("p", `N/A: ${criterion.na_rule}`, "muted small"));
    const select = document.createElement("select");
    for (const [v, name] of [["", "Выберите оценку"], ...answerOptions(criterion)]) {
      const option = node("option", name); option.value = v; select.append(option);
    }
    const previous = lastResult?.criteria?.find(c => c.id === criterion.id);
    if (previous && previous.value != null) select.value = String(previous.value);
    row.append(select);
    const reason = document.createElement("textarea");
    reason.rows = 2; reason.placeholder = "Почему такой ответ? Для N/A укажите условие неприменимости.";
    reason.value = previous?.reason || "";
    row.append(reason);
    const evidence = document.createElement("select");
    activeConversation.transcript.forEach((m, idx) => {
      const opt = node("option", `#${idx + 1} · ${m.speaker} · ${String(m.text || "").slice(0, 100)}`);
      opt.value = String(idx); evidence.append(opt);
    });
    if (previous?.evidence_index != null) evidence.value = String(previous.evidence_index);
    row.append(node("p", "Реплика-доказательство:", "muted small"));
    row.append(evidence);
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
      if (!raw) {notify(`Выбери оценку для «${c.criterion.name}».`, "error"); c.select.focus(); return;}
      answers[id] = {value: c.criterion.type === "scale" && raw !== "na" ? Number(raw) : raw,
        reason: c.reason.value.trim(), evidence_index: Number(c.evidence.value)};
    }
    submit.disabled = true;
    try {
      const result = await requestJson(`/api/evaluations/${encodeURIComponent(activeConversationId)}`, {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({answers})
      });
      notify(`Оценка сохранена: ${result.score == null ? "не рассчитана" : result.score + "/100"}.`, "success");
      await renderAssessment();
    } catch (error) {notify(`Ошибка оценки: ${error.message}`, "error");}
    finally {submit.disabled = false;}
  });
  area.append(form);
}

function renderResult(parent, result) {
  const score = result.score == null ? "Нет применимых критериев" : `${Number(result.score).toFixed(2)} / 100`;
  parent.append(node("h3", `Сохранённая оценка: ${score}`));
  parent.append(node("p", `Режим: ручной · Чек-лист версия ${result.checklist_version} · Грубая ошибка: ${result.gross_violation ? "ДА" : "нет"}`, "muted"));
  const sections = Object.entries(result.sections || {}).map(([k,v]) => `${k}: ${v}/100`).join(" · ");
  if (sections) parent.append(node("p", sections, "small"));
  for (const item of result.criteria) {
    const box = node("div", "", "result-line");
    const answer = item.value === "yes" ? "Да" : item.value === "no" ? "Нет" : item.value === "na" ? "N/A" : item.value;
    box.append(node("strong", `${item.name}: ${answer}${item.points_before_redistribution != null ? ` (${item.points_before_redistribution} баллов до N/A)` : ""}`));
    box.append(node("p", item.reason, "small"));
    const proof = node("button", `К реплике #${item.evidence_index + 1}`, "link-button"); proof.type = "button";
    proof.addEventListener("click", () => {
      const target = document.getElementById(`msg-${item.evidence_index}`);
      if (target) { target.scrollIntoView({behavior: "smooth", block: "center"}); target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1600); }
    });
    box.append(proof);
    parent.append(box);
  }
}

loadChecklist().catch(error => notify(`Ошибка загрузки чек-листа: ${error.message}`, "error"));
