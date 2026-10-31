import { lerPerfil, credenciais, pintarDisco } from "/perfil.js";

const roomId = location.pathname.split("/").filter(Boolean).pop() || ""; // ignora barra no final da URL
const $ = (id) => document.getElementById(id);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// O que este navegador consegue transmitir. Celulares em geral não capturam a tela; sem isso, os botões só confundem.
const semCaptura = window.isSecureContext && !navigator.mediaDevices?.getDisplayMedia;
const semArquivo = !(HTMLVideoElement.prototype.captureStream || HTMLVideoElement.prototype.mozCaptureStream);

const peers = new Map(); // id -> { id, pc, polite, makingOffer, ignoreOffer, senders:{tela:[],voz:[]} }
const nomes = new Map(); // id -> nome
const tipos = new Map(); // streamId remoto -> "voz" (as demais são a transmissão de tela/arquivo)
const locais = { tela: null, voz: null }; // o que eu envio: tela/arquivo e o microfone
let micMudo = false, abrindoMic = false;
const vozEstado = new Map(); // id -> "on" | "mudo" (quem está no chat de voz)
const perfil = lerPerfil(); // nome + foto + código do dono (só neste navegador); null = visitante sem perfil
const fotos = new Map();    // id -> foto (data URL) dos outros
let ws, myId, hostId = null, sharerId = null, senha = "", nomeAtual = "";
let encerrado = false, tentativas = 0, timerReconexao = null, modoArquivo = false, estadoRemoto = null, arrastando = false, resolverReserva = null;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

/* ---------- entrada e conexão ---------- */
$("nome").value = localStorage.getItem("nome") || "";
if (perfil) { // com perfil, o nome e a foto vêm dele
  $("nome").hidden = true;
  $("dica-entrada").hidden = true;
  $("quem").hidden = false;
  $("quem-nome").textContent = perfil.nome;
  pintarDisco($("quem-foto"), perfil.nome, perfil.foto);
} else {
  $("criar-perfil-link").hidden = false;
}
fetch(`/api/sala/${encodeURIComponent(roomId)}`).then((r) => r.json()).then((i) => { // sala fixa: mostra o nome antes de entrar
  if (!i.fixa) return;
  $("sala-nome").textContent = i.nome;
  $("sala-nome").hidden = false;
  document.title = `${i.nome} · Loge`;
}).catch(() => {});
// Atenção: com `onkeydown = (e) => e.key === "Enter" && ...` toda tecla que não é Enter devolvia `false`,
// e um handler `on...` que devolve false cancela a tecla: o campo ficava vazio e o nome virava "anônimo".
// Por isso o Enter é tratado com addEventListener e sem retorno.
const enterEntra = (e) => { if (e.key === "Enter") $("entrar").click(); };
$("nome").addEventListener("keydown", enterEntra);
$("senha").addEventListener("keydown", enterEntra);

$("entrar").onclick = async () => {
  prepararPlayers(); // precisa rodar já, dentro do toque, antes de qualquer await
  const nome = perfil ? perfil.nome : $("nome").value.trim() || "anônimo";
  if (!perfil) localStorage.setItem("nome", nome);
  senha = $("senha").hidden ? sessionStorage.getItem("senha:" + roomId) || "" : $("senha").value;
  if (senha) sessionStorage.setItem("senha:" + roomId, senha);
  nomeAtual = nome;
  $("entrada").hidden = true;
  $("sala").hidden = false;
  garantirAvatar("eu", nome, true, perfil?.foto);
  try { iceServers = (await (await fetch("/ice")).json()).iceServers; } catch {}
  encerrado = false;
  conectar();
};

function conectar() {
  clearTimeout(timerReconexao); // evita duas conexões se a reconexão foi antecipada
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    ultimoSinal = Date.now();
    iniciarBatimento();
    definirEstadoConexao("conectando");
    ws.send(JSON.stringify({ type: "join", room: roomId, name: nomeAtual, password: senha, foto: perfil?.foto, owner: perfil ? credenciais(perfil) : undefined }));
  };
  ws.onmessage = async ({ data }) => {
    ultimoSinal = Date.now();
    const msg = JSON.parse(data);
    switch (msg.type) {
      case "pong": break;
      case "joined":
        tentativas = 0;
        definirEstadoConexao("conectado");
        myId = msg.id; hostId = msg.host; sharerId = msg.sharer;
        if (msg.sala) document.title = `${msg.sala.nome} · Loge`;
        msg.peers.forEach((p) => { nomes.set(p.id, p.name); fotos.set(p.id, p.foto); garantirAvatar(p.id, p.name, false, p.foto); criarPeer(p.id); });
        atualizarStatus();
        atualizarEstadoTransmissao();
        if (locais.tela) ws.send(JSON.stringify({ type: "share-start" })); // reconectou transmitindo
        if (locais.voz) { enviarMic(); recuperarMic(); } // reconectou na voz: confere se o microfone ainda está vivo
        break;
      case "peer-joined":
        nomes.set(msg.id, msg.name);
        fotos.set(msg.id, msg.foto);
        garantirAvatar(msg.id, msg.name, false, msg.foto);
        criarPeer(msg.id);
        aviso(`${msg.name} entrou`);
        atualizarStatus();
        if (locais.voz) enviarMic(); // quem acabou de chegar precisa saber se estou na voz ou mutado
        break;
      case "peer-left":
        aviso(`${nomes.get(msg.id) || "Alguém"} saiu`);
        removerPeer(msg.id);
        atualizarStatus();
        atualizarEstadoTransmissao();
        break;
      case "host": hostId = msg.id; atualizarStatus(); break;
      case "sharer": sharerId = msg.id; if (!msg.id) { estadoRemoto = null; encerrarVideoRemoto(); } atualizarStatus(); atualizarEstadoTransmissao(); break;
      case "share-ok": sharerId = myId; resolverReserva?.(msg); atualizarStatus(); atualizarEstadoTransmissao(); break;
      case "share-denied":
        if (resolverReserva) resolverReserva(msg);
        else { negarPalco(msg); pararTransmissao(); }
        break;
      case "stop-share": aviso("O anfitrião liberou o palco."); pararTransmissao(); break;
      case "sync": tratarSync(msg.from, msg.data); break;
      case "need-password": case "wrong-password": pedirSenha(msg.type === "wrong-password"); break;
      case "locked": pedirSenha(true, "Muitas tentativas. Tente de novo em 1 minuto."); break;
      case "signal": await tratarSinal(msg.from, msg.data); break;
      case "chat": mensagem(msg); break;
      case "reaction": mostrarReacao(msg); break;
      case "closed": encerrado = true; alert("Esta sala foi excluída pelo dono."); location.href = "/"; break;
      case "full": encerrado = true; alert("Sala cheia."); break;
      case "invalid-room": encerrado = true; alert("Link de sala inválido."); break;
    }
  };
  ws.onclose = () => {
    pararBatimento();
    limparPeers();
    if (encerrado) { definirEstadoConexao("desconectado"); return; }
    definirEstadoConexao("reconectando");
    timerReconexao = setTimeout(conectar, Math.min(1000 * 2 ** tentativas++, 10000));
  };
}

