const SECURITY_HEADERS={
 "X-Content-Type-Options":"nosniff",
 "X-Frame-Options":"DENY",
 "Referrer-Policy":"no-referrer",
 "Cross-Origin-Resource-Policy":"same-origin",
 "X-DNS-Prefetch-Control":"off",
 "X-Download-Options":"noopen",
 "Permissions-Policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
 "Cross-Origin-Opener-Policy":"same-origin",
 "X-Permitted-Cross-Domain-Policies":"none",
 "Origin-Agent-Cluster":"?1",
 "Strict-Transport-Security":"max-age=31536000; includeSubDomains",
 "X-Robots-Tag":"noindex, nofollow, noarchive"
};
function badRequest(message){const error=new Error(message);error.status=400;return error;}
function nonceValue(){
 const bytes=new Uint8Array(18);crypto.getRandomValues(bytes);
 return btoa(String.fromCharCode(...bytes));
}
function withSecurity(response,nonce=null){
 const headers=new Headers(response.headers);
 for(const [k,v] of Object.entries(SECURITY_HEADERS))headers.set(k,v);
 const scriptPolicy=nonce
  ? `script-src 'self' 'nonce-${nonce}' https://www.instagram.com`
  : "script-src 'self' https://www.instagram.com";
 const stylePolicy=nonce
  ? `style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'`
  : "style-src 'self'; style-src-attr 'unsafe-inline'";
 headers.set("Content-Security-Policy",`default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self' blob:; ${scriptPolicy}; ${stylePolicy}; img-src 'self' data: blob: https://*.cdninstagram.com https://*.fbcdn.net https://assets.science.nasa.gov; media-src 'self' blob: https://*.cdninstagram.com https://*.fbcdn.net; font-src 'self' data:; connect-src 'self'; frame-src https://www.instagram.com https://open.spotify.com; upgrade-insecure-requests`);
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
async function secureAssetResponse(response){
 if(!response.ok)return withSecurity(response);
 const type=response.headers.get("content-type")||"";
 if(!type.toLowerCase().includes("text/html"))return withSecurity(response);
 const nonce=nonceValue();
 const html=await response.text();
 const secured=html.replace(/<(script|style)\b/gi,match=>match+` nonce="${nonce}"`);
 const headers=new Headers(response.headers);
 headers.set("Cache-Control","no-store, max-age=0");
 headers.set("Pragma","no-cache");
 headers.delete("ETag");
 headers.delete("Last-Modified");
 return withSecurity(new Response(secured,{status:response.status,statusText:response.statusText,headers}),nonce);
}
const json=(data,status=200)=>withSecurity(new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","pragma":"no-cache"}}));
async function rateLimit(request,path,env){
 if(!env.RATE_LIMITER)return {allowed:false,unavailable:true};
 const ip=request.headers.get("CF-Connecting-IP")||"unknown";
 const expensive=/\/(profile|stories|highlights?|media|comments|likers|trending|search)/.test(path);
 const limit=expensive?20:90;
 try{
  const id=env.RATE_LIMITER.idFromName(ip+"|"+(expensive?"expensive":"general"));
  const stub=env.RATE_LIMITER.get(id);
  const response=await stub.fetch("https://rate-limiter.internal/check",{
   method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({limit,windowMs:60_000})
  });
  if(!response.ok)return {allowed:false,unavailable:true};
  return await response.json();
 }catch{return {allowed:false,unavailable:true};}
}
function validMedia(value){
 const raw=String(value||"").trim();
 if(!raw||raw.length>500)throw badRequest("请输入有效的 Instagram 帖子或 Reels 链接。");
 let u;try{u=new URL(raw)}catch{throw badRequest("请使用完整的 Instagram 官方链接。");}
 if(u.protocol!=="https:"||!/(^|\.)instagram\.com$/i.test(u.hostname)||u.username||u.password)throw badRequest("只支持 HTTPS Instagram 官方链接。");
 if(!/^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))throw badRequest("请使用 Instagram 帖子或 Reels 链接。");
 return u.origin+u.pathname;
}
function safeCursor(value){
 if(!value)return null;
 const v=String(value).trim();
 if(v.length>500||/[<>\r\n]/.test(v))throw badRequest("分页标记无效，请重新加载列表。");
 return v;
}
function cleanProfile(value){
 let raw=String(value||"").trim();
 if(/^https?:\/\//i.test(raw)){
  let parsed;try{parsed=new URL(raw)}catch{throw badRequest("Instagram 主页链接无效。")}
  if(parsed.protocol!=="https:"||!/(^|\.)instagram\.com$/i.test(parsed.hostname)||parsed.username||parsed.password)throw badRequest("只支持 HTTPS Instagram 官方主页链接。");
  const parts=parsed.pathname.split("/").filter(Boolean);
  raw=parts[0]==="stories"?parts[1]||"":parts[0]||"";
 }
 raw=raw.replace(/^@/,"");
 if(!/^[A-Za-z0-9._]{1,30}$/.test(raw))throw badRequest("请输入有效的 Instagram 用户名，或 instagram.com 用户主页链接。");
 return raw;
}

async function social(path,env){
 if(!env.INSTALOADER_SERVICE_URL||!env.INSTALOADER_SERVICE_TOKEN){
  const e=new Error("Instaloader Python 服务尚未连接。请配置 INSTALOADER_SERVICE_URL 和 INSTALOADER_SERVICE_TOKEN。");e.status=503;throw e;
 }
 let base;
 try{base=new URL(env.INSTALOADER_SERVICE_URL);}catch{const e=new Error("INSTALOADER_SERVICE_URL 不是有效网址。");e.status=503;throw e;}
 if(base.protocol!=="https:"||base.username||base.password){const e=new Error("Instaloader 服务地址必须使用 HTTPS。");e.status=503;throw e;}
 if(typeof path!=="string"||!path.startsWith("/v2/instagram/")||path.includes("..")||path.length>1800){const e=new Error("无效的上游请求。");e.status=400;throw e;}
 const [p,q=""]=path.split("?"),old=new URLSearchParams(q);
 let route="",params=new URLSearchParams();
 const stories=p.match(/^\/v2\/instagram\/profiles\/([^/]+)\/stories$/);
 const highlights=p.match(/^\/v2\/instagram\/profiles\/([^/]+)\/highlights$/);
 const list=p.match(/^\/v2\/instagram\/profiles\/([^/]+)\/media$/);
 const profile=p.match(/^\/v2\/instagram\/profiles\/([^/]+)$/);
 const highlight=p.match(/^\/v2\/instagram\/highlights\/(\d{5,30})$/);
 const tag=p.match(/^\/v2\/instagram\/hashtags\/([^/]+)\/media$/);
 const comments=p.match(/^\/v2\/instagram\/media\/([^/]+)\/comments$/);
 const media=p.match(/^\/v2\/instagram\/media\/([^/]+)$/);
 const search=p==="/v2/instagram/profiles/search";
 const likers=/\/likers$/.test(p);
 if(stories){route="/v1/instagram/stories";params.set("handle",decodeURIComponent(stories[1]));}
 else if(highlights){route="/v1/instagram/highlights";params.set("handle",decodeURIComponent(highlights[1]));}
 else if(list){route=old.get("tab")==="reels"?"/v1/instagram/reels":"/v1/instagram/posts";params.set("handle",decodeURIComponent(list[1]));}
 else if(profile){route="/v1/instagram/profile";params.set("handle",decodeURIComponent(profile[1]));}
 else if(highlight){const e=new Error("Instaloader bridge 当前不支持仅凭 Highlight ID 读取内容；请先加载账号 Highlights。");e.status=501;throw e;}
 else if(tag){route="/v1/instagram/hashtag";params.set("tag",decodeURIComponent(tag[1]));}
 else if(comments){route="/v1/instagram/comments";params.set("url",decodeURIComponent(comments[1]));}
 else if(media){route="/v1/instagram/post";params.set("url",decodeURIComponent(media[1]));}
 else if(search){const e=new Error("Instaloader 不提供 Instagram 账号搜索接口。");e.status=501;throw e;}
 else if(p==="/v2/instagram/reels/trending"){const e=new Error("Instaloader 不提供全站热门 Reels 榜单。");e.status=501;throw e;}
 else if(p==="/v2/instagram/hashtags/search"){const e=new Error("Instaloader 不提供话题自动补全搜索。");e.status=501;throw e;}
 else if(likers){route="/v1/instagram/likers";params.set("url",decodeURIComponent(p.match(/^\/v2\/instagram\/media\/([^/]+)\/likers$/)?.[1]||""));}
 else {const e=new Error("Instaloader 适配器不支持此功能，未调用其他服务。");e.status=501;throw e;}
 const target=new URL(route,base.origin);target.search=params.toString();
 let response,data;
 try{
  response=await fetch(target.toString(),{method:"GET",headers:{"authorization":"Bearer "+env.INSTALOADER_SERVICE_TOKEN,"accept":"application/json"},redirect:"error",signal:AbortSignal.timeout(28000)});
  const raw=await response.text();if(raw.length>5_000_000)throw new Error("response too large");data=JSON.parse(raw);
 }catch(err){const e=new Error("Instaloader Python 服务连接失败或超时，请检查服务是否在线。");e.status=504;throw e;}
 if(!response.ok){
  const msg=data?.error||data?.detail||"Instaloader 请求失败。";
  const e=new Error(String(msg).slice(0,400));e.status=response.status;throw e;
 }
 return {data:data?.data||{},meta:{provider:"Instaloader",creditsCharged:0,stale:false}};
}
function normalize(items){
 const typeOf=x=>{const t=String(x?.mediaType||"").toLowerCase();if(t==="video"||x?.videoUrl)return "VIDEO";if(t==="carousel"||Array.isArray(x?.carousel)&&x.carousel.length)return "CAROUSEL";return "IMAGE"};
 const one=x=>({
  id:x.id||null,
  media_type:typeOf(x),
  media_url:x.videoUrl||x.imageUrl||x.thumbnailUrl||x.carousel?.[0]?.videoUrl||x.carousel?.[0]?.imageUrl||"",
  thumbnail_url:x.thumbnailUrl||x.imageUrl||x.carousel?.[0]?.imageUrl||x.carousel?.[0]?.videoUrl||"",
  timestamp:x.createdAt||x.story?.expiresAt||null,
  permalink:x.url||null,
  caption:x.caption||x.altText||"",
  kind:x.kind||"post",
  carousel:Array.isArray(x.carousel)?x.carousel.map((c,i)=>({id:c.id||String(i),media_type:String(c.mediaType||"").toLowerCase()==="video"||c.videoUrl?"VIDEO":"IMAGE",media_url:c.videoUrl||c.imageUrl||"",thumbnail_url:c.imageUrl||c.videoUrl||"",caption:c.altText||x.caption||"",timestamp:x.createdAt||null,permalink:x.url||null,kind:"carousel"})).filter(c=>c.media_url||c.thumbnail_url):[]
 });
 return (Array.isArray(items)?items:[]).map(one).filter(x=>x.media_url||x.thumbnail_url||x.carousel.length);
}
export class RateLimiter {
 constructor(state,env){this.state=state;this.env=env;}
 async fetch(request){
  const url=new URL(request.url);
  if(url.hostname!=="rate-limiter.internal"||url.pathname!=="/check")return new Response("Not found",{status:404,headers:{"cache-control":"no-store"}});
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  let input;try{input=await request.json()}catch{return new Response("Bad request",{status:400});}
  const limit=Math.max(1,Math.min(100,Number(input.limit)||1));
  const windowMs=Math.max(1000,Math.min(300000,Number(input.windowMs)||60000));
  const now=Date.now();
  let result;
  try{
   result=await this.state.storage.transaction(async tx=>{
    let bucket=await tx.get("bucket");
    if(!bucket||now-bucket.start>=windowMs)bucket={start:now,count:0};
    bucket.count++;
    await tx.put("bucket",bucket);
    return {allowed:bucket.count<=limit,remaining:Math.max(0,limit-bucket.count),resetAt:bucket.start+windowMs};
   });
   await this.state.storage.setAlarm(now+windowMs*2);
  }catch{return new Response("Rate limiter storage unavailable",{status:503});}
  return Response.json(result,{headers:{"cache-control":"no-store"}});
 }
 async alarm(){try{await this.state.storage.delete("bucket");}catch{}}
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  try{
   if(url.pathname.startsWith("/api/")){
    if(request.method!=="GET")return json({error:"Method not allowed"},405);
    const origin=request.headers.get("Origin");
    if(origin&&origin!==url.origin)return json({error:"Cross-origin request blocked"},403);
    if(request.headers.get("Sec-Fetch-Site")==="cross-site")return json({error:"Cross-site request blocked"},403);
    const rate=await rateLimit(request,url.pathname,env);
    if(rate.unavailable)return json({error:"安全限流服务暂不可用，请稍后重试。"},503);
    if(!rate.allowed)return withSecurity(new Response(JSON.stringify({error:"请求过于频繁，请一分钟后重试。"}),{status:429,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","retry-after":"60"}}));
   }
   if(url.pathname==="/spotify/callback"){
    const target=new URL("/spotify-player.html",url);
    target.search=url.search;
    return withSecurity(Response.redirect(target.toString(),302));
   }
   if(url.pathname==="/api/health") return json({ok:true,service:"instagram-stories-viewer",provider:"Instaloader",paidFallback:false,creditsCharged:0});
   if(url.pathname==="/api/status"){
    const configured=!!(env.INSTALOADER_SERVICE_URL&&env.INSTALOADER_SERVICE_TOKEN);
    if(!configured)return json({connected:false,provider:"Instaloader",configured:false,paidFallback:false,message:"请配置 Cloudflare Worker 的 INSTALOADER_SERVICE_URL 和 INSTALOADER_SERVICE_TOKEN。"});
    try{
     const base=new URL(env.INSTALOADER_SERVICE_URL);
     if(base.protocol!=="https:")throw new Error("HTTPS required");
     // /health is intentionally public; it verifies service reachability, not API-token auth.
     // Render Free instances can take a while to wake after idle, so allow a longer timeout.
     const r=await fetch(new URL("/health",base.origin).toString(),{redirect:"error",signal:AbortSignal.timeout(25000)});
     const d=await r.json().catch(()=>({}));
     const connected=r.ok&&d.ok===true;
     return json({connected,provider:"Instaloader",configured:true,authenticated:!!d.authenticated,version:d.version||null,paidFallback:false,creditsCharged:0,httpStatus:r.status,message:connected?"Instaloader Python 服务已连接；Instagram 数据请求仍受 Instagram 自身限流。":("Render 健康检查返回 HTTP "+r.status+"，响应不是有效的健康状态。")});
    }catch(err){return json({connected:false,provider:"Instaloader",configured:true,paidFallback:false,creditsCharged:0,error:err?.name||"FetchError",message:"Cloudflare 无法在 25 秒内完成 Render 健康检查。请确认 URL 是服务根地址且 Render 服务为 Live；如果刚休眠，请稍后重试。"});}
   }
   if(url.pathname==="/api/profile"){
    const profile=cleanProfile(url.searchParams.get("username"));
    const result=await social("/v2/instagram/profiles/"+encodeURIComponent(profile)+"?include=recentMedia,about",env);
    const d=result.data||{};
    const raw=d.profile||{};const mapped={handle:raw.handle||raw.username||profile,displayName:raw.full_name||raw.fullName||raw.username||profile,bio:raw.biography||raw.bio||"",avatarUrl:raw.profile_pic_url||raw.avatarUrl||"",avatarUrlHd:raw.profile_pic_url||raw.avatarUrlHd||"",verified:!!(raw.is_verified??raw.verified),isPrivate:!!(raw.is_private??raw.isPrivate),metrics:{posts:raw.media_count??raw.metrics?.posts??0,followers:raw.follower_count??raw.metrics?.followers??0,following:raw.following_count??raw.metrics?.following??0}};return json({username:profile,lookupStatus:d.lookupStatus||"ok",profile:mapped,recentMedia:normalize(d.recentMedia||d.posts),about:d.about||null,creditsCharged:result.meta?.creditsCharged??0,stale:!!result.meta?.stale});
   }
   if(url.pathname==="/api/trending/reels"){
    const result=await social("/v2/instagram/reels/trending",env);
    const d=result.data||{};
    return json({media:normalize(d.media),items:d.media||[],creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/hashtags/search"){
    const query=String(url.searchParams.get("query")||"").trim();
    if(!query||query.length>100) throw badRequest("请输入话题关键词。");
    const result=await social("/v2/instagram/hashtags/search?query="+encodeURIComponent(query),env);
    const d=result.data||{};
    return json({hashtags:d.hashtags||[],creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/hashtags/media"){
    const hashtag=String(url.searchParams.get("hashtag")||"").trim().replace(/^#/,"");
    if(!/^[\p{L}\p{N}_.]+$/u.test(hashtag)||hashtag.length>100) throw badRequest("话题标签格式无效。");
    const tab=["top","recent","reels"].includes(url.searchParams.get("tab"))?url.searchParams.get("tab"):"top";
    const cursor=safeCursor(url.searchParams.get("cursor"));
    const qs=new URLSearchParams({tab});if(cursor)qs.set("cursor",cursor);
    const result=await social("/v2/instagram/hashtags/"+encodeURIComponent(hashtag)+"/media?"+qs.toString(),env);
    const d=result.data||{};
    return json({media:normalize(d.media||d.posts),page:d.page||null,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/search/profiles"){
    const query=String(url.searchParams.get("query")||"").trim();
    if(!query||query.length>100) throw badRequest("请输入要搜索的账号关键词（最多 100 个字符）。");
    const cursor=safeCursor(url.searchParams.get("cursor"));
    const qs=new URLSearchParams({query});if(cursor)qs.set("cursor",cursor);
    const result=await social("/v2/instagram/profiles/search?"+qs.toString(),env);
    const d=result.data||{};
    return json({accounts:d.accounts||[],page:d.page||null,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/comments"){
    const media=validMedia(url.searchParams.get("media"));
    const sort=url.searchParams.get("sort")==="newest"?"newest":"top";
    const cursor=safeCursor(url.searchParams.get("cursor"));
    const qs=new URLSearchParams({sort});if(cursor)qs.set("cursor",cursor);
    const result=await social("/v2/instagram/media/"+encodeURIComponent(media)+"/comments?"+qs.toString(),env);
    const d=result.data||{};
    return json({lookupStatus:d.lookupStatus||"unknown",comments:d.comments||[],page:d.page||null,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/likers"){
    const media=validMedia(url.searchParams.get("media"));
    const result=await social("/v2/instagram/media/"+encodeURIComponent(media)+"/likers",env);
    const d=result.data||{};
    return json({lookupStatus:d.lookupStatus||"unknown",accounts:d.accounts||[],sampled:!!d.sampled,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/media/music"){
    const media=validMedia(url.searchParams.get("media"));
    const result=await social("/v2/instagram/media/"+encodeURIComponent(media),env);
    const d=result.data||{},m=d.media||{};
    return json({lookupStatus:d.lookupStatus||"unknown",audio:d.audio||m.audio||null,post:m?{id:m.id||null,url:m.url||media,kind:m.kind||null,mediaType:m.mediaType||null,caption:m.caption||null,owner:m.owner||null}:null,creditsCharged:result.meta?.creditsCharged??null,stale:!!result.meta?.stale});
   }
   if(url.pathname==="/api/media/detail"){
    const media=validMedia(url.searchParams.get("media"));
    const result=await social("/v2/instagram/media/"+encodeURIComponent(media),env);
    const d=result.data||{};
    return json({lookupStatus:d.lookupStatus||"unknown",media:d.media||null,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/stories"){
    const profile=cleanProfile(url.searchParams.get("username"));
    const result=await social("/v2/instagram/profiles/"+encodeURIComponent(profile)+"/stories",env);
    const d=result.data||{};
    return json({username:profile,lookupStatus:d.lookupStatus||"unknown",stories:normalize(d.media||d.stories),creditsCharged:result.meta?.creditsCharged??null,stale:!!result.meta?.stale,fetchedAt:result.meta?.fetchedAt||null});
   }
   if(url.pathname==="/api/highlights"){
    const profile=cleanProfile(url.searchParams.get("username"));
    const result=await social("/v2/instagram/profiles/"+encodeURIComponent(profile)+"/highlights",env);
    const d=result.data||{};
    return json({username:profile,lookupStatus:d.lookupStatus||"unknown",highlights:d.highlights||[],creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/highlight"){
    const id=String(url.searchParams.get("id")||"").trim();
    if(!/^\d{5,30}$/.test(id)) throw badRequest("精选快拍 ID 无效。");
    const result=await social("/v2/instagram/highlights/"+encodeURIComponent(id),env);
    const d=result.data||{};
    return json({highlight:d.highlight||null,stories:normalize(d.media),lookupStatus:d.lookupStatus||"unknown",creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname==="/api/media"){
    const profile=cleanProfile(url.searchParams.get("username"));
    const tab=["posts","reels"].includes(url.searchParams.get("tab"))?url.searchParams.get("tab"):"posts";
    const result=await social("/v2/instagram/profiles/"+encodeURIComponent(profile)+"/media?tab="+tab,env);
    const d=result.data||{};
    return json({username:profile,lookupStatus:d.lookupStatus||"unknown",media:normalize(d.media||d.posts||d.reels),page:d.page||null,creditsCharged:result.meta?.creditsCharged??null});
   }
   if(url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
   return env.ASSETS?await secureAssetResponse(await env.ASSETS.fetch(request)):withSecurity(new Response("Static assets binding missing",{status:500}));
  }catch(e){const status=Number.isInteger(e.status)?e.status:500;const message=status>=500?"服务器暂时不可用，请稍后重试。":(e.message||"请求失败");return url.pathname.startsWith("/api/")?json({error:message,retryAt:e.retryAt||null},status):withSecurity(new Response("服务暂时不可用",{status:503}));}
 }
};
