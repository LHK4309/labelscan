"use strict";
const APP_VER = "2026-11-14-13";
const $ = s => document.querySelector(s);
const abs = p => new URL(p, location.href).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let IDX = null, DICT = null;
let worker = null, workerLang = null, workerLoading = null;
let mode = localStorage.getItem("lang2") || "auto";   // auto 또는 고정 언어
const found = new Map();   // ingredient id -> result (누적)
let lastText = "";

/* ---------- 상태 표시 ---------- */
function status(msg, pct) {
  $("#status").textContent = msg || "";
  const bar = $("#bar");
  if (pct == null) { bar.style.display = "none"; return; }
  bar.style.display = "block"; bar.firstElementChild.style.width = Math.round(pct * 100) + "%";
}
function setNet() {
  $("#net").textContent = navigator.onLine ? "온라인" : "오프라인";
}
addEventListener("online", setNet); addEventListener("offline", setNet);

/* ---------- 안내 배너 ---------- */
function banners() {
  const ua = navigator.userAgent;
  const box = $("#banners"); box.innerHTML = "";
  const add = (key, html) => {
    if (localStorage.getItem("hide-" + key)) return;
    const d = document.createElement("div"); d.className = "banner";
    d.innerHTML = `<button class="x" aria-label="닫기">×</button>${html}`;
    d.querySelector(".x").onclick = () => { localStorage.setItem("hide-" + key, 1); d.remove(); };
    box.appendChild(d);
  };
  if (/KAKAOTALK|NAVER|Line\/|FBAN|FBAV|Instagram|DaumApps/i.test(ua)) {
    const d = document.createElement("div"); d.className = "banner";
    d.innerHTML = "<b>메신저 안에서 열려 있습니다.</b> 카메라가 작동하지 않을 수 있어요. 오른쪽 위 메뉴(⋮ 또는 공유)에서 <b>‘다른 브라우저로 열기’</b>를 눌러 Safari·Chrome으로 열어 주세요.";
    box.appendChild(d);
  }
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!standalone) {
    if (/iPhone|iPad|iPod/.test(ua))
      add("a2hs", "<b>홈 화면에 추가해 두세요.</b> Safari 아래쪽 <b>공유 버튼(□↑) → ‘홈 화면에 추가’</b>. 그래야 인터넷 없이도 계속 쓸 수 있습니다.");
    else
      add("a2hs", "<b>홈 화면에 추가해 두세요.</b> Chrome 오른쪽 위 <b>⋮ → ‘홈 화면에 추가’(또는 ‘앱 설치’)</b>. 인터넷 없이도 계속 쓸 수 있습니다.");
  }
}

/* ---------- 사전 ---------- */
async function loadDict() {
  status("사전 불러오는 중…");
  const r = await fetch("data/dict.json");
  DICT = await r.json();
  IDX = Matcher.build(DICT);
  $("#ver").textContent = `앱 ${APP_VER} · 사전 ${DICT.ver} (기준일 ${DICT.date}) · 성분 ${Object.keys(DICT.ing).length}종 · 검색어 ${DICT.terms.length.toLocaleString()}개`;
  status("");
}

/* ---------- 글자 인식 엔진 ---------- */
const LANG_NAME = { eng: "영문", "eng+kor": "한국어", "eng+jpn": "일본어", "eng+chi_sim": "중국어(간체)", "eng+chi_tra": "중국어(번체)" };
let active = mode === "auto" ? "eng" : mode;   // 실제 인식에 쓰는 언어 조합
let needDetect = mode === "auto", emptyStreak = 0;