/* ---------- conexão viva? ---------- */
// No celular a conexão pode morrer sem aviso (troca de rede, tela bloqueada): o navegador continua dizendo "conectado"
// e as mensagens somem. Por isso o site manda um "ping" e, se nada voltar, derruba e reconecta na hora.
let ultimoSinal = Date.now(), timerBatimento = null, timerVerifica = null;
const BATIMENTO_MS = 10_000, SEM_SINAL_MS = 25_000;

function iniciarBatimento() {
  pararBatimento();
  timerBatimento = setInterval(() => {
    if (ws?.readyState !== 1) return;
    if (Date.now() - ultimoSinal > SEM_SINAL_MS) return reconectarJa("sem resposta do servidor");
    ws.send(JSON.stringify({ type: "ping" }));
  }, BATIMENTO_MS);
}
function pararBatimento() { clearInterval(timerBatimento); clearTimeout(timerVerifica); timerBatimento = timerVerifica = null; }

function reconectarJa() {
  if (encerrado) return;
  const velho = ws;
  if (velho) { velho.onopen = velho.onmessage = velho.onclose = null; try { velho.close(); } catch {} }
  pararBatimento();
  limparPeers();
  definirEstadoConexao("reconectando");
  tentativas = 0;
  conectar();
}

// Pergunta ao servidor se ainda está lá; sem resposta em 3 s, reconecta
function verificarConexao() {
  if (encerrado || !ws) return;
  if (ws.readyState !== 1) { if (ws.readyState === 3) reconectarJa(); return; }
  const antes = ultimoSinal;
  try { ws.send(JSON.stringify({ type: "ping" })); } catch { return reconectarJa(); }
  clearTimeout(timerVerifica);
  timerVerifica = setTimeout(() => { if (ultimoSinal === antes) reconectarJa(); }, 3000);
}
// Dá para mandar? Se a conexão está duvidosa, confere e avisa em vez de perder a mensagem em silêncio.
function conexaoOk(oQue) {
  if (ws?.readyState === 1 && Date.now() - ultimoSinal < SEM_SINAL_MS) return true;
  aviso(`Conexão instável; reconectando. Tente enviar ${oQue} de novo em instantes.`);
  verificarConexao();
  return false;
}
window.addEventListener("online", verificarConexao);
window.addEventListener("pageshow", (e) => { if (e.persisted) { verificarConexao(); recuperarMic(); } });

function limparPeers() {
  [...peers.keys()].forEach(removerPeer);
  nomes.clear();
  fotos.clear();
  hostId = sharerId = estadoRemoto = null;
}

function pedirSenha(errada, texto) {
  encerrado = true;
  sessionStorage.removeItem("senha:" + roomId);
  $("sala").hidden = true;
  $("entrada").hidden = false;
  $("senha").hidden = false;
  $("senha").value = "";
  $("erro-senha").hidden = false;
  $("erro-senha").textContent = texto || (errada ? "Senha incorreta." : "Esta sala tem senha.");
  $("senha").focus();
}

const enviarSinal = (to, data) =>
  ws?.readyState === 1 && ws.send(JSON.stringify({ type: "signal", to, data }));

function definirEstadoConexao(estado) {
  const status = $("status");
  const texto = $("conexao-txt");
  if (!status || !texto) return;
  const rotulos = { conectando: "Conectando…", conectado: "Online", reconectando: "Reconectando…", desconectado: "Offline" };
  status.dataset.conexao = estado;
  status.title = rotulos[estado] || "Estado da conexão";
  texto.textContent = rotulos[estado] || "Conectando…";
}

// O robozinho "Transmissão encerrada" só aparece depois que uma transmissão realmente aconteceu e terminou.
// Antes disso, o palco vazio mostra "Nenhuma transmissão ainda…".
let jaHouveTransmissao = false;
function atualizarEstadoTransmissao() {
  const aviso = $("transmissao-encerrada");
  if (!aviso) return;
  const ativa = !!sharerId || !!locais.tela || modoArquivo; // eu mesmo começando a transmitir também conta
  if (ativa) jaHouveTransmissao = true;
  const encerrada = !ativa && jaHouveTransmissao;
  aviso.hidden = !encerrada;
  $("quadro")?.classList.toggle("sem-transmissao", encerrada);
}
function encerrarVideoRemoto() {
  document.querySelectorAll("#palco video:not(#v-local)").forEach(devolverPlayer);
  renderRemoto();
  atualizarWakeLock();
}

function atualizarStatus() {
  $("contagem").textContent = `${peers.size + 1} na sala`;
  document.querySelectorAll(".avatar").forEach((f) => {
    const eu = f.dataset.avatar === "eu";
    const ehHost = (eu ? myId : f.dataset.avatar) === hostId;
    f.querySelector("figcaption").textContent = (ehHost ? "★ " : "") + (eu ? "Você" : f.dataset.nome);
  });
  $("liberar").hidden = !(myId && myId === hostId && sharerId && sharerId !== myId);
}

/* ---------- avatares (bolinhas da sala) ---------- */

function garantirAvatar(id, nome, eu = false, foto = null) {
  let el = document.querySelector(`[data-avatar="${id}"]`);
  const rotulo = eu ? "Você" : nome;
  if (el) { el.querySelector("figcaption").textContent = rotulo; return el; }

  el = document.createElement("figure");
  el.className = "avatar";
  el.dataset.avatar = id;
  el.dataset.nome = nome;
  if (!eu) el.dataset.peer = id; // removerPeer() apaga tudo que tem data-peer

  const disco = document.createElement("div");
  disco.className = "disco";
  pintarDisco(disco, nome, foto);

  const legenda = document.createElement("figcaption");
  legenda.textContent = rotulo;

  const voz = document.createElement("span"); // marca de microfone: ao vivo ou mutado
  voz.className = "voz";
  voz.hidden = true;

  el.append(disco, legenda, voz);

  const lista = $("avatares");
  const meu = lista.querySelector('[data-avatar="eu"]');
  if (meu && !eu) lista.insertBefore(el, meu); // "Você" fica sempre por último
  else lista.append(el);
  pintarVoz(eu ? "eu" : id);
  return el;
}

