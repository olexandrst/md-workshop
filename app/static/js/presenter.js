/* Екран ведучого: живі результати для проєктора + керування ідеями та воркшопом. */
(function () {
  "use strict";

  const { api, el, plural, fmt, FORMS, SCALE, segBar, toast, poller, boot } = window.WS;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 1500;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCORES_DESC = SCALE.map((s) => s.score).sort((a, b) => b - a);

  const store = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* приватний режим */ } },
  };

  const state = {
    data: null,
    sort: store.get("ws-sort", "rank") === "order" ? "order" : "rank",
    present: store.get("ws-present", "0") === "1",
    compact: store.get("ws-compact", "0") === "1",
    totals: new Map(),
    editingIdeaId: null,
  };
  const cards = new Map(); // ideaId -> {root, parts}

  const ICONS = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  function iconButton(icon, label, onClick, extraClass) {
    const button = el("button", { type: "button", class: `icon-btn ${extraClass || ""}`, title: label, "aria-label": label });
    button.innerHTML = ICONS[icon];
    button.addEventListener("click", onClick);
    return button;
  }

  // ------------------------------------------------------------------ дані

  async function call(method, url, body) {
    try {
      const data = await api(method, url, body);
      apply(data);
      return data;
    } catch (err) {
      if (err.status === 401) {
        window.location.href = "/admin/login?next=/admin";
      }
      throw err;
    }
  }

  async function refresh() {
    const v = state.data ? `?v=${state.data.version}` : "";
    await call("GET", `/api/admin/state${v}`);
  }

  function apply(data) {
    if (!data || data.changed === false || !data.workshop) return;
    if (state.data && data.version < state.data.version) return;
    state.data = data;
    render();
  }

  // ------------------------------------------------------------------ рендер

  function render() {
    const d = state.data;
    const ws = d.workshop;
    document.title = `Екран ведучого · ${ws.title}`;
    $("ws-title").textContent = ws.title;
    $("ws-desc").textContent = ws.description;
    $("ws-desc").hidden = !ws.description;

    const pill = $("voting-pill");
    pill.textContent = ws.voting_open ? "Голосування відкрите" : "Голосування закрите";
    pill.className = `pill ${ws.voting_open ? "open" : "closed"}`;
    $("btn-voting").textContent = ws.voting_open ? "Закрити голосування" : "Відкрити голосування";

    const totalVotes = d.ideas.reduce((sum, i) => sum + i.results.votes, 0);
    $("stat-participants").textContent = d.participants_count;
    $("stat-participants-label").textContent = plural(d.participants_count, FORMS.participants);
    $("stat-votes").textContent = totalVotes;
    $("stat-votes-label").textContent = plural(totalVotes, FORMS.ratings);

    const url = d.participant_url || boot.participantUrl || "";
    const shortUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    $("qr-url").textContent = shortUrl;
    $("qr-overlay-url").textContent = shortUrl;
    $("url-warning").hidden = !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(shortUrl);

    $("sort-note").textContent = state.sort === "rank"
      ? "Рейтинг: сума балів, далі середній бал"
      : "Порядок обговорення";

    renderIdeas(d);
    renderSettingsLive(d);
  }

  function renderLegend() {
    $("legend").replaceChildren(
      ...SCALE.map((s) =>
        el("span", { class: "legend-item" }, el("span", { class: `sw s${s.score}` }), el("b", { text: s.score }), s.label)
      )
    );
  }

  function sortedIdeas(d) {
    const ideas = d.ideas.slice();
    if (state.sort === "rank") ideas.sort((a, b) => a.results.rank - b.results.rank);
    return ideas;
  }

  function renderIdeas(d) {
    const container = $("ideas");
    const ideas = sortedIdeas(d);

    // FLIP: запам'ятовуємо позиції до перестановки
    const before = new Map();
    if (!reduceMotion) for (const [id, card] of cards) before.set(id, card.root.getBoundingClientRect().top);

    const alive = new Set(ideas.map((i) => i.id));
    for (const [id, card] of cards) {
      if (!alive.has(id)) {
        card.root.remove();
        cards.delete(id);
        state.totals.delete(id);
      }
    }

    const emptyNode = container.querySelector(".pr-empty");
    if (!ideas.length) {
      if (!emptyNode) {
        container.replaceChildren(
          el("div", { class: "pr-empty" }, "Ідей поки немає. ", el("span", { class: "admin-only", text: "Натисніть «Нова ідея», щоб додати першу." }))
        );
      }
      return;
    }
    if (emptyNode) emptyNode.remove();

    const ids = d.ideas.map((i) => i.id); // порядок обговорення
    ideas.forEach((idea, index) => {
      let card = cards.get(idea.id);
      if (!card) {
        card = createCard(idea.id);
        cards.set(idea.id, card);
      }
      updateCard(card, idea, index, ids, d.workshop);
      if (container.children[index] !== card.root) container.insertBefore(card.root, container.children[index] || null);
    });

    if (!reduceMotion) {
      for (const [id, card] of cards) {
        const top = before.get(id);
        if (top === undefined) continue;
        const dy = top - card.root.getBoundingClientRect().top;
        if (Math.abs(dy) < 2) continue;
        card.root.style.transition = "none";
        card.root.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            card.root.style.transition = "transform 650ms cubic-bezier(.2,.8,.2,1)";
            card.root.style.transform = "";
          });
        });
      }
    }
  }

  function createCard(ideaId) {
    const p = {};
    p.rank = el("div", { class: "pr-rank" });
    p.title = el("h2");
    p.desc = el("p", { class: "pr-idea-desc pre-line" });
    p.effects = el("ul", { class: "effects", "aria-label": "Бізнес-ефекти" });
    p.up = iconButton("up", "Вище", () => moveIdea(ideaId, -1));
    p.down = iconButton("down", "Нижче", () => moveIdea(ideaId, 1));
    p.actions = el(
      "div",
      { class: "pr-actions admin-only" },
      p.up,
      p.down,
      iconButton("edit", "Редагувати", () => openIdeaModal(ideaId)),
      iconButton("trash", "Видалити", () => deleteIdea(ideaId), "danger")
    );
    p.total = el("span", { class: "pr-total" });
    p.unit = el("span", { class: "pr-total-unit" });
    p.meta = el("span", { class: "pr-meta" });
    p.bar = el("div");
    p.voters = el("div", { class: "voters" });
    const root = el(
      "article",
      { class: "pr-idea", dataset: { id: ideaId } },
      p.rank,
      el("div", { class: "pr-info" }, p.title, p.desc, p.effects, p.actions),
      el(
        "div",
        { class: "pr-results" },
        el("div", { class: "pr-scoreline" }, el("span", null, p.total, p.unit), p.meta),
        p.bar,
        p.voters
      )
    );
    root.addEventListener("animationend", () => root.classList.remove("bump"));
    return { root, parts: p };
  }

  function updateCard(card, idea, index, orderIds, ws) {
    const p = card.parts;
    const r = idea.results;
    const position = orderIds.indexOf(idea.id);

    p.rank.textContent = state.sort === "rank" ? r.rank : position + 1;
    p.rank.title = state.sort === "rank" ? `Місце в рейтингу: ${r.rank}` : `Порядок: ${position + 1}`;
    card.root.classList.toggle("top", state.sort === "rank" && r.rank === 1 && r.total > 0);

    p.title.textContent = idea.title;
    p.desc.textContent = idea.description;
    p.desc.hidden = !idea.description;
    p.effects.replaceChildren(...idea.effects.map((e) => el("li", { text: e.text })));
    p.effects.hidden = idea.effects.length === 0;

    const canMove = state.sort === "order";
    p.up.hidden = !canMove;
    p.down.hidden = !canMove;
    p.up.disabled = position === 0;
    p.down.disabled = position === orderIds.length - 1;

    p.total.textContent = fmt(r.total);
    p.unit.textContent = plural(r.total, FORMS.points);
    p.meta.replaceChildren(
      el("b", { text: r.votes }), ` ${plural(r.votes, FORMS.votes)}`,
      r.votes ? " · середній " : "", r.votes ? el("b", { text: fmt(r.avg) }) : ""
    );
    segBar(p.bar, r.dist, { tall: true });
    renderVoters(p.voters, r, ws.show_names);

    const previous = state.totals.get(idea.id);
    if (previous !== undefined && previous !== r.total) {
      card.root.classList.remove("bump");
      void card.root.offsetWidth; // перезапуск анімації
      card.root.classList.add("bump");
    }
    state.totals.set(idea.id, r.total);
  }

  /** Текстова деталізація: хто як голосував (або лише кількість, якщо імена вимкнено). */
  function renderVoters(container, r, showNames) {
    const rows = [];
    for (const score of SCORES_DESC) {
      const count = r.dist[score];
      if (!count) continue;
      const s = SCALE.find((x) => x.score === score);
      const head = el("span", { class: "vr-head" }, el("span", { class: `sw s${score}` }), `${score} · ${s.short} — ${count}`);
      const names = showNames
        ? r.voters[score].map((v) => `${v.company} (${v.name})`).join(", ")
        : "";
      rows.push(el("div", { class: "voter-row", title: s.label }, head, el("span", { class: "vr-names", text: names })));
    }
    container.replaceChildren(...rows);
    container.hidden = rows.length === 0;
  }

  // ------------------------------------------------------------------ дії з ідеями

  function findIdea(id) {
    return state.data && state.data.ideas.find((i) => i.id === id);
  }

  async function moveIdea(id, delta) {
    const ids = state.data.ideas.map((i) => i.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    try {
      await call("POST", "/api/admin/ideas/reorder", { ids });
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function deleteIdea(id) {
    const idea = findIdea(id);
    if (!idea) return;
    const votes = idea.results.votes;
    const warning = votes ? `\n\nРазом з нею буде видалено ${votes} ${plural(votes, FORMS.votes)}.` : "";
    if (!window.confirm(`Видалити ідею «${idea.title}»?${warning}`)) return;
    try {
      await call("DELETE", `/api/admin/ideas/${id}`);
      toast("Ідею видалено");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function effectRow(text) {
    const input = el("input", { class: "input", maxlength: "300", placeholder: "Наприклад, скорочення витрат на логістику" });
    input.value = text || "";
    const row = el("div", { class: "effect-row" }, input);
    row.append(iconButton("x", "Прибрати ефект", () => row.remove(), "danger"));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const next = effectRow("");
        row.after(next);
        next.querySelector("input").focus();
      }
    });
    return row;
  }

  function openIdeaModal(id) {
    const idea = id ? findIdea(id) : null;
    state.editingIdeaId = idea ? idea.id : null;
    $("idea-modal-title").textContent = idea ? "Редагувати ідею" : "Нова ідея";
    $("idea-title").value = idea ? idea.title : "";
    $("idea-description").value = idea ? idea.description : "";
    const effects = idea ? idea.effects.map((e) => e.text) : [""];
    $("effects-editor").replaceChildren(...(effects.length ? effects : [""]).map(effectRow));
    $("idea-error").hidden = true;
    $("idea-modal").showModal();
    $("idea-title").focus();
  }

  $("idea-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      title: $("idea-title").value,
      description: $("idea-description").value,
      effects: [...$("effects-editor").querySelectorAll("input")].map((i) => i.value).filter((v) => v.trim()),
    };
    if (!payload.title.trim()) {
      $("idea-error").textContent = "Вкажіть назву ідеї";
      $("idea-error").hidden = false;
      return;
    }
    const button = $("idea-save");
    button.disabled = true;
    try {
      const id = state.editingIdeaId;
      if (id) await call("PUT", `/api/admin/ideas/${id}`, payload);
      else await call("POST", "/api/admin/ideas", payload);
      $("idea-modal").close();
      toast(id ? "Ідею оновлено" : "Ідею додано");
    } catch (err) {
      $("idea-error").textContent = err.message;
      $("idea-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  $("effect-add").addEventListener("click", () => {
    const row = effectRow("");
    $("effects-editor").append(row);
    row.querySelector("input").focus();
  });

  // ------------------------------------------------------------------ налаштування

  function openSettings() {
    const ws = state.data.workshop;
    $("ws-title-input").value = ws.title;
    $("ws-desc-input").value = ws.description;
    $("workshop-error").hidden = true;
    $("settings-modal").showModal();
    renderSettingsLive(state.data);
  }

  function renderSettingsLive(d) {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      input.checked = !!d.workshop[input.dataset.setting];
    });
    if (!$("settings-modal").open) return;
    $("participants-total").textContent = `(${d.participants.length})`;
    const rows = d.participants.map((p) =>
      el(
        "tr",
        null,
        el("td", { text: p.company }),
        el("td", { text: p.name }),
        el("td", { class: "num", text: p.votes_count }),
        el("td", { class: "num" }, iconButton("trash", "Видалити учасника", () => deleteParticipant(p), "danger"))
      )
    );
    if (!rows.length) rows.push(el("tr", null, el("td", { colspan: "4", class: "muted", text: "Поки нікого немає" })));
    $("participants-body").replaceChildren(...rows);
  }

  async function updateWorkshop(patch, successMessage) {
    try {
      await call("PUT", "/api/admin/workshop", patch);
      if (successMessage) toast(successMessage);
      return true;
    } catch (err) {
      toast(err.message, "error");
      if (state.data) render();
      return false;
    }
  }

  $("workshop-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await call("PUT", "/api/admin/workshop", {
        title: $("ws-title-input").value,
        description: $("ws-desc-input").value,
      });
      $("workshop-error").hidden = true;
      toast("Збережено");
    } catch (err) {
      $("workshop-error").textContent = err.message;
      $("workshop-error").hidden = false;
    }
  });

  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("change", () => updateWorkshop({ [input.dataset.setting]: input.checked }, "Збережено"));
  });

  async function deleteParticipant(p) {
    const votes = p.votes_count ? ` та ${p.votes_count} ${plural(p.votes_count, FORMS.ratings)}` : "";
    if (!window.confirm(`Видалити учасника «${p.company} (${p.name})»${votes}?`)) return;
    try {
      await call("DELETE", `/api/admin/participants/${p.id}`);
      toast("Учасника видалено");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("btn-reset-votes").addEventListener("click", async () => {
    if (!window.confirm("Обнулити ВСІ голоси? Учасники та ідеї залишаться. Дію не можна скасувати.")) return;
    try {
      await call("POST", "/api/admin/reset-votes");
      toast("Голоси обнулено");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("btn-delete-participants").addEventListener("click", async () => {
    if (!window.confirm("Видалити ВСІХ учасників разом з їхніми голосами? Ідеї залишаться. Дію не можна скасувати.")) return;
    try {
      await call("POST", "/api/admin/delete-participants");
      toast("Учасників видалено");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // ------------------------------------------------------------------ режими екрана

  function applyModes() {
    document.body.classList.toggle("present-mode", state.present);
    document.body.classList.toggle("admin-mode", !state.present);
    document.body.classList.toggle("compact", state.compact);
    $("present-exit").hidden = !state.present;
    $("btn-compact").setAttribute("aria-pressed", String(state.compact));
    $("btn-compact").textContent = state.compact ? "Детально" : "Компактно";
    document.querySelectorAll("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
  }

  function togglePresent() {
    state.present = !state.present;
    store.set("ws-present", state.present ? "1" : "0");
    applyModes();
    refitSoon();
  }

  function refitSoon() {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    store.set("ws-theme", next);
  }

  function showQr(show) {
    $("qr-overlay").hidden = !show;
  }

  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sort = button.dataset.sort;
      store.set("ws-sort", state.sort);
      applyModes();
      if (state.data) render();
    });
  });
  $("btn-add").addEventListener("click", () => openIdeaModal(null));
  $("btn-voting").addEventListener("click", () => {
    const open = !state.data.workshop.voting_open;
    updateWorkshop({ voting_open: open }, open ? "Голосування відкрито" : "Голосування закрито");
  });
  $("btn-compact").addEventListener("click", () => {
    state.compact = !state.compact;
    store.set("ws-compact", state.compact ? "1" : "0");
    applyModes();
    refitSoon();
  });
  $("btn-settings").addEventListener("click", openSettings);
  $("ws-title").addEventListener("click", () => { if (!state.present && state.data) openSettings(); });
  $("ws-desc").addEventListener("click", () => { if (!state.present && state.data) openSettings(); });
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-present").addEventListener("click", togglePresent);
  $("present-exit").addEventListener("click", togglePresent);
  $("qr-open").addEventListener("click", () => showQr(true));
  $("qr-overlay").addEventListener("click", () => showQr(false));

  document.querySelectorAll("dialog [data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("qr-overlay").hidden) {
      showQr(false);
      return;
    }
    const target = event.target;
    const typing = target.closest && target.closest("input, textarea, select, dialog");
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "p" || key === "з") togglePresent();
    else if (key === "f" || key === "а") toggleFullscreen();
    else if (key === "q" || key === "й") showQr($("qr-overlay").hidden);
  });

  // ------------------------------------------------------------------ старт

  renderLegend();
  applyModes();
  const poll = poller(refresh, POLL_MS);
  refresh()
    .catch((err) => toast(err.message, "error"))
    .finally(() => poll.start());
})();
