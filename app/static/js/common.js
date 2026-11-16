/* Спільні утиліти для сторінки учасника та екрана ведучого. */
(function () {
  "use strict";

  const bootEl = document.getElementById("boot");
  const boot = bootEl ? JSON.parse(bootEl.textContent) : {};
  const SCALE = boot.scale || [];

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(method, url, body) {
    const options = {
      method,
      headers: { Accept: "application/json", "X-Requested-With": "fetch" },
      credentials: "same-origin",
      cache: "no-store",
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      throw new ApiError("Немає з'єднання з сервером", 0);
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      throw new ApiError((data && data.error) || `Помилка сервера (${response.status})`, response.status);
    }
    return data;
  }

  /** Створення DOM-елемента: el("div", {class: "x", text: "..."}, child1, child2) */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /** Українські форми множини: plural(5, ["бал", "бали", "балів"]) */
  function plural(n, forms) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  const numberFormat = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 });
  const fmt = (x) => numberFormat.format(x);

  const FORMS = {
    points: ["бал", "бали", "балів"],
    votes: ["голос", "голоси", "голосів"],
    participants: ["учасник", "учасники", "учасників"],
    ratings: ["оцінка", "оцінки", "оцінок"],
  };

  function scaleItem(score) {
    return SCALE.find((s) => s.score === Number(score));
  }

  /**
   * Сегментована смуга розподілу оцінок. Сегменти створюються один раз і лише змінюють ширину,
   * тож зміни анімуються. tall: 28px з кількістю голосів усередині; thin: 8px без тексту.
   */
  function segBar(bar, dist, opts) {
    const tall = !!(opts && opts.tall);
    const total = SCALE.reduce((sum, s) => sum + (Number(dist && dist[s.score]) || 0), 0);
    if (!bar.dataset.ready) {
      bar.className = "segbar " + (tall ? "tall" : "thin");
      bar.setAttribute("role", "img");
      for (const s of SCALE) {
        const seg = el("div", { class: `seg s${s.score} zero`, dataset: { score: s.score } });
        if (tall) seg.append(el("span", { class: "seg-label" }));
        bar.append(seg);
      }
      bar.append(el("div", { class: "empty-track", text: tall ? "Ще немає оцінок" : "" }));
      bar.dataset.ready = "1";
    }
    const parts = [];
    for (const seg of bar.querySelectorAll(".seg")) {
      const s = scaleItem(seg.dataset.score);
      const count = Number(dist && dist[s.score]) || 0;
      seg.classList.toggle("zero", count === 0);
      seg.style.flexGrow = String(count);
      const pct = total ? Math.round((count / total) * 100) : 0;
      seg.title = `${s.score} — ${s.label}: ${count} ${plural(count, FORMS.votes)} (${pct}%)`;
      if (tall) seg.firstChild.textContent = `${pct}%`;
      if (count) parts.push(`${s.label}: ${count}`);
    }
    bar.querySelector(".empty-track").hidden = total > 0;
    bar.setAttribute("aria-label", total ? `Розподіл оцінок — ${parts.join(", ")}` : "Ще немає оцінок");
    if (tall) requestAnimationFrame(() => fitSegLabels(bar));
  }

  /** Число всередині сегмента показуємо лише якщо воно вміщується (без обрізання). */
  function fitSegLabels(bar) {
    if (!bar || !bar.classList.contains("tall")) return;
    for (const seg of bar.querySelectorAll(".seg:not(.zero)")) {
      const label = seg.firstChild;
      if (!label) continue;
      label.classList.remove("hide");
      if (label.offsetWidth + 12 > seg.clientWidth) label.classList.add("hide");
    }
  }

  function refitAllBars() {
    document.querySelectorAll(".segbar.tall").forEach(fitSegLabels);
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refitAllBars, 150);
  });
  // Після анімації ширини сегментів перевіряємо, чи вміщуються числа.
  document.addEventListener("transitionend", (event) => {
    if (event.target.classList && event.target.classList.contains("seg")) {
      fitSegLabels(event.target.parentElement);
    }
  });

  let toastTimer = null;
  function toast(message, kind) {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", kind === "error");
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), kind === "error" ? 4000 : 1600);
  }

  /**
   * Опитування сервера з паузою, коли вкладка прихована. fn повертає Promise.
   * Після помилки інтервал поступово збільшується.
   */
  function poller(fn, interval) {
    let timer = null;
    let running = false;
    let failures = 0;
    const connLost = document.getElementById("conn-lost");

    async function tick() {
      timer = null;
      if (document.hidden) return;
      running = true;
      try {
        await fn();
        failures = 0;
        if (connLost) connLost.hidden = true;
      } catch (err) {
        failures += 1;
        if (connLost && err && err.status === 0 && failures >= 2) connLost.hidden = false;
      } finally {
        running = false;
      }
      schedule();
    }

    function schedule(delay) {
      clearTimeout(timer);
      const backoff = Math.min(failures, 5) * interval;
      timer = setTimeout(tick, delay !== undefined ? delay : interval + backoff);
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !running) schedule(0);
    });

    return {
      start() { schedule(); },
      now() { if (!running) schedule(0); },
    };
  }

  // ------------------------------------------------------------------ зірочки

  const STAR_PATH = "M12 2.6l2.93 5.94 6.56.95-4.75 4.63 1.12 6.53L12 17.57l-5.86 3.08 1.12-6.53L2.51 9.49l6.56-.95z";
  const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
  const FIVE_STARS = STAR_SVG.repeat(5);

  /**
   * Рейтинг зірочками 0–5 з частковим заповненням (середній бал 3,67 → 3⅔ зірки).
   * Кожна зірка має власні поля у viewBox, тож відсоток ширини точно відповідає значенню.
   */
  function stars(value, className) {
    const node = el("span", { class: `stars ${className || ""}`, role: "img" });
    node.innerHTML = `<span class="stars-bg">${FIVE_STARS}</span><span class="stars-fg">${FIVE_STARS}</span>`;
    setStars(node, value);
    return node;
  }

  function setStars(node, value) {
    const v = Math.max(0, Math.min(5, Number(value) || 0));
    node.style.setProperty("--fill", `${(v / 5) * 100}%`);
    node.setAttribute("aria-label", `${fmt(v)} з 5`);
  }

  // ------------------------------------------------------------------ «Нова» ідея

  const NEW_IDEA_MS = 10 * 60 * 1000;

  /** Ідея додана менше ніж 10 хв тому (за годинником сервера, щоб не залежати від годинника телефона). */
  function isNewIdea(idea, serverTime) {
    if (!idea.created_at || !serverTime) return false;
    const age = Date.parse(serverTime) - Date.parse(idea.created_at);
    return age >= 0 && age < NEW_IDEA_MS;
  }

  // ------------------------------------------------------------------ бізнес-ефекти

  const EFFECT_CATALOG = boot.effects || [];
  const EFFECT_ICONS = {
    speed: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    cost: '<path d="M22 17l-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
    revenue: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    defects: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4 12 14l-3-3"/>',
    quality: '<circle cx="12" cy="8" r="6"/><path d="M15.5 12.9 17 22l-5-3-5 3 1.5-9.1"/>',
    productivity: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    materials: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    inventory: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
    customer: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>',
    control: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  };

  function effectMeta(kind) {
    return EFFECT_CATALOG.find((c) => c.kind === kind);
  }

  function effectIcon(kind) {
    const node = el("span", { class: "fx-icon", "aria-hidden": "true" });
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EFFECT_ICONS[kind] || ""}</svg>`;
    return node;
  }

  /** Чіп ефекту. compact (плитка): лише назва типового ефекту, уточнення — у підказці. */
  function effectItem(effect, compact) {
    const meta = effect.kind ? effectMeta(effect.kind) : null;
    const tooltip = [effect.display, meta && meta.hint].filter(Boolean).join("\n");
    if (!effect.kind) {
      return el("li", { class: "fx fx-custom", title: tooltip }, el("span", { class: "fx-body", text: effect.text }));
    }
    const body = el("span", { class: "fx-body" }, el("b", { text: effect.label }));
    if (!compact && effect.text) body.append(el("span", { class: "fx-detail", text: ` — ${effect.text}` }));
    return el("li", { class: `fx fx-${effect.kind}`, title: tooltip }, effectIcon(effect.kind), body);
  }

  /** Назва з червоною частиною після двокрапки: «Воркшоп: <червоне>ІТ-рішення…</червоне>». */
  function setTitle(node, title) {
    const index = title.indexOf(":");
    const tail = index >= 0 ? title.slice(index + 1).trim() : "";
    if (index < 0 || !tail) {
      node.textContent = title;
      return;
    }
    node.replaceChildren(`${title.slice(0, index)}: `, el("span", { class: "accent-text", text: tail }));
  }

  window.WS = {
    setTitle,
    boot, SCALE, api, ApiError, el, plural, fmt, FORMS, scaleItem, segBar, toast, poller,
    stars, setStars, isNewIdea, EFFECT_CATALOG, effectMeta, effectIcon, effectItem,
  };
})();
