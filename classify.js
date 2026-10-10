// 動画のカテゴリ判定（ブラウザと Node の両方で使う）
// 判定順：手動上書き → タイトル＋ハッシュタグ → （料理の種類が未確定なら）概要の冒頭 → 未分類
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Classifier = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 全角/半角の統一と英字の小文字化のみ（カタカナ⇔ひらがなは区別したまま）
  const norm = s => (s || '').normalize('NFKC').toLowerCase();

  function compile(def) {
    const groups = [];
    const items = [];
    const byId = {};
    for (const g of def.groups || []) {
      const group = { id: g.id, name: g.name, short: g.short || g.name, attribute: !!g.attribute, items: [] };
      for (const it of g.items || []) {
        const item = {
          id: `${g.id}/${it.id}`,
          group: g.id,
          name: it.name,
          attribute: !!g.attribute,
          keywords: (it.keywords || []).map(norm).filter(Boolean),
          patterns: (it.patterns || []).map(p => new RegExp(norm(p))),
          exclude: (it.exclude || []).map(norm).filter(Boolean).sort((a, b) => b.length - a.length),
          also: (it.also || []).map(norm).filter(Boolean),
          unless: (it.unless || []).map(norm).filter(Boolean),
          with: it.with || [],
        };
        group.items.push(item);
        items.push(item);
        byId[item.id] = item;
      }
      groups.push(group);
    }
    // 他カテゴリを条件にするもの（with）は最後に判定する
    const ordered = [...items.filter(i => !i.with.length), ...items.filter(i => i.with.length)];
    return { groups, items: ordered, byId };
  }

  function hit(item, text) {
    let t = text;
    for (const ex of item.exclude) t = t.split(ex).join('　');
    const kw = item.keywords.some(k => t.includes(k)) || item.patterns.some(r => r.test(t));
    if (!kw) return false;
    if (item.also.length && !item.also.some(a => t.includes(a))) return false;
    if (item.unless.length && item.unless.some(u => text.includes(u))) return false;
    return true;
  }

  function classifyText(c, text, onlyDish) {
    const found = new Set();
    for (const item of c.items) {
      if (onlyDish && item.attribute) continue;
      if (item.with.length && !item.with.some(id => found.has(id))) continue;
      if (hit(item, text)) found.add(item.id);
    }
    return found;
  }

  const hashtags = desc => (desc.match(/#[^\s#]+/g) || []).join(' ');

  // 概要の冒頭：材料・作り方の手前まで（最大200字）
  const lead = desc => {
    const cut = desc.search(/材料|分量|作り方|レシピ\s*[:：]|ingredients|recipe\s*[:：]/);
    return (cut >= 0 ? desc.slice(0, cut) : desc).slice(0, 200);
  };

  // 戻り値 { cats: ['okazu/niku', ...], source: 'manual' | 'title' | 'description' | 'none' }
  function classify(c, video, overrides) {
    const manual = overrides && overrides[video.id];
    if (Array.isArray(manual)) {
      const cats = manual.filter(id => c.byId[id]);
      return { cats, source: cats.length ? 'manual' : 'none' };
    }
    const desc = norm(video.description);
    const found = classifyText(c, norm(video.title) + ' ' + hashtags(desc), false);
    let source = found.size ? 'title' : 'none';
    const hasDish = [...found].some(id => !c.byId[id].attribute);
    if (!hasDish) {
      const extra = classifyText(c, lead(desc), true);
      if (extra.size) {
        extra.forEach(id => found.add(id));
        source = 'description';
      }
    }
    return { cats: [...found], source };
  }

  return { compile, classify, norm };
});
