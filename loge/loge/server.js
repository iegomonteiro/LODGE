import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID, createHmac, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MAX_PEERS = Number(process.env.MAX_PEERS) || 8;
const ROOM_RE = /^[a-zA-Z0-9_-]{4,64}$/;

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.get("/sala/:id", (req, res) => {
  if (!ROOM_RE.test(req.params.id)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "sala.html"));
});

// Servidores STUN/TURN. O TURN usa credenciais temporárias (padrão do coturn).
app.get("/ice", (_req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  const { TURN_URL, TURN_SECRET } = process.env;
  if (TURN_URL && TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + 6 * 3600);
    const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");
    iceServers.push({ urls: TURN_URL.split(","), username, credential });
  }
  res.set("Cache-Control", "no-store").json({ iceServers });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const rooms = new Map(); // Map<sala, Map<peerId, { ws, name }>> + .hash (senha) e .sharer (quem transmite)
const hash = (t) => createHash("sha256").update(String(t || "")).digest("hex");
const hostId = (room) => room.keys().next().value; // anfitrião = quem está há mais tempo na sala
const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (room, msg, exceptId) => {
  for (const [pid, p] of room) if (pid !== exceptId) send(p.ws, msg);
};

wss.on("connection", (ws) => {
  const id = randomUUID();
  let roomId = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      if (roomId) return;
      const rid = String(msg.room);
      if (!ROOM_RE.test(rid)) return ws.close();
      const pw = String(msg.password || "").slice(0, 64);
      if (!rooms.has(rid)) {
        const nova = new Map();
        nova.hash = pw ? hash(pw) : null; // quem cria a sala define a senha (opcional)
        nova.sharer = null;
        rooms.set(rid, nova);
      }
      const room = rooms.get(rid);
      if (room.hash && hash(pw) !== room.hash) {
        send(ws, { type: pw ? "wrong-password" : "need-password" });
        return ws.close();
      }
      if (room.size >= MAX_PEERS) {
        send(ws, { type: "full" });
        return ws.close();
      }
      roomId = rid;
      const name = String(msg.name || "anônimo").slice(0, 24);
      const peers = [...room].map(([pid, p]) => ({ id: pid, name: p.name }));
      room.set(id, { ws, name });
      send(ws, { type: "joined", id, peers, host: hostId(room), sharer: room.sharer });
      broadcast(room, { type: "peer-joined", id, name }, id);
      return;
    }

    const room = roomId && rooms.get(roomId);
    if (!room) return;

    if (msg.type === "signal") {
      const target = room.get(msg.to);
      if (target) send(target.ws, { type: "signal", from: id, data: msg.data });
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "").slice(0, 500);
      if (text) broadcast(room, { type: "chat", from: id, name: room.get(id)?.name, text });
    }

    // Só uma pessoa transmite por vez
    if (msg.type === "share-start") {
      if (room.sharer && room.sharer !== id)
        return send(ws, { type: "share-denied", by: room.get(room.sharer)?.name });
      room.sharer = id;
      send(ws, { type: "share-ok" });
      broadcast(room, { type: "sharer", id }, id);
    }
    if (msg.type === "share-stop" && room.sharer === id) {
      room.sharer = null;
      broadcast(room, { type: "sharer", id: null });
    }
    // O anfitrião pode liberar o palco
    if (msg.type === "release" && hostId(room) === id && room.sharer) {
      const alvo = room.get(room.sharer);
      room.sharer = null;
      if (alvo) send(alvo.ws, { type: "stop-share" });
      broadcast(room, { type: "sharer", id: null });
    }
    // Controle do player (play, pause, posição): só repassa mensagens pequenas
    if (msg.type === "sync" && JSON.stringify(msg.data ?? null).length < 300)
      broadcast(room, { type: "sync", from: id, data: msg.data }, id);
  });

  ws.on("close", () => {
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    const eraHost = hostId(room) === id;
    room.delete(id);
    if (room.size === 0) return rooms.delete(roomId);
    broadcast(room, { type: "peer-left", id });
    if (room.sharer === id) { room.sharer = null; broadcast(room, { type: "sharer", id: null }); }
    if (eraHost) broadcast(room, { type: "host", id: hostId(room) });
  });
});

setInterval(() => {
  wss.clients.forEach((c) => {
    if (!c.isAlive) return c.terminate();
    c.isAlive = false;
    c.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`Loge rodando em http://localhost:${PORT}`));
