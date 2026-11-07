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

let activeKind = "all";
const KIND_LABEL = {call: "Звонок", chat: "Переписка"};
const KIND_ICON = {
  call: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};
const kindOf = (c) => c.kind || (/call|voice|phone/i.test(c.channel || "") || c.has_audio ? "call" : "chat");
const downloadUrl = (id, format) => `/api/conversations/${encodeURIComponent(id)}/download?format=${format}`;

function updateKindCounts() {
  const counts = {all: allConversations.length, call: 0, chat: 0};
  for (const c of allConversations) counts[kindOf(c)] += 1;
  for (const [kind, value] of Object.entries(counts)) {
    document.querySelectorAll(`[data-kind-count="${kind}"]`).forEach(el => el.textContent = String(value));
  }
  $("kind-split").textContent = `${counts.call} / ${counts.chat}`;
  document.querySelectorAll("[data-count]").forEach(el => el.textContent = String(counts.all || 65));
  const languages = [...new Set(allConversations.map(c => c.language).filter(Boolean))].sort();
  const select = $("language-filter");
  const current = select.value;
  select.replaceChildren(new Option("Все языки", ""), ...languages.map(l => new Option(l, l)));
  select.value = languages.includes(current) ? current : "";
}

function setKind(kind) {
  activeKind = kind;
  document.querySelectorAll("[data-kind]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.kind === kind)));
  $("export-label").textContent = {all: "все скрипты", call: "все звонки", chat: "все переписки"}[kind];
  $("export-txt").href = `/api/export?kind=${kind}&format=txt`;
  $("export-json").href = `/api/export?kind=${kind}&format=json`;
  renderList();
}

function renderList() {
  const container = $("conversation-list");
  const search = $("search").value.trim().toLowerCase();
  const language = $("language-filter").value;
  const filtered = allConversations.filter(c =>
    (c.conversation_id || "").toLowerCase().includes(search) &&
    (activeKind === "all" || kindOf(c) === activeKind) &&
    (!language || c.language === language));
  container.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "muted list-empty";
    empty.textContent = allConversations.length ? "Ничего не найдено. Измените фильтр." : "Пока нет скриптов. Нажмите «Загрузить DEV из API».";
    container.append(empty);
    return;
  }
  for (const conversation of filtered) {
    const kind = kindOf(conversation);
    const item = document.createElement("div");
    item.className = "list-item" + (conversation.conversation_id === activeConversationId ? " selected" : "");
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "list-open";
    const icon = document.createElement("span");
    icon.className = `kind-icon ${kind}`;
    icon.innerHTML = KIND_ICON[kind];
    const text = document.createElement("span");
    text.className = "list-text";
    const title = document.createElement("strong");
    title.textContent = conversation.conversation_id || "Без ID";
    const meta = document.createElement("span");
    meta.textContent = `${KIND_LABEL[kind]} · ${conversation.language || "?"} · ${conversation.message_count} реплик`;
    text.append(title, meta);
    button.append(icon, text);
    button.addEventListener("click", () => openConversation(conversation.conversation_id));
    const download = document.createElement("a");
    download.className = "list-download";
    download.href = downloadUrl(conversation.conversation_id, "txt");
    download.setAttribute("download", "");
    download.title = `Скачать ${conversation.conversation_id} (TXT)`;
    download.setAttribute("aria-label", download.title);
    download.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    item.append(button, download);
    container.append(item);
  }
}

async function openConversation(conversationId) {
  try {
    const conversation = await requestJson(`/api/conversations/${encodeURIComponent(conversationId)}`);
    activeConversationId = conversationId;
    activeConversation = conversation;
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
      const indexId = `msg-${index}`;
      const block = document.createElement("article");
      const speaker = String(message.speaker || "").toLowerCase();
      block.className = `message ${speaker === "operator" ? "operator" : speaker === "bot" ? "bot" : ""}`;
      block.id = indexId;
      const info = document.createElement("div");
      info.className = "info";
      info.textContent = `#${index + 1} · ${message.speaker || "unknown"}${message.timestamp ? " · " + message.timestamp : ""}`;
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
    if (window.matchMedia("(max-width: 900px)").matches) $("conversation-title").scrollIntoView({behavior: "smooth", block: "start"});
    await renderAssessment();
    document.dispatchEvent(new CustomEvent("cqa:conversation-opened", {detail: {conversationId}}));
  } catch (error) { notify(`Ошибка открытия диалога: ${error.message}`, "error"); }
}

