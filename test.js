// Teste live (Node 18+): node test.js
import { soapCall, parseDosare, parseSedinte, validNumarDosar, validData, envelope } from "./lib.js";
import { INSTANTE } from "./instante.js";
import worker from "./worker.js";

const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };

assert(validNumarDosar("17005/3/2025") && validNumarDosar("58206/299/2012*") && !validNumarDosar("abc"), "validare numar dosar");
assert(validData("2026-11-17") && !validData("17.11.2026"), "validare data");
assert(INSTANTE.length > 200 && INSTANTE.includes("TribunalulBUCURESTI"), "lista instante");
assert(envelope("X", { a: "1<2", b: "" }).includes("<a>1&lt;2</a>") && !envelope("X", { a: "1", b: "" }).includes("<b>"), "envelope escape + omit gol");

const sx = await soapCall("CautareSedinte", { dataSedinta: "2026-11-17T00:00:00", institutie: "JudecatoriaSECTORUL1BUCURESTI" });
const sed = parseSedinte(sx);
assert(sed.length >= 1 && sed[0].dosare.length > 0 && sed[0].dosare[0].numar, "CautareSedinte live + parse");

const nr = sed[0].dosare[0].numar;
const dx = await soapCall("CautareDosare", { numarDosar: nr });
const dos = parseDosare(dx);
assert(dos.length >= 1 && dos[0].numar && dos[0].instanta && dos[0].termene.length >= 1, `CautareDosare live (${nr}) + parse`);
assert(!("parti" in dos[0]) && dos[0].numar_parti >= 1, "partile nu sunt incluse implicit");
assert(parseDosare(dx, { includeParti: true })[0].parti.length === dos[0].numar_parti, "include_parti");

// Worker handler end-to-end (fără rețea Cloudflare)
const env = { ACCESS_TOKEN: "t1,t2" };
const call = (body, key = "t2", method = "POST") =>
  worker.fetch(new Request(`https://x/mcp${key ? `?key=${key}` : ""}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }), env);

assert((await call({}, "")).status === 401, "fără token → 401");
assert((await worker.fetch(new Request("https://x/mcp?key=t1"), {})).status === 503, "fără ACCESS_TOKEN → 503");
assert((await call(null, "t2", "GET")).status === 405, "GET → 405");
const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
assert(init.result.serverInfo.name === "portal-just-mcp", "initialize");
const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
assert(list.result.tools.map((t) => t.name).join() === "cautare_dosar,cautare_sedinte,lista_instante", "tools/list");
const li = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lista_instante", arguments: { filtru: "sector 1" } } })).json();
assert(JSON.parse(li.result.content[0].text).instante.includes("JudecatoriaSECTORUL1BUCURESTI"), "lista_instante filtru");
const cd = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cautare_dosar", arguments: { numar_dosar: nr } } })).json();
assert(JSON.parse(cd.result.content[0].text).gasit === true, "tools/call cautare_dosar");
const bad = await (await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cautare_dosar", arguments: { numar_dosar: "x" } } })).json();
assert(bad.result.isError === true, "numar invalid → isError");
console.log("\nToate testele au trecut.");
