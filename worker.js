// portal-just-mcp — Remote MCP Server (Streamable HTTP, JSON-RPC 2.0) pe Cloudflare Workers
// Sursă: serviciul web public ECRIS al Ministerului Justiției, http://portalquery.just.ro/Query.asmx
// Documentație oficială: https://portal.just.ro/SitePages/acces.aspx
//
// Endpoint: POST /mcp   (GET /health pentru verificare rapidă)
// Acces privat: secretul ACCESS_TOKEN (unul sau mai multe, separate prin virgulă), trimis ca
//   Authorization: Bearer <token>  |  X-Api-Key: <token>  |  ?key=<token>
// Fără ACCESS_TOKEN setat, Worker-ul răspunde 503 la tot.

import { soapCall, parseDosare, parseSedinte, validNumarDosar, validData } from "./lib.js";
import { INSTANTE } from "./instante.js";

const SERVER_INFO = { name: "portal-just-mcp", version: "1.0.0" };
const MAX_SEDINTE_DOSARE = 150;

const TOOLS = [
  {
    name: "cautare_dosar",
    description:
      "Caută un dosar în portal.just.ro (ECRIS) după numărul unic (format nr/instanță/an, ex. 17005/3/2025). " +
      "Întoarce instanța, secția, obiectul, categoria, stadiul procesual, termenele cu soluțiile pe scurt și căile de atac. " +
      "Numele părților nu sunt incluse implicit (include_parti=true doar dacă utilizatorul este parte sau cere explicit). " +
      "Datele provin din ECRIS și pot avea întârziere; nu conțin motivarea hotărârilor.",
    inputSchema: {
      type: "object",
      properties: {
        numar_dosar: { type: "string", description: "Numărul unic ECRIS, ex. '12345/3/2023'. Obligatoriu." },
        instanta: {
          type: "string",
          description: "Opțional. Codul instanței din lista_instante (ex. 'TribunalulBUCURESTI'), pentru dezambiguizare.",
        },
        include_parti: { type: "boolean", description: "Opțional, implicit false. Include lista părților (nume + calitate)." },
      },
      required: ["numar_dosar"],
    },
  },
  {
    name: "cautare_sedinte",
    description:
      "Lista ședințelor de judecată dintr-o zi, la o instanță: secție, complet, ora și dosarele de pe rol (număr, categorie, stadiu). " +
      "Util pentru exerciții de procedură. Rezultatul e trunchiat la " + MAX_SEDINTE_DOSARE + " dosare; filtrează cu 'sectie'.",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data ședinței, format YYYY-MM-DD. Obligatoriu." },
        instanta: { type: "string", description: "Codul instanței din lista_instante, ex. 'JudecatoriaSECTORUL1BUCURESTI'. Obligatoriu." },
        sectie: { type: "string", description: "Opțional. Filtru text pe numele secției (ex. 'civil', 'penal')." },
      },
      required: ["data", "instanta"],
    },
  },
  {
    name: "lista_instante",
    description:
      "Codurile de instanță acceptate de portal.just.ro (ex. 'TribunalulCLUJ', 'JudecatoriaSECTORUL2BUCURESTI'). " +
      "Caută după un fragment ('cluj', 'sector 2', 'apel'). Folosește rezultatul în cautare_dosar / cautare_sedinte.",
    inputSchema: {
      type: "object",
      properties: { filtru: { type: "string", description: "Opțional. Fragment din numele instanței, fără diacritice." } },
    },
  },
];

// ---------- Auth ----------