async function refresh() {
  const status = await requestJson("/api/status");
  $("api-status").textContent = status.api_configured ? "Настроен" : "Нет ссылки";
  $("count").textContent = String(status.record_count);
  allConversations = await requestJson("/api/conversations");
  updateKindCounts();
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
$("language-filter").addEventListener("change", renderList);
document.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => setKind(b.dataset.kind)));
refresh()
  .then(status => notify(status.data_loaded
    ? `Диалоги готовы: ${status.record_count}. Выберите скрипт в библиотеке.`
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
  area.append(node("p", "Сравните ручную оценку и вывод модели. Python сам проверит правила и посчитает итог.", "muted"));
  let lastResult = null;
  try { lastResult = await requestJson(`/api/evaluations/${encodeURIComponent(activeConversationId)}`); }
  catch (e) { if (!String(e.message).includes("ещё не оценён")) notify(`Оценка: ${e.message}`, "error"); }
  if (lastResult) {
    const resultContainer = node("div", "", "result-card");
    renderResult(resultContainer, lastResult);
    area.append(resultContainer);
  }
  // ЭТАП 4. Два AI с кешем: Groq / Gemini / авто (резерв) / сравнение.
  const aiPanel = node("div", "", "ai-panel");
  aiPanel.append(node("h3", "Автоматическая AI-оценка"));
  const aiStatus = node("p", "Проверяем ключи...", "muted small");
  aiPanel.append(aiStatus);

  const aiControls = node("div", "", "ai-controls");
  const selectLabel = node("label", "Выберите режим: ", "edit-field");
  const providerSelect = document.createElement("select");
  const modes = [["auto", "Авто: Groq → Gemini при ошибке"],
                 ["groq", "Только GroqCloud · Qwen"],
                 ["gemini", "Только Gemini · Flash-Lite"]];
  modes.forEach(([value,label]) => {const option=node("option",label);option.value=value;providerSelect.append(option);});
  selectLabel.append(providerSelect);
  aiControls.append(selectLabel);

  const freshLabel = node("label", "", "checkline");
  const forceCheckbox = document.createElement("input");
  forceCheckbox.type = "checkbox";
  freshLabel.append(forceCheckbox, node("span", "Оценить заново (расходует токены)"));
  aiControls.append(freshLabel);

  const buttons = node("div", "", "actions");
  const aiButton = node("button", "Оценить с AI", "primary"); aiButton.type="button"; aiButton.disabled=true;
  const compareButton = node("button", "Сравнить Groq и Gemini", "secondary");
  compareButton.type="button"; compareButton.disabled=true;
  buttons.append(aiButton, compareButton);
  aiControls.append(buttons);
  aiPanel.append(aiControls);
  const aiResultBox = node("div", "", "ai-results");
  aiPanel.append(aiResultBox);
  area.append(aiPanel);
  const aiConversationId = activeConversationId;

  async function displayStored() {
    aiResultBox.replaceChildren();
    let results;
    try {results=await requestJson(`/api/ai/evaluations/${encodeURIComponent(aiConversationId)}`);}
    catch (error) {
      if (String(error.message).includes("ещё не оценён AI")) return;
      throw error;
    }
    renderCompare(aiResultBox, results);
    document.dispatchEvent(new CustomEvent("cqa:assessment-changed", {detail: {conversationId: aiConversationId}}));
    for (const id of ["groq", "gemini"]) {
      if (results[id]) {
        const box=node("div", "", "result-card");
        renderResult(box, results[id]);
        aiResultBox.append(box);
      }
    }
  }

  try {
    const status=await requestJson("/api/ai/status");
    const available=(status.providers || []).filter(p=>p.configured);
    aiStatus.textContent = available.length
      ? `Подключено: ${available.map(p=>p.name+" ("+p.model+")").join("; ")}. Оценки сохраняются; повторный просмотр не тратит токены.`
      : "Нет API-ключей. Добавьте GROQ_API_KEY и/или GEMINI_API_KEY в .env и перезапустите сервер.";
    aiButton.disabled=!available.length;
    compareButton.disabled=!available.length;
    await displayStored();
  } catch(error) {aiStatus.textContent=`Не удалось проверить AI: ${error.message}`;}

  aiButton.addEventListener("click", async()=>{
    if (activeConversationId!==aiConversationId) return;
    aiButton.disabled=true; compareButton.disabled=true;
    aiButton.textContent="AI анализирует...";
    try {
      const provider=encodeURIComponent(providerSelect.value);
      const force=forceCheckbox.checked ? "true" : "false";
      const result=await requestJson(`/api/ai/evaluations/${encodeURIComponent(aiConversationId)}?provider=${provider}&force=${force}`, {method:"POST"});
      const fromCache=result.cached?" (из сохранённой оценки, без нового запроса)":"";
      const fallback=result.fallback_used?"; использован резервный AI":"";
      notify(`Готово: ${result.provider}, ${result.score ?? "N/A"}/100${fromCache}${fallback}.`,"success");
      await displayStored();
    } catch(error) {notify(`AI: ${error.message}`,"error");}
    finally {aiButton.disabled=false; compareButton.disabled=false; aiButton.textContent="Оценить с AI";}
  });

  compareButton.addEventListener("click", async()=>{
    if (activeConversationId!==aiConversationId) return;
    aiButton.disabled=true; compareButton.disabled=true;
    compareButton.textContent="Сравниваем...";
    try {
      const force=forceCheckbox.checked ? "true" : "false";
      const comparison=await requestJson(`/api/ai/compare/${encodeURIComponent(aiConversationId)}?force=${force}`, {method:"POST"});
      await displayStored();
      const errors=Object.values(comparison.errors||{}).join("; ");
      notify(errors?`Сравнение частично готово: ${errors}`:
        `Обе оценки готовы. Разница итогов: ${comparison.score_difference ?? "не рассчитывается"} балла.`,errors?"error":"success");
    } catch(error) {notify(`Сравнение: ${error.message}`,"error");}
    finally {aiButton.disabled=false; compareButton.disabled=false; compareButton.textContent="Сравнить Groq и Gemini";}
  });

  area.append(node("h3", "Ручная оценка"));
  area.append(node("p", "Можно оставить собственную оценку для сравнения с AI.", "muted small"));
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
      document.dispatchEvent(new CustomEvent("cqa:assessment-changed", {detail: {conversationId: activeConversationId}}));
    } catch (error) {notify(`Ошибка оценки: ${error.message}`, "error");}
    finally {submit.disabled = false;}
  });
  area.append(form);
}

