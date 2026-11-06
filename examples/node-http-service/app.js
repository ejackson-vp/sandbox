import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "node-http-workload" });
});

app.post("/transform", (req, res) => {
  const text = String(req.body?.text ?? "");
  res.json({
    original: text,
    upper: text.toUpperCase(),
    reversed: [...text].reverse().join(""),
    length: text.length,
  });
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    res.write(`id: ${n}\ndata: event-${n}\n\n`);
    if (n >= 3) {
      clearInterval(timer);
      res.end();
    }
  }, 40);
  req.on("close", () => clearInterval(timer));
});

const server = app.listen(3000, "0.0.0.0", () => {
  console.log("listening on 3000");
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
});