function tokenFrom(request, url) {
  const auth = request.headers.get("Authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return (request.headers.get("X-Api-Key") || url.searchParams.get("key") || "").trim();
}
function authorize(request, url, env) {
  const allowed = String(env.ACCESS_TOKEN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return { ok: false, status: 503, msg: "Worker neconfigurat: setați secretul ACCESS_TOKEN." };
  const t = tokenFrom(request, url);
  if (!t || !allowed.includes(t)) return { ok: false, status: 401, msg: "Acces neautorizat." };
  return { ok: true };
}

// ---------- HTTP helpers ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra } });
const rpcResult = (id, result) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);
const toolText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const toolFail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

// ---------- Tools ----------

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function runTool(name, args = {}) {
  if (name === "lista_instante") {
    // Fiecare cuvânt din filtru trebuie să apară (ex. "sector 1" → SECTORUL1; "curte apel cluj" → CurteadeApelCLUJ).
    const words = String(args.filtru || "").split(/\s+/).map(normalize).filter(Boolean);
    const list = words.length ? INSTANTE.filter((i) => words.every((w) => normalize(i).includes(w))) : INSTANTE;
    return toolText({ total: list.length, instante: list.slice(0, 100), nota: list.length > 100 ? "Afișate primele 100; rafinează filtrul." : undefined });
  }

  if (name === "cautare_dosar") {
    const nr = String(args.numar_dosar || "").trim();
    if (!validNumarDosar(nr)) return toolFail("numar_dosar invalid. Format așteptat: nr/instanță/an, ex. 12345/3/2023.");
    if (args.instanta && !INSTANTE.includes(args.instanta)) return toolFail(`Instanță necunoscută: '${args.instanta}'. Folosește lista_instante.`);
    const xml = await soapCall("CautareDosare", { numarDosar: nr, institutie: args.instanta });
    const dosare = parseDosare(xml, { includeParti: args.include_parti === true });
    if (!dosare.length) return toolText({ gasit: false, numar_dosar: nr, mesaj: "Niciun dosar cu acest număr în portal.just.ro." });
    return toolText({
      gasit: true,
      sursa: "portal.just.ro (ECRIS) — date informative, pot avea întârziere; fără motivarea hotărârilor",
      interogat_la: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
      dosare,
    });
  }

  if (name === "cautare_sedinte") {
    if (!validData(args.data)) return toolFail("data invalidă. Format: YYYY-MM-DD.");
    if (!INSTANTE.includes(args.instanta)) return toolFail(`Instanță necunoscută: '${args.instanta}'. Folosește lista_instante.`);
    const xml = await soapCall("CautareSedinte", { dataSedinta: `${args.data}T00:00:00`, institutie: args.instanta });
    let sedinte = parseSedinte(xml);
    if (args.sectie) {
      const f = normalize(args.sectie);
      sedinte = sedinte.filter((s) => normalize(s.sectie).includes(f));
    }
    const totalDosare = sedinte.reduce((n, s) => n + s.dosare.length, 0);
    let ramase = MAX_SEDINTE_DOSARE;
    const trunchiat = totalDosare > MAX_SEDINTE_DOSARE;
    if (trunchiat) {
      sedinte = sedinte
        .map((s) => {
          const d = s.dosare.slice(0, Math.max(0, ramase));
          ramase -= d.length;
          return { ...s, dosare: d };
        })
        .filter((s) => s.dosare.length);
    }
    return toolText({
      data: args.data,
      instanta: args.instanta,
      numar_sedinte: sedinte.length,
      numar_dosare: totalDosare,
      trunchiat,
      nota: trunchiat ? `Afișate ${MAX_SEDINTE_DOSARE} din ${totalDosare} dosare; filtrează cu 'sectie'.` : undefined,
      sedinte,
    });
  }

  return toolFail(`Unealtă necunoscută: ${name}`);
}

// ---------- MCP JSON-RPC ----------

async function handleRpc(msg) {
  const { id = null, method, params = {} } = msg || {};
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Conector către portal.just.ro (ECRIS): stare dosare, termene, ședințe. Interoghează punctual, la cererea utilizatorului. " +
          "Nu căuta după nume de persoane. Nu reține datele părților. Datele sunt informative și nu conțin motivarea hotărârilor.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202, headers: CORS });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        return rpcResult(id, await runTool(name, args || {}));
      } catch (e) {
        return rpcResult(id, toolFail(`Eroare la interogarea portal.just.ro: ${e.message || e}`));
      }
    }
    default:
      return rpcError(id, -32601, `Metodă necunoscută: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") return json({ ok: true, server: SERVER_INFO });

    if (url.pathname !== "/mcp") return json({ eroare: "Folosiți POST /mcp" }, 404);

    const auth = authorize(request, url, env);
    if (!auth.ok) return json({ eroare: auth.msg }, auth.status);

    if (request.method !== "POST") return json({ eroare: "Method not allowed. Folosiți POST /mcp" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "JSON invalid", 400);
    }
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) {
        const r = await handleRpc(m);
        if (r.status !== 202) out.push(await r.json());
      }
      return json(out);
    }
    return handleRpc(body);
  },
};