async function getWorker(want = active) {
  if (workerLoading) await workerLoading.catch(() => {});
  if (worker && workerLang === want) return worker;
  workerLoading = (async () => {
    if (worker) {                                           // 같은 엔진에서 언어만 교체
      await worker.reinitialize(want.split("+"), 1);
    } else {
      status("글자 인식 엔진 준비 중…", 0);
      worker = await Tesseract.createWorker(want.split("+"), 1, {
        workerPath: abs("vendor/worker.min.js"), corePath: abs("vendor/core"), langPath: abs("vendor/lang"),
        gzip: true, cacheMethod: "write",
        logger: m => { if (m.status && /load|initializ/i.test(m.status) && !running) status("글자 인식 엔진 준비 중… (처음 한 번만 오래 걸립니다)", m.progress || 0); },
      });
      status("");
    }
    await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
    workerLang = want;
    return worker;
  })();
  try { return await workerLoading; } finally { workerLoading = null; }
}

function confidentWords(data, minConf) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const ws = (l.words || []).filter(x => x.confidence >= minConf && x.text.trim());
    if (ws.length) out.push(ws);
  }
  return out;
}

/* 글자 인식 — 신뢰도 낮은 단어(잡음)는 버림. minConf: 0~100 */
async function ocr(canvas, minConf = 0) {
  const w = await getWorker(active);
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: minConf > 0 });
  const full = data.text || "";
  // 판정에는 전체 글자를 쓰고(성분명은 신뢰도가 낮게 나와도 정확히 읽히는 경우가 많음), 화면 표시는 또렷한 글자만
  const shown = minConf && data.blocks ? confidentWords(data, minConf).map(ws => ws.map(x => x.text).join(" ")).join("\n") : full;
  return Object.assign(new String(full), { shown });
}

/* 포장 언어 자동 감지: 영어 + 자국 문자 1개 조합 고르기 */
async function detectLang(canvas) {
  status("포장 글자 언어 확인 중…");
  const count = async langs => {
    const w = await getWorker(langs);
    const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
    const c = { hangul: 0, kana: 0, han: 0, hanConf: 0, hanWords: 0, latin: 0 };
    for (const ws of confidentWords(data, 75)) for (const x of ws) {
      const t = x.text;
      c.latin += (t.match(/[A-Za-z]/g) || []).length;
      if (t.replace(/[^\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g, "").length < 2) continue;   // 한 글자짜리는 잡음으로 봄
      c.hangul += (t.match(/[\uac00-\ud7a3]/g) || []).length;
      c.kana += (t.match(/[\u3040-\u30ff]/g) || []).length;
      const h = (t.match(/[\u3400-\u9fff]/g) || []).length;
      if (h) { c.han += h; c.hanConf += x.confidence; c.hanWords++; }
    }
    return c;
  };
  let pick = "eng";
  const c = await count("eng+kor+jpn+chi_sim");
  const enough = n => n >= 6 && n * 4 >= c.latin * 0.5;        // 자국 문자가 충분히 많을 때만
  if (enough(c.kana) || (c.kana >= 4 && enough(c.kana + c.han))) pick = "eng+jpn";
  else if (enough(c.hangul) && c.hangul >= c.han) pick = "eng+kor";
  else if (enough(c.han)) {                                    // 간체·번체는 둘 다 읽어 보고 더 자신 있는 쪽
    const s = await count("eng+chi_sim"), t = await count("eng+chi_tra");
    const ms = s.hanWords ? s.hanConf / s.hanWords : 0, mt = t.hanWords ? t.hanConf / t.hanWords : 0;
    pick = mt > ms ? "eng+chi_tra" : "eng+chi_sim";
  }
  active = pick; needDetect = false; emptyStreak = 0;
  showLangs();
  return pick;
}

/* 이미지 전처리: 회색조 + 명암 늘리기 */
function prep(src, sx, sy, sw, sh, maxW) {
  const scale = Math.min(1, maxW / sw);
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y;
  }
  const k = hi - lo > 20 ? 255 / (hi - lo) : 1;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] - lo) * k; d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(img, 0, 0);
  return c;
}

/* 캔버스 회전(90·180·270도) */
function rotate(c, deg) {
  if (!deg) return c;
  const r = document.createElement("canvas"), sw = deg % 180 !== 0;
  r.width = sw ? c.height : c.width; r.height = sw ? c.width : c.height;
  const g = r.getContext("2d");
  g.translate(r.width / 2, r.height / 2); g.rotate(deg * Math.PI / 180);
  g.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}
