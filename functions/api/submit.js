// 9本の映画を保存し、似た人を探して、おすすめを9本返す係。

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

export async function onRequestPost(context) {
  const { request, env } = context;
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

  // 1) 自分の9本を倉庫に保存する
  await KV.put(storeKey, JSON.stringify({ movies: myIds, meta: picks, ts: Date.now() }));

  // 2) 倉庫にある「他の人たちの9本」を全部見て、自分との一致数を数える
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

  // 3) 一致が多い人ほど重みをつけて、おすすめ映画に点数をつける
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

  // 4) まだ9本に足りない場合は、TMDBの「似ている映画」機能で補充する（無料・AI不使用）
  const source = recs.length >= 9 ? "community" : recs.length > 0 ? "mixed" : "tmdb";
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

  return json({ recs, similarUsers, source });
}
