import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MAX_PEERS = Number(process.env.MAX_PEERS) || 8;
const ROOM_RE = /^[a-zA-Z0-9_-]{4,64}$/;

// Limites simples contra abuso
const MSG_LIMIT = 300;            // mensagens por conexão a cada 10 s (cobre rajadas de ICE)
const CHAT_LIMIT = 10;            // mensagens de chat por conexão a cada 10 s
const MAX_FAILS = 10;             // senhas erradas por sala antes de bloquear
const LOCK_MS = 60_000;           // duração do bloqueio da sala
const EMPTY_ROOM_TTL = 10 * 60_000; // sala com senha vazia guarda a senha por 10 min

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

const rooms = new Map(); // Map<sala, Map<peerId, { ws, name }>> + .salt/.hash (senha), .sharer (quem transmite), .fails/.lockedUntil/.expira
// Senha guardada como HMAC-SHA256 com sal aleatório por sala; comparação em tempo constante.
const digest = (salt, t) => createHmac("sha256", salt).update(String(t || "")).digest();
const senhaOk = (room, t) => timingSafeEqual(digest(room.salt, t), room.hash);
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
  const janela = { t: Date.now(), n: 0, chat: 0 };

  ws.on("message", (raw) => {
    const agora = Date.now();
    if (agora - janela.t > 10_000) { janela.t = agora; janela.n = 0; janela.chat = 0; }
    if (++janela.n > MSG_LIMIT) return ws.close(1008, "rate limit");

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      if (roomId) return;
      const rid = String(msg.room);
      if (!ROOM_RE.test(rid)) {
        send(ws, { type: "invalid-room" });
        return ws.close();
      }
      const pw = String(msg.password || "").slice(0, 64);
      if (!rooms.has(rid)) {
        const nova = new Map();
        nova.salt = randomBytes(16);
        nova.hash = pw ? digest(nova.salt, pw) : null; // quem cria a sala define a senha (opcional)
        nova.sharer = null;
        nova.fails = 0;
        nova.lockedUntil = 0;
        rooms.set(rid, nova);
      }
      const room = rooms.get(rid);
      if (room.hash) {
        if (room.lockedUntil > agora) {
          send(ws, { type: "locked" });
          return ws.close();
        }
        if (!senhaOk(room, pw)) {
          // pedir a senha pela primeira vez (campo vazio) não conta como tentativa errada
          if (pw && ++room.fails >= MAX_FAILS) { room.lockedUntil = agora + LOCK_MS; room.fails = 0; }
          send(ws, { type: pw ? "wrong-password" : "need-password" });
          return ws.close();
        }
        room.fails = 0;
      }
      if (room.size >= MAX_PEERS) {
        send(ws, { type: "full" });
        return ws.close();
      }
      clearTimeout(room.expira);
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
      if (text && ++janela.chat <= CHAT_LIMIT) broadcast(room, { type: "chat", from: id, name: room.get(id)?.name, text });
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
    const eraSharer = room.sharer === id;
    room.delete(id);
    if (eraSharer) room.sharer = null;
    if (room.size === 0) {
      if (!room.hash) return rooms.delete(roomId);
      // sala com senha: guarda a senha por um tempo, para o link não ficar aberto a quem recriar a sala
      const rid = roomId;
      clearTimeout(room.expira);
      room.expira = setTimeout(() => {
        if (rooms.get(rid) === room && room.size === 0) rooms.delete(rid);
      }, EMPTY_ROOM_TTL);
      room.expira.unref?.();
      return;
    }
    broadcast(room, { type: "peer-left", id });
    if (eraSharer) broadcast(room, { type: "sharer", id: null });
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