/* 방향 고르기: 0·90·270도로 빠르게 읽어 보고 글자가 가장 많이 읽히는 방향 */
let lastRotN = 0;
async function bestRotation(c, langs = active) {
  const w = await getWorker(langs);
  let best = 0, bestN = -1;
  for (const deg of [0, 90, 270]) {
    const { data } = await w.recognize(rotate(c, deg), {}, { text: true, blocks: true });
    const n = confidentWords(data, 75).flat().reduce((s, x) => s + (x.text.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g) || []).length, 0);
    if (n > bestN * 1.15) { best = deg; bestN = n; }
  }
  lastRotN = bestN;
  return best;
}

/* ---------- 결과 표시 ---------- */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function lawText(i) {
  if (i.g === "임시마약류") return `${i.b} · ${i.m} 연번 ${i.n}`;
  if (i.m === "법률 본문") return `마약류관리법 ${i.b}`;
  return `${i.b} 제${i.n}호${i.m && i.m !== "-" ? " (" + i.m + ")" : ""}`;
}
function verdictLabel(g) {
  return { 마약: "마약", 향정: "향정신성의약품", 대마: "대마", 임시마약류: "임시마약류", 원료물질: "원료물질(마약류 아님)" }[g] || g;
}
const RANK = { 확인: 0, 상표: 1, 유사: 2, 주의: 3 };
function isMain(r) { return r.level === "확인" || ((r.level === "상표" || r.level === "유사") && r.confirmed); }
function render(newRes, opts = {}) {
  for (const r of newRes) {
    const prev = found.get(r.id);
    if (!prev) { found.set(r.id, r); continue; }
    for (const e of r.evidence) if (!prev.evidence.some(x => x.term === e.term && x.type === e.type)) prev.evidence.push(e);
    if (RANK[r.level] < RANK[prev.level]) prev.level = r.level;
    if (r.confirmed) prev.confirmed = true;
  }
  const box = $("#results");
  const gord = { 마약: 0, 향정: 1, 대마: 2, 임시마약류: 3, 원료물질: 5 };
  const all = [...found.values()].sort((a, b) => RANK[a.level] - RANK[b.level] || (gord[a.ing.g] ?? 4) - (gord[b.ing.g] ?? 4));
  const main = all.filter(isMain), ref = all.filter(r => !isMain(r));
  if (!all.length) {
    box.innerHTML = opts.searched
      ? `<div class="none"><b>사전 미등재</b><br>사전에서 일치하는 성분·제품명을 찾지 못했습니다. <b>비해당이라는 뜻이 아닙니다.</b><br>성분표 글자를 더 가까이·밝게 비추거나, ‘직접 입력’으로 성분명을 넣어 확인해 주세요.</div>`
      : `<div class="none">아직 판정한 내용이 없습니다.</div>`;
    updateAi();
    return;
  }
  const card = r => {
    const i = r.ing;
    const ev = r.evidence.map(e => `<span>${esc(e.type)}: ${esc(e.orig)}${e.how !== "일치" ? " (" + esc(e.how) + ")" : ""}</span>`).join("");
    const names = [i.z, i.j].filter(Boolean).join(" · ");
    const tag = isMain(r) ? (r.level === "상표" ? `<span class="lvl 상표">제품명으로 찾음 — 성분표 확인 권장</span>`
      : r.level === "유사" ? `<span class="lvl 유사">글자 1자 차이로 찾음 — 포장 표기 확인</span>` : "")
      : `<span class="lvl 주의">${r.level === "유사" ? "글자가 비슷함(오인식 가능)" : r.level === "상표" ? "제품명 1회만 인식 — 다시 비춰 확인" : "짧은·흔한 단어 일치"}</span>`;
    return `<div class="card ${esc(i.g)}${isMain(r) ? "" : " weak"}">
      <span class="verdict ${esc(i.g)}">${esc(verdictLabel(i.g))}</span>${tag}
      <div class="name">${esc(i.k || i.e)}</div>
      <div class="en">${esc(i.k ? i.e : "")}${names ? " · " + esc(names) : ""}</div>
      <div class="law">근거: ${esc(lawText(i))}</div>
      ${isMain(r) && i.x ? `<div class="note">혼합제제 주의: ${esc(i.x)}</div>` : ""}
      ${isMain(r) && i.t ? `<div class="note">${esc(i.t)}</div>` : ""}
      <div class="ev">찾은 근거 ${ev}</div>
    </div>`;
  };
  let html = main.length ? main.map(card).join("")
    : `<div class="none"><b>사전 미등재</b><br>확실하게 일치하는 성분·제품명을 찾지 못했습니다. <b>비해당이라는 뜻이 아닙니다.</b></div>`;
  if (ref.length) html += `<details class="refs"><summary>참고: 약한 일치 ${ref.length}건 (판정 근거로 쓰지 마세요)</summary>${ref.map(card).join("")}</details>`;
  box.innerHTML = html;
  updateAi();
}
/* ---------- AI 상세 검색 ---------- */
let lastInput = "";
function aiPrompt(withPhotos) {
  const src = (lastInput || lastText || "").replace(/\s+/g, " ").trim().slice(0, withPhotos ? 300 : 700);
  const res = [...found.values()].filter(isMain).map(r => `${r.ing.k || r.ing.e}(${r.ing.e}, ${r.ing.g})`).join(", ");
  const weak = [...found.values()].filter(r => !isMain(r)).map(r => r.ing.k || r.ing.e).join(", ");
  return [
    withPhotos ? "첨부한 의약품 포장 사진(앞면·성분표 등)을 직접 읽고 한국 마약류 해당 여부를 확인해 주세요."
               : "의약품 포장에서 읽은 글자를 보고 한국 마약류 해당 여부를 확인하고 싶습니다.",
    `${withPhotos ? "참고로 앱이 자동으로 읽은 글자(오타 많음)" : "포장에서 읽은 글자(오타 있을 수 있음)"}: "${src || "(없음)"}"`,
    `오프라인 판정앱 결과: ${res || "사전 미등재"}${weak ? ` / 약한 일치(참고): ${weak}` : ""}`,
    "1) 이 글자로 추정되는 정확한 제품명·제조국·주성분과 함량을 찾아 주세요(글자 인식 오류가 있을 수 있음).",
    "2) 주성분 중 한국 마약류관리법상 마약·향정신성의약품·대마, 식약처 지정 임시마약류, 또는 원료물질에 해당하는 것이 있는지 근거(시행령 별표, 공고)와 함께 알려 주세요.",
    "3) 확실하지 않은 부분은 추정이라고 구분해 주세요.",
  ].join("\n");
}
function updateAi() {
  const has = !!(lastInput || lastText || found.size || caps.length);
  const canShare = caps.length && navigator.canShare && navigator.canShare({ files: [new File([caps[0].blob], "a.jpg", { type: "image/jpeg" })] });
  $("#aiShare").hidden = !canShare;
  $("#aiShareHint").hidden = !caps.length;
  $("#aiShareHint").textContent = canShare
    ? `사진 ${caps.length}장과 질문을 함께 보냅니다. 공유 목록에서 Claude 앱을 고르세요(질문은 복사도 해 둡니다).`
    : caps.length ? "이 브라우저는 사진 공유를 지원하지 않습니다. 사진을 길게 눌러 저장한 뒤 AI 앱에 첨부해 주세요." : "";
  $("#aiBox").hidden = !has;
  if (!has) return;
  const p = aiPrompt(), q = encodeURIComponent(p);
  $("#aiClaude").href = "https://claude.ai/new?q=" + q;
  $("#aiGpt").href = "https://chatgpt.com/?q=" + q;
  const words = (lastInput || lastText || "").replace(/\s+/g, " ").trim().slice(0, 120);
  $("#aiGoogle").href = "https://www.google.com/search?q=" + encodeURIComponent(words + " 성분");
}
document.querySelectorAll("#aiBox a").forEach(x => x.addEventListener("click", e => {
  if (!navigator.onLine) { e.preventDefault(); status("AI 검색은 인터넷 연결이 필요합니다."); }
}));
$("#aiShare").onclick = async () => {
  const p = aiPrompt(true);
  try { await navigator.clipboard.writeText(p); } catch (e) {}
  const files = caps.map((c, i) => new File([c.blob], `포장사진_${i + 1}.jpg`, { type: "image/jpeg" }));
  try { await navigator.share({ files, text: p, title: "의약품 포장 확인" }); }
  catch (e) { if (e.name !== "AbortError") status("공유하지 못했습니다: " + e.message); }
};
$("#aiCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(aiPrompt()); status("질문 내용을 복사했습니다. AI 앱에 붙여 넣으세요."); }
  catch (e) { status("복사하지 못했습니다."); }
};

