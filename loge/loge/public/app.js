const roomId = location.pathname.split("/").filter(Boolean).pop() || ""; // ignora barra no final da URL
const $ = (id) => document.getElementById(id);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// O que este navegador consegue transmitir. Celulares em geral não capturam a tela; sem isso, os botões só confundem.
const semCaptura = window.isSecureContext && !navigator.mediaDevices?.getDisplayMedia;
const semArquivo = !(HTMLVideoElement.prototype.captureStream || HTMLVideoElement.prototype.mozCaptureStream);

const peers = new Map(); // id -> { id, pc, polite, makingOffer, ignoreOffer, senders:{tela:[]} }
const nomes = new Map(); // id -> nome
const locais = { tela: null }; // stream que estou transmitindo (tela ou arquivo)
let ws, myId, hostId = null, sharerId = null, senha = "", nomeAtual = "";
let encerrado = false, tentativas = 0, timerReconexao = null, modoArquivo = false, estadoRemoto = null, arrastando = false, resolverReserva = null;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

/* ---------- entrada e conexão ---------- */
$("nome").value = localStorage.getItem("nome") || "";
// Atenção: com `onkeydown = (e) => e.key === "Enter" && ...` toda tecla que não é Enter devolvia `false`,
// e um handler `on...` que devolve false cancela a tecla: o campo ficava vazio e o nome virava "anônimo".
// Por isso o Enter é tratado com addEventListener e sem retorno.
const enterEntra = (e) => { if (e.key === "Enter") $("entrar").click(); };
$("nome").addEventListener("keydown", enterEntra);
$("senha").addEventListener("keydown", enterEntra);

$("entrar").onclick = async () => {
  const nome = $("nome").value.trim() || "anônimo";
  localStorage.setItem("nome", nome);
  senha = $("senha").hidden ? sessionStorage.getItem("senha:" + roomId) || "" : $("senha").value;
  if (senha) sessionStorage.setItem("senha:" + roomId, senha);
  nomeAtual = nome;
  $("entrada").hidden = true;
  $("sala").hidden = false;
  garantirAvatar("eu", nome, true);
  try { iceServers = (await (await fetch("/ice")).json()).iceServers; } catch {}
  encerrado = false;
  conectar();
};

function conectar() {
  clearTimeout(timerReconexao); // evita duas conexões se a reconexão foi antecipada
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", room: roomId, name: nomeAtual, password: senha }));
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case "joined":
        tentativas = 0;
        myId = msg.id; hostId = msg.host; sharerId = msg.sharer;
        msg.peers.forEach((p) => { nomes.set(p.id, p.name); garantirAvatar(p.id, p.name); criarPeer(p.id); });
        atualizarStatus();
        if (locais.tela) ws.send(JSON.stringify({ type: "share-start" })); // reconectou transmitindo
        break;
      case "peer-joined":
        nomes.set(msg.id, msg.name);
        garantirAvatar(msg.id, msg.name);
        criarPeer(msg.id);
        aviso(`${msg.name} entrou`);
        atualizarStatus();
        break;
      case "peer-left":
        aviso(`${nomes.get(msg.id) || "Alguém"} saiu`);
        removerPeer(msg.id);
        atualizarStatus();
        break;
      case "host": hostId = msg.id; atualizarStatus(); break;
      case "sharer": sharerId = msg.id; if (!msg.id) estadoRemoto = null; atualizarStatus(); break;
      case "share-ok": sharerId = myId; resolverReserva?.(msg); atualizarStatus(); break;
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
      case "full": encerrado = true; alert("Sala cheia."); break;
      case "invalid-room": encerrado = true; alert("Link de sala inválido."); break;
    }
  };
  ws.onclose = () => {
    limparPeers();
    if (encerrado) return;
    $("contagem").textContent = "Reconectando…";
    timerReconexao = setTimeout(conectar, Math.min(1000 * 2 ** tentativas++, 10000));
  };
}

