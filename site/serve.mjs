/**
 * A zero-dependency static server for the site.
 *
 * `npm run dev` starts this on 127.0.0.1:4173. Override with PORT and HOST.
 * It is intentionally tiny: index.html, CSS, JS, the mark and llms.txt.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

const aliases = new Map([["/latency.json", resolve(root, "../docs/perf/latency.json")]]);

const types = new Map([  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
};

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${req.headers.host ?? host}`).pathname);
  } catch {
    send(res, 400, "Bad request\n");
    return;
  }

  const requested = pathname.endsWith("/") ? join(pathname, "index.html") : pathname;
  /* Dev only: the page reads ./latency.json as its last fallback, so serve the
     real file from docs/perf instead of keeping a copy next to index.html. */
  const aliased = aliases.get(requested);
  const file = aliased ?? resolve(root, `.${requested}`);

  if (file !== root && !file.startsWith(root + sep)) {
    send(res, 403, "Forbidden\n");
    return;
  }

  let info;
  try {
    info = await stat(file);
  } catch {
    send(res, 404, "Not found. Try / or /llms.txt.\n");
    return;
  }

  if (info.isDirectory()) {
    res.writeHead(302, { Location: `${pathname.replace(/\/?$/, "/")}index.html` });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": types.get(extname(file)) ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`sandbox site  http://${host}:${port}`);
  console.log(`agent docs    http://${host}:${port}/llms.txt`);
});

const stop = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
