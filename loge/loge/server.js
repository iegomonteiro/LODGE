import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
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

// Salas fixas (criadas por um perfil, sobrevivem a reinicializações)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ARQUIVO = path.join(DATA_DIR, "salas.json");
const MAX_FIXAS = Number(process.env.MAX_FIXED_ROOMS) || 200; // no servidor todo
const MAX_FIXAS_POR_DONO = 10;
const CRIACOES_POR_HORA = 30;     // por endereço de rede (atrás de um túnel, todo mundo divide o mesmo)
const SLUG_FIXA_RE = /^[a-z0-9][a-z0-9_-]{3,63}$/; // minúsculas: /sala/Cinema e /sala/cinema são a mesma sala fixa
const ID_RE = /^[a-f0-9]{16,32}$/;
const TOKEN_RE = /^[a-f0-9]{32,64}$/;
const FOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const FOTO_MAX = 40_000;          // caracteres; o navegador reduz a foto para ~128 px (uns 8 mil)

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

/* ---------- salas fixas: dados ---------- */
const fixas = new Map(); // slug -> { slug, nome, donoId, donoHash, salt, hash, criadaEm }
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

function carregarFixas() {
  try {
    const dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
    for (const f of dados.salas || []) if (f && SLUG_FIXA_RE.test(f.slug)) fixas.set(f.slug, f);
  } catch (e) {
    if (e.code === "ENOENT") return;
    // arquivo ilegível: guarda uma cópia e começa vazio, sem apagar o original às cegas
    try { fs.copyFileSync(ARQUIVO, `${ARQUIVO}.corrompido-${Date.now()}`); } catch {}
    console.error("Não consegui ler", ARQUIVO, "-", e.message);
  }
}

function salvarFixas() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ARQUIVO}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ versao: 1, salas: [...fixas.values()] }, null, 2));
  fs.renameSync(tmp, ARQUIVO); // troca atômica: nunca fica meio escrito
}
carregarFixas();

// A senha da sala fixa fica guardada com sal (HMAC-SHA256), como a das salas temporárias
function definirSenha(f, senha) {
  f.salt = randomBytes(16).toString("base64");
  f.hash = senha ? digest(Buffer.from(f.salt, "base64"), senha).toString("base64") : null;
}

const perfilValido = (p) => !!p && typeof p.id === "string" && typeof p.token === "string" && ID_RE.test(p.id) && TOKEN_RE.test(p.token);

