/* Сторінка учасника: реєстрація (ім'я + компанія) і голосування з телефона. */
(function () {
  "use strict";

  const { api, el, plural, fmt, FORMS, SCALE, scaleItem, segBar, toast, poller } = window.WS;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 3000;

  const state = {
    data: null,
    editing: false,
    optimistic: new Map(), // ideaId -> score|null, поки запит голосування в дорозі
    requestSeq: new Map(), // ideaId -> номер останнього запиту
  };
  const cards = new Map(); // ideaId -> {root, parts}

  const store = {
    get(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* приватний режим */ } },
  };

  // ------------------------------------------------------------------ стан

  function apply(data) {
    if (!data || data.changed === false) return;
    if (state.data && data.version < state.data.version) return; // застаріла відповідь
    state.data = data;
    render();
  }

  async function refresh() {
    const v = state.data ? `?v=${state.data.version}` : "";
    apply(await api("GET", `/api/state${v}`));
  }

  function myVote(ideaId) {
    const key = String(ideaId);
    if (state.optimistic.has(key)) return state.optimistic.get(key);
    const votes = (state.data && state.data.me && state.data.me.votes) || {};
    return key in votes ? votes[key] : null;
  }

  // ------------------------------------------------------------------ рендер

  function render() {
    const d = state.data;
    $("loading").hidden = true;
    $("ws-title").textContent = d.workshop.title;
    document.title = d.workshop.title;
    $("ws-desc").textContent = d.workshop.description;
    $("ws-desc").hidden = !d.workshop.description;

    if (!d.me || state.editing) {
      showJoin(d.me);
    } else {
      $("join").hidden = true;
      $("voting").hidden = false;
    }
    if (d.me) renderVoting(d);
  }

  function showJoin(me) {
    const editing = !!(me && state.editing);
    $("voting").hidden = true;
    $("join").hidden = false;
    $("join-title").textContent = editing ? "Змінити дані" : "Представтеся, будь ласка";
    $("join-lead").textContent = editing
      ? "Виправте ім'я або назву компанії. Ваші оцінки збережуться."
      : "Вкажіть ім'я та компанію — і можна голосувати за ідеї. Реєстрація не потрібна.";
    $("join-submit").textContent = editing ? "Зберегти" : "Почати голосування";
    $("edit-extra").hidden = !editing;
    if (!$("join-form").dataset.filled) {
      $("join-name").value = editing ? me.name : store.get("ws-name");
      $("join-company").value = editing ? me.company : store.get("ws-company");
      $("join-form").dataset.filled = "1";
    }
  }

  function renderVoting(d) {
    const me = d.me;
    $("me-label").textContent = `${me.company} (${me.name})`;
    $("closed-banner").hidden = d.workshop.voting_open;

    const voted = d.ideas.filter((idea) => myVote(idea.id) !== null).length;
    $("progress-text").textContent = `Оцінено ${voted} з ${d.ideas.length}`;
    $("progress-fill").style.width = d.ideas.length ? `${(voted / d.ideas.length) * 100}%` : "0";

    const container = $("ideas");
    const alive = new Set(d.ideas.map((i) => i.id));
    for (const [id, card] of cards) {
      if (!alive.has(id)) {
        card.root.remove();
        cards.delete(id);
      }
    }
    if (!d.ideas.length) {
      if (!container.querySelector(".empty-state")) {
        container.replaceChildren(el("div", { class: "card empty-state", text: "Ведучий ще не додав ідеї. Зачекайте хвилинку." }));
      }
      return;
    }
    const empty = container.querySelector(".empty-state");
    if (empty) empty.remove();

    d.ideas.forEach((idea, index) => {
      let card = cards.get(idea.id);
      if (!card) {
        card = createCard(idea.id);
        cards.set(idea.id, card);
      }
      updateCard(card, idea, d.workshop);
      if (container.children[index] !== card.root) container.insertBefore(card.root, container.children[index] || null);
    });
  }

  function createCard(ideaId) {
    const parts = {};
    parts.title = el("h2");
    parts.desc = el("p", { class: "idea-desc pre-line clamped" });
    parts.more = el("button", { class: "more-btn", type: "button", text: "Детальніше" });
    parts.more.addEventListener("click", () => {
      const clamped = parts.desc.classList.toggle("clamped");
      parts.more.textContent = clamped ? "Детальніше" : "Згорнути";
    });
    parts.effects = el("ul", { class: "effects", "aria-label": "Бізнес-ефекти" });
    parts.row = el("div", { class: "score-row", role: "radiogroup", "aria-label": "Ваша оцінка" });
    parts.buttons = SCALE.map((s) => {
      const button = el(
        "button",
        {
          type: "button",
          class: `score-btn s${s.score}`,
          role: "radio",
          "aria-checked": "false",
          "aria-label": `${s.score} — ${s.label}`,
          title: s.label,
        },
        el("span", { class: "num", text: s.score }),
        el("span", { class: "lbl", text: s.short })
      );
      button.addEventListener("click", () => vote(ideaId, s.score));
      parts.row.append(button);
      return button;
    });
    parts.caption = el("p", { class: "score-caption" });
    parts.resTotal = el("span");
    parts.resAvg = el("span");
    parts.bar = el("div");
    parts.results = el(
      "div",
      { class: "idea-results" },
      el("div", { class: "res-line" }, parts.resTotal, parts.resAvg),
      parts.bar
    );
    const root = el(
      "article",
      { class: "card idea-card", dataset: { id: ideaId } },
      parts.title, parts.desc, parts.more, parts.effects, parts.row, parts.caption, parts.results
    );
    return { root, parts };
  }

  function updateCard(card, idea, workshop) {
    const p = card.parts;
    p.title.textContent = idea.title;
    p.desc.textContent = idea.description;
    p.desc.hidden = !idea.description;
    const long = idea.description.length > 170 || idea.description.split("\n").length > 3;
    p.more.hidden = !long;
    if (!long) p.desc.classList.remove("clamped");

    p.effects.replaceChildren(...idea.effects.map((e) => el("li", { text: e.text })));
    p.effects.hidden = idea.effects.length === 0;

    const score = myVote(idea.id);
    p.buttons.forEach((button, i) => {
      button.setAttribute("aria-checked", String(SCALE[i].score === score));
      button.disabled = !workshop.voting_open;
    });
    p.row.classList.toggle("disabled", !workshop.voting_open);
    p.caption.replaceChildren();
    if (score === null) {
      p.caption.append(workshop.voting_open ? "Оберіть оцінку" : "Без оцінки");
    } else {
      p.caption.append("Ваша оцінка: ", el("b", { text: `${score} — ${scaleItem(score).label}` }));
    }

    const r = idea.results;
    p.results.hidden = !r;
    if (r) {
      p.resTotal.replaceChildren(
        el("b", { text: fmt(r.total) }), ` ${plural(r.total, FORMS.points)} · ${r.votes} ${plural(r.votes, FORMS.votes)}`
      );
      p.resAvg.replaceChildren(r.votes ? "середній " : "", r.votes ? el("b", { text: fmt(r.avg) }) : "");
      segBar(p.bar, r.dist, { tall: false });
    }
  }

  function renderScaleHelp() {
    $("scale-list").replaceChildren(
      ...SCALE.map((s) =>
        el("li", null, el("span", { class: `num-badge seg s${s.score}`, text: s.score }), s.label)
      )
    );
  }

  // ------------------------------------------------------------------ дії

  async function vote(ideaId, score) {
    const d = state.data;
    if (!d || !d.workshop.voting_open) {
      toast("Голосування закрите", "error");
      return;
    }
    const key = String(ideaId);
    const next = myVote(ideaId) === score ? null : score;
    const seq = (state.requestSeq.get(key) || 0) + 1;
    state.requestSeq.set(key, seq);
    state.optimistic.set(key, next);
    render();
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch (e) { /* не підтримується */ }
    }
    try {
      const data = await api("POST", "/api/vote", { idea_id: ideaId, score: next });
      if (state.requestSeq.get(key) === seq) state.optimistic.delete(key);
      apply(data);
      if (state.requestSeq.get(key) === seq) toast(next === null ? "Оцінку знято" : "Збережено ✓");
    } catch (err) {
      if (state.requestSeq.get(key) === seq) state.optimistic.delete(key);
      toast(err.message, "error");
      if (state.data) render();
      if (err.status === 401 || err.status === 404 || err.status === 403) refresh().catch(() => {});
    }
  }

  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("join-name").value.trim();
    const company = $("join-company").value.trim();
    const errorBox = $("join-error");
    if (!name || !company) {
      errorBox.textContent = "Вкажіть, будь ласка, ім'я та компанію";
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;
    const submit = $("join-submit");
    submit.disabled = true;
    try {
      const editing = state.editing && state.data && state.data.me;
      const data = await api(editing ? "PUT" : "POST", editing ? "/api/me" : "/api/join", { name, company });
      store.set("ws-name", name);
      store.set("ws-company", company);
      state.editing = false;
      delete $("join-form").dataset.filled;
      apply(data);
      window.scrollTo({ top: 0 });
      toast(editing ? "Дані оновлено" : "Вітаємо! Можна голосувати");
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  $("me-edit").addEventListener("click", () => {
    state.editing = true;
    delete $("join-form").dataset.filled;
    render();
    $("join-name").focus();
  });

  $("edit-cancel").addEventListener("click", () => {
    state.editing = false;
    delete $("join-form").dataset.filled;
    render();
  });

  $("edit-leave").addEventListener("click", async () => {
    try {
      const data = await api("POST", "/api/leave");
      state.editing = false;
      store.set("ws-name", "");
      store.set("ws-company", "");
      delete $("join-form").dataset.filled;
      cards.forEach((c) => c.root.remove());
      cards.clear();
      apply(data);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // ------------------------------------------------------------------ старт

  renderScaleHelp();
  const poll = poller(refresh, POLL_MS);
  refresh()
    .catch((err) => {
      $("loading").textContent = `${err.message}. Оновіть сторінку.`;
    })
    .finally(() => poll.start());
})();
