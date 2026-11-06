import http from "node:http";
import { chromium } from "playwright-core";

const page = `<!doctype html><html><body>
<h1 id="title">Synthetic browser workload</h1>
<form id="form"><input id="name" name="name" /><button type="submit">Send</button></form>
<div id="out"></div>
<script>
  document.getElementById('form').addEventListener('submit', (event) => {
    event.preventDefault();
    document.getElementById('out').textContent = 'hello ' + document.getElementById('name').value;
  });
</script></body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});
await new Promise((resolve) => server.listen(3210, "127.0.0.1", resolve));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: process.env.CHROMIUM_ARGS ? process.env.CHROMIUM_ARGS.split(" ") : [],
});
const context = await browser.newContext();
const tab = await context.newPage();
await tab.goto("http://127.0.0.1:3210/");
await tab.fill("#name", "sandbox");
await tab.click("button");
const output = await tab.textContent("#out");
const title = await tab.title();
await tab.screenshot({ path: "/workspace/screenshot.png", fullPage: true });
console.log(JSON.stringify({ title, output, url: tab.url() }));
await browser.close();
server.close();
