/* 마약류 판정 매칭 엔진 — 브라우저·Node 공용 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Matcher = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CJK = /[぀-ヿ㐀-鿿가-힣豈-﫿]/;
  const NAME_TYPES = new Set(["대표명", "동의어", "규칙생성", "상표명"]);

  function foldAscii(s) {
    return s
      .replace(/α/g, "alpha").replace(/β/g, "beta").replace(/[ΔΔ]/g, "delta")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "");
  }
  function normLatin(s) {
    s = foldAscii(s.normalize("NFKC")).toLowerCase().replace(/[’`]/g, "'");
    s = s.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
    s = s.replace(/[^a-z0-9\-'\s]/g, " ").replace(/-{2,}/g, "-");
    return s.replace(/\s+/g, " ").trim();
  }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function build(dict) {
    const latin = new Map();      // key -> [termIdx...]
    const cjk = [];               // [key, termIdx]
    const fuzzy = new Map();      // first letter -> [[key, termIdx]]
    let maxWords = 1;
    dict.terms.forEach((t, i) => {
      const [key, , typeIdx] = t;
      if (!key) return;
      if (CJK.test(key)) { cjk.push([key.normalize("NFKC").replace(/\s+/g, ""), i]); return; }
      const variants = new Set([normLatin(key), normLatin(key.replace(/-/g, " ")), normLatin(key.replace(/-/g, ""))]);
      for (const v of variants) {
        if (!v) continue;
        if (!latin.has(v)) latin.set(v, []);
        latin.get(v).push(i);
        maxWords = Math.max(maxWords, v.split(" ").length);
      }
      const k = normLatin(key);
      if (NAME_TYPES.has(dict.types[typeIdx]) && k.length >= 7 && !k.includes(" ")) {
        if (!fuzzy.has(k[0])) fuzzy.set(k[0], []);
        fuzzy.get(k[0]).push([k, i]);
      }
    });
    cjk.sort((a, b) => b[0].length - a[0].length);
    return { dict, latin, cjk, fuzzy, maxWords: Math.min(maxWords, 7) };
  }

  /** 텍스트 → 매칭 결과(성분별 묶음) */
  function match(idx, text, opts) {
    opts = opts || {};
    const { dict, latin, cjk, fuzzy, maxWords } = idx;
    const hits = [];   // {termIdx, found, how}
    const norm = normLatin(text);
    const toks = norm.split(" ").filter(Boolean);
    const used = new Set();
    for (let n = Math.min(maxWords, toks.length); n >= 1; n--) {
      for (let s = 0; s + n <= toks.length; s++) {
        const w = toks.slice(s, s + n).join(" ");
        const ids = latin.get(w);
        if (!ids) continue;
        // 'without codeine', 'codeine free', 'w/o codeine' 같은 부정 표현은 제외
        const prev = toks[s - 1], prev2 = toks[s - 2], next = toks[s + n];
        if (prev === "without" || prev === "non" || (prev === "o" && prev2 === "w") || next === "free" || next === "-free") continue;
        for (const ti of ids) hits.push({ ti, found: w, how: "일치" });
        for (let k = s; k < s + n; k++) used.add(k);
      }
    }
    // OCR 오인식 보정: 성분명(7자 이상)만 1~2글자 차이 허용
    if (opts.fuzzy !== false) toks.forEach((tk, k) => {
      if (used.has(k) || tk.length < 7 || !/^[a-z\-]+$/.test(tk)) return;
      const max = tk.length >= 11 ? 2 : 1;
      for (const [key, ti] of fuzzy.get(tk[0]) || []) {
        if (lev(tk, key, max) <= max) hits.push({ ti, found: tk, how: "유사(오인식 보정)" });
      }
    });
    const flat = text.normalize("NFKC").replace(/\s+/g, "");
    if (CJK.test(flat)) {
      // 긴 단어부터 찾고, 이미 찾은 긴 단어 속에만 들어 있는 짧은 단어는 제외(ジヒドロコデイン 속 コデイン 등)
      const covered = new Uint8Array(flat.length);
      const spans = [], seen = new Map();
      for (const [key, ti] of cjk) {
        if (seen.has(key)) { if (seen.get(key)) hits.push({ ti, found: key, how: "일치" }); continue; }
        let from = 0, pos, ok = false;
        while ((pos = flat.indexOf(key, from)) !== -1) {
          let inside = true;
          for (let k = pos; k < pos + key.length; k++) if (!covered[k]) { inside = false; break; }
          if (!inside) { ok = true; spans.push([pos, pos + key.length]); }
          from = pos + 1;
        }
        seen.set(key, ok);
        if (ok) hits.push({ ti, found: key, how: "일치" });
        if (ok && spans.length) for (const [a, b] of spans.splice(0)) for (let k = a; k < b; k++) covered[k] = 1;
      }
    }
    // 성분별로 묶기
    const by = new Map();
    for (const h of hits) {
      const t = dict.terms[h.ti];
      const id = t[1];
      const type = dict.types[t[2]];
      const strength = h.how === "일치" ? t[4] : 2;     // 0 성분명 1 상표·제품명 2 약함
      const ev = { term: t[0], orig: t[3] || t[0], type, strength, caution: strength === 2, how: h.how, found: h.found };
      if (!by.has(id)) by.set(id, []);
      const arr = by.get(id);
      if (!arr.some(e => e.term === ev.term && e.type === ev.type)) arr.push(ev);
    }
    const res = [];
    for (const [id, evs] of by) {
      const ing = dict.ing[id];
      if (!ing) continue;
      const best = Math.min(...evs.map(e => e.strength));
      const level = best === 0 ? "확인" : best === 1 ? "상표" : evs.some(e => e.how !== "일치") ? "유사" : "주의";
      res.push({ id, ing, evidence: evs, level, best });
    }
    const rank = r => r.best * 10 + ({ 마약: 0, 향정: 1, 대마: 2, 임시마약류: 3, 원료물질: 5 }[r.ing.g] ?? 4);
    res.sort((a, b) => rank(a) - rank(b));
    return res;
  }

  function gtin(dict, code) {
    let c = String(code || "").replace(/\D/g, "");
    const m = String(code || "").match(/(?:^|\x1d|\(01\)|^01)(\d{14})/);
    if (m) c = m[1];
    c = c.replace(/^0+/, "");
    const g = dict.gtin[c];
    if (!g) return null;
    return { name: g[0], ids: g[1].split(", ") };
  }

  return { build, match, gtin, normLatin };
});