function showOcr(text) {
  lastText = text;
  $("#ocrBox").hidden = !text.trim();
  $("#ocrText").textContent = text.trim();
  updateAi();
}
function judge(text, opts) {
  const res = Matcher.match(IDX, text);
  render(res, opts);
  return res;
}
$("#clear").onclick = () => { lastInput = ""; caps.splice(0).forEach(c => URL.revokeObjectURL(c.url)); drawCaps(); if (mode === "auto") needDetect = true; found.clear(); if (typeof seen !== "undefined") seen.clear(); render([]); showOcr(""); };

/* ---------- 탭 ---------- */
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.id === "p-" + b.dataset.tab));
  if (b.dataset.tab !== "cam") camStop();
});
function showLangs() {
  document.querySelectorAll("#langs .chip").forEach(c => {
    c.classList.toggle("on", c.dataset.l === mode);
    if (c.dataset.l === "auto") c.innerHTML = mode === "auto" && workerLang
      ? `자동 <small>· ${LANG_NAME[active] || "영문"}</small>` : "자동";
  });
}
document.querySelectorAll("#langs .chip").forEach(c => {
  c.onclick = () => {
    mode = c.dataset.l; localStorage.setItem("lang2", mode);
    if (mode === "auto") { needDetect = true; }
    else { active = mode; getWorker(active).catch(e => status("엔진 준비 실패: " + e.message)); }
    showLangs();
  };
});
showLangs();

