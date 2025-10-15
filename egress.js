// egress.js — proxy resiliente p/ Fly.io (Node 20/22 + Undici)
const express = require("express");
const { request } = require("undici");
const app = express();

app.get("/health", (req,res)=>res.json({ok:true}));
app.get("/", (req,res)=>{
  if (req.query && req.query.u) return proxyHandler(req,res);
  res.type("text/plain").send("egress up\nroutes: GET /health, GET /proxy?u=...");
});

function isHttpUrl(v){ try{ const u=new URL(String(v)); return u.protocol==="http:"||u.protocol==="https:" }catch{ return false } }
function wantsRange(u){ return /\.(mp4|mkv|ts)(\?|$)/i.test(String(u||"")) }
function hostAllowed(u){
  const allow=(process.env.ALLOW_HOSTS||"").split(",").map(s=>s.trim()).filter(Boolean);
  if(!allow.length) return true;
  try{ return allow.includes(new URL(u).hostname) }catch{ return false }
}

function swallow(stream){
  if (!stream) return;
  try {
    // evita “Unhandled 'error' event”
    stream.on?.('error', ()=>{});
  } catch {}
}
async function closeQuiet(up,label){
  try{
    const s = up && up.body;
    if (!s) return;
    swallow(s);
    // tente cancelar (undici) e, por via das dúvidas, destruir
    if (typeof s.cancel === "function") { try{ await s.cancel(); }catch{} }
    if (!s.destroyed && typeof s.destroy === "function") s.destroy();
  }catch{}
}

async function fetchFollow(startUrl, req, max=8){
  let url = String(startUrl);
  for (let hops=0; hops<=max; hops++){
    const u = new URL(url);
    const q = req.query || {};
    const headers = {
      "User-Agent": q.ua || req.get("user-agent") || "Mozilla/5.0",
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      ...(req.get("range") ? { Range: req.get("range") } : wantsRange(url) ? { Range: "bytes=0-" } : {}),
      "Referer": q.r || (u.origin + "/"),
      "Origin": (q.r ? new URL(q.r).origin : u.origin),
      "Host": u.host,
      "Connection": "close",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8"
    };

    try{
      const up = await request(url, { method:"GET", headers, maxRedirections:0, bodyTimeout:0, headersTimeout:0 });
      // 👉 prenda o erro IMEDIATAMENTE
      swallow(up.body);

      const sc  = up.statusCode;
      const loc = up.headers.location;

      if (sc>=300 && sc<400 && loc && hops<max){
        await closeQuiet(up, "redirect");
        url = new URL(loc, url).toString();
        continue;
      }
      return { up, finalUrl:url };
    }catch(e){
      const msg = String(e.code||e.message||e);
      if (/Premature close|UND_ERR_(SOCKET|ABORTED)|ECONNRESET|EPIPE|ETIMEDOUT/i.test(msg) && hops<max){
        await new Promise(r=>setTimeout(r,150));
        continue;
      }
      throw e;
    }
  }
  throw new Error("too many redirects/retries");
}

async function proxyHandler(req,res){
  const u = req.query.u;
  if (!u || !isHttpUrl(u)) return res.status(400).send("bad url");
  if (!hostAllowed(u))     return res.status(403).send("forbidden host");

  try{
    const { up, finalUrl } = await fetchFollow(u, req);
    res.status(up.statusCode);

    const pass=new Set(["content-type","content-length","accept-ranges","content-range","cache-control","etag","last-modified"]);
    for (const [k,v] of Object.entries(up.headers||{})) if (pass.has(String(k).toLowerCase()) && v!=null) res.setHeader(k,v);

    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Expose-Headers","Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Cross-Origin-Resource-Policy","cross-origin");
    res.setHeader("Accept-Ranges","bytes");
    res.setHeader("Content-Disposition","inline");
    res.setHeader("X-Content-Type-Options","nosniff");

    let ct=String(up.headers["content-type"]||"").toLowerCase();
    if (!ct || ct.includes("octet-stream") || ct.includes("application/force-download")){
      if (finalUrl.toLowerCase().endsWith(".ts")) res.setHeader("Content-Type","video/mp2t");
    }
    if (!("content-range" in up.headers)) res.removeHeader("Content-Length");

    // handlers para garantir que o processo nunca caia
    up.body.on("error", ()=>{ try{ res.destroy(); }catch{} });
    res.on("close", ()=>closeQuiet(up,"res close"));
    res.on("error", ()=>closeQuiet(up,"res error"));

    up.body.pipe(res);
  }catch(e){
    console.error("proxy error:", e.code||e.message||e);
    if (!res.headersSent) res.status(502).send("proxy error");
  }
}

app.get("/proxy", proxyHandler);

const PORT = Number(process.env.PORT||8080);
app.listen(PORT, ()=>console.log("EGRESS listening on", PORT));
