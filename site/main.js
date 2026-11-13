/* Small, dependency-free sprinkles. The page is complete without this file. */

document.documentElement.classList.add("js");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());

/* The docs URL follows wherever this page is served from. */
const servedFromHttp = location.protocol === "http:" || location.protocol === "https:";
const origin = servedFromHttp
  ? location.origin
  : "https://raw.githubusercontent.com/ejackson-vp/sandbox/main/site";
const docsUrl = `${origin}/llms.txt`;

/* The hosted API lives at api.<root> while the page sits on the root domain.
 * Local preview and hosts with more than one label, such as a GitHub Pages
 * subdomain, have no such sibling and keep pointing at whatever served the page. */
const host = servedFromHttp ? location.hostname : "";
const isRootDomain = host.split(".").length === 2 && !/^\d+\.\d+$/.test(host);
const apiBase = isRootDomain ? `https://api.${host}` : origin;

const fill = (text) => text.replaceAll("{origin}", origin).replaceAll("{api}", apiBase);

for (const el of document.querySelectorAll("code")) {
  el.innerHTML = fill(el.innerHTML);
}

for (const el of document.querySelectorAll("[data-copy]")) {
  el.dataset.copy = fill(el.dataset.copy);
}

/* ---------- nav shadow ---------- */

const nav = document.querySelector("#nav");
const onScroll = () => nav?.classList.toggle("is-scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* ---------- terminal demo ---------- */

const term = document.querySelector("[data-term]");

if (term) {
  const cmd = term.querySelector(".t-cmd");
  const cmdLine = term.querySelector(".t-cmd-line");
  const lines = [...term.querySelectorAll(".t-line")];
  const rest = lines.filter((line) => line !== cmdLine);
  const replay = term.querySelector("[data-term-replay]");
  const toggle = term.querySelector("[data-term-toggle]");
  const full = cmd?.dataset.cmd ?? "";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hold = 9000;
  const initialHold = 3000;
  let running = false;
  let paused = false;
  let inView = false;
  let runToken = 0;
  let loopTimer = 0;

  const reset = () => {
    term.classList.add("is-armed");
    lines.forEach((line) => line.classList.remove("is-on"));
    if (cmd) cmd.textContent = "";
  };

  const finish = () => {
    runToken += 1;
    running = false;
    clearTimeout(loopTimer);
    term.classList.remove("is-playing");
    term.classList.add("is-armed");
    lines.forEach((line) => line.classList.add("is-on"));
    if (cmd) cmd.textContent = full;
  };

  const play = async () => {
    if (running || !cmd || reduceMotion || paused) return;
    running = true;
    const token = ++runToken;
    reset();
    term.classList.add("is-playing");
    cmdLine?.classList.add("is-on");

    for (let i = 1; i <= full.length; i += 1) {
      if (token !== runToken) return;
      cmd.textContent = full.slice(0, i);
      await wait(75);
    }

    await wait(1200);
    if (token !== runToken) return;

    for (const line of rest) {
      line.classList.add("is-on");
      await wait(1400);
    }

    if (token !== runToken) return;
    term.classList.remove("is-playing");
    running = false;
  };

  function schedule(delay) {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(run, delay);
  }

  async function run() {
    if (running || reduceMotion || !inView || document.hidden || paused) return;
    await play();
    if (inView && !document.hidden && !paused) schedule(hold);
  }

  const setPaused = (value) => {
    paused = value;
    if (paused) finish();
    else if (!reduceMotion) schedule(40);

    if (toggle) {
      toggle.textContent = paused ? "play" : "pause";
      toggle.setAttribute(
        "aria-label",
        paused ? "Play the terminal animation" : "Pause the terminal animation",
      );
    }
  };

  toggle?.addEventListener("click", () => {
    if (reduceMotion) return;
    setPaused(!paused);
  });

  replay?.addEventListener("click", () => {
    if (reduceMotion) return;
    if (paused) {
      setPaused(false);
      return;
    }
    runToken += 1;
    running = false;
    schedule(30);
  });

  if (!reduceMotion) {
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          inView = entries.some((entry) => entry.isIntersecting);
          if (inView && !paused) schedule(running ? hold : initialHold);
          else if (!inView) clearTimeout(loopTimer);
        },
        { threshold: 0.25 },
      );
      observer.observe(term);
    } else {
      inView = true;
      if (!paused) schedule(initialHold);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearTimeout(loopTimer);
      else if (inView && !running && !paused) schedule(initialHold);
    });
  }
}

/* ---------- clipboard ---------- */

let toastTimer;

const toast = (message) => {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1700);
};

const fallbackCopy = (text) => {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
};

const copy = async (text, okMessage) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!fallbackCopy(text)) {
      throw new Error("copy failed");
    }
    toast(okMessage);
  } catch {
    toast("Copy failed, select it by hand");
  }
};

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => {
    copy(button.dataset.copy, "Copied to clipboard");
  });
}

const prompt = [
  "You have access to sandbox, a disposable Linux VM service.",
  "",
  "Read the agent documentation before writing code:",
  docsUrl,
  "",
  "Rules:",
  "- Use the `sandbox` CLI or `@x402s/sdk`. Do not hand-roll the sealed envelopes.",
  "- Prefer `sandbox run --json` for one-shot work: it creates, uploads, runs, downloads and destroys.",
  "- Always destroy a session in a `finally` block.",
  "- Keep input and returned files under 8 MiB. Command output truncates at 256 KiB.",
  "- Pass secrets through env, never inline in a command string.",
  "- There is no inbound networking. Use a service plus the relay HTTP operations.",
  "- This is an alpha reference deployment with no hardware attestation. Do not treat it as confidential computing.",
].join("\n");

