const express = require("express");
const { request } = require("undici");
const { pipeline } = require("node:stream");
const { promisify } = require("node:util");
const pump = promisify(pipeline);

const app = express();
app.set("trust proxy", true);

function isHttpUrl(v){ try{const u=new URL(String(v)); return u.protocol==="http:"||u.protocol==="https:";}catch{return false;} }
function wantsRange(u){ return /\.(mp4|mkv|ts)(\?|$)/i.test(String(u||"")); }
function guessMime(u=""){ const p=(u||"").toLowerCase();
  if(p.endsWith(".mp4"))return"video/mp4";
  if(p.endsWith(".m3u8"))return"application/vnd.apple.mpegurl";
  if(p.endsWith(".ts")) return"video/mp2t";
  if(p.endsWith(".mkv"))return"video/x-matroska";
  return"application/octet-stream";
}
const ALLOW=(process.env.ALLOW_HOSTS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
function allowed(u){ if(!ALLOW.length) return true; try{const h=new URL(u).hostname.toLowerCase(); return ALLOW.some(x=>x===h||h.endsWith("."+x));}catch{return false;} }

app.get("/health",(_,res)=>res.status(200).send("ok"));

app.get("/proxy", async (req,res)=>{
  const src=req.query.u;
  if(!src||!isHttpUrl(src)) return res.status(400).send("bad url");
  if(!allowed(src)) return res.status(403).send("forbidden host");

  const ua=req.query.ua?String(req.query.ua):(req.get("user-agent")||"Mozilla/5.0");
  const ref=req.query.r?String(req.query.r):src;

  const makeHeaders=(url)=>{
    const U=new URL(url);
    const h={
      "User-Agent":ua,"Accept":"*/*","Accept-Encoding":"identity","Referer":ref,
      "Origin":(()=>{try{return new URL(ref).origin;}catch{try{return new URL(src).origin;}catch{return""}}})(),
      "Host":U.host,"Connection":"close","Accept-Language":"en-US,en;q=0.9,pt-BR;q=0.8"
    };
    const r=req.get("range"); if(r) h.Range=r; else if(wantsRange(src)) h.Range="bytes=0-";
    return h;
  };

  let url=String(src);
  for(let hops=0;hops<8;hops++){
    let up;
    try{ up=await request(url,{method:"GET",headers:makeHeaders(url),maxRedirections:0,headersTimeout:0,bodyTimeout:
