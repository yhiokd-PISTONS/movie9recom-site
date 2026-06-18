// このファイルがサーバー側の頭脳です。
// 1) /api/search   → TMDBで映画を検索
// 2) /api/submit   → 9本を保存しておすすめを計算
// 3) それ以外      → publicフォルダの中のサイト本体(index.html)を表示

const GENRE_JA = {
  28: "アクション", 12: "アドベンチャー", 16: "アニメーション", 35: "コメディ",
  80: "クライム", 99: "ドキュメンタリー", 18: "ドラマ", 10751: "ファミリー",
  14: "ファンタジー", 36: "歴史", 27: "ホラー", 10402: "音楽",
  9648: "ミステリー", 10749: "ロマンス", 878: "SF", 10770: "TVムービー",
  53: "スリラー", 10752: "戦争", 37: "西部劇"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json([]);

  const key = env.TMDB_API_KEY;
  if (!key) return json({ error: "TMDB_API_KEYが設定されていません" }, 500);

  try {
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encodeURIComponent(q)}&language=ja-JP&include_adult=false`
    );
    const data = await searchRes.json();
    const results = (data.results || []).slice(0, 6);

    const withDirector = await Promise.all(
      results.map(async m => {
        let director = "";
        try {
          const c = await fetch(
            `https://api.themoviedb.org/3/movie/${m.id}/credits?api_key=${key}&language=ja-JP`
          );
          const cd = await c.json();
          const found = (cd.crew || []).find(p => p.job === "Director");
          director = found ? found.name : "";
        } catch {}
        return {
          id: String(m.id),
          title: m.title,
          year: m.release_date ? m.release_date.slice(0, 4) : "----",
          genre: (m.genre_ids || []).map(g => GENRE_JA[g]).filter(Boolean)[0] || "映画",
          director,
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : ""
        };
      })
    );

    return json(withDirector);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

async function handleSubmit(request, env) {
  const KV = env.MOVIE9_KV;
  const TMDB_KEY = env.TMDB_API_KEY;
  if (!KV) return json({ error: "MOVIE9_KVが設定されていません" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "リクエストの形式が不正です" }, 400);
  }

  const { sessionId, picks } = body || {};
  if (!sessionId || !Array.isArray(picks) || picks.length !== 9) {
    return json({ error: "9本の映画が必要です" }, 400);
  }

  const storeKey = `picks:${sessionId}`;
  const myIds = picks.map(p => String(p.id));
  const mySet = new Set(myIds);
  const metaMap = {};
  picks.forEach(p => (metaMap[String(p.id)] = p));

  await KV.put(storeKey, JSON.stringify({ movies: myIds, meta: picks, ts: Date.now() }));

  let sessions = [];
  try {
    const list = await KV.list({ prefix: "picks:" });
    for (const k of list.keys) {
      if (k.name === storeKey) continue;
      const raw = await KV.get(k.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        sessions.push(parsed);
        (parsed.meta || []).forEach(m => {
          if (m && m.id && !metaMap[String(m.id)]) metaMap[String(m.id)] = m;
        });
      } catch {}
    }
  } catch {}

  const ranked = sessions
    .map(s => ({ ...s, overlap: (s.movies || []).filter(id => mySet.has(id)).length }))
    .filter(s => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  const similarUsers = ranked.length;
  let recs = [];

  if (ranked.length >= 3) {
    const scored = {};
    ranked.slice(0, 80).forEach(s => {
      (s.movies || []).forEach(id => {
        if (!mySet.has(id)) scored[id] = (scored[id] || 0) + s.overlap;
      });
    });
    recs = Object.entries(scored)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 9)
      .map(([id]) => ({
        ...(metaMap[id] || { id, title: id, year: "", genre: "", director: "" }),
        reason: "感性の近いユーザーのおすすめ"
      }));
  }

  if (recs.length < 9 && TMDB_KEY) {
    const exist = new Set([...myIds, ...recs.map(r => String(r.id))]);
    for (const p of picks) {
      if (recs.length >= 9) break;
      try {
        const r = await fetch(
          `https://api.themoviedb.org/3/movie/${p.id}/recommendations?api_key=${TMDB_KEY}&language=ja-JP`
        );
        const d = await r.json();
        for (const m of d.results || []) {
          if (recs.length >= 9) break;
          const mid = String(m.id);
          if (exist.has(mid)) continue;
          exist.add(mid);
          recs.push({
            id: mid,
            title: m.title,
            year: m.release_date ? m.release_date.slice(0, 4) : "----",
            genre: (m.genre_ids || []).map(g => GENRE_JA[g]).filter(Boolean)[0] || "映画",
            director: "",
            poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : "",
            reason: `「${p.title}」が好きな人へ`
          });
        }
      } catch {}
    }
  }

  return json({ recs, similarUsers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search" && request.method === "GET") {
      return handleSearch(request, env);
    }
    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    // それ以外のアクセスは、public フォルダの中のファイル（サイト本体）を返す
    return env.ASSETS.fetch(request);
  }
};