const promptButton = document.querySelector("#copy-prompt");
const promptNote = document.querySelector("#copy-note");

promptButton?.addEventListener("click", async () => {
  await copy(prompt, "Agent handoff copied");
  if (promptNote) {
    promptNote.textContent = "Paste it into your agent's system prompt.";
    setTimeout(() => {
      promptNote.textContent = "";
    }, 4000);
  }
});

/* ---------- numbers from the repo ----------
 * Optional and unauthenticated. Reads the benchmark file from main, which is the
 * newest one, then the copy tagged with the latest release, then the local file.
 * Payloads that are not the four warm/cold numbers are ignored. The page is
 * complete without any of it. Nothing about the visitor is sent anywhere.
 */

const repo = "ejackson-vp/sandbox";
const api = "https://api.github.com";
const raw = "https://raw.githubusercontent.com/ejackson-vp/sandbox";
const cacheMs = 30 * 60 * 1000;

/* The stored shape changes between deploys, so the key carries a version and the
 * reader checks the shape it is about to use. A bad payload is a cache miss. */
const cache = {
  get(key, isValid = () => true) {
    try {
      const value = JSON.parse(localStorage.getItem(`sandbox:v3:${key}`) ?? "null");
      const fresh = value && Date.now() - value.at < cacheMs;
      return fresh && isValid(value.body) ? value.body : null;
    } catch {
      return null;
    }
  },
  set(key, body) {
    try {
      localStorage.setItem(`sandbox:v3:${key}`, JSON.stringify({ at: Date.now(), body }));
    } catch {
      /* Private mode and file:// both refuse this. Fine. */
    }
  },
};

const getJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
};


/* ---------- hero numbers, from the latest release ---------- */

const statsEl = document.querySelector("#stats");
const noteEl = document.querySelector("#stat-note");

const isLatency = (data) =>
  Array.isArray(data?.metrics) &&
  data.metrics.length === 4 &&
  data.metrics.every(
    (m) => typeof m?.value === "string" && /warm|cold/i.test(m.label) && /p50|p95/i.test(m.label),
  );

const renderStats = (data, ref = "main") => {
  if (!statsEl || !isLatency(data)) return;

  const parsed = data.metrics.map(({ value, label }) => ({
    value,
    kind: /p50/i.test(label) ? "p50" : /p95/i.test(label) ? "p95" : null,
    group: /warm/i.test(label) ? "Warm start" : /cold/i.test(label) ? "Cold start" : null,
  }));
  if (parsed.some((m) => !m.kind || !m.group)) return;

  const groups = ["Warm start", "Cold start"].map((name) => {
    const cells = ["p50", "p95"].map((kind) => parsed.find((m) => m.group === name && m.kind === kind));
    return cells.every(Boolean) ? { name, cells } : null;
  });
  if (groups.some((group) => !group)) return;

  statsEl.replaceChildren(
    ...groups.map(({ name, cells }) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.className = "stat-name";
      dt.textContent = name;

      const dd = document.createElement("dd");
      dd.className = "stat-pair";
      for (const { kind, value } of cells) {
        const cell = document.createElement("span");
        const b = document.createElement("b");
        const small = document.createElement("small");
        b.textContent = value;
        small.textContent = kind;
        cell.append(b, small);
        dd.append(cell);
      }

      wrap.append(dt, dd);
      return wrap;
    }),
  );

  if (!noteEl) return;

  noteEl.replaceChildren(data.note ? `${data.note} ` : "");

  const method = document.createElement("a");
  method.href = `https://github.com/${repo}/blob/${ref}/docs/performance-cluster.md`;
  method.textContent = "Method and caveats";
  noteEl.append(method, ".");
};

const loadStats = async () => {
  if (!statsEl) return;

  const remembered = cache.get("latency", (body) => isLatency(body?.data));
  if (remembered) {
    renderStats(remembered.data, remembered.ref);
    return;
  }

  let tag = null;
  try {
    const release = await (await getJson(`${api}/repos/${repo}/releases/latest`)).json();
    tag = release?.tag_name ?? null;
  } catch {
    /* Rate limited or offline. The main branch copy is still worth showing. */
  }

  /* Main carries the newest benchmark. The tag copy can lag by a release, so it
   * is only a fallback. A local preview prefers the checkout. */
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const candidates = [
    local ? { url: "./latency.json", ref: "main" } : null,
    { url: `${raw}/main/docs/perf/latency.json`, ref: "main" },
    tag ? { url: `${raw}/${tag}/docs/perf/latency.json`, ref: tag } : null,
    { url: "./latency.json", ref: "main" },
  ].filter(Boolean);

  for (const { url, ref } of candidates) {
    try {
      const data = await (await getJson(url, { cache: "no-cache" })).json();
      if (!isLatency(data)) continue;
      renderStats(data, ref);
      cache.set("latency", { data, ref });
      return;
    } catch {
      /* Try the next source. */
    }
  }
};

loadStats().catch(() => {});