// O dono é reconhecido pelo código secreto do perfil (guardado só no navegador dele); o servidor guarda só o hash
function donoOk(f, perfil) {
  if (!f || !perfilValido(perfil) || perfil.id !== f.donoId) return false;
  const a = Buffer.from(hashToken(perfil.token), "hex"), b = Buffer.from(f.donoHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const fotoValida = (f) => (typeof f === "string" && f.length <= FOTO_MAX && FOTO_RE.test(f) ? f : null);
const limpaTexto = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const publica = (f) => ({ slug: f.slug, nome: f.nome, comSenha: !!f.hash, criadaEm: f.criadaEm });

/* ---------- salas fixas: API ---------- */
function responder(res, codigo, obj) {
  res.statusCode = codigo;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function lerJson(req, limite = 4096) {
  return new Promise((ok, erro) => {
    let n = 0, grande = false;
    const partes = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limite) { if (!grande) { grande = true; partes.length = 0; erro(new Error("grande")); } } // descarta o resto, mas deixa a resposta 413 sair
      else if (!grande) partes.push(c);
    });
    req.on("end", () => {
      if (grande) return;
      try { ok(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")); } catch { erro(new Error("json")); }
    });
    req.on("error", erro);
  });
}

const api = (fn) => async (req, res) => {
  try {
    const corpo = await lerJson(req);
    await fn(req, res, corpo && typeof corpo === "object" ? corpo : {});
  } catch (e) {
    if (!["grande", "json"].includes(e.message)) console.error(e);
    if (!res.headersSent) responder(res, e.message === "grande" ? 413 : 400, { erro: "Pedido inválido." });
  }
};

const criacoes = new Map(); // endereço -> horários das últimas criações
function podeCriar(ip) {
  const agora = Date.now();
  const lista = (criacoes.get(ip) || []).filter((t) => agora - t < 3_600_000);
  if (lista.length >= CRIACOES_POR_HORA) { criacoes.set(ip, lista); return false; }
  lista.push(agora);
  criacoes.set(ip, lista);
  return true;
}

const acharDona = (req, res, b) => {
  const f = fixas.get(String(req.params.slug || "").toLowerCase());
  if (!f) { responder(res, 404, { erro: "Sala não encontrada." }); return null; }
  if (!donoOk(f, b.perfil)) { responder(res, 403, { erro: "Só o dono da sala pode fazer isso." }); return null; }
  return f;
};

// informações públicas: o link de uma sala fixa mostra o nome dela antes de entrar
app.get("/api/sala/:slug", (req, res) => {
  const f = fixas.get(String(req.params.slug || "").toLowerCase());
  responder(res, 200, f ? { fixa: true, nome: f.nome, comSenha: !!f.hash } : { fixa: false });
});

app.post("/api/salas", api(async (req, res, b) => {
  if (!perfilValido(b.perfil)) return responder(res, 401, { erro: "Perfil inválido." });
  const slug = String(b.slug || "").toLowerCase();
  const nome = limpaTexto(b.nome, 40);
  if (!nome) return responder(res, 400, { erro: "Dê um nome para a sala." });
  if (!SLUG_FIXA_RE.test(slug)) return responder(res, 400, { erro: "Endereço inválido: use de 4 a 64 letras minúsculas, números, - ou _." });
  if (fixas.has(slug) || rooms.has(slug)) return responder(res, 409, { erro: "Esse endereço já está em uso." });
  const donoHash = hashToken(b.perfil.token);
  if ([...fixas.values()].filter((f) => f.donoHash === donoHash).length >= MAX_FIXAS_POR_DONO)
    return responder(res, 429, { erro: `Você já tem ${MAX_FIXAS_POR_DONO} salas fixas. Exclua uma para criar outra.` });
  if (fixas.size >= MAX_FIXAS) return responder(res, 429, { erro: "Este servidor atingiu o limite de salas fixas." });
  if (!podeCriar(req.socket.remoteAddress)) return responder(res, 429, { erro: "Muitas salas criadas agora. Tente de novo mais tarde." });

  const f = { slug, nome, donoId: b.perfil.id, donoHash, criadaEm: Date.now() };
  definirSenha(f, String(b.senha || "").slice(0, 64));
  fixas.set(slug, f);
  try { salvarFixas(); }
  catch (e) { fixas.delete(slug); console.error(e); return responder(res, 500, { erro: "Não consegui salvar a sala no servidor." }); }
  responder(res, 201, publica(f));
}));

app.post("/api/minhas-salas", api(async (_req, res, b) => {
  if (!perfilValido(b.perfil)) return responder(res, 401, { erro: "Perfil inválido." });
  responder(res, 200, { salas: [...fixas.values()].filter((f) => donoOk(f, b.perfil)).map(publica) });
}));

app.post("/api/salas/:slug/editar", api(async (req, res, b) => {
  const f = acharDona(req, res, b);
  if (!f) return;
  const antes = { nome: f.nome, salt: f.salt, hash: f.hash };
  if (b.nome !== undefined) {
    const nome = limpaTexto(b.nome, 40);
    if (!nome) return responder(res, 400, { erro: "Dê um nome para a sala." });
    f.nome = nome;
  }
  if (b.senha !== undefined) definirSenha(f, b.senha ? String(b.senha).slice(0, 64) : ""); // "" ou null remove a senha
  try { salvarFixas(); }
  catch (e) { Object.assign(f, antes); console.error(e); return responder(res, 500, { erro: "Não consegui salvar." }); }
  const viva = rooms.get(f.slug);
  if (viva?.fixa) aplicarSenha(viva); // vale já para quem tentar entrar agora
  responder(res, 200, publica(f));
}));

app.post("/api/salas/:slug/excluir", api(async (req, res, b) => {
  const f = acharDona(req, res, b);
  if (!f) return;
  fixas.delete(f.slug);
  try { salvarFixas(); }
  catch (e) { fixas.set(f.slug, f); console.error(e); return responder(res, 500, { erro: "Não consegui salvar." }); }
  const viva = rooms.get(f.slug);
  if (viva?.fixa) { // quem estava dentro é avisado e desconectado
    rooms.delete(f.slug);
    for (const p of viva.values()) { send(p.ws, { type: "closed" }); p.ws.close(); }
  }
  responder(res, 200, { ok: true });
}));

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const rooms = new Map(); // Map<sala, Map<peerId, { ws, name, foto, owner }>> + .salt/.hash (senha), .sharer (quem transmite), .fails/.lockedUntil/.expira, .fixa
// Senha guardada como HMAC-SHA256 com sal aleatório por sala; comparação em tempo constante.
const digest = (salt, t) => createHmac("sha256", salt).update(String(t || "")).digest();
const senhaOk = (room, t) => timingSafeEqual(digest(room.salt, t), room.hash);
// Sala fixa: o dono é sempre o anfitrião quando está presente. Nas demais: quem está há mais tempo na sala.
const hostId = (room) => {
  if (room.fixa) for (const [pid, p] of room) if (p.owner) return pid;
  return room.keys().next().value;
};
// (sala viva) senha e sal vêm do registro da sala fixa
function aplicarSenha(room) {
  room.salt = Buffer.from(room.fixa.salt, "base64");
  room.hash = room.fixa.hash ? Buffer.from(room.fixa.hash, "base64") : null;
}
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
      const pedida = String(msg.room);
      if (!ROOM_RE.test(pedida)) {
        send(ws, { type: "invalid-room" });
        return ws.close();
      }
      const fixa = fixas.get(pedida.toLowerCase());
      const rid = fixa ? fixa.slug : pedida;
      const pw = String(msg.password || "").slice(0, 64);
      if (!rooms.has(rid)) {
        const nova = new Map();
        nova.sharer = null;
        nova.fails = 0;
        nova.lockedUntil = 0;
        if (fixa) {
          nova.fixa = fixa;
          aplicarSenha(nova); // a senha vem do registro da sala fixa
        } else {
          nova.salt = randomBytes(16);
          nova.hash = pw ? digest(nova.salt, pw) : null; // quem cria a sala define a senha (opcional)
        }
        rooms.set(rid, nova);
      }
      const room = rooms.get(rid);
      const dono = !!(room.fixa && donoOk(room.fixa, msg.owner)); // o dono entra sem digitar a senha
      if (room.hash && !dono) {
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
      const name = limpaTexto(msg.name, 24) || "anônimo";
      const foto = fotoValida(msg.foto);
      const peers = [...room].map(([pid, p]) => ({ id: pid, name: p.name, foto: p.foto, dono: p.owner }));
      const hostAntes = room.size ? hostId(room) : null;
      room.set(id, { ws, name, foto, owner: dono });
      const sala = room.fixa ? { fixa: true, nome: room.fixa.nome } : null;
      send(ws, { type: "joined", id, peers, host: hostId(room), sharer: room.sharer, sala });
      broadcast(room, { type: "peer-joined", id, name, foto, dono }, id);
      // quando o dono chega a uma sala que já tem gente, ele assume o posto de anfitrião
      if (hostAntes && hostAntes !== hostId(room)) broadcast(room, { type: "host", id: hostId(room) }, id);
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
      if (room.fixa) return; // sala fixa fica na memória (com a contagem de senhas erradas) até ser excluída
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
