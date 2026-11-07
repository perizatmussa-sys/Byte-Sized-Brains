"use strict";

// Этап 5. Апелляции и пересмотр. Отдельный файл, не вмешивается в AI-логику.
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
    item.scrollIntoView({behavior:"smooth",block:"center"});
    item.classList.add("flash");
    setTimeout(() => item.classList.remove("flash"), 1500);
  }

  function proofButton(index, label) {
    const btn = el("button", label || `Показать реплику #${index + 1}`, "appeal-link");
    btn.type = "button";
    btn.addEventListener("click", () => jumpTo(index));
    return btn;
  }

  function valueLabel(value) {
    if (value === "yes") return "Да";
    if (value === "no") return "Нет";
    if (value === "na") return "N/A";
    return String(value);
  }

  function selectControl(options) {
    const select = el("select");
    for (const [value, label] of options) {
      const option = el("option", label);
      option.value = value;
      select.append(option);
    }
    return select;
  }

  function sourceLabel(s) {
    return ({manual:"Ручная", groq:"GroqCloud", gemini:"Google Gemini"})[s] || s;
  }

  function scoreLabel(score) {
    return score == null ? "не рассчитывается" : `${Number(score).toFixed(2)} / 100`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ru-RU");
  }

  function sourceResults(all) {
    const out = {};
    if (all.manual) out.manual = all.manual;
    if (all.groq) out.groq = all.groq;
    if (all.gemini) out.gemini = all.gemini;
    return out;
  }

  async function getAvailableResults(conversationId) {
    const urls = [
      `/api/evaluations/${encodeURIComponent(conversationId)}`,
      `/api/ai/evaluations/${encodeURIComponent(conversationId)}`
    ];
    const result = {};
    const responses = await Promise.all(urls.map(async url => {
      try { return await api(url); }
      catch (err) { if (err.message.includes("ещё не оценён")) return null; throw err; }
    }));
    if (responses[0]) result.manual = responses[0];
    if (responses[1]) {
      if (responses[1].groq) result.groq = responses[1].groq;
      if (responses[1].gemini) result.gemini = responses[1].gemini;
    }
    return sourceResults(result);
  }

  function buildNewAppealForm(results, conversationId) {
    const card = el("div", "", "appeals-box");
    card.append(el("h3", "1. Подать апелляцию (пользователь)"));
    const available = Object.keys(results);
    if (!available.length) {
      card.append(el("p", "Сначала оцените этот диалог вручную или с AI. Затем здесь можно оспорить критерий.", "muted"));
      return card;
    }
    const form = el("form", "", "appeals-form");
    const sourceLabelEl = el("label", "Источник оценки:", "appeal-field");
    const source = selectControl(available.map(key => [key, sourceLabel(key)]));
    sourceLabelEl.append(source);
    const criterionLabel = el("label", "Какой критерий оспариваем:", "appeal-field");
    const criterionSelect = selectControl([]);
    criterionLabel.append(criterionSelect);
    const details = el("p", "", "appeals-hint");
    const proof = el("div");
    const commentLabel = el("label", "Почему вы не согласны с оценкой?", "appeal-field");
    const comment = el("textarea");
    comment.rows = 3;
    comment.placeholder = "Например: оператор назвал следующий шаг в сообщении №5, а AI этого не заметил";
    comment.required = true;
    comment.maxLength = 2000;
    commentLabel.append(comment);
    const send = el("button", "Подать апелляцию", "primary");
    send.type = "submit";
    const message = el("p", "", "appeal-inline-msg");

    function updateProof() {
      const current = results[source.value];
      const row = current?.criteria?.find(r => r.id === criterionSelect.value);
      proof.replaceChildren();
      if (!row) return;
      details.textContent = `Оценка: ${valueLabel(row.value)} · исходный итог: ${scoreLabel(current.score)}. ${row.reason}`;
      if (Number.isInteger(row.evidence_index)) proof.append(proofButton(row.evidence_index, `Исходное доказательство — реплика #${row.evidence_index + 1}`));
    }
    function updateCriteria() {
      criterionSelect.replaceChildren();
      const rows = results[source.value]?.criteria || [];
      for (const row of rows) {
        const opt = el("option", row.name);
        opt.value = row.id;
        criterionSelect.append(opt);
      }
      updateProof();
    }
    source.addEventListener("change", updateCriteria);
    criterionSelect.addEventListener("change", updateProof);
    updateCriteria();

    form.append(sourceLabelEl, criterionLabel, details, proof, commentLabel, send, message);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (selectedId !== conversationId) return;
      send.disabled = true;
      message.textContent = "Сохраняем обращение...";
      try {
        await api("/api/appeals", {method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({conversation_id: conversationId, source: source.value,
            criterion_id: criterionSelect.value, comment: comment.value.trim()})});
        await refresh(conversationId);
      } catch (err) {message.textContent = `Ошибка: ${err.message}`;}
      finally {send.disabled = false;}
    });
    card.append(form);
    return card;
  }

  function getCriterionConfig(appeal) {
    return (appeal.checklist_snapshot?.criteria || []).find(c => c.id === appeal.criterion_id);
  }

  function buildDecisionForm(appeal, conversationId) {
    const form = el("form", "", "appeals-form reviewer-form");
    const decisionLabel = el("label", "Решение проверяющего:", "appeal-field");
    const action = selectControl([["confirm", "Подтвердить исходную оценку"], ["change", "Изменить оценку"]]);
    decisionLabel.append(action);
    form.append(decisionLabel);

    const criterion = getCriterionConfig(appeal);
    const gradeLabel = el("label", "Новая оценка:", "appeal-field");
    const options = [];
    if (criterion?.type === "scale") {
      for (const v of criterion.scale) options.push([String(v), String(v)]);
    } else {
      options.push(["yes", "Да"], ["no", "Нет"]);
    }
    if (criterion?.allow_na) options.push(["na", "N/A"]);
    const grade = selectControl(options);
    const originalValue = appeal.original_result.criteria.find(c => c.id === appeal.criterion_id)?.value;
    grade.value = String(originalValue);
    gradeLabel.append(grade);

    const evidenceLabel = el("label", "Реплика для новой оценки (номер с нуля):", "appeal-field");
    const evidence = el("input");
    evidence.type = "number";
    evidence.min = "0";
    evidence.step = "1";
    const oldIndex = appeal.original_result.criteria.find(c => c.id === appeal.criterion_id)?.evidence_index;
    evidence.value = String(oldIndex ?? 0);
    evidenceLabel.append(evidence);

    const reasonLabel = el("label", "Причина решения (обязательно):", "appeal-field");
    const reason = el("textarea");
    reason.required = true;
    reason.maxLength = 2000;
    reason.placeholder = "Например: просмотрел реплику №4, AI не учёл уточнение оператора";
    reasonLabel.append(reason);
    const submit = el("button", "Сохранить решение проверяющего", "primary");
    submit.type = "submit";
    const message = el("p", "", "appeal-inline-msg");
    const showChange = () => {gradeLabel.hidden = action.value !== "change"; evidenceLabel.hidden = action.value !== "change";};
    action.addEventListener("change", showChange);
    showChange();
    form.append(gradeLabel, evidenceLabel, reasonLabel, submit, message);

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (selectedId !== conversationId) return;
      const changed = action.value === "change";
      const rawValue = grade.value;
      const newValue = criterion?.type === "scale" && rawValue !== "na" ? Number(rawValue) : rawValue;
      const answer = {action:action.value, reason:reason.value.trim()};
      if (changed) {answer.new_value=newValue; answer.evidence_index=Number(evidence.value);}
      submit.disabled = true;
      message.textContent = "Сохраняем итог...";
      try {
        await api(`/api/appeals/${encodeURIComponent(appeal.id)}/decision`, {
          method:"POST",headers:{"Content-Type":"application/json"}, body:JSON.stringify(answer)});
        await refresh(conversationId);
      } catch(err) {message.textContent=`Ошибка: ${err.message}`;}
      finally {submit.disabled = false;}
    });
    return form;
  }

  function buildAppealCard(appeal, conversationId) {
    const card = el("div", "", "appeal-entry");
    const resolved = appeal.status === "resolved";
    const header = el("div", "", "appeal-entry-head");
    header.append(el("strong", `${sourceLabel(appeal.source)} · ${appeal.criterion_name}`));
    header.append(el("span", resolved ? "Решено" : "Ожидает решения", resolved ? "appeal-state resolved" : "appeal-state pending"));
    card.append(header);
    card.append(el("p", `Создано: ${formatDate(appeal.created_at)}`, "muted small"));
    card.append(el("p", `Комментарий пользователя: ${appeal.comment}`));
    const old = appeal.original_result.criteria.find(c => c.id === appeal.criterion_id);
    if (old) {
      card.append(el("p", `Первоначальная оценка: ${valueLabel(old.value)} · итог ${scoreLabel(appeal.original_score)}`, "small"));
      if (Number.isInteger(old.evidence_index)) card.append(proofButton(old.evidence_index, `Показать доказательство (#${old.evidence_index + 1})`));
    }
    if (resolved) {
      const d = appeal.decision;
      card.append(el("p", `Решение проверяющего: ${d.action === "confirm" ? "Подтвердить" : "Изменить на " + valueLabel(d.new_value)}. Причина: ${d.reason}`));
      card.append(el("strong", `Итог после пересмотра: ${scoreLabel(appeal.final_score)}`, "appeal-final"));
      if (d.action === "change" && Number.isInteger(d.evidence_index)) card.append(proofButton(d.evidence_index, `Доказательство проверяющего (#${d.evidence_index + 1})`));
    } else {
      card.append(el("h4", "2. Решение проверяющего"));
      card.append(buildDecisionForm(appeal, conversationId));
    }
    return card;
  }

  async function refresh(conversationId) {
    if (!conversationId) return;
    selectedId = conversationId;
    panel.replaceChildren();
    panel.append(el("h2", "Апелляции и пересмотр"));
    panel.append(el("p", "Здесь можно оспорить конкретный критерий. Проверяющий подтверждает или меняет оценку и указывает причину. Вход не нужен — это демо хакатона.", "muted small"));
    const loading = el("p", "Загружаем оценки и обращения...", "muted");
    panel.append(loading);
    try {
      const [results, appeals] = await Promise.all([
        getAvailableResults(conversationId),
        api(`/api/appeals?conversation_id=${encodeURIComponent(conversationId)}`),
      ]);
      if (selectedId !== conversationId) return;
      loading.remove();
      panel.append(buildNewAppealForm(results, conversationId));
      const history = el("div", "", "appeal-history");
      history.append(el("h3", `История обращений (${appeals.length})`));
      if (!appeals.length) history.append(el("p", "Пока нет апелляций для этого диалога.", "muted"));
      for (const appeal of appeals) history.append(buildAppealCard(appeal, conversationId));
      panel.append(history);
    } catch(err) {
      if (selectedId === conversationId) loading.textContent = `Не удалось загрузить апелляции: ${err.message}`;
    }
  }

  document.addEventListener("cqa:conversation-opened", event => refresh(event.detail.conversationId));
  document.addEventListener("cqa:assessment-changed", event => {
    if (event.detail.conversationId === selectedId) refresh(selectedId);
  });
})();