function destacar(id) {
  const el = document.querySelector(`[data-avatar="${id}"]`);
  if (!el) return;
  el.classList.add("ativo");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("ativo"), 3000);
}

/* ---------- WebRTC (perfect negotiation) ---------- */
function criarPeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers });
  const peer = { id, pc, polite: myId > id, makingOffer: false, ignoreOffer: false,
    senders: { tela: [], voz: [] } };
  peers.set(id, peer);

  pc.onicecandidate = ({ candidate }) => candidate && enviarSinal(id, { candidate });
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      enviarSinal(id, { description: pc.localDescription });
    } catch (e) { console.error(e); }
    finally { peer.makingOffer = false; }
  };
  pc.ontrack = ({ streams: [stream] }) => {
    if (!stream) return;
    if (tipos.get(stream.id) === "voz") tocarVoz(id, stream); // áudio do chat de voz: não vira vídeo no palco
    else mostrarRemoto(id, stream);
  };
  // Troca de rede (Wi-Fi para 4G) ou volta do segundo plano no celular: tenta refazer o caminho em vez de ficar mudo
  pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") pc.restartIce?.(); };

  if (locais.tela) adicionarStream(peer, "tela");
  if (locais.voz) adicionarStream(peer, "voz");
  return peer;
}

async function tratarSinal(from, { description, candidate, info }) {
  if (info) { tipos.set(info.streamId, info.tipo); return; } // avisa o que é a próxima stream (chega antes das trilhas)
  const peer = criarPeer(from);
  const { pc } = peer;
  try {
    if (description) {
      const colisao = description.type === "offer" &&
        (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && colisao;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === "answer") aplicarQualidade(peer);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        enviarSinal(from, { description: pc.localDescription });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { if (!peer.ignoreOffer) throw e; }
    }
  } catch (e) { console.error(e); }
}

function removerPeer(id) {
  const peer = peers.get(id);
  if (peer) { peer.pc.close(); peers.delete(id); }
  document.querySelectorAll(`[data-peer="${id}"]`).forEach((el) => {
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") devolverPlayer(el); else el.remove();
  });
  medidores.get(id)?.(); medidores.delete(id);
  vozEstado.delete(id);
}

/* ---------- envio de streams (tela, arquivo ou microfone) ---------- */
function adicionarStream(peer, tipo) {
  const stream = locais[tipo];
  if (!stream) return;
  if (tipo === "voz") enviarSinal(peer.id, { info: { streamId: stream.id, tipo } }); // antes das trilhas, para o outro lado tocar como áudio
  for (const t of stream.getTracks()) {
    if (tipo === "tela" && t.kind === "video") t.contentHint = $("dica").value;
    const sender = peer.pc.addTrack(t, stream);
    peer.senders[tipo].push(sender);
    if (tipo === "tela" && t.kind === "video") escolherCodec(peer.pc, sender);
  }
}

function removerStream(tipo) {
  peers.forEach((p) => {
    p.senders[tipo].forEach((s) => { try { p.pc.removeTrack(s); } catch {} });
    p.senders[tipo] = [];
  });
  locais[tipo]?.getTracks().forEach((t) => t.stop());
  locais[tipo] = null;
}

function escolherCodec(pc, sender) {
  const escolhido = $("codec").value;
  if (escolhido === "auto") return;
  const tr = pc.getTransceivers().find((t) => t.sender === sender);
  const caps = RTCRtpSender.getCapabilities("video")?.codecs;
  if (!tr?.setCodecPreferences || !caps) return;
  const mime = "video/" + escolhido;
  const pref = caps.filter((c) => c.mimeType === mime);
  if (!pref.length) return; // navegador não suporta: usa o padrão
  tr.setCodecPreferences([...pref, ...caps.filter((c) => c.mimeType !== mime)]);
}

async function aplicarQualidade(peer) {
  const bps = Number($("bitrate").value) * 1_000_000;
  const fps = Number($("fps").value);
  const nitidez = $("dica").value === "detail";
  for (const s of peer.senders.tela) {
    if (s.track?.kind !== "video") continue;
    const params = s.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bps;
    params.encodings[0].maxFramerate = fps;
    params.degradationPreference = nitidez ? "maintain-resolution" : "maintain-framerate";
    try { await s.setParameters(params); } catch (e) { console.warn("setParameters:", e); }
  }
}

for (const id of ["bitrate", "fps", "dica"]) {
  $(id).onchange = () => {
    locais.tela?.getVideoTracks().forEach((t) => (t.contentHint = $("dica").value));
    peers.forEach(aplicarQualidade);
  };
}

/* ---------- tela ---------- */
$("tela").onclick = async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return aviso(window.isSecureContext
      ? "Este navegador não permite compartilhar a tela (comum em celulares). Use um computador."
      : "Compartilhar tela exige HTTPS ou localhost (veja o README). Use um túnel HTTPS ou abra por http://localhost.");
  }
  const [w, h] = $("res").value.split("x").map(Number);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: Number($("fps").value) } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch { return; } // cancelou
  pararTransmissao();
  const r = await reservarPalco();
  if (r.type === "share-denied") { stream.getTracks().forEach((t) => t.stop()); return negarPalco(r); }
  const v = document.createElement("video");
  v.id = "v-local"; v.muted = true; v.autoplay = true; v.playsInline = true;
  v.srcObject = stream;
  $("palco").prepend(v);
  transmitir(stream);
};

function transmitir(stream) {
  locais.tela = stream;
  atualizarEstadoTransmissao();
  stream.getVideoTracks()[0]?.addEventListener("ended", pararTransmissao);
  peers.forEach((p) => adicionarStream(p, "tela"));
  atualizarBotoes();
  atualizarWakeLock();
}

function pararTransmissao() {
  const tinhaTela = !!locais.tela;
  if (locais.tela) removerStream("tela");
  const v = $("v-local");
  if (v) {
    v.onpause = null; // de propósito: ao parar a transmissão a pausa é permitida
    v.pause?.();
    if (v.src?.startsWith("blob:")) URL.revokeObjectURL(v.src);
    v.remove();
  }
  $("arquivo").value = "";
  const estava = modoArquivo || sharerId === myId || tinhaTela;
  modoArquivo = false;
  if (estava && ws?.readyState === 1) ws.send(JSON.stringify({ type: "share-stop" }));
  if (sharerId === myId) sharerId = null;
  atualizarEstadoTransmissao();
  atualizarBotoes();
  atualizarStatus();
  atualizarEstadoTransmissao();
  atualizarWakeLock();
}
$("parar").onclick = pararTransmissao;