/* ---------- 캡처 사진(포장 앞·뒷면) ---------- */
const MAX_CAPS = 6;
const caps = [];           // {blob, url, label, score, auto}
function grabFrame(src, w0, h0, maxW = 1600) {
  const sc = Math.min(1, maxW / w0), c = document.createElement("canvas");
  c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(b => r(b), "image/jpeg", 0.85));
}
function addCap(blob, label, score = 0, auto = false) {
  if (!blob) return;
  if (auto) {                                           // 자동 캡처는 한 장만 유지하고 더 잘 읽힌 화면으로 교체
    const i = caps.findIndex(c => c.auto);
    if (i >= 0) { if (caps[i].score >= score) return; URL.revokeObjectURL(caps[i].url); caps.splice(i, 1); }
  }
  if (caps.length >= MAX_CAPS) { const j = caps.findIndex(c => c.auto); const k = j >= 0 ? j : 0; URL.revokeObjectURL(caps[k].url); caps.splice(k, 1); }
  caps.push({ blob, url: URL.createObjectURL(blob), label, score, auto });
  drawCaps();
}
function drawCaps() {
  const box = $("#caps");
  box.hidden = !caps.length;
  $("#capList").innerHTML = caps.map((c, i) => `<figure><img src="${c.url}" alt=""><figcaption>${esc(c.label)}</figcaption><button data-i="${i}" aria-label="삭제">×</button></figure>`).join("");
  $("#capList").querySelectorAll("button").forEach(b => b.onclick = () => { const i = +b.dataset.i; URL.revokeObjectURL(caps[i].url); caps.splice(i, 1); drawCaps(); });
  updateAi();
}

