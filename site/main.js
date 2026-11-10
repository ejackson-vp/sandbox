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
