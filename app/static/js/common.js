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

  window.WS = { boot, SCALE, api, ApiError, el, plural, fmt, FORMS, scaleItem, segBar, toast, poller };
})();
