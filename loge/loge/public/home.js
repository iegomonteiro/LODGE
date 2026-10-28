import { lerPerfil, salvarPerfil, sairDoPerfil, novoPerfil, credenciais, codigoDe, perfilDoCodigo, pintarDisco, reduzirFoto, AVATARES, CATEGORIAS } from "/perfil.js";

const $ = (id) => document.getElementById(id);
const novoId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

let perfil = lerPerfil();
let fotoNova = null;

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

/* ---------- seletor de avatares ---------- */
function montarGrid(gridEl, categoria, onSelect) {
  gridEl.textContent = "";
  const lista = AVATARES[categoria] || [];
  for (const src of lista) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-opcao" + (fotoNova === src ? " selecionado" : "");
    btn.title = src.split("/").pop();
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    btn.append(img);
    btn.onclick = () => {
      fotoNova = src;
      onSelect(src);
      gridEl.querySelectorAll(".avatar-opcao").forEach((b) => b.classList.toggle("selecionado", b === btn));
    };
    gridEl.append(btn);
  }
}

function setupTabs(tabsContainer, gridId, previewId, isEdit = false) {
  const grid = $(gridId);
  const preview = $(previewId);
  const tabs = tabsContainer.querySelectorAll(".avatar-tab");

  const ativar = (cat) => {
    tabs.forEach((t) => t.classList.toggle("ativo", t.dataset.cat === cat));
    montarGrid(grid, cat, (src) => {
      const nome = isEdit ? ($("ed-nome").value || "?") : ($("novo-nome").value || "+");
      pintarDisco(preview, nome, src);
    });
  };

  tabs.forEach((tab) => {
    tab.onclick = () => ativar(tab.dataset.cat);
  });

  ativar("historicas");
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

/* ---------- sem perfil (fluxo em 2 passos) ---------- */
const erroPerfil = (t) => { $("erro-perfil").hidden = !t; $("erro-perfil").textContent = t || ""; };
const erroAvatar = (t) => { $("erro-avatar").hidden = !t; $("erro-avatar").textContent = t || ""; };

$("ir-avatar").onclick = () => {
  const nome = $("novo-nome").value.trim();
  if (!nome) return erroPerfil("Digite seu nome.");
  erroPerfil("");
  $("passo-nome").hidden = true;
  $("passo-avatar").hidden = false;
  pintarDisco($("novo-foto"), nome, fotoNova);
  setupTabs(document.querySelector("#passo-avatar .avatar-tabs"), "avatar-grid", "novo-foto");
};

$("voltar-nome").onclick = () => {
  $("passo-avatar").hidden = true;
  $("passo-nome").hidden = false;
  erroAvatar("");
};

$("novo-arquivo").addEventListener("change", async () => {
  const nome = $("novo-nome").value.trim() || "+";
  const foto = await escolherFoto($("novo-arquivo"), $("novo-foto"), nome);
  if (foto) {
    fotoNova = foto;
    // desmarca os ícones da grade
    document.querySelectorAll("#avatar-grid .avatar-opcao").forEach((b) => b.classList.remove("selecionado"));
  }
});

$("criar-perfil").onclick = () => {
  const nome = $("novo-nome").value.trim();
  if (!nome) return erroAvatar("Digite seu nome.");
  if (!fotoNova) return erroAvatar("Escolha um avatar ou envie uma foto.");
  perfil = novoPerfil(nome, fotoNova);
  if (!salvarPerfil(perfil)) {
    perfil = null;
    return erroAvatar("Seu navegador não deixou guardar o perfil (modo privado?).");
  }
  fotoNova = null;
  abrirPainel();
};

$("novo-nome").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("ir-avatar").click();
});

$("tenho-codigo").onclick = () => { $("recuperar").hidden = !$("recuperar").hidden; };
$("recuperar-ok").onclick = () => {
  const nome = $("novo-nome").value.trim();
  if (!nome) return erroPerfil("Digite seu nome primeiro.");
  // se ainda não escolheu avatar, usa o que tiver
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
  erroAvatar("");
  mostrar("com-perfil");
  pintarDisco($("meu-foto"), perfil.nome, perfil.foto);
  $("meu-nome").textContent = perfil.nome;
  carregarSalas();
}

$("sair-perfil").onclick = () => {
  if (!confirm("Sair deste perfil neste aparelho? Guarde seu código de recuperação antes, senão você perde o acesso às suas salas fixas.")) return;
  sairDoPerfil();
  perfil = null;
  fotoNova = null;
  $("passo-nome").hidden = false;
  $("passo-avatar").hidden = true;
  mostrar("sem-perfil");
};

$("editar-perfil").onclick = () => {
  $("bloco-codigo").hidden = true;
  const abrir = $("bloco-editar").hidden;
  $("bloco-editar").hidden = !abrir;
  if (abrir) {
    fotoNova = perfil.foto;
    $("ed-nome").value = perfil.nome;
    pintarDisco($("ed-foto"), perfil.nome, perfil.foto);
    setupTabs(document.querySelector("#bloco-editar .avatar-tabs"), "avatar-grid-ed", "ed-foto", true);
    if (perfil.foto && perfil.foto.includes("/avatars")) {
      const parts = perfil.foto.split("/");
      const cat = parts[parts.length - 2];
      const tab = document.querySelector(`#bloco-editar .avatar-tab[data-cat="${cat}"]`);
      if (tab) tab.click();
    }
  }
};

$("ed-arquivo").addEventListener("change", async () => {
  const foto = await escolherFoto($("ed-arquivo"), $("ed-foto"), $("ed-nome").value);
  if (foto) {
    fotoNova = foto;
    document.querySelectorAll("#avatar-grid-ed .avatar-opcao").forEach((b) => b.classList.remove("selecionado"));
  }
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
