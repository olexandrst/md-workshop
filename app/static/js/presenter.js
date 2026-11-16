/* Екран ведучого: плитки з живими результатами для проєктора + керування ідеями та воркшопом. */
(function () {
  "use strict";

  const { api, el, plural, fmt, FORMS, SCALE, toast, poller, boot, stars, setStars, isNewIdea, EFFECT_CATALOG, effectMeta, effectIcon, effectItem } = window.WS;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 1500;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCORES_DESC = SCALE.map((s) => s.score).sort((a, b) => b - a); // 5, 3, 2, 1, 0
  const scaleOf = (score) => SCALE.find((s) => s.score === score);

  const store = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* приватний режим */ } },
  };

  const state = {
    data: null,
    sort: store.get("ws-sort-v2", "order") === "rank" ? "rank" : "order",
    present: store.get("ws-present", "0") === "1",
    totals: new Map(),
    editingIdeaId: null,
    spotlightId: null,
  };
  const tiles = new Map(); // ideaId -> {root, parts}

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
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // не відкривати spotlight при кліку на кнопку плитки
      onClick();
    });
    return button;
  }

  // ------------------------------------------------------------------ дані

  async function call(method, url, body) {
    try {
      const data = await api(method, url, body);
      apply(data);
      return data;
    } catch (err) {
      if (err.status === 401) window.location.href = "/admin/login?next=/admin";
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
    window.WS.setTitle($("ws-title"), ws.title);
    $("ws-desc").textContent = ws.description;
    $("ws-desc").classList.toggle("is-empty", !ws.description);

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

    renderTiles(d);
    renderSpotlight();
    renderSettingsLive(d);
    syncLayout();
  }

  /** Шкала оцінок на сторінці QR-коду: «★★★★★ 5 — Готові пілотувати» тощо. */
  function renderLegend() {
    $("qr-scale").replaceChildren(
      ...SCORES_DESC.map((score) =>
        el(
          "li",
          { class: `qro-item s${score}` },
          el("span", { class: "qro-num", text: score }),
          score ? stars(score, "qro") : el("span", { class: "qro-zero", text: "без зірок" }),
          el("span", { class: "qro-label", text: scaleOf(score).label })
        )
      )
    );
  }

  function sortedIdeas(d) {
    const ideas = d.ideas.slice(); // сервер віддає «за порядком»: нові зверху
    if (state.sort === "rank") ideas.sort((a, b) => a.results.rank - b.results.rank);
    return ideas;
  }

  function medalClass(r) {
    return r.votes > 0 && r.rank <= 3 ? `medal-${r.rank}` : "";
  }

  function renderTiles(d) {
    const container = $("ideas");
    const ideas = sortedIdeas(d);

    // FLIP: позиції плиток до перестановки
    const before = new Map();
    if (!reduceMotion) for (const [id, tile] of tiles) before.set(id, tile.root.getBoundingClientRect());

    const alive = new Set(ideas.map((i) => i.id));
    for (const [id, tile] of tiles) {
      if (!alive.has(id)) {
        tile.root.remove();
        tiles.delete(id);
        state.totals.delete(id);
      }
    }

    const emptyNode = container.querySelector(".tiles-empty");
    if (!ideas.length) {
      if (!emptyNode) {
        container.replaceChildren(
          el("div", { class: "tiles-empty" }, "Ідей поки немає. ",
            el("span", { class: "admin-only", text: "Натисніть «+ Ідея», щоб додати першу." }))
        );
      }
      return;
    }
    if (emptyNode) emptyNode.remove();

    const orderIds = d.ideas.map((i) => i.id);
    ideas.forEach((idea, index) => {
      let tile = tiles.get(idea.id);
      if (!tile) {
        tile = createTile(idea.id);
        tiles.set(idea.id, tile);
      }
      updateTile(tile, idea, orderIds, d);
      if (container.children[index] !== tile.root) container.insertBefore(tile.root, container.children[index] || null);
    });

    if (!reduceMotion) {
      for (const [id, tile] of tiles) {
        const prev = before.get(id);
        if (!prev) continue;
        const now = tile.root.getBoundingClientRect();
        const dx = prev.left - now.left;
        const dy = prev.top - now.top;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
        tile.root.style.transition = "none";
        tile.root.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            tile.root.style.transition = "transform 700ms cubic-bezier(.2,.8,.2,1)";
            tile.root.style.transform = "";
          });
        });
      }
    }
  }

  function createTile(ideaId) {
    const p = {};
    p.rank = el("div", { class: "rank-badge" });
    p.title = el("h2", { class: "tile-title" });
    p.newBadge = el("span", { class: "new-badge", text: "Нова" });
    p.effects = el("ul", { class: "effects tile-effects", "aria-label": "Бізнес-ефекти" });
    p.avgStars = stars(0, "md");
    p.avgNum = el("b", { class: "avg-num" });
    p.total = el("b", { class: "total-num" });
    p.totalUnit = el("span", { class: "total-unit" });
    p.totalBadge = el("div", { class: "total-badge", title: "Сума балів — головний показник ідеї" }, p.total, p.totalUnit);
    p.votes = el("span", { class: "avg-cap" });
    p.hist = el("div", { class: "hist" });
    p.up = iconButton("up", "Вище", () => moveIdea(ideaId, -1));
    p.down = iconButton("down", "Нижче", () => moveIdea(ideaId, 1));
    const actions = el(
      "div",
      { class: "tile-actions admin-only" },
      p.up,
      p.down,
      iconButton("edit", "Редагувати", () => openIdeaModal(ideaId)),
      iconButton("trash", "Видалити", () => deleteIdea(ideaId), "danger")
    );
    const root = el(
      "article",
      { class: "tile", dataset: { id: ideaId }, tabindex: "0", title: "Відкрити на весь екран" },
      el("div", { class: "tile-head" }, p.rank, p.title, p.newBadge),
      // Порядок читання: загальний бал → середня оцінка → ефекти (стовпчиком, до 4 рядків)
      el(
        "div",
        { class: "tile-body" },
        p.totalBadge,
        el("div", { class: "tile-avg" }, p.avgNum, p.avgStars, p.votes),
        p.effects
      ),
      p.hist,
      actions
    );
    root.addEventListener("click", () => openSpotlight(ideaId));
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target === root) openSpotlight(ideaId);
    });
    root.addEventListener("animationend", () => root.classList.remove("bump"));
    return { root, parts: p };
  }

  function updateTile(tile, idea, orderIds, d) {
    const p = tile.parts;
    const r = idea.results;
    const position = orderIds.indexOf(idea.id);

    renderRank(p.rank, r);
    tile.root.classList.remove("medal-1", "medal-2", "medal-3");
    const medal = medalClass(r);
    if (medal) tile.root.classList.add(medal);

    p.title.textContent = idea.title;
    p.title.title = idea.title;
    p.newBadge.hidden = !isNewIdea(idea, d.server_time);
    // Плитка: сітка 2×2 — до 4 ефектів; якщо більше, четверта клітинка «+N ще» (повний список — у spotlight).
    const TILE_FX = 4;
    const shown = idea.effects.length > TILE_FX ? idea.effects.slice(0, TILE_FX - 1) : idea.effects;
    const fxItems = shown.map((e) => effectItem(e, true));
    if (idea.effects.length > TILE_FX) {
      const rest = idea.effects.slice(TILE_FX - 1);
      fxItems.push(el("li", { class: "fx fx-more", title: rest.map((e) => e.display).join("\n") },
        el("span", { class: "fx-body", text: `+${rest.length} ще` })));
    }
    p.effects.replaceChildren(...fxItems);
    p.effects.hidden = idea.effects.length === 0;

    setStars(p.avgStars, r.avg);
    p.avgNum.textContent = r.votes ? fmt(r.avg) : "—";
    p.total.textContent = fmt(r.total);
    p.totalUnit.textContent = plural(r.total, FORMS.points);
    p.totalBadge.classList.toggle("is-empty", r.total === 0);
    p.votes.textContent = `середня · ${r.votes} ${plural(r.votes, FORMS.votes)}`;
    tile.root.classList.toggle("no-effects", idea.effects.length === 0);
    renderHist(p.hist, r, d.workshop.show_names, false);

    const canMove = state.sort === "order";
    p.up.hidden = !canMove;
    p.down.hidden = !canMove;
    p.up.disabled = position === 0;
    p.down.disabled = position === orderIds.length - 1;

    const previous = state.totals.get(idea.id);
    if (previous !== undefined && previous !== r.total) {
      tile.root.classList.remove("bump");
      void tile.root.offsetWidth; // перезапуск анімації
      tile.root.classList.add("bump");
    }
    state.totals.set(idea.id, r.total);
  }

  function renderRank(node, r) {
    node.textContent = r.votes ? r.rank : "–";
    node.title = r.votes ? `Місце в рейтингу: ${r.rank}` : "Ще немає оцінок";
  }

  /**
   * Гістограма оцінок у стилі «★★★★★ Пілот — 6»: заливка рядка = частка голосів,
   * далі — хто так проголосував. full: усі імена з переносом (spotlight), інакше один рядок з «…».
   */
  function renderHist(container, r, showNames, full) {
    if (!container.dataset.ready) {
      for (const score of SCORES_DESC) {
        const s = scaleOf(score);
        const row = el(
          "div",
          { class: `hist-row s${score}`, dataset: { score } },
          el("span", { class: "hist-fill" }),
          score ? stars(score, "sm") : el("span", { class: "stars-none", text: "0" }),
          el("span", { class: "hist-label", text: s.short }),
          el("b", { class: "hist-count" }),
          el("span", { class: "hist-names" })
        );
        container.append(row);
      }
      container.dataset.ready = "1";
    }
    for (const row of container.children) {
      const score = Number(row.dataset.score);
      const count = r.dist[score] || 0;
      const share = r.votes ? count / r.votes : 0;
      row.querySelector(".hist-fill").style.width = `${share * 100}%`;
      row.querySelector(".hist-count").textContent = count;
      row.classList.toggle("is-zero", count === 0);
      const names = showNames && count ? r.voters[score].map((v) => `${v.company} (${v.name})`).join(", ") : "";
      const namesNode = row.querySelector(".hist-names");
      namesNode.textContent = names;
      row.title = `${scaleOf(score).label}: ${count} ${plural(count, FORMS.votes)} (${Math.round(share * 100)}%)${names ? `\n${names}` : ""}`;
    }
    container.classList.toggle("full", !!full);
  }

  // ------------------------------------------------------------------ spotlight (ідея на весь екран)

  function spotlightOrder() {
    return state.data ? sortedIdeas(state.data).map((i) => i.id) : [];
  }

  function openSpotlight(id) {
    state.spotlightId = id;
    $("spotlight").hidden = false;
    renderSpotlight();
  }

  function closeSpotlight() {
    state.spotlightId = null;
    $("spotlight").hidden = true;
  }

  function stepSpotlight(delta) {
    const ids = spotlightOrder();
    if (!ids.length) return;
    const index = ids.indexOf(state.spotlightId);
    state.spotlightId = ids[(index + delta + ids.length) % ids.length];
    renderSpotlight();
  }

  function renderSpotlight() {
    if (state.spotlightId === null || !state.data) return;
    const idea = findIdea(state.spotlightId);
    if (!idea) {
      closeSpotlight();
      return;
    }
    const r = idea.results;
    const ids = spotlightOrder();
    const sp = $("spotlight");
    sp.classList.remove("medal-1", "medal-2", "medal-3");
    const medal = medalClass(r);
    if (medal) sp.classList.add(medal);
    renderRank($("sp-rank"), r);
    $("sp-title").textContent = idea.title;
    $("sp-new").hidden = !isNewIdea(idea, state.data.server_time);
    $("sp-counter").textContent = `${ids.indexOf(idea.id) + 1} / ${ids.length}`;
    $("sp-desc").textContent = idea.description;
    $("sp-desc").hidden = !idea.description;
    $("sp-effects").replaceChildren(...idea.effects.map((e) => effectItem(e, false)));
    $("sp-effects-title").hidden = idea.effects.length === 0;

    $("sp-score").replaceChildren(
      el(
        "div",
        { class: `total-badge xl${r.total ? "" : " is-empty"}`, title: "Сума балів" },
        el("b", { class: "total-num", text: fmt(r.total) }),
        el("span", { class: "total-unit", text: plural(r.total, FORMS.points) })
      ),
      el(
        "div",
        { class: "sp-avg" },
        el("div", { class: "avg-line" }, stars(r.avg, "xl"), el("b", { text: r.votes ? fmt(r.avg) : "—" })),
        el("span", { class: "avg-cap", text: `середня оцінка · ${r.votes} ${plural(r.votes, FORMS.votes)}` })
      )
    );
    renderHist($("sp-hist"), r, state.data.workshop.show_names, true);
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

  /** Рядок вибраного ефекту: типовий (іконка + назва + необов'язкове уточнення) або власний (текст). */
  function effectRow(effect) {
    const kind = (effect && effect.kind) || null;
    const meta = kind ? effectMeta(kind) : null;
    const input = el("input", {
      class: "input",
      maxlength: "300",
      placeholder: kind ? "Уточнення, напр. «−15% на логістиці»" : "Власний ефект: напр. «Вихід на ринок ЄС»",
      "aria-label": kind ? `Уточнення для «${meta.label}»` : "Власний бізнес-ефект",
    });
    input.value = (effect && effect.text) || "";
    const tag = kind
      ? el("span", { class: "fx-tag", title: meta.hint }, effectIcon(kind), meta.label)
      : el("span", { class: "fx-tag custom", text: "Власний" });
    const row = el("div", { class: `effect-row${kind ? "" : " custom"}`, dataset: kind ? { kind } : {} }, tag, input);
    row.append(iconButton("x", "Прибрати ефект", () => { row.remove(); syncEffectChips(); }, "danger"));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addCustomEffect(row);
      }
    });
    return row;
  }

  function addCustomEffect(after) {
    const row = effectRow({ kind: null, text: "" });
    if (after) after.after(row);
    else $("effects-editor").append(row);
    row.querySelector("input").focus();
  }

  function renderEffectCatalog() {
    $("effect-catalog").replaceChildren(
      ...EFFECT_CATALOG.map((c) => {
        const chip = el(
          "button",
          { type: "button", class: "fx-chip", "aria-pressed": "false", title: c.hint, dataset: { kind: c.kind } },
          effectIcon(c.kind),
          c.label
        );
        chip.addEventListener("click", () => toggleEffectKind(c.kind));
        return chip;
      })
    );
  }

  function toggleEffectKind(kind) {
    const editor = $("effects-editor");
    const existing = editor.querySelector(`.effect-row[data-kind="${kind}"]`);
    if (existing) {
      existing.remove();
    } else {
      // типові ефекти — перед власними
      const row = effectRow({ kind, text: "" });
      const firstCustom = editor.querySelector(".effect-row.custom");
      editor.insertBefore(row, firstCustom);
      row.querySelector("input").focus();
    }
    syncEffectChips();
  }

  function syncEffectChips() {
    const selected = new Set([...$("effects-editor").querySelectorAll(".effect-row[data-kind]")].map((r) => r.dataset.kind));
    $("effect-catalog").querySelectorAll(".fx-chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(selected.has(chip.dataset.kind)));
    });
    $("effects-empty").hidden = $("effects-editor").children.length > 0;
  }

  function openIdeaModal(id) {
    const idea = id ? findIdea(id) : null;
    state.editingIdeaId = idea ? idea.id : null;
    $("idea-modal-title").textContent = idea ? "Редагувати ідею" : "Нова ідея";
    $("idea-title").value = idea ? idea.title : "";
    $("idea-description").value = idea ? idea.description : "";
    $("effects-editor").replaceChildren(...(idea ? idea.effects : []).map(effectRow));
    syncEffectChips();
    $("idea-error").hidden = true;
    $("idea-modal").showModal();
    $("idea-title").focus();
  }

  $("idea-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      title: $("idea-title").value,
      description: $("idea-description").value,
      effects: [...$("effects-editor").querySelectorAll(".effect-row")].map((row) => ({
        kind: row.dataset.kind || null,
        text: row.querySelector("input").value,
      })),
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
      toast(id ? "Ідею оновлено" : "Ідею додано — вона зверху списку");
    } catch (err) {
      $("idea-error").textContent = err.message;
      $("idea-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  $("effect-add").addEventListener("click", () => {
    addCustomEffect(null);
    syncEffectChips();
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
    } catch (err) {
      toast(err.message, "error");
      if (state.data) render();
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

  // ------------------------------------------------------------------ компонування та режими

  /** Висота шапки → CSS-змінна, щоб рівно 2 ряди плиток (6 ідей) займали решту екрана. */
  function syncLayout() {
    const head = $("stage-head");
    document.documentElement.style.setProperty("--head-h", `${Math.ceil(head.getBoundingClientRect().height)}px`);
  }
  if (window.ResizeObserver) new ResizeObserver(syncLayout).observe($("stage-head"));
  window.addEventListener("resize", syncLayout);

  function applyModes() {
    document.body.classList.toggle("present-mode", state.present);
    document.body.classList.toggle("admin-mode", !state.present);
    $("present-exit").hidden = !state.present;
    document.querySelectorAll("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort)));
    syncLayout();
  }

  function togglePresent() {
    state.present = !state.present;
    store.set("ws-present", state.present ? "1" : "0");
    applyModes();
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
      store.set("ws-sort-v2", state.sort);
      applyModes();
      if (state.data) render();
    });
  });
  $("btn-add").addEventListener("click", () => openIdeaModal(null));
  $("btn-voting").addEventListener("click", () => {
    const open = !state.data.workshop.voting_open;
    updateWorkshop({ voting_open: open }, open ? "Голосування відкрито" : "Голосування закрито");
  });
  $("btn-settings").addEventListener("click", openSettings);
  $("ws-title").addEventListener("click", () => { if (!state.present && state.data) openSettings(); });
  $("ws-desc").addEventListener("click", () => { if (!state.present && state.data) openSettings(); });
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-present").addEventListener("click", togglePresent);
  $("present-exit").addEventListener("click", togglePresent);
  document.querySelectorAll(".qr-open").forEach((button) => button.addEventListener("click", () => showQr(true)));
  $("qr-overlay").addEventListener("click", () => showQr(false));
  $("sp-close").addEventListener("click", closeSpotlight);
  $("sp-prev").addEventListener("click", () => stepSpotlight(-1));
  $("sp-next").addEventListener("click", () => stepSpotlight(1));

  document.querySelectorAll("dialog [data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("qr-overlay").hidden) return showQr(false);
      if (state.spotlightId !== null) return closeSpotlight();
    }
    const target = event.target;
    const typing = target.closest && target.closest("input, textarea, select, dialog");
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (state.spotlightId !== null && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      return stepSpotlight(event.key === "ArrowRight" ? 1 : -1);
    }
    const key = event.key.toLowerCase();
    if (key === "p" || key === "з") togglePresent();
    else if (key === "f" || key === "а") toggleFullscreen();
    else if (key === "q" || key === "й") showQr($("qr-overlay").hidden);
  });

  // ------------------------------------------------------------------ старт

  renderLegend();
  renderEffectCatalog();
  applyModes();
  const poll = poller(refresh, POLL_MS);
  refresh()
    .catch((err) => toast(err.message, "error"))
    .finally(() => poll.start());
})();
