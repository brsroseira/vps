// egress.js — egress/proxy mínimo com logs
const express = require("express");
const { request } = require("undici");
const app = express();

app.use((req,res,next)=>{
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get("/health", (req,res)=> res.json({ok:true}));

function isHttpUrl(v){
  try{ const u=new URL(String(v)); return u.protocol==="http:"||u.protocol==="https:"; }
  catch{ return false; }
}
function guessMime(u=""){
  const p=String(u).toLowerCase();
  if(p.endsWith(".mp4")) return "video/mp4";
  if(p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if(p.endsWith(".ts")) return "video/mp2t";
  if(p.endsWith(".mkv")) return "video/x-matroska";
  return "application/octet-stream";
}
function hostAllowed(url){
  const allow = (process.env.ALLOW_HOSTS||"").split(",").map(s=>s.trim()).filter(Boolean);
  if(allow.length===0) return true;
  try{ const h=new URL(url).hostname; return allow.includes(h); } catch{ return false; }
}

// follow simples + headers esperados pelo origin
async function fetchFollow(startUrl, req, max=8){
  let url = String(startUrl);
  for(let hops=0; hops<=max; hops++){
    const u = new URL(url);
    const q = req.query||{};
    const headers = {
      "User-Agent": q.ua || req.get("user-agent") || "Mozilla/5.0",
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      ...(req.get("range") ? { Range: req.get("range") } : {}),
      "Referer": q.r || (u.origin + "/"),
      "Origin": (q.r ? new URL(q.r).origin : u.origin),
      "Connection": "keep-alive",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
      "Host": u.host
    };
    const up = await request(url, { method:"GET", headers, maxRedirections:0 });
    const sc = up.statusCode, loc = up.headers.location;
    if(sc>=300 && sc<400 && loc && hops<max){
      up.body?.destroy?.();
      url = new URL(loc, url).toString();
      continue;
    }
    return { up, finalUrl: url };
  }
  throw new Error("too many redirects");
}

// === A ROTA QUE INTERESSA ===
app.get("/proxy", async (req,res)=>{
  const u = req.query.u;
  if(!u || !isHttpUrl(u)) return res.status(400).send("bad url");
  if(!hostAllowed(u)) return res.status(403).send("forbidden host");

  try{
    const { up, finalUrl } = await fetchFollow(u, req);

    res.status(up.statusCode);

    const pass = new Set(["content-type","content-length","accept-ranges","content-range","cache-control","etag","last-modified"]);
    for(const [k,v] of Object.entries(up.headers||{})){
      if(pass.has(String(k).toLowerCase()) && v!=null) res.setHeader(k, v);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");

    let ct = String(up.headers["content-type"]||"").toLowerCase();
    if(!ct || ct.includes("octet-stream") || ct.includes("application/force-download")){
      ct = guessMime(finalUrl);
      res.setHeader("Content-Type", ct);
    }
    if(!("content-range" in up.headers)) res.removeHeader("Content-Length");

    up.body.pipe(res);
    up.body.on("error", ()=>res.destroy());
  }catch(e){
    console.error("proxy error:", e?.code||e?.message||e);
    if(!res.headersSent) res.status(502).send("proxy error");
  }
});

// root p/ confirmar que é este app
app.get("/", (req,res)=> res.type("text/plain").send("egress up\nroutes: GET /health, GET /proxy?u=..."));

const PORT = Number(process.env.PORT||8080);
app.listen(PORT, ()=> console.log("EGRESS listening on", PORT));
