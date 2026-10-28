import { lerPerfil, salvarPerfil, sairDoPerfil, novoPerfil, credenciais, codigoDe, perfilDoCodigo, reduzirFoto, pintarDisco } from "/perfil.js";

const $ = (id) => document.getElementById(id);
// getRandomValues funciona também em HTTP puro; randomUUID exige contexto seguro (HTTPS/localhost)
const novoId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

let perfil = lerPerfil();
let fotoNova = null; // foto escolhida na criação ou edição

function mostrar(qual) {
  for (const id of ["sem-perfil", "com-perfil", "rapida"]) $(id).hidden = id !== qual;
}

function criarSalaRapida(senhaEl) {
  const id = novoId();
  if (senhaEl.value) sessionStorage.setItem("senha:" + id, senhaEl.value);
  location.href = "/sala/" + id;
}

async function pedir(url, corpo) {
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ perfil: credenciais(perfil), ...corpo }) });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || "Algo deu errado.");
  return dados;
}

async function escolherFoto(input, alvo, nome) {
  const f = input.files[0];
  input.value = "";
  if (!f) return null;
  try {
    const foto = await reduzirFoto(f);
    pintarDisco(alvo, nome || "?", foto);
    return foto;
  } catch {
    alert("Não consegui usar essa foto. Tente outra.");
    return null;
  }
}

/* ---------- sem perfil ---------- */
pintarDisco($("novo-foto"), "+", null);
$("novo-nome").addEventListener("input", () => { if (!fotoNova) pintarDisco($("novo-foto"), $("novo-nome").value || "+", null); });
$("novo-arquivo").addEventListener("change", async () => {
  fotoNova = (await escolherFoto($("novo-arquivo"), $("novo-foto"), $("novo-nome").value)) || fotoNova;
});

const erroPerfil = (t) => { $("erro-perfil").hidden = !t; $("erro-perfil").textContent = t || ""; };

$("criar-perfil").onclick = () => {
  const nome = $("novo-nome").value.trim();
  if (!nome) return erroPerfil("Digite seu nome.");
  perfil = novoPerfil(nome, fotoNova);
  if (!salvarPerfil(perfil)) { perfil = null; return erroPerfil("Seu navegador não deixou guardar o perfil (modo privado?)."); }
  fotoNova = null;
  abrirPainel();
};
$("novo-nome").addEventListener("keydown", (e) => { if (e.key === "Enter") $("criar-perfil").click(); });
$("tenho-codigo").onclick = () => { $("recuperar").hidden = !$("recuperar").hidden; };
$("recuperar-ok").onclick = () => {
  const nome = $("novo-nome").value.trim();
  if (!nome) return erroPerfil("Digite seu nome (e escolha a foto, se quiser) e depois recupere.");
  const p = perfilDoCodigo($("codigo-in").value, nome, fotoNova);
  if (!p) return erroPerfil("Esse código não está certo. Confira se copiou inteiro.");
  perfil = p;
  salvarPerfil(perfil);
  abrirPainel();
};
$("so-rapida").onclick = () => mostrar("rapida");
$("voltar-g").onclick = () => mostrar("sem-perfil");
$("criar-g").onclick = () => criarSalaRapida($("senha-sala-g"));

/* ---------- com perfil ---------- */
function abrirPainel() {
  erroPerfil("");
  mostrar("com-perfil");
  pintarDisco($("meu-foto"), perfil.nome, perfil.foto);
  $("meu-nome").textContent = perfil.nome;
  carregarSalas();
}

$("sair-perfil").onclick = () => {
  if (!confirm("Sair deste perfil neste aparelho? Guarde seu código de recuperação antes, senão você perde o acesso às suas salas fixas.")) return;
  sairDoPerfil();
  perfil = null;
  mostrar("sem-perfil");
};

$("editar-perfil").onclick = () => {
  $("bloco-codigo").hidden = true;
  const abrir = $("bloco-editar").hidden;
  $("bloco-editar").hidden = !abrir;
  if (abrir) { fotoNova = perfil.foto; $("ed-nome").value = perfil.nome; pintarDisco($("ed-foto"), perfil.nome, perfil.foto); }
};
$("ed-arquivo").addEventListener("change", async () => {
  fotoNova = (await escolherFoto($("ed-arquivo"), $("ed-foto"), $("ed-nome").value)) || fotoNova;
});
$("ed-salvar").onclick = () => {
  const nome = $("ed-nome").value.trim();
  if (!nome) return;
  perfil = { ...perfil, nome: nome.slice(0, 24), foto: fotoNova };
  salvarPerfil(perfil);
  $("bloco-editar").hidden = true;
  abrirPainel();
};

$("ver-codigo").onclick = () => {
  $("bloco-editar").hidden = true;
  $("bloco-codigo").hidden = !$("bloco-codigo").hidden;
  $("codigo-txt").textContent = codigoDe(perfil);
};
$("copiar-codigo").onclick = async () => {
  try { await navigator.clipboard.writeText(codigoDe(perfil)); $("copiar-codigo").textContent = "Copiado!"; }
  catch { const r = document.createRange(); r.selectNodeContents($("codigo-txt")); getSelection().removeAllRanges(); getSelection().addRange(r); $("copiar-codigo").textContent = "Selecionado: copie"; }
  setTimeout(() => ($("copiar-codigo").textContent = "Copiar código"), 2500);
};

$("criar").onclick = () => criarSalaRapida($("senha-sala"));