function limparPeers() {
  [...peers.keys()].forEach(removerPeer);
  nomes.clear();
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
const PALETAS = [
  ["#7a4a35", "#3d2418"],
  ["#2f5560", "#16292f"],
  ["#5b4678", "#2a2038"],
  ["#6a5a2e", "#2f2713"],
  ["#3f6a52", "#1b2f24"],
];

function corDe(texto) {
  let h = 0;
  for (const c of texto) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETAS[h % PALETAS.length];
}

function garantirAvatar(id, nome, eu = false) {
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
  const [c1, c2] = corDe(nome);
  disco.style.background = `radial-gradient(circle at 30% 25%, ${c1}, ${c2})`;

  const inicial = document.createElement("span");
  inicial.textContent = (nome.trim()[0] || "?").toUpperCase();

  const legenda = document.createElement("figcaption");
  legenda.textContent = rotulo;

  disco.append(inicial);
  el.append(disco, legenda);

  const lista = $("avatares");
  const meu = lista.querySelector('[data-avatar="eu"]');
  if (meu && !eu) lista.insertBefore(el, meu); // "Você" fica sempre por último
  else lista.append(el);
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
    senders: { tela: [] } };
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
  pc.ontrack = ({ streams: [stream] }) => stream && mostrarRemoto(id, stream);
  // Troca de rede (Wi-Fi para 4G) ou volta do segundo plano no celular: tenta refazer o caminho em vez de ficar mudo
  pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") pc.restartIce?.(); };

  if (locais.tela) adicionarStream(peer, "tela");
  return peer;
}

async function tratarSinal(from, { description, candidate }) {
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
  document.querySelectorAll(`[data-peer="${id}"]`).forEach((el) => el.remove());
}

/* ---------- envio de streams (tela ou arquivo) ---------- */
function adicionarStream(peer, tipo) {
  const stream = locais[tipo];
  if (!stream) return;
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
    v.pause?.();
    if (v.src?.startsWith("blob:")) URL.revokeObjectURL(v.src);
    v.remove();
  }
  $("arquivo").value = "";
  const estava = modoArquivo || sharerId === myId || tinhaTela;
  modoArquivo = false;
  if (estava && ws?.readyState === 1) ws.send(JSON.stringify({ type: "share-stop" }));
  if (sharerId === myId) sharerId = null;
  atualizarBotoes();
  atualizarStatus();
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
  v.id = "v-local"; v.controls = true; v.playsInline = true;
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

/* ---------- vídeos remotos ---------- */
function mostrarRemoto(peerId, stream) {
  let el = document.querySelector(`[data-stream="${stream.id}"]`);
  if (!el) {
    el = document.createElement("video");
    el.autoplay = true; 
    el.playsInline = true; 
    el.setAttribute("playsinline", ""); 
    el.setAttribute("webkit-playsinline", "");
    
    // O SEGREDO PARA O IPHONE: começa mutado para o navegador liberar a imagem
    el.muted = true; 
    
    el.dataset.stream = stream.id;
    el.dataset.peer = peerId;
    el.srcObject = stream; // antes do play(), para o navegador já ter o que reproduzir
    $("palco").append(el);

    // Força o play no iOS
    el.play().catch(e => console.log("Aviso do iOS sobre autoplay:", e));

    // Cria o botão amarelo "Toque para ativar o som"
    const btnSom = document.createElement("button");
    btnSom.textContent = "🔊 Toque para ativar o som";
    btnSom.style.cssText = "position:absolute; bottom:20px; left:50%; transform:translateX(-50%); background:#ffb347; color:#1a1205; padding:10px 20px; border-radius:25px; font-weight:bold; border:none; cursor:pointer; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,0.5); font-family:Inter,sans-serif;";
    
    btnSom.onclick = () => {
      el.muted = false;
      el.volume = $("rc-vol").value / 100;
      el.play().catch(() => {});
      btnSom.remove();
    };

    // Se for um iPhone (ou iPad), mostra o botão. No PC toca direto com som.
    if (isIOS) {
      // (o #quadro já é position: relative no CSS; um style inline aqui vencia a tela cheia falsa e a deslocava)
      $("quadro").append(btnSom);
    } else {
      el.muted = false;
      el.volume = $("rc-vol").value / 100;
    }

    stream.onremovetrack = () => {
      if (!stream.getTracks().length) {
        el.remove();
        btnSom.remove();
        atualizarWakeLock();
      }
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
});

/* ---------- chat ---------- */
$("form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("texto").value.trim();
  if (!text || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "chat", text }));
  $("texto").value = "";
};