/* ---------- arquivo local ---------- */
$("arquivo").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pararTransmissao(); // antes de reservar, como no fluxo de tela: senão o share-stop desfaria a reserva
  const r = await reservarPalco();
  if (r.type === "share-denied") { e.target.value = ""; return negarPalco(r); }
  const v = document.createElement("video");
  v.id = "v-local"; v.playsInline = true; // sem controles: ninguém pausa, nem quem transmite
  v.disablePictureInPicture = true;
  v.onpause = () => { if (!v.ended) v.play().catch(() => {}); }; // se algo pausar, volta a tocar
  v.src = URL.createObjectURL(file);
  $("palco").prepend(v);
  try { await v.play(); } catch {}
  const capturar = v.captureStream || v.mozCaptureStream;
  if (!capturar) {
    alert("Este navegador não consegue capturar vídeo de arquivo.");
    pararTransmissao(); // sharerId === myId (share-ok), então isso também libera o palco no servidor
    return;
  }
  transmitir(capturar.call(v));
  modoArquivo = true;
  enviarEstado();
};

function atualizarBotoes() {
  const transmitindo = !!locais.tela;
  $("tela").hidden = transmitindo || semCaptura;
  $("arquivo-label").hidden = transmitindo || semArquivo;
  $("parar").hidden = !transmitindo;
  $("qualidade").hidden = semCaptura && semArquivo; // só quem transmite usa a qualidade
  document.body.classList.toggle("so-assiste", semCaptura && semArquivo);
}

/* ---------- áudio sempre ligado e vídeo sem pausa ----------
   Navegadores (principalmente o Safari do iPhone) só tocam com som elementos que já tocaram dentro de um toque
   do usuário. Por isso, no toque de "Entrar" preparamos alguns players (tocando um silêncio); depois, cada vídeo
   ou voz que chega usa um desses players e já sai com som, sem botão de "ativar áudio".
   Se mesmo assim o navegador recusar, o vídeo toca mudo e o som liga no primeiro toque em qualquer lugar. */
const SILENCIO = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const piscina = { video: [], audio: [] };
const semSom = new Set(); // vídeos que tiveram de começar mudos

function novoPlayer(tag) {
  const el = document.createElement(tag);
  el.autoplay = true;
  el.playsInline = true;
  el.setAttribute("playsinline", "");
  return el;
}

function prepararPlayers() { // chamado dentro do toque em "Entrar"
  for (const [tag, qtd] of [["video", 2], ["audio", 8]]) {
    while (piscina[tag].length < qtd) {
      const el = novoPlayer(tag);
      el.src = SILENCIO;
      el.play().catch(() => {});
      piscina[tag].push(el);
    }
  }
  try { ctxAudio ||= new (window.AudioContext || window.webkitAudioContext)(); ctxAudio.resume?.(); } catch {}
}

function pegarPlayer(tag) {
  const el = piscina[tag].pop() || novoPlayer(tag);
  el.removeAttribute("src");
  el.muted = false;
  return el;
}

function devolverPlayer(el) {
  pendentes.delete(el);
  semSom.delete(el);
  el.onpause = null;
  try { el.pause(); } catch {}
  el.srcObject = null;
  delete el.dataset.stream;
  delete el.dataset.peer;
  el.remove();
  const tag = el.tagName.toLowerCase();
  if (piscina[tag] && piscina[tag].length < 8) piscina[tag].push(el);
}

function tocarComSom(el) {
  el.play().catch(() => { // o navegador recusou o som: toca mudo e liga o som no próximo toque
    el.muted = true;
    el.play().catch(() => {});
    semSom.add(el);
  });
}

/* ---------- vídeos remotos ---------- */
function mostrarRemoto(peerId, stream) {
  let el = document.querySelector(`video[data-stream="${stream.id}"]`);
  if (!el) {
    el = pegarPlayer("video");
    el.dataset.stream = stream.id;
    el.dataset.peer = peerId;
    el.volume = $("rc-vol").value / 100;
    el.srcObject = stream;
    // sem pausa para ninguém: se algo pausar (toque, player nativo do iPhone, trocar de app), volta a tocar
    el.onpause = () => { if (!el.ended && el.srcObject) el.play().catch(() => {}); };
    $("palco").append(el);
    atualizarEstadoTransmissao();
    tocarComSom(el);
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) { devolverPlayer(el); atualizarWakeLock(); renderRemoto(); }
    };
  }
  if (el.srcObject !== stream) el.srcObject = stream;
  renderRemoto();
  atualizarWakeLock();
}

/* ---------- celular: manter a tela ligada e reconectar ao voltar do segundo plano ---------- */
let wakeLock = null, pedindoWakeLock = false;
async function atualizarWakeLock() {
  if (!("wakeLock" in navigator) || pedindoWakeLock) return;
  const querLigada = !!document.querySelector("#palco video");
  try {
    if (querLigada && !wakeLock && document.visibilityState === "visible") {
      pedindoWakeLock = true;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!querLigada && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* sem permissão ou bateria fraca: segue sem */ }
  finally { pedindoWakeLock = false; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  atualizarWakeLock(); // o navegador solta o wake lock quando a aba some
  // o celular derruba o WebSocket em segundo plano: reconecta já, sem esperar o próximo ciclo do backoff
  if (ws && !encerrado && ws.readyState === WebSocket.CLOSED) { tentativas = 0; conectar(); }
  else { ultimoSinal = Date.now(); verificarConexao(); } // timers pausados em segundo plano não contam como "sem sinal"
  recuperarMic();
});
// Ao sair da página, solta o microfone: no iPhone a página antiga pode continuar segurando e a próxima visita falha
window.addEventListener("pagehide", (e) => {
  if (e.persisted) return; // vai para o cache de volta/avançar: ao voltar, "pageshow" recupera
  try { locais.voz?.getTracks().forEach((t) => t.stop()); } catch {}
});

/* ---------- chat de voz ----------
   O microfone é mais uma faixa nas mesmas conexões WebRTC da transmissão (peer a peer, sem passar pelo servidor).
   Mutar só desliga a faixa (`enabled = false`): o navegador continua com o microfone aberto, como no Discord,
   e desmutar é instantâneo. Fone de ouvido é o ideal: com o som do filme no alto-falante, o microfone o capta. */
let ctxAudio = null;
const pendentes = new Set();   // áudios que o navegador não deixou tocar sem um toque do usuário (iPhone)
const medidores = new Map();   // chave -> função que para o medidor de volume

function tocar(el) { el.play().catch(() => pendentes.add(el)); }
document.addEventListener("pointerdown", () => {
  try { ctxAudio?.resume?.(); } catch {}
  for (const el of [...pendentes]) { pendentes.delete(el); tocar(el); }
  for (const el of [...semSom]) { semSom.delete(el); el.muted = false; el.play().catch(() => {}); }
}, true);

function tocarVoz(peerId, stream) {
  if (document.querySelector(`audio[data-stream="${stream.id}"]`)) return;
  const el = pegarPlayer("audio");
  el.dataset.stream = stream.id;
  el.dataset.peer = peerId; // removerPeer() devolve junto com o resto da pessoa
  el.srcObject = stream;
  $("voz").append(el);
  tocar(el);
  ouvirNivel(stream, peerId);
  stream.onremovetrack = () => { if (!stream.getTracks().length) devolverPlayer(el); };
}

// Anel dourado no avatar de quem está falando (mede o volume da faixa; não muda o áudio)
function ouvirNivel(stream, chave) {
  try {
    ctxAudio ||= new (window.AudioContext || window.webkitAudioContext)();
    const fonte = ctxAudio.createMediaStreamSource(stream);
    const an = ctxAudio.createAnalyser();
    an.fftSize = 512;
    fonte.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let ate = 0;
    const timer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let soma = 0;
      for (const v of buf) { const x = (v - 128) / 128; soma += x * x; }
      if (Math.sqrt(soma / buf.length) > 0.03) ate = Date.now() + 350;
      document.querySelector(`[data-avatar="${chave}"]`)?.classList.toggle("falando", Date.now() < ate);
    }, 120);
    medidores.get(chave)?.();
    medidores.set(chave, () => { clearInterval(timer); try { fonte.disconnect(); } catch {} });
  } catch { /* sem WebAudio: só não aparece o anel */ }
}

