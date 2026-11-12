// 킹콩 사이트 🤖 물어보기 — Claude 중계 Worker (build 307)
// 하는 일: 사이트(브라우저)가 보낸 대화를 Anthropic API로 넘기고 답을 돌려줌. API 키는 여기(비밀값)에만 있음.
// 설정(Cloudflare → Workers → 이 Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY (Secret, 필수)   Anthropic Console에서 만든 키
//   TEAM_CODE         (Secret, 권장)   뷰어용 팀 코드(사이트 🧠 패널에서 한 번 입력)
//   FIREBASE_API_KEY  (Text, 권장)     사이트 index.html의 firebase apiKey(관리자 로그인 확인용, 공개값)
//   ADMIN_EMAILS      (Text, 선택)     관리자 이메일(쉼표). 비우면 로그인한 모든 계정 허용
//   ALLOWED_ORIGINS   (Text, 선택)     기본 https://ldj0120-boop.github.io
//   MODEL_FAST / MODEL_DEEP (Text, 선택) 기본 claude-haiku-4-5 / claude-sonnet-4-5 (Anthropic 모델 목록에서 최신 이름으로 바꿔도 됨)
//   DAILY_LIMIT       (Text, 선택)     사람(관리자 이메일 · 뷰어 IP)마다 하루 질문 수, 기본 150 — KV 'USAGE'를 연결했을 때만 셈
// KV(선택): Workers KV 네임스페이스를 만들어 이 Worker에 'USAGE' 이름으로 연결하면 하루 한도를 셈.
const tokenCache = new Map();
async function adminEmail(token, env){
  if(!token || !env.FIREBASE_API_KEY) return null;
  const c = tokenCache.get(token); if(c && c.exp > Date.now()) return c.email;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ idToken: token }) });
  if(!r.ok) return null; const j = await r.json(); const email = j && j.users && j.users[0] && j.users[0].email; if(!email) return null;
  const allow = (env.ADMIN_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(allow.length && !allow.includes(email.toLowerCase())) return null;
  tokenCache.set(token, { email, exp: Date.now() + 5*60*1000 }); return email;
}
export default {
  async fetch(req, env){
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://ldj0120-boop.github.io").split(",").map(x=>x.trim());
    const okOrigin = allowed.includes(origin);
    const cors = { "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0], "Access-Control-Allow-Methods":"POST, GET, OPTIONS", "Access-Control-Allow-Headers":"content-type, authorization, x-kk-code", "Access-Control-Max-Age":"86400", "Vary":"Origin" };
    const J = (o, st=200)=> new Response(JSON.stringify(o), { status:st, headers:{ ...cors, "content-type":"application/json; charset=utf-8" } });
    if(req.method === "OPTIONS") return new Response(null, { status:204, headers:cors });
    if(req.method === "GET") return J({ ok:true, fast: env.MODEL_FAST || "claude-haiku-4-5", deep: env.MODEL_DEEP || "claude-sonnet-4-5", key: !!env.ANTHROPIC_API_KEY });
    if(req.method !== "POST") return J({ error:"POST만 됩니다" }, 405);
    if(!okOrigin) return J({ error:"허용되지 않은 사이트" }, 403);
    if(!env.ANTHROPIC_API_KEY) return J({ error:"Worker에 ANTHROPIC_API_KEY가 없습니다" }, 500);
    // 누가 묻나: 관리자(Firebase 로그인) 또는 팀 코드
    const bearer = (req.headers.get("authorization")||"").replace(/^Bearer\s+/i, "");
    let who = null;
    try{ who = await adminEmail(bearer, env); }catch(_){ who = null; }
    if(!who){ const code = req.headers.get("x-kk-code") || ""; if(env.TEAM_CODE && code === env.TEAM_CODE) who = "viewer:" + (req.headers.get("CF-Connecting-IP") || "?"); }
    if(!who && !env.TEAM_CODE && !env.FIREBASE_API_KEY) who = "open";   // 처음 시험할 때만(코드 · 로그인 확인 둘 다 안 넣은 경우)
    if(!who) return J({ error:"권한 없음 — 관리자 로그인 또는 팀 코드" }, 401);
    // 하루 한도(KV 연결 시)
    if(env.USAGE){ const day = new Date(Date.now()+9*3600e3).toISOString().slice(0,10), k = `${day}|${who}`; const n = +(await env.USAGE.get(k) || 0);
      if(n >= +(env.DAILY_LIMIT || 150)) return J({ error:"오늘 한도를 다 썼습니다" }, 429);
      await env.USAGE.put(k, String(n+1), { expirationTtl: 3*86400 }); }
    let b; try{ b = await req.json(); }catch(_){ return J({ error:"잘못된 요청" }, 400); }
    if(!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 40) return J({ error:"messages 확인" }, 400);
    const body = { model: b.tier === "deep" ? (env.MODEL_DEEP || "claude-sonnet-4-5") : (env.MODEL_FAST || "claude-haiku-4-5"),
      max_tokens: Math.min(+b.max_tokens || 1200, 4000), system: b.system, tools: Array.isArray(b.tools) ? b.tools.slice(0, 20) : undefined, messages: b.messages, temperature: 0 };
    const r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", headers:{ "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    return new Response(txt, { status: r.status, headers:{ ...cors, "content-type":"application/json; charset=utf-8" } });
  }
};
