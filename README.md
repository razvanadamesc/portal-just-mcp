# portal-just-mcp

Server MCP (remote, Streamable HTTP) pentru **portal.just.ro** — portalul instanțelor (ECRIS) al Ministerului Justiției.
Folosește exclusiv serviciul web public documentat la https://portal.just.ro/SitePages/acces.aspx. Fără dependențe, fără bază de date.

## Unelte

| Unealtă | Ce face |
|---|---|
| `cautare_dosar` | dosar după număr unic (`nr/instanță/an`): instanță, secție, obiect, stadiu, termene cu soluții pe scurt, căi de atac. Părțile doar cu `include_parti=true`. |
| `cautare_sedinte` | ședințele dintr-o zi la o instanță, cu dosarele de pe rol; filtru pe secție; trunchiat la 150 dosare. |
| `lista_instante` | codurile de instanță acceptate (246), cu filtru pe fragmente. |

Nu există căutare după nume de parte — decizie deliberată (GDPR / uz didactic).

## Deploy fără terminal (GitHub + Cloudflare)

1. GitHub → **New repository** → nume `portal-just-mcp`, Public sau Private → Create.
2. În repo-ul gol: **uploading an existing file** → tragi toate fișierele din acest folder → Commit.
3. dash.cloudflare.com → Workers & Pages → **Create** → **Import a repository** → alegi `portal-just-mcp` → Project name `portal-just-mcp` → Build command gol → **Create and deploy**.
4. Worker → **Settings → Variables and Secrets (Runtime)** → Add → Type **Secret**, Key `ACCESS_TOKEN`, Value: parolă lungă → **Add 1 variable and deploy**.
5. Test: `https://portal-just-mcp.<cont>.workers.dev/mcp?key=PAROLA` în browser → `405` = parola acceptată. `/health` → `{"ok":true}`.
6. claude.ai → Settings → Connectors → Add custom connector → Name `portal-just`, URL `https://portal-just-mcp.<cont>.workers.dev/mcp?key=PAROLA`.

## Deploy cu terminal

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put ACCESS_TOKEN
```

## Teste

```bash
node test.js        # teste unitare + apeluri live către portalquery.just.ro
npx wrangler dev    # rulează local în workerd; ACCESS_TOKEN din .dev.vars sau --var
```

## Limite

- Datele vin din ECRIS cu întârziere și nu conțin motivarea hotărârilor.
- Serviciul MJ este HTTP simplu (fără TLS) și poate fi lent; timeout 45 s.
- Licență MIT. Datele judiciare publice aparțin Ministerului Justiției.