const estadoMic = () => (!locais.voz ? "off" : micMudo ? "mudo" : "on");
const enviarMic = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "sync", data: { k: "mic", e: estadoMic() } }));

function definirVoz(id, e) { vozEstado.set(id, e); pintarVoz(id); }

function pintarVoz(id) {
  const el = document.querySelector(`[data-avatar="${id}"]`);
  if (!el) return;
  const e = id === "eu" ? estadoMic() : vozEstado.get(id) || "off";
  const marca = el.querySelector(".voz");
  if (e === "off") { delete el.dataset.voz; marca.hidden = true; el.classList.remove("falando"); return; }
  el.dataset.voz = e;
  marca.hidden = false;
  marca.textContent = e === "mudo" ? "🔇" : "🎙️";
  marca.title = e === "mudo" ? "Mutado" : "Na voz";
  if (e === "mudo") el.classList.remove("falando");
}

function atualizarMic() {
  const dentro = !!locais.voz;
  const b = $("mic");
  b.classList.toggle("ao-vivo", dentro && !micMudo);
  b.classList.toggle("mudo", dentro && micMudo);
  b.setAttribute("aria-pressed", String(dentro && !micMudo));
  $("mic-txt").textContent = abrindoMic ? "Abrindo…" : !dentro ? "Entrar na voz" : micMudo ? "Desmutar" : "Mutar";
  b.setAttribute("aria-busy", String(abrindoMic));
  b.title = !dentro ? "Entrar no chat de voz (depois, M muta e desmuta)" : micMudo ? "Desmutar o microfone (M)" : "Mutar o microfone (M)";
  b.setAttribute("aria-label", b.title);
  document.querySelector(".ico-mic").hidden = dentro && micMudo;
  document.querySelector(".ico-mudo").hidden = !(dentro && micMudo);
  pintarVoz("eu");
}

// Abre o microfone com tempo limite (no iPhone o pedido às vezes trava sem resposta) e algumas tentativas
// (o microfone pode ainda estar sendo solto pela página anterior). Se as opções de limpeza de ruído falharem, tenta o básico.
const comTempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("tempo"), { name: "TimeoutError" })), ms))]);
async function abrirMicrofone() {
  const pedidos = [
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
    { audio: true, video: false },
  ];
  let ultimo;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    for (const pedido of pedidos) {
      try { return await comTempo(navigator.mediaDevices.getUserMedia(pedido), 12000); }
      catch (e) {
        ultimo = e;
        // permissão negada, sem microfone ou pedido travado: insistir não adianta (e pedidos travados não se empilham)
        if (["NotAllowedError", "SecurityError", "NotFoundError", "TimeoutError"].includes(e.name)) throw e;
      }
    }
    await new Promise((r) => setTimeout(r, 700 * (tentativa + 1)));
  }
  throw ultimo;
}
const erroMic = (e) =>
  e.name === "NotAllowedError" ? "Permissão do microfone negada. Libere nas configurações do navegador."
  : e.name === "NotFoundError" ? "Nenhum microfone encontrado."
  : e.name === "NotReadableError" || e.name === "AbortError"
    ? "O microfone está em uso por outro app ou aba. Feche a outra aba do Loge (ou o app que usa o microfone) e toque de novo."
  : e.name === "TimeoutError" ? "O celular não respondeu ao pedido do microfone. Toque de novo."
  : "Não consegui abrir o microfone. Toque de novo.";

// Vigia a faixa do microfone: o iPhone costuma só silenciá-la (evento "mute") quando outro app ou uma ligação a interrompe,
// e o botão continuava "ligado" sem ninguém ouvir.
let timerMudoSistema = null;
function vigiarMic(stream) {
  const faixa = stream.getAudioTracks()[0];
  if (!faixa) return;
  faixa.addEventListener("ended", () => { // desconectou o fone, revogou a permissão ou o sistema soltou
    if (locais.voz !== stream) return;
    recuperarMic(true);
  });
  faixa.addEventListener("mute", () => {
    if (locais.voz !== stream) return;
    clearTimeout(timerMudoSistema);
    timerMudoSistema = setTimeout(() => {
      if (locais.voz === stream && faixa.muted && document.visibilityState === "visible") recuperarMic();
    }, 2000);
  });
  faixa.addEventListener("unmute", () => clearTimeout(timerMudoSistema));
}

