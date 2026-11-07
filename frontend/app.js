"use strict";

let allConversations = [];
let activeConversationId = null;

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
    $("conversation-title").textContent = `Диалог ${conversationId}`;
    $("conversation-meta").textContent = `${conversation.language || "?"} · ${conversation.channel || "?"} · ${conversation.transcript.length} реплик`;
    const messages = $("messages");
    messages.replaceChildren();
    for (const message of conversation.transcript) {
      const block = document.createElement("article");
      block.className = `message ${message.speaker === "operator" ? "operator" : ""}`;
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