/* ---------- 카메라(실시간) ---------- */
let stream = null, running = false, paused = false, track = null, torchOn = false, frames = 0, lastMs = 0, shotHi = false;
const seen = new Map();   // 실시간 모드에서 제품명 인식 횟수
let camRot = 0, lowStreak = 0;  // 실시간 판독 방향
const barcode = ("BarcodeDetector" in window) ? new BarcodeDetector({ formats: ["ean_13", "data_matrix", "code_128", "upc_a"] }) : null;

async function camStart() {
  lastInput = "";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    status(location.protocol !== "https:" && location.hostname !== "localhost"
      ? "카메라는 https 주소에서만 켜집니다." : "카메라를 켤 수 없습니다. 브라우저 설정에서 카메라 권한을 허용해 주세요.");
    return;
  }
  const v = $("#video"); v.srcObject = stream; await v.play().catch(() => {});
  track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $("#camTorch").style.display = caps.torch ? "" : "none";
  $("#camOver").style.display = "none";
  $("#camPause").disabled = $("#camStop").disabled = $("#camShot").disabled = false;
  running = true; paused = false; $("#camPause").textContent = "일시정지";
  if (mode === "auto") needDetect = true;
  loop();
}
function camStop() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null;
  $("#camOver").style.display = ""; $("#camPause").disabled = $("#camStop").disabled = $("#camShot").disabled = true; $("#live").style.display = "none";
  $("#guide").classList.remove("hit");
}
async function loop() {
  const v = $("#video");
  status("글자 인식 엔진 준비 중…");
  try { await getWorker(); } catch (e) { status("엔진 준비 실패: " + e.message); return; }
  while (running) {
    if (paused || !v.videoWidth) { await sleep(200); continue; }
    const t0 = performance.now(); frames++;
    // 화면의 네모 칸 영역만 잘라서 인식
    const vw = v.videoWidth, vh = v.videoHeight, box = $("#camBox").getBoundingClientRect();
    const s = Math.max(box.width / vw, box.height / vh);            // object-fit: cover 보정
    const ox = (vw * s - box.width) / 2, oy = (vh * s - box.height) / 2;
    const top = camRot ? 0.10 : 0.30, hgt = camRot ? 0.80 : 0.40;   // 옆으로 읽을 때는 세로로 더 넓게
    const gx = (box.width * 0.07 + ox) / s, gy = (box.height * top + oy) / s;
    const gw = (box.width * 0.86) / s, gh = (box.height * hgt) / s;
    const canvas = rotate(prep(v, gx, gy, gw, gh, shotHi ? 1800 : 1000), camRot);
    const hi = shotHi; shotHi = false;
    status(hi ? "촬영한 화면 판독 중…" : `읽는 중… (${frames}번째${lastMs ? ", 1회 " + (lastMs / 1000).toFixed(1) + "초" : ""})`);
    let res = [];
    if (barcode) {
      try {
        for (const b of await barcode.detect(v)) {
          const g = Matcher.gtin(DICT, b.rawValue);
          if (g) res = res.concat(g.ids.map(id => ({ id, ing: DICT.ing[id], level: "확인", evidence: [{ term: b.rawValue, orig: g.name, type: "바코드(영국)", how: "일치", caution: false }] })));
        }
      } catch (e) {}
    }
    let text = "";
    if (mode === "auto" && needDetect) { try { await detectLang(canvas); } catch (e) {} if (!running) break; }
    try { text = await ocr(canvas, hi ? 60 : 70); } catch (e) { status("인식 오류: " + e.message); await sleep(800); continue; }
    if (!running) break;
    lastMs = performance.now() - t0;
    if (mode === "auto") {                               // 글자가 계속 안 읽히면 다른 포장으로 보고 언어 재감지
      emptyStreak = text.replace(/\s/g, "").length < 4 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 6) needDetect = true;
    }
    // 글자가 적게 읽히면 옆으로 누운 포장일 수 있어 방향을 바꿔 시험
    if ((clean0 => (clean0.match(/[A-Za-z\u3040-\u9fff\uac00-\ud7a3]/g) || []).length)(text) < 8) {
      lowStreak++;
      if (lowStreak >= 3) { camRot = { 0: 90, 90: 270, 270: 0 }[camRot]; lowStreak = 0; }
    } else lowStreak = 0;
    const clean = (text.shown ?? String(text)).replace(/\s+/g, " ").trim();
    const lv = $("#live"); lv.style.display = "block";
    lv.textContent = clean ? "인식: " + clean.slice(0, 120) : "글자를 찾지 못했습니다 — 더 가까이, 밝게 비춰 주세요";
    if (clean) showOcr(text.shown ?? String(text));
    const score = (clean.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/g) || []).length;
    const autoCap = caps.find(c => c.auto);
    if (hi) addCap(await grabFrame(v, vw, vh), "촬영 " + (caps.filter(c => c.label.startsWith("촬영")).length + 1), score);
    else if (score >= 12 && (!autoCap || score > autoCap.score * 1.2)) addCap(await grabFrame(v, vw, vh), "자동 캡처", score, true);
    const m = Matcher.match(IDX, String(text));
    for (const r of m) if (r.level === "유사") {
      const k = "f|" + r.id, n = (seen.get(k) || 0) + 1; seen.set(k, n);
      if (n >= 2 || hi) r.confirmed = true;
    }
    for (const r of m) if (r.level === "상표") {           // 같은 제품명이 2번 이상 읽혀야 확정
      const k = r.id + "|" + r.evidence.filter(e => e.strength === 1).map(e => e.term).sort().join(",");
      const n = (seen.get(k) || 0) + 1; seen.set(k, n);
      if (n >= 2 || hi) r.confirmed = true;
    }
    res = res.concat(m);
    const before = new Set([...found.entries()].filter(([, r]) => isMain(r)).map(([k]) => k));
    render(res, { searched: true });
    const fresh = res.filter(r => isMain(r) && !before.has(r.id));
    if (fresh.length) {
      if (!hi) addCap(await grabFrame(v, vw, vh), "판정 화면", score);
      $("#guide").classList.add("hit");
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      paused = true; $("#camPause").textContent = "계속 읽기";
      status("마약류 관련 성분을 찾았습니다. 결과를 확인하세요.");
      document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      status(hi ? (clean ? "이 화면에서는 사전 단어를 찾지 못했습니다(사전 미등재)" : "글자를 읽지 못했습니다 — 더 가까이·밝게 다시 찍어 주세요")
                : `계속 읽는 중… (1회 ${(lastMs / 1000).toFixed(1)}초)`);
    }
    await sleep(250);
  }
}
$("#camStart").onclick = camStart;
$("#camShot").onclick = () => {           // 한 장을 더 높은 해상도로 판독 + 사진 보관
  shotHi = true; paused = false; $("#camPause").textContent = "일시정지"; $("#guide").classList.remove("hit");
  status("다음 판독에서 이 화면을 정밀하게 읽습니다…");
};
$("#camStop").onclick = camStop;
$("#camPause").onclick = () => {
  paused = !paused; $("#camPause").textContent = paused ? "계속 읽기" : "일시정지";
  if (!paused) { $("#guide").classList.remove("hit"); status("읽는 중…"); }
};
$("#camTorch").onclick = async () => {
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
};

