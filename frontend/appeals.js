"use strict";

// Апелляции в карточке диалога: подача обращения по ОДНОМУ ИЛИ НЕСКОЛЬКИМ критериям
// и история обращений. Решение проверяющего принимается на отдельной странице
// «Карточка апелляции» (см. app.js → openCase).
(() => {
  const panel = document.getElementById("appeals-panel");
  if (!panel) return;
  let selectedId = null;

  function el(tag, text = "", className = "") {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    let json;
    try { json = await response.json(); }
    catch { throw new Error(`HTTP ${response.status}: некорректный ответ сервера`); }
    if (!response.ok) throw new Error(typeof json.detail === "string" ? json.detail : `HTTP ${response.status}`);
    return json;
  }

  function jumpTo(index) {
    const item = document.getElementById(`msg-${index}`);
    if (!item) return;
    item.scrollIntoView({behavior: "smooth", block: "center"});
    item.classList.add("flash");
    setTimeout(() => item.classList.remove("flash"), 1500);
  }

  const valueLabel = (v) => v === "yes" ? "Да" : v === "no" ? "Нет" : v === "na" ? "N/A" : v == null ? "—" : String(v);
  const sourceLabel = (s) => ({manual: "Ручная", groq: "GroqCloud", gemini: "Google Gemini"})[s] || s;
  const scoreLabel = (s) => s == null ? "—" : `${Number(s).toFixed(2)} / 100`;
  const formatDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ru-RU"); };

  async function getAvailableResults(conversationId) {
    const out = {};
    const [manual, ai] = await Promise.all([
      `/api/evaluations/${encodeURIComponent(conversationId)}`,
      `/api/ai/evaluations/${encodeURIComponent(conversationId)}`,
    ].map(async url => {
      try { return await api(url); }
      catch (err) { if (err.message.includes("ещё не оценён")) return null; throw err; }
    }));
    if (manual) out.manual = manual;
    if (ai?.groq) out.groq = ai.groq;
    if (ai?.gemini) out.gemini = ai.gemini;
    return out;
  }

  function buildForm(results, conversationId, openCriteria) {
    const card = el("div", "", "appeals-box");
    card.append(el("h3", "Подать апелляцию"));
    const sources = Object.keys(results);
    if (!sources.length) {
      card.append(el("p", "Сначала оцените этот диалог вручную или с AI — затем здесь можно оспорить один или несколько критериев.", "muted small"));
      return card;
    }
    const form = el("form", "", "appeals-form");
    const sourceField = el("label", "", "appeal-field");
    sourceField.append(el("span", "Какую оценку оспариваем"));
    const source = el("select");
    for (const key of sources) source.append(new Option(`${sourceLabel(key)} · ${scoreLabel(results[key].score)}`, key));
    sourceField.append(source);

    const pick = el("fieldset", "", "appeal-pick");
    pick.append(el("legend", "Критерии (можно выбрать несколько)"));
    const rows = el("div", "", "appeal-rows");
    pick.append(rows);

    const generalField = el("label", "", "appeal-field");
    generalField.append(el("span", "Общий комментарий (используется для критериев без своего комментария)"));
    const general = el("textarea");
    general.rows = 2; general.maxLength = 2000;
    general.placeholder = "Например: оператор поздоровался и попрощался, AI этого не учёл";
    generalField.append(general);

    const message = el("p", "", "appeal-inline-msg");
    const send = el("button", "Подать апелляцию", "primary");
    send.type = "submit";
    form.append(sourceField, pick, generalField, message, send);
    card.append(form);

    let controls = [];
    function renderRows() {
      rows.replaceChildren();
      controls = [];
      const result = results[source.value];
      const busy = openCriteria[source.value] || new Set();
      for (const row of result.criteria || []) {
        const line = el("div", "", "appeal-row");
        const label = el("label", "", "appeal-check");
        const box = el("input"); box.type = "checkbox";
        const name = el("span", row.name, "appeal-crit");
        const value = el("span", valueLabel(row.value), "appeal-val");
        label.append(box, name, value);
        line.append(label);
        if (busy.has(row.id)) {
          box.disabled = true;
          line.append(el("span", "уже на рассмотрении", "appeal-busy"));
        }
        if (Number.isInteger(row.evidence_index)) {
          const proof = el("button", `#${row.evidence_index + 1}`, "appeal-link");
          proof.type = "button"; proof.title = "Показать реплику-доказательство";
          proof.addEventListener("click", () => jumpTo(row.evidence_index));
          line.append(proof);
        }
        const comment = el("textarea", "", "appeal-comment");
        comment.rows = 2; comment.maxLength = 2000; comment.hidden = true;
        comment.placeholder = `Почему вы не согласны с оценкой «${row.name}»?`;
        box.addEventListener("change", () => { comment.hidden = !box.checked; line.classList.toggle("on", box.checked); if (box.checked) comment.focus(); });
        line.append(comment);
        rows.append(line);
        controls.push({row, box, comment});
      }
    }
    source.addEventListener("change", renderRows);
    renderRows();

    form.addEventListener("submit", async event => {
      event.preventDefault();
      message.textContent = "";
      const picked = controls.filter(c => c.box.checked);
      if (!picked.length) { message.textContent = "Отметьте хотя бы один критерий."; return; }
      const missing = picked.find(c => c.comment.value.trim().length < 3 && general.value.trim().length < 3);
      if (missing) { message.textContent = `Добавьте комментарий к «${missing.row.name}» или общий комментарий.`; missing.comment.focus(); return; }
      send.disabled = true;
      send.textContent = "Сохраняем...";
      try {
        await api("/api/appeals", {method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({conversation_id: conversationId, source: source.value, comment: general.value.trim(),
            items: picked.map(c => ({criterion_id: c.row.id, comment: c.comment.value.trim()}))})});
        await refresh(conversationId);
        document.dispatchEvent(new CustomEvent("cqa:appeals-changed", {detail: {conversationId}}));
      } catch (err) { message.textContent = `Ошибка: ${err.message}`; }
      finally { send.disabled = false; send.textContent = "Подать апелляцию"; }
    });
    return card;
  }

  function historyCard(appeal) {
    const resolved = appeal.status === "resolved";
    const card = el("article", "", "appeal-entry");
    const head = el("div", "", "appeal-entry-head");
    head.append(el("strong", `${sourceLabel(appeal.source)} · ${appeal.items.length} ${appeal.items.length === 1 ? "критерий" : appeal.items.length < 5 ? "критерия" : "критериев"}`),
      el("span", resolved ? "Решена" : "Ожидает решения", `appeal-state ${resolved ? "resolved" : "pending"}`));
    card.append(head);
    card.append(el("p", `Создано: ${formatDate(appeal.created_at)}`, "muted small"));
    const list = el("ul", "", "appeal-items");
    for (const item of appeal.items) {
      const li = el("li");
      const d = item.decision;
      const after = d ? (d.action === "change" ? ` → ${valueLabel(d.new_value)}` : " · подтверждено") : "";
      li.append(el("strong", item.criterion_name || item.criterion_id), el("span", ` ${valueLabel(item.original_value ?? d?.old_value)}${after}`, "muted"));
      if (item.comment) li.append(el("p", `«${item.comment}»`, "small"));
      list.append(li);
    }
    card.append(list);
    card.append(el("p", resolved ? `Итог: ${scoreLabel(appeal.original_score)} → ${scoreLabel(appeal.final_score)}` : `Исходный итог: ${scoreLabel(appeal.original_score)}`, resolved ? "appeal-final" : "small"));
    const open = el("button", resolved ? "Открыть карточку" : "Рассмотреть (проверяющий)", resolved ? "secondary" : "primary");
    open.type = "button";
    open.addEventListener("click", () => document.dispatchEvent(new CustomEvent("cqa:open-case", {detail: {id: appeal.id}})));
    card.append(open);
    return card;
  }

  async function refresh(conversationId) {
    if (!conversationId) return;
    selectedId = conversationId;
    panel.replaceChildren();
    panel.append(el("h2", "Апелляции"));
    panel.append(el("p", "Оспорьте один или несколько критериев одним обращением. Проверяющий рассматривает его на отдельной странице.", "muted small"));
    const loading = el("p", "Загружаем оценки и обращения...", "muted small");
    panel.append(loading);
    try {
      const [results, appeals] = await Promise.all([
        getAvailableResults(conversationId),
        api(`/api/appeals?conversation_id=${encodeURIComponent(conversationId)}`),
      ]);
      if (selectedId !== conversationId) return;
      loading.remove();
      // Критерии, по которым уже есть открытая апелляция к той же оценке.
      const openCriteria = {};
      for (const a of appeals) {
        if (a.status !== "pending") continue;
        const base = results[a.source];
        if (!base || base.created_at !== a.base_created_at) continue;
        openCriteria[a.source] ??= new Set();
        a.items.forEach(i => openCriteria[a.source].add(i.criterion_id));
      }
      panel.append(buildForm(results, conversationId, openCriteria));
      const history = el("div", "", "appeal-history");
      history.append(el("h3", `История обращений (${appeals.length})`));
      if (!appeals.length) history.append(el("p", "Пока нет апелляций для этого диалога.", "muted small"));
      for (const appeal of appeals) history.append(historyCard(appeal));
      panel.append(history);
    } catch (err) {
      if (selectedId === conversationId) loading.textContent = `Не удалось загрузить апелляции: ${err.message}`;
    }
  }

  document.addEventListener("cqa:conversation-opened", event => refresh(event.detail.conversationId));
  document.addEventListener("cqa:assessment-changed", event => {
    if (event.detail.conversationId === selectedId) refresh(selectedId);
  });
  document.addEventListener("cqa:appeals-changed", event => {
    if (event.detail?.conversationId === selectedId && event.detail?.fromCase) refresh(selectedId);
  });
})();
