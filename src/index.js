// このファイルがサーバー側の頭脳です。
// 1) /api/search   → TMDBで映画を検索
// 2) /api/submit   → 4本を保存しておすすめを計算
// 3) それ以外      → publicフォルダの中のサイト本体(index.html)を表示

const PICK_COUNT = 4; // 選んでもらう本数
const REC_COUNT = 4;  // おすすめとして出す本数（4本それぞれの「参照元」を必ず変える）

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

function toMovie(m, extra) {
  return {
    id: String(m.id),
    title: m.title,
    year: m.release_date ? m.release_date.slice(0, 4) : "----",
    genre: (m.genre_ids || []).map(g => GENRE_JA[g]).filter(Boolean)[0] || "映画",
    director: "",
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : "",
    ...extra
  };
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
        return toMovie(m, { director });
      })
    );

    return json(withDirector);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// 1本の映画について、TMDBの「おすすめ映画」一覧を取得する
async function fetchTmdbRecs(movieId, key) {
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/movie/${movieId}/recommendations?api_key=${key}&language=ja-JP`
    );
    const d = await r.json();
    return d.results || [];
  } catch {
    return [];
  }
}

// 配信状況（JustWatch経由）のリンクを取得する
async function fetchWatchUrl(movieId, key) {
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/movie/${movieId}/watch/providers?api_key=${key}`
    );
    const d = await r.json();
    return (d.results && d.results.JP && d.results.JP.link) || null;
  } catch {
    return null;
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
  if (!sessionId || !Array.isArray(picks) || picks.length !== PICK_COUNT) {
    return json({ error: `${PICK_COUNT}本の映画が必要です` }, 400);
  }

  const storeKey = `picks:${sessionId}`;
  const myIds = picks.map(p => String(p.id));
  const mySet = new Set(myIds);
  const metaMap = {};
  picks.forEach(p => (metaMap[String(p.id)] = p));

  await KV.put(storeKey, JSON.stringify({ movies: myIds, meta: picks, ts: Date.now() }));

  // 他の人たちの選んだリストを集める
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

  // 似た人が3人以上いれば、コミュニティのおすすめを使う
  // （色々な人の組み合わせから来るので、自然と参照元が分散する）
  if (ranked.length >= 3) {
    const scored = {};
    ranked.slice(0, 80).forEach(s => {
      (s.movies || []).forEach(id => {
        if (!mySet.has(id)) scored[id] = (scored[id] || 0) + s.overlap;
      });
    });
    recs = Object.entries(scored)
      .sort((a, b) => b[1] - a[1])
      .slice(0, REC_COUNT)
      .map(([id]) => ({
        ...(metaMap[id] || { id, title: id, year: "", genre: "", director: "", poster: "" }),
        reason: "感性の近いユーザーのおすすめ"
      }));
  }

  // 足りない分はTMDBの「似ている映画」で補充する。
  // ここがポイント：4本それぞれの候補リストを「1本ずつ順番に」取っていくことで、
  // 最初に選んだ1本だけに偏らないようにする（ラウンドロビン方式）。
  if (recs.length < REC_COUNT && TMDB_KEY) {
    const exist = new Set([...myIds, ...recs.map(r => String(r.id))]);
    const pools = await Promise.all(
      picks.map(async p => ({
        pick: p,
        results: await fetchTmdbRecs(p.id, TMDB_KEY),
        idx: 0
      }))
    );

    let progressed = true;
    while (recs.length < REC_COUNT && progressed) {
      progressed = false;
      for (const pool of pools) {
        if (recs.length >= REC_COUNT) break;
        while (pool.idx < pool.results.length) {
          const m = pool.results[pool.idx++];
          const mid = String(m.id);
          if (exist.has(mid)) continue;
          exist.add(mid);
          recs.push(toMovie(m, { reason: `「${pool.pick.title}」が好きな人へ` }));
          progressed = true;
          break; // 1周につき1本だけ取って、次の映画の番に回す
        }
      }
    }
  }

  // 各おすすめ映画に「配信状況」のリンクを付け加える
  recs = await Promise.all(
    recs.map(async m => ({
      ...m,
      watchUrl: TMDB_KEY ? await fetchWatchUrl(m.id, TMDB_KEY) : null
    }))
  );

  return json({ recs, similarUsers });
}

// TMDBの画像を代わりに取りに行って返す係。
// これを経由させると「他サイトからの読み込み許可（CORS）」のヘッダーを
// 自分でつけられるので、Xシェア用の画像合成（canvas）が可能になる。
async function handleImageProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";

  // 安全のため、TMDBの画像サーバー以外は中継しない
  if (!target.startsWith("https://image.tmdb.org/")) {
    return new Response("invalid url", { status: 400 });
  }

  try {
    const r = await fetch(target, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return new Response("not found", { status: 404 });
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch (e) {
    return new Response("error", { status: 500 });
  }
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
    if (url.pathname === "/api/img" && request.method === "GET") {
      return handleImageProxy(request);
    }

    // それ以外のアクセスは、public フォルダの中のファイル（サイト本体）を返す
    return env.ASSETS.fetch(request);
  }
};