/* ---------- 사진 ---------- */
$("#photoPick").onclick = () => $("#photoInput").click();
$("#filePick").onclick = () => $("#fileInput").click();
async function judgeImage(f) {
  const url = URL.createObjectURL(f);
  const img = $("#photoImg"); img.src = url; img.style.display = "block"; $("#photoOver").style.display = "none";
  await img.decode().catch(() => {});
  if (!img.naturalWidth) throw new Error(`${f.name || "사진"}을(를) 열 수 없습니다(HEIC 등 지원하지 않는 형식일 수 있음)`);
  let res = [];
  if (barcode) {
    try {
      for (const b of await barcode.detect(img)) {
        const g = Matcher.gtin(DICT, b.rawValue);
        if (g) res = res.concat(g.ids.map(id => ({ id, ing: DICT.ing[id], level: "확인", evidence: [{ term: b.rawValue, orig: g.name, type: "바코드(영국)", how: "일치", caution: false }] })));
      }
    } catch (e) {}
  }
  status("글자 방향 확인 중…");
  const small = prep(img, 0, 0, img.naturalWidth, img.naturalHeight, 1000);
  let deg = await bestRotation(small, mode === "auto" ? "eng" : active);
  if (mode === "auto" && lastRotN < 15) deg = await bestRotation(small, "eng+kor+jpn+chi_sim");   // 영문이 거의 없으면 한·중·일 문자로 다시
  const c = rotate(prep(img, 0, 0, img.naturalWidth, img.naturalHeight, 2000), deg);
  if (mode === "auto") await detectLang(rotate(small, deg));
  status("사진에서 글자 읽는 중…");
  let text = await ocr(c, 60);
  if (mode === "auto" && active !== "eng") {              // 자국어로 읽은 결과가 빈약하면 영문으로 한 번 더
    const t2 = await (async () => { const keep = active; active = "eng"; const t = await ocr(c, 60); active = keep; return t; })();
    text = text + "\n" + t2;
  }
  addCap(await grabFrame(img, img.naturalWidth, img.naturalHeight), "사진 " + (caps.filter(x => x.label.startsWith("사진")).length + 1));
  return { text: text.shown ?? String(text), res: res.concat(Matcher.match(IDX, String(text)).map(r => ((r.level === "상표" || r.level === "유사") && (r.confirmed = true), r))) };
}
$("#photoInput").onchange = $("#fileInput").onchange = async e => {
  const files = [...e.target.files].slice(0, MAX_CAPS); if (!files.length) return;
  lastInput = "";
  try {
    const texts = [];
    const bad = [];
    for (let i = 0; i < files.length; i++) {
      status(`사진에서 글자 읽는 중… (${i + 1}/${files.length})`);
      try { const r = await judgeImage(files[i]); texts.push(r.text); render(r.res, { searched: true }); }
      catch (err) { bad.push(err.message); }
    }
    if (bad.length) { showOcr(texts.join("\n")); status(bad.join(" / ")); e.target.value = ""; return; }
    showOcr(texts.join("\n"));
    status([...found.values()].some(isMain) ? "판정 완료" : "판정 완료 — 확실한 일치 없음(사전 미등재)");
  } catch (err) { status("인식 오류: " + err.message); }
  e.target.value = "";
};