let recuperando = false;
// Se a faixa do microfone morreu ou ficou muda pelo sistema, abre outra e troca nas conexões sem reentrar na voz
async function recuperarMic(forcar = false) {
  if (!locais.voz || recuperando || abrindoMic) return;
  const faixa = locais.voz.getAudioTracks()[0];
  const ruim = !faixa || faixa.readyState === "ended" || faixa.muted;
  if (!ruim && !forcar) return;
  recuperando = true;
  try {
    const novo = await abrirMicrofone();
    const nova = novo.getAudioTracks()[0];
    nova.enabled = !micMudo; // mantém mutado quem estava mutado
    const velho = locais.voz;
    peers.forEach((p) => p.senders.voz.forEach((s) => { if (s.track?.kind === "audio" || !s.track) s.replaceTrack(nova).catch(() => {}); }));
    locais.voz = novo;
    velho.getTracks().forEach((t) => t.stop());
    vigiarMic(novo);
    medidores.get("eu")?.(); medidores.delete("eu");
    ouvirNivel(novo, "eu");
    enviarMic(); atualizarMic();
    aviso("Microfone reconectado.");
  } catch (e) {
    if (locais.voz && locais.voz.getAudioTracks()[0]?.readyState === "ended") { // não deu: sai da voz com aviso claro
      removerStream("voz");
      medidores.get("eu")?.(); medidores.delete("eu");
      enviarMic(); atualizarMic();
      aviso("O microfone foi interrompido e não voltou. " + erroMic(e));
    }
  } finally { recuperando = false; }
}

async function entrarNaVoz() {
  if (abrindoMic) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return aviso(window.isSecureContext
      ? "Este navegador não permite usar o microfone."
      : "O microfone exige HTTPS ou localhost (veja o README). Use um túnel HTTPS ou abra por http://localhost.");
  }
  abrindoMic = true;
  atualizarMic();
  let stream;
  try {
    stream = await abrirMicrofone();
  } catch (e) {
    abrindoMic = false;
    atualizarMic();
    return aviso(erroMic(e));
  }
  abrindoMic = false;
  micMudo = false;
  locais.voz = stream;
  vigiarMic(stream);
  peers.forEach((p) => adicionarStream(p, "voz"));
  try { ctxAudio ||= new (window.AudioContext || window.webkitAudioContext)(); ctxAudio.resume?.(); } catch {}
  ouvirNivel(stream, "eu");
  enviarMic();
  atualizarMic();
}

function alternarMudo() {
  const faixa = locais.voz?.getAudioTracks()[0];
  if (!faixa) return;
  micMudo = !micMudo;
  faixa.enabled = !micMudo;
  enviarMic();
  atualizarMic();
}

$("mic").onclick = () => { if (locais.voz) alternarMudo(); else entrarNaVoz(); };
// Atalho M (no computador) para mutar e desmutar sem tirar o olho do filme; ignora quando está digitando
document.addEventListener("keydown", (e) => {
  if (e.key?.toLowerCase() !== "m" || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $("sala").hidden) return;
  if (locais.voz) alternarMudo();
});
atualizarMic();

/* ---------- chat e GIFs ---------- */
$("form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("texto").value.trim();
  if (!text) return;
  if (!conexaoOk("a mensagem")) return; // o texto continua no campo
  ws.send(JSON.stringify({ type: "chat", text }));
  $("texto").value = "";
};

const gifBtn = $("gif-btn");
const gifPanel = $("gif-panel");
const reagirBtn = $("reagir");
let modoReacao = false;

// Safari no iPhone mantém o layout viewport maior que a área visível quando o teclado abre.
// Usamos visualViewport para redimensionar a sala e deixar o chat/GIFs acima do teclado.
const viewportVisual = window.visualViewport;
let campoChatFocado = false;
function atualizarViewportChat() {
  if (!isIOS || !viewportVisual || $("sala").hidden) return;
  // No modo de reprodução em tela cheia, o seletor de reação fica sobre o vídeo,
  // então não aplicamos o layout alternativo do chat quando o teclado abre.
  if (document.body.classList.contains("tela-cheia-mobile")) {
    document.body.classList.remove("teclado-ios");
    document.documentElement.style.removeProperty("--altura-visual");
    return;
  }
  const tecladoAberto = campoChatFocado &&
    viewportVisual.height < window.innerHeight * 0.82;
  document.body.classList.toggle("teclado-ios", tecladoAberto);
  if (tecladoAberto) {
    document.documentElement.style.setProperty("--altura-visual", viewportVisual.height + "px");
    requestAnimationFrame(() => {
      const alvo = document.activeElement;
      if (!alvo || !["texto", "gif-search"].includes(alvo.id)) return;
      // Corrige o scroll interno do Safari sem deslocar a página inteira.
      const limite = viewportVisual.offsetTop + viewportVisual.height - 12;
      const rect = alvo.getBoundingClientRect();
      if (rect.bottom > limite) {
        $("lateral").scrollTop += rect.bottom - limite;
      }
    });
  } else {
    document.documentElement.style.removeProperty("--altura-visual");
  }
}
if (viewportVisual) {
  viewportVisual.addEventListener("resize", atualizarViewportChat);
  viewportVisual.addEventListener("scroll", atualizarViewportChat);
}
document.addEventListener("focusin", (e) => {
  if (!isIOS) return;
  if (e.target?.id === "texto" || e.target?.id === "gif-search") {
    campoChatFocado = true;
    // Aguarda o Safari começar a animar o teclado antes de medir a área disponível.
    setTimeout(atualizarViewportChat, 80);
  }
});
document.addEventListener("focusout", (e) => {
  if (!isIOS || !["texto", "gif-search"].includes(e.target?.id)) return;
  setTimeout(() => {
    campoChatFocado = ["texto", "gif-search"].includes(document.activeElement?.id);
    atualizarViewportChat();
  }, 100);
});

reagirBtn.onclick = () => {
  modoReacao = true;
  gifPanel.hidden = false;
  gifBtn.setAttribute("aria-expanded", "false");
  if (!gifResults.childElementCount) buscarGifs("reaction");
  gifSearch.placeholder = "Buscar reação GIF...";
  gifSearch.focus();
  // No iPhone, o foco abre o teclado; o visualViewport reposiciona a sala para mostrar os GIFs.
  if (isIOS) {
    campoChatFocado = true;
    setTimeout(atualizarViewportChat, 80);
  }
};
const gifSearch = $("gif-search");
const gifResults = $("gif-results");
let buscaGifTimer = null;
let buscaGifAtual = 0;

