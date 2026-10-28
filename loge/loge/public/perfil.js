// Perfil do Loge: nome + foto/avatar, guardado só neste navegador. Sem senha.
// O "código secreto" (token) prova ao servidor que você é o dono das suas salas fixas.
// Quem tiver o código vira você: trate como uma senha.

const CHAVE = "loge:perfil";
const FOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_RE = /^\/avatars\/(historicas|cinema|monstros)\/foto_\d{2}\.png$/;

const hex = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export function lerPerfil() {
  try {
    const p = JSON.parse(localStorage.getItem(CHAVE));
    if (p && /^[a-f0-9]{16}$/.test(p.id) && /^[a-f0-9]{32}$/.test(p.token) && typeof p.nome === "string") {
      const foto = p.foto && (FOTO_RE.test(p.foto) || AVATAR_RE.test(p.foto)) ? p.foto : null;
      return { id: p.id, token: p.token, nome: p.nome.slice(0, 24), foto };
    }
  } catch {}
  return null;
}

export function salvarPerfil(p) {
  try { localStorage.setItem(CHAVE, JSON.stringify(p)); return true; } catch { return false; }
}

export const sairDoPerfil = () => { try { localStorage.removeItem(CHAVE); } catch {} };

export const novoPerfil = (nome, foto) => ({ id: hex(8), token: hex(16), nome: nome.trim().slice(0, 24), foto: foto || null });

// O que vai ao servidor para provar quem é o dono (nunca a foto nem o nome aqui)
export const credenciais = (p) => ({ id: p.id, token: p.token });

// Código de recuperação: id + token em grupos de 6 letras/números, fácil de copiar e colar
export const codigoDe = (p) => (p.id + p.token).match(/.{1,6}/g).join("-");

export function perfilDoCodigo(texto, nome, foto) {
  const h = String(texto).toLowerCase().replace(/[^a-f0-9]/g, "");
  if (h.length !== 48) return null;
  return { id: h.slice(0, 16), token: h.slice(16), nome: nome.trim().slice(0, 24), foto: foto || null };
}

// Reduz a foto escolhida para um quadrado de 128 px (cerca de 8 mil caracteres), cortando o excesso do centro
export async function reduzirFoto(arquivo) {
  const bmp = await createImageBitmap(arquivo);
  const lado = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  c.getContext("2d").drawImage(bmp, (bmp.width - lado) / 2, (bmp.height - lado) / 2, lado, lado, 0, 0, 128, 128);
  bmp.close?.();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length < 30_000) return url;
  }
  throw new Error("foto");
}

/* ---------- bolinha com foto ou inicial ---------- */
const PALETAS = [
  ["#7a4a35", "#3d2418"],
  ["#2f5560", "#16292f"],
  ["#5b4678", "#2a2038"],
  ["#6a5a2e", "#2f2713"],
  ["#3f6a52", "#1b2f24"],
];

export function corDe(texto) {
  let h = 0;
  for (const c of texto) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETAS[h % PALETAS.length];
}

export function pintarDisco(disco, nome, foto) {
  disco.textContent = "";
  if (foto && (FOTO_RE.test(foto) || AVATAR_RE.test(foto))) {
    disco.style.background = `center / cover no-repeat url("${foto}")`;
    return;
  }
  const [c1, c2] = corDe(nome);
  disco.style.background = `radial-gradient(circle at 30% 25%, ${c1}, ${c2})`;
  const inicial = document.createElement("span");
  inicial.textContent = (nome.trim()[0] || "?").toUpperCase();
  disco.append(inicial);
}

// Lista de avatares disponíveis por categoria
export const AVATARES = {
  historicas: Array.from({ length: 12 }, (_, i) => `/avatars/historicas/foto_${String(i + 1).padStart(2, "0")}.png`),
  cinema: Array.from({ length: 12 }, (_, i) => `/avatars/cinema/foto_${String(i + 1).padStart(2, "0")}.png`),
  monstros: Array.from({ length: 16 }, (_, i) => `/avatars/monstros/foto_${String(i + 1).padStart(2, "0")}.png`),
};

export const CATEGORIAS = [
  { id: "historicas", nome: "Históricas" },
  { id: "cinema", nome: "Cinema" },
  { id: "monstros", nome: "Monstros" },
];