/* ---------- 직접 입력 ---------- */
$("#textGo").onclick = () => {
  const t = $("#textIn").value;
  if (!t.trim()) return;
  found.clear(); showOcr(""); lastInput = t.trim();
  const r = Matcher.match(IDX, t).map(x => ((x.level === "상표" || x.level === "유사") && (x.confirmed = true), x));
  render(r, { searched: true });
  status(r.length ? "" : "사전에서 찾지 못했습니다");
};
$("#textClr").onclick = () => { $("#textIn").value = ""; };
$("#textIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#textGo").click(); } });

/* ---------- 시작 ---------- */
(async () => {
  setNet(); banners();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
    // 새 버전이 설치되면 한 번 자동으로 새로고침
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (had && !sessionStorage.getItem("reloaded")) { sessionStorage.setItem("reloaded", 1); location.reload(); }
    });
  }
  try { await loadDict(); } catch (e) { status("사전을 불러오지 못했습니다. 처음 한 번은 인터넷 연결이 필요합니다."); return; }
  // 엔진은 미리 준비(첫 실행 시 데이터 저장)
  getWorker(active).then(() => {
    status("준비 완료 — 오프라인에서도 사용할 수 있습니다"); showLangs();
    for (const l of ["kor", "jpn", "chi_sim", "chi_tra"]) fetch(abs(`vendor/lang/${l}.traineddata.gz`)).catch(() => {});
  }).catch(() => {});
})();