/* ---------- busca pública de salas pelo nome ---------- */
document.querySelectorAll(".form-busca-salas").forEach((form) => {
  const campo = form.querySelector(".busca-nome");
  const resultados = form.parentElement.querySelector(".resultados-salas");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = campo.value.trim();
    if (!q) return;
    resultados.textContent = "";
    const status = document.createElement("p");
    status.className = "sub peq";
    status.textContent = "Procurando salas…";
    resultados.append(status);
    try {
      const r = await fetch("/api/buscar-salas?q=" + encodeURIComponent(q), { cache: "no-store" });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados.erro || "Não foi possível procurar salas.");
      resultados.textContent = "";
      if (!dados.salas?.length) {
        const vazio = document.createElement("p");
        vazio.className = "sub peq";
        vazio.textContent = "Nenhuma sala encontrada com esse nome.";
        resultados.append(vazio);
        return;
      }
      for (const sala of dados.salas) {
        const item = document.createElement("div");
        item.className = "sala-fixa";
        const info = document.createElement("div");
        info.className = "info";
        const nome = document.createElement("strong");
        nome.textContent = sala.nome;
        const detalhe = document.createElement("small");
        detalhe.textContent = sala.comSenha ? "🔒 Protegida por senha — entrada bloqueada pela busca." : "Sala sem senha";
        info.append(nome, detalhe);
        item.append(info);
        if (!sala.comSenha) {
          const entrar = document.createElement("a");
          entrar.className = "btn primario";
          entrar.href = "/sala/" + encodeURIComponent(sala.slug);
          entrar.textContent = "Entrar na sala";
          item.append(entrar);
        }
        resultados.append(item);
      }
    } catch (err) {
      resultados.textContent = "";
      const aviso = document.createElement("p");
      aviso.className = "sub erro";
      aviso.textContent = err.message || "Erro ao procurar salas.";
      resultados.append(aviso);
    }
  });
});

/* ---------- salas fixas ---------- */
const slugDe = (t) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

let slugManual = false;
$("fx-slug").addEventListener("input", () => { slugManual = $("fx-slug").value !== ""; });
$("fx-nome").addEventListener("input", () => { if (!slugManual) $("fx-slug").value = slugDe($("fx-nome").value); });

const erroFixa = (t) => { $("fx-erro").hidden = !t; $("fx-erro").textContent = t || ""; };

$("nova-fixa").addEventListener("submit", async (e) => {
  e.preventDefault();
  erroFixa("");
  let slug = slugDe($("fx-slug").value || $("fx-nome").value);
  if (slug.length < 4) slug = (slug + "-" + novoId()).replace(/^-/, "").slice(0, 40);
  try {
    await pedir("/api/salas", { slug, nome: $("fx-nome").value, senha: $("fx-senha").value });
    $("nova-fixa").reset();
    slugManual = false;
    carregarSalas();
  } catch (err) { erroFixa(err.message); }
});

async function carregarSalas() {
  const lista = $("minhas");
  try {
    const { salas } = await pedir("/api/minhas-salas", {});
    lista.textContent = "";
    if (!salas.length) {
      const p = document.createElement("p");
      p.className = "sub peq";
      p.textContent = "Você ainda não tem salas fixas.";
      lista.append(p);
    }
    for (const s of salas) lista.append(linhaDe(s));
  } catch (err) {
    lista.textContent = err.message;
  }
}

function botao(texto, fn, cls = "btn") {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = texto;
  b.onclick = fn;
  return b;
}

function linhaDe(s) {
  const url = `${location.origin}/sala/${s.slug}`;
  const li = document.createElement("div");
  li.className = "sala-fixa";

  const info = document.createElement("div");
  info.className = "info";
  const nome = document.createElement("strong");
  nome.textContent = s.nome + (s.comSenha ? "  🔒" : "");
  const link = document.createElement("small");
  link.textContent = url;
  info.append(nome, link);

  const acoes = document.createElement("div");
  acoes.className = "acoes-fixa";
  const entrar = document.createElement("a");
  entrar.className = "btn primario";
  entrar.href = "/sala/" + s.slug;
  entrar.textContent = "Entrar";
  const copiar = botao("Copiar link", async () => {
    try { await navigator.clipboard.writeText(url); copiar.textContent = "Copiado!"; } catch { prompt("Copie o link:", url); }
    setTimeout(() => (copiar.textContent = "Copiar link"), 2000);
  });
  const editar = botao("Editar", () => {
    const novoNome = prompt("Nome da sala:", s.nome);
    if (novoNome === null) return;
    const corpo = { nome: novoNome };
    const troca = prompt(s.comSenha ? "Nova senha (deixe vazio para REMOVER a senha, Cancelar para manter):" : "Senha (opcional, vazio = sem senha):", "");
    if (troca !== null) corpo.senha = troca;
    pedir(`/api/salas/${s.slug}/editar`, corpo).then(carregarSalas).catch((e) => alert(e.message));
  });
  const excluir = botao("Excluir", () => {
    if (!confirm(`Excluir "${s.nome}"? O link deixa de funcionar e quem estiver dentro será desconectado.`)) return;
    pedir(`/api/salas/${s.slug}/excluir`, {}).then(carregarSalas).catch((e) => alert(e.message));
  });
  acoes.append(entrar, copiar, editar, excluir);
  li.append(info, acoes);
  return li;
}

if (perfil) abrirPainel(); else mostrar("sem-perfil");
