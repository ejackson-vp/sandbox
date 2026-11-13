/* Small, dependency-free sprinkles. The page is complete without this file. */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());

/* The docs URL follows wherever this page is served from. */
const servedFromHttp = location.protocol === "http:" || location.protocol === "https:";
const origin = servedFromHttp
  ? location.origin
  : "https://raw.githubusercontent.com/ejackson-vp/sandbox/main/site";
const docsUrl = `${origin}/llms.txt`;

for (const el of document.querySelectorAll(".dossier code")) {
  el.innerHTML = el.innerHTML.replaceAll("{origin}", origin);
}

/* ---------- nav shadow ---------- */

const nav = document.querySelector("#nav");
const onScroll = () => nav?.classList.toggle("is-scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* ---------- reveal on scroll ---------- */

const reveals = [...document.querySelectorAll(".reveal")];

if (reduceMotion || !("IntersectionObserver" in window)) {
  reveals.forEach((el) => el.classList.add("reveal-in"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("reveal-pending");
        entry.target.classList.add("reveal-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
  );

  for (const el of reveals) {
    const box = el.getBoundingClientRect();
    if (box.top < window.innerHeight * 0.92) {
      el.classList.add("reveal-in");
    } else {
      el.classList.add("reveal-pending");
      observer.observe(el);
    }
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
  "- This is a hosted beta with no hardware attestation and no verified isolation. Do not treat it as confidential computing.",
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
 * Two reads, both optional and unauthenticated: the latest release tag, then the
 * latency file that was published with it. The page is complete without either.
 * Nothing about the visitor is sent anywhere.
 */

const repo = "ejackson-vp/sandbox";
const api = "https://api.github.com";
const raw = "https://raw.githubusercontent.com/ejackson-vp/sandbox";
const cacheMs = 30 * 60 * 1000;

const cache = {
  get(key) {
    try {
      const value = JSON.parse(localStorage.getItem(`sandbox:${key}`) ?? "null");
      return value && Date.now() - value.at < cacheMs ? value.body : null;
    } catch {
      return null;
    }
  },
  set(key, body) {
    try {
      localStorage.setItem(`sandbox:${key}`, JSON.stringify({ at: Date.now(), body }));
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

const relative = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "pushed just now";
  if (mins < 60) return `pushed ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `pushed ${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `pushed ${days} d ago`;
  return `pushed ${Math.round(days / 7)} w ago`;
};

/* ---------- hero numbers, from the latest release ---------- */

const statsEl = document.querySelector("#stats");
const noteEl = document.querySelector("#stat-note");

const renderStats = (data, tag) => {
  if (!statsEl || !Array.isArray(data.metrics) || !data.metrics.length) return;

  statsEl.replaceChildren(
    ...data.metrics.map(({ value, label }) => {
      const cell = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = value;
      dd.textContent = label;
      cell.append(dt, dd);
      return cell;
    }),
  );

  if (!noteEl) return;

  const ref = tag ?? "main";
  noteEl.replaceChildren(
    `Two-node Kata cluster, control ${data.control}, ${data.measured}, n=${data.samples}. `,
  );

  if (data.caveat?.text) {
    noteEl.append(`${data.caveat.text} `);
    if (data.caveat.link?.href) {
      const caveat = document.createElement("a");
      caveat.href = data.caveat.link.href;
      caveat.textContent = data.caveat.link.label;
      noteEl.append(caveat, ". ");
    }
  }

  const method = document.createElement("a");
  method.href = `https://github.com/${repo}/blob/${ref}/docs/performance-cluster.md`;
  method.textContent = "Method and caveats";
  noteEl.append(method, ".");
};

const loadStats = async () => {
  if (!statsEl) return;

  const remembered = cache.get("latency");
  if (remembered) {
    renderStats(remembered.data, remembered.tag);
    return;
  }

  let tag = null;
  try {
    const release = await (await getJson(`${api}/repos/${repo}/releases/latest`)).json();
    tag = release?.tag_name ?? null;
  } catch {
    /* Rate limited or offline. The main branch copy is still worth showing. */
  }

  /* A release only carries the file once it has been tagged after a benchmark run. */
  const candidates = [tag && `${raw}/${tag}/docs/perf/latency.json`, `${raw}/main/docs/perf/latency.json`, "./latency.json"];

  for (const url of candidates.filter(Boolean)) {
    try {
      const data = await (await getJson(url, { cache: "no-cache" })).json();
      renderStats(data, tag);
      cache.set("latency", { data, tag });
      return;
    } catch {
      /* Try the next source. */
    }
  }
};

/* ---------- repo vitals ---------- */

const vitals = document.querySelector("#vitals-data");

const loadVitals = async () => {
  if (!vitals) return;

  const remembered = cache.get("vitals");
  if (remembered) {
    vitals.textContent = remembered.text.replace(/pushed [^·]+$/, relative(remembered.pushedAt));
    return;
  }

  const headers = { Accept: "application/vnd.github+json" };

  const [repoRes, commitRes, runRes, contributorsRes] = await Promise.all([
    getJson(`${api}/repos/${repo}`, { headers }),
    getJson(`${api}/repos/${repo}/commits?sha=main&per_page=1`, { headers }),
    getJson(`${api}/repos/${repo}/actions/runs?branch=main&per_page=1`, { headers }),
    getJson(`${api}/repos/${repo}/contributors?per_page=1&anon=1`, { headers }),
  ]);

  const [info, commits, runs] = await Promise.all([repoRes.json(), commitRes.json(), runRes.json()]);

  /* The contributor count lives in the pagination header, not the body. */
  const link = contributorsRes.headers.get("link") ?? "";
  const contributors = Number(link.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1] ?? 1);

  const sha = commits?.[0]?.sha?.slice(0, 7);
  const run = runs?.workflow_runs?.[0];
  const ci =
    !run || run.status !== "completed"
      ? run
        ? "CI running"
        : null
      : run.conclusion === "success"
        ? "CI passing"
        : `CI ${run.conclusion}`;

  const issues = info.open_issues_count;
  const text = [
    sha ? `main@${sha}` : null,
    relative(info.pushed_at),
    ci,
    `${issues} open ${issues === 1 ? "issue" : "issues"}`,
    `${contributors} ${contributors === 1 ? "contributor" : "contributors"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  vitals.textContent = text;
  cache.set("vitals", { text, pushedAt: info.pushed_at });
};

/* Each block fails on its own. A rate limit must not blank the other. */
loadStats().catch(() => {});
loadVitals().catch(() => {});
