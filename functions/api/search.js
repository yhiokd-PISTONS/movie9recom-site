// このファイルはサーバー側（Cloudflare）で動きます。
// ブラウザからは見えないので、ここにAPIキーを書いても安全です。

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

export async function onRequestGet(context) {
  const { request, env } = context;
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

    // それぞれの映画の「監督」も追加で取得する
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
