// Minimal dependency-free WebSocket echo server used by the local/kind demos.
// It accepts one text frame at a time and echoes it back.
const http = require("http");
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const port = Number(process.env.WS_PORT || 18084);

function sendFrame(socket, opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    return;
  }
  socket.write(Buffer.concat([header, payload]));
}

const server = http.createServer();
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", (buf) => {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    let off = 2;
    let len = buf[1] & 0x7f;
    if (len === 126) {
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      return;
    }
    const masked = (buf[1] & 0x80) !== 0;
    let mask;
    if (masked) {
      mask = buf.slice(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return;
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = masked ? buf[off + i] ^ mask[i % 4] : buf[off + i];
    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(socket, 0xa, data);
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) sendFrame(socket, opcode, data);
  });
});
server.listen(port, "127.0.0.1", () => console.log(`ws echo on 127.0.0.1:${port}`));
