// Funcții pure, fără dependențe: SOAP către portalquery.just.ro + parsare XML minimală.
// Folosite și de worker.js (Cloudflare) și de testele locale (Node).

export const SOAP_URL = "http://portalquery.just.ro/Query.asmx";
export const SOAP_NS = "portalquery.just.ro";

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
export function decode(s) {
  if (!s) return "";
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]);
}
export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Întoarce textul primului copil <tag> dintr-un fragment XML (fără copii imbricați cu același nume).
export function text(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]).trim() : "";
}
// Toate blocurile <tag>...</tag> (ne-imbricate).
export function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const day = (iso) => (iso ? iso.slice(0, 10) : "");

export function envelope(op, params) {
  const body = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op} xmlns="${SOAP_NS}">${body}</${op}></soap:Body></soap:Envelope>`;
}

export async function soapCall(op, params, fetchImpl = fetch, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_NS}/${op}"` },
      body: envelope(op, params),
      signal: ctrl.signal,
    });
    const xml = await res.text();
    if (!res.ok) {
      const fault = text(xml, "faultstring");
      throw new Error(`portal.just.ro a răspuns HTTP ${res.status}${fault ? `: ${fault}` : ""}`);
    }
    return xml;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Parsare răspunsuri ----------

export function parseDosare(xml, { includeParti = false } = {}) {
  return blocks(xml, "Dosar").map((d) => {
    const dosar = {
      numar: text(d, "numar"),
      numar_vechi: text(d, "numarVechi") || undefined,
      data_inregistrare: day(text(d, "data")),
      instanta: text(d, "institutie"),
      sectie: text(d, "departament"),
      categorie_caz: text(d, "categorieCazNume"),
      stadiu_procesual: text(d, "stadiuProcesualNume"),
      obiect: text(d, "obiect"),
      ultima_modificare: text(d, "dataModificare").replace("T", " ").slice(0, 19),
      numar_parti: blocks(d, "DosarParte").length,
      termene: blocks(d, "DosarSedinta").map((s) => ({
        data: day(text(s, "data")),
        ora: text(s, "ora"),
        complet: text(s, "complet"),
        solutie: text(s, "solutie") || undefined,
        solutie_sumar: text(s, "solutieSumar") || undefined,
        data_pronuntare: day(text(s, "dataPronuntare")) || undefined,
        document: text(s, "numarDocument") || undefined,
      })),
      cai_atac: blocks(d, "DosarCaleAtac").map((c) => ({
        data_declarare: day(text(c, "dataDeclarare")),
        tip: text(c, "tipCaleAtac"),
        parte_declaratoare: text(c, "parteDeclaratoare"),
      })),
    };
    if (includeParti) {
      dosar.parti = blocks(d, "DosarParte").map((p) => ({ nume: text(p, "nume"), calitate: text(p, "calitateParte") }));
    }
    return dosar;
  });
}

export function parseSedinte(xml) {
  return blocks(xml, "Sedinta").map((s) => ({
    sectie: text(s, "departament"),
    complet: text(s, "complet"),
    data: day(text(s, "data")),
    ora: text(s, "ora"),
    dosare: blocks(s, "SedintaDosar").map((d) => ({
      numar: text(d, "numar"),
      ora: text(d, "ora"),
      categorie_caz: text(d, "categorieCazNume"),
      stadiu_procesual: text(d, "stadiuProcesualNume"),
    })),
  }));
}

// ---------- Validări ----------

export const RE_NUMAR_DOSAR = /^\d{1,7}\/\d{1,4}\/\d{4}(\*+|\/a\d*|\*\*)?$/i;
export function validNumarDosar(s) {
  return typeof s === "string" && RE_NUMAR_DOSAR.test(s.trim());
}
export function validData(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
