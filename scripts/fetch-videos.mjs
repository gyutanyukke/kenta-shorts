// YouTube Data API v3 からショート動画の一覧を取得して data/videos.json を更新する
// 使い方:  YT_API_KEY=xxxx node scripts/fetch-videos.mjs [--full]
//   --full または環境変数 FULL=1 で全件取り直し（削除・タイトル変更も反映）
//   それ以外は新着だけ取得して既存データに追加する（日曜日は自動で全件）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const CHANNEL_ID = process.env.CHANNEL_ID || 'UCWsAvz-plMpc8dgiaoMb0XQ'; // @oi_ken（けんた食堂）
const API_KEY = process.env.YT_API_KEY;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/data/videos.json`;
const SHORTS_MAX_SECONDS = 180; // 予備判定用：ショートは最長3分
const API = 'https://www.googleapis.com/youtube/v3';

if (!API_KEY) {
  console.error('YT_API_KEY が設定されていません');
  process.exit(1);
}

let quota = 0;

async function api(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: API_KEY })) url.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    quota += 1;
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || '';
    const err = new Error(`${path} ${res.status} ${reason} ${body?.error?.message || ''}`.trim());
    err.status = res.status;
    err.reason = reason;
    if (res.status >= 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw err;
  }
}

// 再生リストを新しい順にたどる。stopIds に含まれる動画が出たページで打ち切る
async function walkPlaylist(playlistId, stopIds) {
  const items = [];
  let pageToken;
  do {
    const data = await api('playlistItems', {
      part: 'snippet,contentDetails,status',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    let reachedKnown = false;
    for (const it of data.items || []) {
      const id = it.contentDetails?.videoId;
      if (!id) continue;
      if (stopIds?.has(id)) reachedKnown = true;
      items.push(it);
    }
    if (reachedKnown) break;
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

const toVideo = it => {
  const id = it.contentDetails.videoId;
  const th = it.snippet.thumbnails || {};
  return {
    id,
    title: it.snippet.title,
    description: it.snippet.description || '',
    publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    thumbnail: (th.medium || th.high || th.default || {}).url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    url: `https://www.youtube.com/shorts/${id}`,
  };
};

const isPublic = it =>
  it.status?.privacyStatus === 'public' && it.contentDetails?.videoPublishedAt;

// ISO8601 の再生時間（PT1M5S など）を秒に
const seconds = iso => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
};

async function durations(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await api('videos', { part: 'contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    for (const v of data.items || []) out.set(v.id, seconds(v.contentDetails.duration));
  }
  return out;
}

async function main() {
  let existing = { videos: [] };
  try { existing = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }

  const sunday = new Date(Date.now() + 9 * 3600e3).getUTCDay() === 0; // JST の曜日
  const full = process.argv.includes('--full') || process.env.FULL === '1' || sunday || !existing.videos?.length;
  const known = full ? null : new Set(existing.videos.map(v => v.id));

  // 主方式：ショート専用の自動生成再生リスト（UC → UUSH）
  const shortsList = 'UUSH' + CHANNEL_ID.slice(2);
  let items, method;
  try {
    items = await walkPlaylist(shortsList, known);
    method = 'UUSH';
  } catch (e) {
    if (e.status !== 404) throw e;
    // 予備方式：全アップロード（UC → UU）から3分以下を抽出
    console.warn('ショート再生リストが見つからないため、再生時間で判定します');
    const all = (await walkPlaylist('UU' + CHANNEL_ID.slice(2), known)).filter(isPublic);
    const dur = await durations(all.map(it => it.contentDetails.videoId));
    items = all.filter(it => (dur.get(it.contentDetails.videoId) ?? Infinity) <= SHORTS_MAX_SECONDS);
    method = 'duration';
  }

  const fetched = items.filter(isPublic).map(toVideo);
  const byId = new Map();
  if (!full) for (const v of existing.videos) byId.set(v.id, v);
  for (const v of fetched) byId.set(v.id, v); // 新しく取れたもので上書き（タイトル変更の反映）

  const videos = [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  // 全件取得なのに極端に減った場合は異常とみなして上書きしない
  if (full && existing.videos?.length && videos.length < existing.videos.length * 0.5) {
    throw new Error(`取得件数が異常に少ないため中止しました（既存 ${existing.videos.length} → 取得 ${videos.length}）`);
  }

  const added = videos.filter(v => !existing.videos?.some(e => e.id === v.id)).length;
  const out = {
    channelId: CHANNEL_ID,
    fetchedAt: new Date().toISOString(),
    method,
    count: videos.length,
    videos,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`${full ? '全件' : '差分'}取得：${videos.length}件（新規 ${added}件、判定方式 ${method}、使用クォータ約 ${quota}）`);
  await reportCategories(videos);
}

// カテゴリ判定の結果をログに出す（未分類のタイトルを辞書追加の参考にする）
async function reportCategories(videos) {
  try {
    const require = createRequire(import.meta.url);
    const C = require(`${ROOT}/classify.js`);
    const cats = C.compile(JSON.parse(await readFile(`${ROOT}/data/categories.json`, 'utf8')));
    let overrides = {};
    try { overrides = JSON.parse(await readFile(`${ROOT}/data/category-overrides.json`, 'utf8')); } catch { /* なし */ }
    const results = videos.map(v => ({ v, r: C.classify(cats, v, overrides) }));
    const none = results.filter(x => !x.r.cats.length);
    const guessed = results.filter(x => x.r.source === 'description');
    console.log(`カテゴリ：分類済み ${videos.length - none.length}件 / 概要から推定 ${guessed.length}件 / 未分類 ${none.length}件`);
    if (none.length) {
      console.log('--- 未分類の動画（categories.json にキーワードを足すか、category-overrides.json で指定） ---');
      for (const { v } of none.slice(0, 100)) console.log(`${v.id}  ${v.title}`);
      if (none.length > 100) console.log(`…ほか ${none.length - 100}件`);
    }
  } catch (e) {
    console.warn('カテゴリ集計をスキップしました：', e.message);
  }
}

main().catch(e => {
  console.error('取得に失敗しました。データは更新していません：', e.message);
  process.exit(1);
});