function renderCompare(parent, results) {
  if (!results.groq || !results.gemini) return;
  const groq=results.groq, gemini=results.gemini;
  const comparison=node("div", "", "compare-panel");
  comparison.append(node("h3", "Сравнение двух AI"));
  comparison.append(node("p", `Итог Groq: ${groq.score ?? "N/A"}/100 · Gemini: ${gemini.score ?? "N/A"}/100. Это две независимые оценки, не окончательная истина.`,"muted small"));
  const table=node("table", "", "compare-table");
  const head=node("tr");
  ["Критерий","Groq","Gemini"].forEach(x=>head.append(node("th",x)));
  table.append(head);
  for(const c of groq.criteria||[]) {
    const match=(gemini.criteria||[]).find(g=>g.id===c.id);
    const row=node("tr");
    [c.name,String(c.value),match?String(match.value):"—"].forEach(v=>row.append(node("td",v)));
    table.append(row);
  }
  comparison.append(table);
  parent.append(comparison);
}

function renderResult(parent, result) {
  const score = result.score == null ? "Нет применимых критериев" : `${Number(result.score).toFixed(2)} / 100`;
  const isAi = result.mode === "ai";
  const aiName = result.provider === "groq" ? "GroqCloud" : result.provider === "gemini" ? "Google Gemini" : "AI";
  parent.append(node("h3", `${isAi ? aiName + " — AI-оценка" : "Ручная оценка"}: ${score}`));
  parent.append(node("p", `Режим: ${isAi ? "AI" : "ручной"}${isAi ? " · Модель: " + (result.model || "?") : ""} · Чек-лист версия ${result.checklist_version} · Грубая ошибка: ${result.gross_violation ? "ДА" : "нет"}`, "muted"));
  if (isAi && result.usage) {
    const u=result.usage;
    parent.append(node("p", `Токены: вход ${u.input_tokens ?? "—"}, выход ${u.output_tokens ?? "—"}, всего ${u.total_tokens ?? "—"}.`,"muted small"));
  }
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