function mensagem({ from, name, text }) {
  const eu = from === myId;
  const caixa = document.createElement("div");
  caixa.className = "msg" + (eu ? " eu" : "");
  const autor = document.createElement("span");
  autor.className = "autor";
  autor.textContent = eu ? "Você" : name;
  const balao = document.createElement("div");
  balao.className = "balao";
  balao.textContent = text; // textContent evita injeção de HTML
  caixa.append(autor, balao);
  $("msgs").append(caixa);
  $("msgs").scrollTop = $("msgs").scrollHeight;
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

/* Tela cheia. Três caminhos, do melhor para o pior:
   1) navegador com tela cheia de elemento (computador, Android, iPad): o quadro inteiro;
   2) iPhone: o Safari só aceita o <video> (player nativo, gira sozinho para a horizontal);
   3) sem nada disso (ainda sem vídeo): "tela cheia falsa", o quadro cobre a janela inteira. */
const quadro = $("quadro");
const cheiaNativa = () => document.fullscreenElement || document.webkitFullscreenElement;

function sairCheia() {
  if (cheiaNativa()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  quadro.classList.remove("pseudo-cheia");
  document.body.classList.remove("trava");
  $("sair-cheia").hidden = true;
  try { screen.orientation?.unlock?.(); } catch {}
}

function cheiaFalsa() {
  quadro.classList.add("pseudo-cheia");
  document.body.classList.add("trava");
  $("sair-cheia").hidden = false;
}

$("tela-cheia").onclick = async () => {
  if (cheiaNativa() || quadro.classList.contains("pseudo-cheia")) return sairCheia();

  const pedir = quadro.requestFullscreen || quadro.webkitRequestFullscreen;
  if (pedir) {
    try {
      await pedir.call(quadro);
      $("sair-cheia").hidden = false; // o botão de sair fica dentro do quadro: o resto da página some em tela cheia
      screen.orientation?.lock?.("landscape").catch(() => {}); // Android: deita a tela; iOS ignora
      return;
    } catch { /* recusou: tenta o próximo caminho */ }
  }

  const video = document.querySelector("#palco video");
  if (video?.webkitEnterFullscreen) {
    try { video.webkitEnterFullscreen(); return; } catch { /* sem metadados ainda */ }
  }
  cheiaFalsa();
};

$("sair-cheia").onclick = sairCheia;
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) sairCheia(); });
document.addEventListener("webkitfullscreenchange", () => { if (!document.webkitFullscreenElement) sairCheia(); });

$("copiar").onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); }
  catch {
    // sem área de transferência (HTTP puro, alguns celulares): usa o compartilhamento do sistema ou mostra o link
    if (navigator.share) { try { await navigator.share({ title: "Loge", url: location.href }); } catch {} return; }
    prompt("Copie o link da sala:", location.href);
    return;
  }
  $("copiar-txt").textContent = "Copiado!";
  setTimeout(() => ($("copiar-txt").textContent = "Copiar link"), 1500);
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
  if (d.k === "estado" && from === sharerId) { estadoRemoto = { ...d, t: Date.now() }; renderRemoto(); }
  if (d.k === "cmd" && modoArquivo) {
    const v = $("v-local");
    if (!v) return;
    if (d.acao === "toggle") v.paused ? v.play() : v.pause();
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
  for (const id of ["rc-play", "rc-seek", "rc-tempo"]) $(id).hidden = !vivo;
  if (!vivo) return;
  $("rc-play").textContent = estadoRemoto.pausado ? "Continuar" : "Pausar";
  if (!arrastando) $("rc-seek").value = estadoRemoto.dur ? (estadoRemoto.pos / estadoRemoto.dur) * 1000 : 0;
  $("rc-tempo").textContent = `${fmt(estadoRemoto.pos)} / ${fmt(estadoRemoto.dur)}`;
}
setInterval(renderRemoto, 1000);

$("rc-play").onclick = () => enviarCmd({ acao: "toggle" });
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
