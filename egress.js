const express=require("express");const{request}=require("undici");const{pipeline}=require("node:stream");const{promisify}=require("node:util");const pump=promisify(pipeline);const app=express();app.set("trust proxy",true);
function isHttpUrl(v){try{const u=new URL(String(v));return u.protocol==="http:"||u.protocol==="https:";}catch{return false}}
function wantsRange(u){return /\.(mp4|mkv|ts)(\?|$)/i.test(String(u||""))}
function guessMime(u=""){const p=(u||"").toLowerCase();if(p.endsWith(".mp4"))return"video/mp4";if(p.endsWith(".m3u8"))return"application/vnd.apple.mpegurl";if(p.endsWith(".ts"))return"video/mp2t";if(p.endsWith(".mkv"))return"video/x-matroska";return"application/octet-stream"}
const ALLOW=(process.env.ALLOW_HOSTS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
function allowed(u){if(!ALLOW.length)return true;try{const h=new URL(u).hostname.toLowerCase();return ALLOW.some(x=>x===h||h.endsWith("."+x))}catch{return false}}
app.get("/health",(_,res)=>res.status(200).send("ok"));
app.get("/proxy",async(req,res)=>{const src=req.query.u;if(!src||!isHttpUrl(src))return res.status(400).send("bad url");if(!allowed(src))return res.status(403).send("forbidden host");
const ua=req.query.ua?String(req.query.ua):(req.get("user-agent")||"Mozilla/5.0");const ref=req.query.r?String(req.query.r):src;
const makeHeaders=url=>{const U=new URL(url);const h={"User-Agent":ua,"Accept":"*/*","Accept-Encoding":"identity","Referer":ref,"Origin":(()=>{try{return new URL(ref).origin}catch{try{return new URL(src).origin}catch{return""}}})(),"Host":U.host,"Connection":"close","Accept-Language":"en-US,en;q=0.9,pt-BR;q=0.8"};const r=req.get("range");if(r)h.Range=r;else if(wantsRange(src))h.Range="bytes=0-";return h};
let url=String(src);for(let hops=0;hops<8;hops++){let up;try{up=await request(url,{method:"GET",headers:makeHeaders(url),maxRedirections:0,headersTimeout:0,bodyTimeout:0})}catch(e){const msg=String(e?.code||e?.message||e);if(/ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|Premature close/i.test(msg)){await new Promise(r=>setTimeout(r,150));continue}return res.status(502).send("upstream error")}
const sc=up.statusCode,loc=up.headers.location;if(sc>=300&&sc<400&&loc){try{up.body.destroy()}catch{} url=new URL(loc,url).toString();continue}
res.status(sc);const pass=new Set(["content-type","content-length","accept-ranges","content-range","cache-control","etag","last-modified"]);for(const[k,v]of Object.entries(up.headers||{}))if(pass.has(String(k).toLowerCase())&&v!=null)res.setHeader(k,v);
res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Expose-Headers","Content-Range, Accept-Ranges, Content-Length");res.setHeader("Accept-Ranges","bytes");res.setHeader("Content-Disposition","inline");res.setHeader("X-Content-Type-Options","nosniff");
let ct=String(up.headers["content-type"]||"").toLowerCase();if(!ct||ct.includes("octet-stream")||ct.includes("application/force-download"))res.setHeader("Content-Type",guessMime(url));if(!("content-range" in up.headers))res.removeHeader("Content-Length");
req.on("aborted",()=>{try{up.body.destroy()}catch{}});res.on("close",()=>{try{up.body.destroy()}catch{}});res.on("error",()=>{try{up.body.destroy()}catch{}});
await pump(up.body,res);return}res.status(508).send("too many redirects")});
const PORT=Number(process.env.PORT||8080);app.listen(PORT,()=>console.log("EGRESS listening on",PORT));
