const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store"
};

function response(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}
function fail(message, status=400) { const e=new Error(message); e.status=status; throw e; }
function cleanUsername(value) {
  let value2=String(value||"").trim();
  if (/^https?:\/\//i.test(value2)) {
    let u; try { u=new URL(value2); } catch { fail("主页链接无效。"); }
    if (u.protocol!=="https:" || !/(^|\.)instagram\.com$/i.test(u.hostname)) fail("只接受 Instagram HTTPS 主页链接。");
    value2=u.pathname.split("/").filter(Boolean)[0]||"";
  }
  value2=value2.replace(/^@/,"");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(value2)) fail("请输入有效的 Instagram 用户名。");
  return value2;
}
function cleanPostUrl(value) {
  let u; try { u=new URL(String(value||"").trim()); } catch { fail("请粘贴完整的 Instagram 帖子或 Reels 链接。"); }
  if (u.protocol!=="https:" || !/(^|\.)instagram\.com$/i.test(u.hostname) || u.username || u.password ||
      !/^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) fail("只支持 Instagram /p/、/reel/ 或 /tv/ 链接。");
  return "https://www.instagram.com"+u.pathname;
}
async function limited(request, env, expensive=true) {
  if (!env.RATE_LIMITER) return {allowed:true};
  const ip=request.headers.get("CF-Connecting-IP")||"unknown";
  const id=env.RATE_LIMITER.idFromName(ip+"|"+(expensive?"data":"general"));
  const stub=env.RATE_LIMITER.get(id);
  const r=await stub.fetch("https://rate-limiter.internal/check",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({limit:expensive?18:80,windowMs:60000})
  });
  if (!r.ok) fail("限流服务暂不可用，请稍后重试。",503);
  return r.json();
}
async function upstream(env, route, params={}) {
  if (!env.INSTALOADER_SERVICE_URL || !env.INSTALOADER_SERVICE_TOKEN) fail("后端尚未配置。请在部署平台检查现有环境变量。",503);
  let base; try { base=new URL(env.INSTALOADER_SERVICE_URL); } catch { fail("后端服务地址无效。",503); }
  if (base.protocol!=="https:" || base.username || base.password) fail("后端服务必须使用 HTTPS。",503);
  const target=new URL(route,base.origin);
  for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null && v!=="") target.searchParams.set(k,String(v));
  let r, raw, data;
  try {
    r=await fetch(target,{headers:{Authorization:"Bearer "+env.INSTALOADER_SERVICE_TOKEN,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(28000)});
    raw=await r.text();
    if (raw.length>4_000_000) fail("后端返回内容过大。",502);
    data=JSON.parse(raw);
  } catch(e) {
    if (e.status) throw e;
    fail("无法连接 Instaloader 后端，或请求超时。",504);
  }
  if (!r.ok) fail(data.error||data.detail||"Instagram 请求失败。",r.status);
  return data.data||{};
}
function normalize(items) {
  return (Array.isArray(items)?items:[]).map(x=>{
    const carousel=Array.isArray(x.carouselMedia)?x.carouselMedia.map(c=>({
      id:c.id,media_type:c.mediaType==="video"?"VIDEO":"IMAGE",
      media_url:c.videoUrl||c.imageUrl||"",thumbnail_url:c.thumbnailUrl||c.imageUrl||c.videoUrl||""
    })):[];
    const video=x.mediaType==="video"||!!x.videoUrl;
    return {
      id:x.id||x.shortcode||"",
      media_type:video?"VIDEO":(carousel.length?"CAROUSEL":"IMAGE"),
      media_url:x.videoUrl||x.imageUrl||x.thumbnailUrl||"",
      thumbnail_url:x.thumbnailUrl||x.imageUrl||x.videoUrl||"",
      timestamp:x.createdAt||null,permalink:x.url||null,caption:x.caption||"",
      like_count:x.likeCount??null,comment_count:x.commentCount??null,carousel
    };
  }).filter(x=>x.media_url||x.thumbnail_url||x.carousel.length);
}
export class RateLimiter {
  constructor(state){this.state=state;}
  async fetch(request){
    if(request.method!=="POST")return new Response("Method not allowed",{status:405});
    let input;try{input=await request.json();}catch{return new Response("Bad request",{status:400});}
    const limit=Math.max(1,Math.min(100,Number(input.limit)||1));
    const windowMs=Math.max(1000,Math.min(300000,Number(input.windowMs)||60000));
    const now=Date.now();
    const result=await this.state.storage.transaction(async tx=>{
      let bucket=await tx.get("bucket");
      if(!bucket||now-bucket.start>=windowMs)bucket={start:now,count:0};
      bucket.count++;
      await tx.put("bucket",bucket);
      return {allowed:bucket.count<=limit,remaining:Math.max(0,limit-bucket.count),resetAt:bucket.start+windowMs};
    });
    await this.state.storage.setAlarm(now+windowMs*2);
    return Response.json(result);
  }
  async alarm(){await this.state.storage.delete("bucket");}
}
export default {
 async fetch(request,env) {
  const url=new URL(request.url);
  try {
    if (request.method==="OPTIONS") return new Response(null,{status:204,headers:{...HEADERS,"Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type"}});
    if (url.pathname==="/api/health") return response({ok:true,service:"instagram-stories-viewer",provider:"Instaloader",paidFallback:false});
    if (url.pathname==="/api/status") {
      const configured=!!(env.INSTALOADER_SERVICE_URL&&env.INSTALOADER_SERVICE_TOKEN);
      if(!configured)return response({connected:false,configured:false,provider:"Instaloader",message:"后端环境变量尚未完整配置。"},503);
      try {
        const base=new URL(env.INSTALOADER_SERVICE_URL);
        if(base.protocol!=="https:")throw new Error("HTTPS required");
        const health=await fetch(new URL("/health",base.origin),{signal:AbortSignal.timeout(12000),redirect:"error"});
        const h=await health.json();
        if(!health.ok||h.ok!==true)throw new Error("Backend health check failed");
        await upstream(env,"/v1/health");
        return response({connected:true,configured:true,provider:"Instaloader",authenticated:!!h.authenticated,version:h.version||null,tokenVerified:true,paidFallback:false,message:"Worker、密匙和 Python 后端连接正常。"});
      } catch(e) {
        return response({connected:false,configured:true,provider:"Instaloader",tokenVerified:false,paidFallback:false,message:e.status===401?"后端密匙不匹配。": "后端健康检查或密匙验证失败，请检查 Render 服务。"},503);
      }
    }
    if(!url.pathname.startsWith("/api/")) {
      if(env.ASSETS)return env.ASSETS.fetch(request);
      return new Response("Static assets binding missing",{status:500});
    }
    if(request.method!=="GET")return response({error:"Method not allowed"},405);
    const rate=await limited(request,env,true);
    if(!rate.allowed)return response({error:"请求过于频繁，请稍后再试。"},429,{"Retry-After":"60"});
    let data;
    switch(url.pathname) {
      case "/api/profile": {
        const username=cleanUsername(url.searchParams.get("username"));
        data=await upstream(env,"/v1/instagram/profile",{handle:username});
        return response({username,profile:data.profile||{},recentMedia:normalize(data.posts),provider:"Instaloader",creditsCharged:0});
      }
      case "/api/media": {
        const username=cleanUsername(url.searchParams.get("username"));
        const tab=url.searchParams.get("tab")==="reels"?"reels":"posts";
        data=await upstream(env,"/v1/instagram/"+tab,{handle:username,limit:24});
        return response({username,media:normalize(data[tab]||data.posts||data.reels),page:null,provider:"Instaloader",creditsCharged:0});
      }
      case "/api/stories": {
        const username=cleanUsername(url.searchParams.get("username"));
        data=await upstream(env,"/v1/instagram/stories",{handle:username});
        return response({username,stories:normalize(data.stories),provider:"Instaloader",creditsCharged:0});
      }
      case "/api/highlights": {
        const username=cleanUsername(url.searchParams.get("username"));
        data=await upstream(env,"/v1/instagram/highlights",{handle:username});
        return response({username,highlights:data.highlights||[],provider:"Instaloader",creditsCharged:0});
      }
      case "/api/hashtags/media": {
        const hashtag=String(url.searchParams.get("hashtag")||"").replace(/^#/,"").trim();
        if(!/^[\p{L}\p{N}_.]{1,100}$/u.test(hashtag))fail("话题标签格式无效。");
        data=await upstream(env,"/v1/instagram/hashtag",{tag:hashtag,limit:24});
        return response({hashtag,media:normalize(data.posts),provider:"Instaloader",creditsCharged:0});
      }
      case "/api/media/detail":
      case "/api/media/music": {
        const media=cleanPostUrl(url.searchParams.get("media"));
        data=await upstream(env,"/v1/instagram/post",{url:media});
        return response({media:data.media||null,post:data.media||null,audio:null,provider:"Instaloader",creditsCharged:0,note:"Instaloader 不提供可靠的原声曲目识别元数据。"});
      }
      case "/api/comments": {
        const media=cleanPostUrl(url.searchParams.get("media"));
        data=await upstream(env,"/v1/instagram/comments",{url:media,limit:40});
        return response({comments:data.comments||[],lookupStatus:"ok",provider:"Instaloader",creditsCharged:0});
      }
      case "/api/likers": {
        const media=cleanPostUrl(url.searchParams.get("media"));
        data=await upstream(env,"/v1/instagram/likers",{url:media,limit:50});
        return response({accounts:data.accounts||[],sampled:!!data.sampled,lookupStatus:"ok",provider:"Instaloader",creditsCharged:0});
      }
      case "/api/search/profiles":
      case "/api/trending/reels":
      case "/api/hashtags/search":
      case "/api/highlight":
        fail("当前免费 Instaloader 后端不支持此功能，已移除无效请求，不会调用付费 API。",501);
      default: return response({error:"Not found"},404);
    }
  } catch(e) {
    const status=Number.isInteger(e.status)?e.status:500;
    return response({error:status>=500&&status!==501?"服务暂时不可用，请稍后重试。":e.message||"请求失败。"},status);
  }
 }
};