gifBtn.onclick = () => {
  const abrir = gifPanel.hidden;
  modoReacao = false;
  gifPanel.hidden = !abrir;
  gifBtn.setAttribute("aria-expanded", String(abrir));
  gifSearch.placeholder = "Buscar GIFs...";
  if (abrir && !gifResults.childElementCount) buscarGifs("");
  if (abrir) {
    gifSearch.focus();
    if (isIOS) {
      campoChatFocado = true;
      setTimeout(atualizarViewportChat, 80);
    }
  } else {
    campoChatFocado = false;
    atualizarViewportChat();
  }
};
$("gif-close").onclick = () => {
  gifPanel.hidden = true;
  gifBtn.setAttribute("aria-expanded", "false");
  modoReacao = false;
  gifSearch.placeholder = "Buscar GIFs...";
  if (isIOS) {
    gifSearch.blur();
    campoChatFocado = $("texto") === document.activeElement;
    setTimeout(atualizarViewportChat, 80);
  }
  programarOcultarControlesReacao();
};
gifSearch.addEventListener("input", () => {
  clearTimeout(buscaGifTimer);
  buscaGifTimer = setTimeout(() => buscarGifs(gifSearch.value.trim()), 300);
});

async function buscarGifs(q) {
  const chamada = ++buscaGifAtual;
  gifResults.replaceChildren();
  const carregando = document.createElement("p");
  carregando.className = "gif-status";
  carregando.textContent = "Buscando GIFs…";
  gifResults.append(carregando);
  try {
    const r = await fetch("/api/gifs?q=" + encodeURIComponent(q));
    const dados = await r.json();
    if (chamada !== buscaGifAtual) return;
    if (!r.ok) throw new Error(dados.erro || "Não foi possível carregar GIFs.");
    gifResults.replaceChildren();
    if (!dados.gifs?.length) {
      const vazio = document.createElement("p");
      vazio.className = "gif-status";
      vazio.textContent = "Nenhum GIF encontrado. Tente outra busca.";
      gifResults.append(vazio);
      return;
    }
    for (const gif of dados.gifs) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "gif-opcao";
      item.title = gif.title || "Enviar GIF";
      item.setAttribute("aria-label", "Enviar GIF: " + (gif.title || "GIF"));
      const img = document.createElement("img");
      img.src = gif.preview || gif.url;
      img.alt = gif.alt || gif.title || "GIF";
      img.loading = "lazy";
      item.append(img);
      item.addEventListener("click", () => modoReacao ? enviarReacao(gif) : enviarGif(gif));
      gifResults.append(item);
    }
  } catch (err) {
    if (chamada !== buscaGifAtual) return;
    gifResults.replaceChildren();
    const erro = document.createElement("p");
    erro.className = "gif-status";
    erro.textContent = err.message || "Erro ao buscar GIFs.";
    gifResults.append(erro);
  }
}

function enviarReacao(gif) {
  if (!conexaoOk("a reação")) return;
  ws.send(JSON.stringify({ type: "reaction", gif: { url: gif.url, title: gif.title || "Reação", alt: gif.alt || gif.title || "Reação GIF" } }));
  gifPanel.hidden = true;
  modoReacao = false;
  gifBtn.setAttribute("aria-expanded", "false");
  gifSearch.placeholder = "Buscar GIFs...";
  programarOcultarControlesReacao();
}

function mostrarReacao({ gif, name }) {
  if (!gif?.url) return;
  const camada = $("reacoes");
  if (!camada || camada.childElementCount >= 5) return;

  const item = document.createElement("div");
  item.className = "reacao-item";

  const img = document.createElement("img");
  img.className = "reacao-gif";
  img.src = gif.url;
  img.alt = gif.alt || "GIF de reação";
  img.draggable = false;

  const autor = document.createElement("span");
  autor.className = "reacao-autor";
  autor.textContent = name || "Alguém";

  item.append(img, autor);
  camada.append(item);
  item.addEventListener("animationend", () => item.remove(), { once: true });
}

function enviarGif(gif) {
  if (!conexaoOk("o GIF")) return;
  ws.send(JSON.stringify({
    type: "chat",
    gif: { url: gif.url, title: gif.title || "GIF", alt: gif.alt || gif.title || "GIF" }
  }));
  gifPanel.hidden = true;
  gifBtn.setAttribute("aria-expanded", "false");
}

function mensagem({ from, name, text, gif }) {
  const eu = from === myId;
  const caixa = document.createElement("div");
  caixa.className = "msg" + (eu ? " eu" : "");
  const autor = document.createElement("span");
  autor.className = "autor";
  autor.textContent = eu ? "Você" : name;
  const balao = document.createElement("div");
  balao.className = "balao" + (gif ? " balao-gif" : "");
  if (text) {
    const conteudo = document.createElement("span");
    conteudo.textContent = text; // textContent evita injeção de HTML
    balao.append(conteudo);
  }
  if (gif?.url) {
    const img = document.createElement("img");
    img.className = "chat-gif";
    img.src = gif.url;
    img.alt = gif.alt || gif.title || "GIF enviado no chat";
    img.loading = "lazy";
    img.decoding = "async";
    balao.append(img);
  }
  const hora = document.createElement("time");
  const agora = new Date();
  hora.className = "hora";
  hora.dateTime = agora.toISOString();
  hora.textContent = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(agora);
  const mensagens = $("msgs");
  const estavaNoFim = mensagens.scrollHeight - mensagens.scrollTop - mensagens.clientHeight < 80;
  caixa.append(autor, balao, hora);
  mensagens.append(caixa);
  if (estavaNoFim || eu) mensagens.scrollTop = mensagens.scrollHeight;
  destacar(eu ? "eu" : from);
}

function aviso(texto) {
  const p = document.createElement("p");
  p.className = "aviso";
  p.textContent = texto;
  $("msgs").append(p);
  $("msgs").scrollTop = $("msgs").scrollHeight;
}

/* ---------- modo cinema, tela cheia, link e estatísticas ---------- */
$("cinema").onchange = () => document.body.classList.toggle("cinema", $("cinema").checked);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (quadro.classList.contains("pseudo-cheia")) return sairCheia();
  if (document.body.classList.contains("cinema")) {
    $("cinema").checked = false;
    document.body.classList.remove("cinema");
  }
});

/* Tela cheia: mantém o quadro como elemento de tela cheia para que os controles
   e as reações continuem por cima do vídeo, inclusive no celular. */
const quadro = $("quadro");
const cheiaNativa = () => document.fullscreenElement || document.webkitFullscreenElement;
const reagirOrigem = reagirBtn.parentNode;
const reagirProximo = reagirBtn.nextSibling;
const gifPainelOrigem = gifPanel.parentNode;
const gifPainelProximo = gifPanel.nextSibling;
const telaPequenaToque = () => matchMedia("(max-width: 900px) and (pointer: coarse)").matches;
let timerControlesReacao = null;

// Os controles de GIF permanecem no chat, inclusive no celular em tela cheia.
// Mantemos esta função para chamadas existentes, sem mover elementos sobre o vídeo.
function moverControlesParaQuadro() {}

function restaurarControlesOriginais() {
  document.body.classList.remove("tela-cheia-mobile");
  quadro.classList.remove("reacoes-visiveis");
  if (timerControlesReacao) clearTimeout(timerControlesReacao);
  timerControlesReacao = null;
}

function programarOcultarControlesReacao() {}


function sairCheia() {
  if (cheiaNativa()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  quadro.classList.remove("pseudo-cheia");
  document.body.classList.remove("trava");
  $("sair-cheia").hidden = true;
  restaurarControlesOriginais();
  try { screen.orientation?.unlock?.(); } catch {}
}

function cheiaFalsa() {
  quadro.classList.add("pseudo-cheia");
  document.body.classList.add("trava");
  $("sair-cheia").hidden = false;
  moverControlesParaQuadro();
}

$("tela-cheia").onclick = async () => {
  if (cheiaNativa() || quadro.classList.contains("pseudo-cheia")) return sairCheia();

  const pedir = quadro.requestFullscreen || quadro.webkitRequestFullscreen;
  if (pedir) {
    try {
      await pedir.call(quadro);
      $("sair-cheia").hidden = false;
      moverControlesParaQuadro();
      if (telaPequenaToque()) {
        try { await screen.orientation?.lock?.("landscape"); } catch { /* iOS/Safari pode não permitir travar a orientação */ }
      }
      return;
    } catch { /* usa o modo de tela cheia alternativo */ }
  }

  // Não usamos o player nativo do iPhone: ele esconde os controles HTML sobre o vídeo.
  cheiaFalsa();
};

$("sair-cheia").onclick = sairCheia;
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) sairCheia();
  else { moverControlesParaQuadro(); }
});
document.addEventListener("webkitfullscreenchange", () => {
  if (!document.webkitFullscreenElement) sairCheia();
  else { moverControlesParaQuadro(); }
});

$("copiar").onclick = async () => {
  const compartilharNoCelular = matchMedia("(pointer: coarse)").matches;
  if (compartilharNoCelular && navigator.share) {
    try {
      await navigator.share({ title: document.title || "Loge", text: "Vem assistir comigo no Loge.", url: location.href });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  try { await navigator.clipboard.writeText(location.href); }
  catch {
    if (navigator.share) {
      try { await navigator.share({ title: document.title || "Loge", text: "Vem assistir comigo no Loge.", url: location.href }); return; }
      catch (err) { if (err?.name === "AbortError") return; }
    }
    prompt("Copie o link da sala:", location.href);
    return;
  }
  $("copiar-txt").textContent = "Copiado!";
  setTimeout(() => ($("copiar-txt").textContent = "Convidar"), 1500);
};

const anterior = {};
setInterval(async () => {
  if (!locais.tela) { $("stats").textContent = ""; return; }
  for (const [id, p] of peers) {
    const s = p.senders.tela.find((x) => x.track?.kind === "video");
    if (!s) continue;
    (await s.getStats()).forEach((r) => {
      if (r.type !== "outbound-rtp" || r.kind !== "video") return;
      const ant = anterior[id];
      if (ant) {
        const mbps = ((r.bytesSent - ant.bytes) * 8) / ((r.timestamp - ant.t) / 1000) / 1e6;
        $("stats").textContent =
          `${r.frameWidth}x${r.frameHeight} · ${Math.round(r.framesPerSecond || 0)} fps · ` +
          `${mbps.toFixed(1)} Mbps · ${r.encoderImplementation || ""}`;
      }
      anterior[id] = { bytes: r.bytesSent, t: r.timestamp };
    });
    break;
  }
}, 2000);

/* ---------- palco único, anfitrião e controle do player ---------- */
$("liberar").onclick = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "release" })); };

function reservarPalco() {
  return new Promise((ok) => {
    if (ws?.readyState !== 1) return ok({ type: "share-denied" });
    const t = setTimeout(() => { resolverReserva = null; ok({ type: "share-denied" }); }, 3000);
    resolverReserva = (m) => { clearTimeout(t); resolverReserva = null; ok(m); };
    ws.send(JSON.stringify({ type: "share-start" }));
  });
}
const negarPalco = (r) => aviso(r.by ? `${r.by} já está transmitindo.` : "Não consegui reservar o palco.");

const enviarCmd = (d) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "sync", data: { k: "cmd", ...d } }));

function enviarEstado() {
  const v = $("v-local");
  if (!modoArquivo || !v || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "sync", data: { k: "estado", pos: v.currentTime, dur: v.duration || 0, pausado: v.paused } }));
}
setInterval(enviarEstado, 1000);

function tratarSync(from, d) {
  if (!d) return;
  if (d.k === "mic" && ["on", "mudo", "off"].includes(d.e)) definirVoz(from, d.e);
  if (d.k === "estado" && from === sharerId) { estadoRemoto = { ...d, t: Date.now() }; renderRemoto(); }
  if (d.k === "cmd" && modoArquivo) {
    const v = $("v-local");
    if (!v) return;
    if (d.acao === "seek" && Number.isFinite(d.t)) v.currentTime = d.t;
    setTimeout(enviarEstado, 150);
  }
}

const fmt = (s) => {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(x).padStart(2, "0");
};

function renderRemoto() {
  $("remoto").hidden = !document.querySelector("#palco video[data-stream]");
  const vivo = estadoRemoto && Date.now() - estadoRemoto.t < 3500;
  for (const id of ["rc-seek", "rc-tempo"]) $(id).hidden = !vivo;
  if (!vivo) return;
  if (!arrastando) $("rc-seek").value = estadoRemoto.dur ? (estadoRemoto.pos / estadoRemoto.dur) * 1000 : 0;
  $("rc-tempo").textContent = `${fmt(estadoRemoto.pos)} / ${fmt(estadoRemoto.dur)}`;
}
setInterval(renderRemoto, 1000);

$("rc-seek").oninput = () => (arrastando = true);
$("rc-seek").onchange = () => {
  arrastando = false;
  if (estadoRemoto?.dur) enviarCmd({ acao: "seek", t: ($("rc-seek").value / 1000) * estadoRemoto.dur });
};
$("rc-vol").oninput = () =>
  document.querySelectorAll("#palco video[data-stream]").forEach((v) => (v.volume = $("rc-vol").value / 100));
// No iOS o navegador ignora video.volume (o volume é o do aparelho), então o controle seria inútil.
if (isIOS) $("rc-vol").closest("label").hidden = true;

atualizarBotoes(); // esconde o que este navegador não consegue fazer
