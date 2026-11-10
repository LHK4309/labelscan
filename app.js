"use strict";
const $ = s => document.querySelector(s);
const abs = p => new URL(p, location.href).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let IDX = null, DICT = null;
let worker = null, workerLang = null, workerLoading = null;
let lang = localStorage.getItem("lang") || "eng";
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
  $("#ver").textContent = `사전 ${DICT.ver} (기준일 ${DICT.date}) · 성분 ${Object.keys(DICT.ing).length}종 · 검색어 ${DICT.terms.length.toLocaleString()}개`;
  status("");
}

/* ---------- 글자 인식 엔진 ---------- */
async function getWorker() {
  if (worker && workerLang === lang) return worker;
  if (workerLoading) return workerLoading;
  workerLoading = (async () => {
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
    status("글자 인식 엔진 준비 중…", 0);
    const w = await Tesseract.createWorker(lang.split("+"), 1, {
      workerPath: abs("vendor/worker.min.js"),
      corePath: abs("vendor/core"),
      langPath: abs("vendor/lang"),
      gzip: true,
      cacheMethod: "write",
      logger: m => {
        if (m.status && /load|initializ/i.test(m.status)) status("글자 인식 엔진 준비 중… (처음 한 번만 오래 걸립니다)", m.progress || 0);
      },
    });
    await w.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
    worker = w; workerLang = lang; status("");
    return w;
  })();
  try { return await workerLoading; } finally { workerLoading = null; }
}

async function ocr(canvas) {
  const w = await getWorker();
  const { data } = await w.recognize(canvas);
  return data.text || "";
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
function render(newRes, opts = {}) {
  for (const r of newRes) {
    const prev = found.get(r.id);
    if (!prev) found.set(r.id, r);
    else {
      for (const e of r.evidence) if (!prev.evidence.some(x => x.term === e.term && x.type === e.type)) prev.evidence.push(e);
      if (r.level === "확인") prev.level = "확인";
      else if (r.level === "유사" && prev.level === "주의") prev.level = "유사";
    }
  }
  const box = $("#results");
  if (!found.size) {
    box.innerHTML = opts.searched
      ? `<div class="none"><b>사전 미등재</b><br>사전에서 일치하는 성분·제품명을 찾지 못했습니다. <b>비해당이라는 뜻이 아닙니다.</b><br>성분표의 글자를 더 가까이·밝게 비추거나, ‘직접 입력’으로 성분명을 넣어 확인해 주세요.</div>`
      : `<div class="none">아직 판정한 내용이 없습니다.</div>`;
    return;
  }
  const order = { 확인: 0, 유사: 1, 주의: 2 }, gord = { 마약: 0, 향정: 1, 대마: 2, 임시마약류: 3, 원료물질: 5 };
  const list = [...found.values()].sort((a, b) => order[a.level] - order[b.level] || (gord[a.ing.g] ?? 4) - (gord[b.ing.g] ?? 4));
  box.innerHTML = list.map(r => {
    const i = r.ing;
    const lvl = r.level === "확인" ? "" : r.level === "유사"
      ? `<span class="lvl 유사">글자 유사 — 포장 표기 직접 확인</span>`
      : `<span class="lvl 주의">참고 — 일부 제품만 해당하거나 짧은 단어</span>`;
    const ev = r.evidence.map(e => `<span>${esc(e.type)}: ${esc(e.orig)}${e.how !== "일치" ? " (" + esc(e.how) + ")" : ""}</span>`).join("");
    const names = [i.z, i.j].filter(Boolean).join(" · ");
    return `<div class="card ${esc(i.g)}">
      <span class="verdict ${esc(i.g)}">${esc(verdictLabel(i.g))}</span>${lvl}
      <div class="name">${esc(i.k || i.e)}</div>
      <div class="en">${esc(i.k ? i.e : "")}${names ? " · " + esc(names) : ""}</div>
      <div class="law">근거: ${esc(lawText(i))}</div>
      ${i.x ? `<div class="note">혼합제제 주의: ${esc(i.x)}</div>` : ""}
      ${i.t ? `<div class="note">${esc(i.t)}</div>` : ""}
      <div class="ev">찾은 근거 ${ev}</div>
    </div>`;
  }).join("");
}
function showOcr(text) {
  lastText = text;
  $("#ocrBox").hidden = !text.trim();
  $("#ocrText").textContent = text.trim();
}
function judge(text, opts) {
  const res = Matcher.match(IDX, text);
  render(res, opts);
  return res;
}
$("#clear").onclick = () => { found.clear(); render([]); showOcr(""); };

/* ---------- 탭 ---------- */
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("on", p.id === "p-" + b.dataset.tab));
  if (b.dataset.tab !== "cam") camStop();
});
document.querySelectorAll("#langs .chip").forEach(c => {
  c.classList.toggle("on", c.dataset.l === lang);
  c.onclick = () => {
    lang = c.dataset.l; localStorage.setItem("lang", lang);
    document.querySelectorAll("#langs .chip").forEach(x => x.classList.toggle("on", x === c));
    getWorker().catch(e => status("엔진 준비 실패: " + e.message));
  };
});

/* ---------- 카메라(실시간) ---------- */
let stream = null, running = false, paused = false, track = null, torchOn = false;
const barcode = ("BarcodeDetector" in window) ? new BarcodeDetector({ formats: ["ean_13", "data_matrix", "code_128", "upc_a"] }) : null;

async function camStart() {
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
  $("#camPause").disabled = $("#camStop").disabled = false;
  running = true; paused = false; $("#camPause").textContent = "일시정지";
  loop();
}
function camStop() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null;
  $("#camOver").style.display = ""; $("#camPause").disabled = $("#camStop").disabled = true;
  $("#guide").classList.remove("hit");
}
async function loop() {
  const v = $("#video");
  try { await getWorker(); } catch (e) { status("엔진 준비 실패: " + e.message); return; }
  while (running) {
    if (paused || !v.videoWidth) { await sleep(200); continue; }
    status("읽는 중…");
    // 화면의 네모 칸 영역만 잘라서 인식
    const vw = v.videoWidth, vh = v.videoHeight, box = $("#camBox").getBoundingClientRect();
    const s = Math.max(box.width / vw, box.height / vh);            // object-fit: cover 보정
    const ox = (vw * s - box.width) / 2, oy = (vh * s - box.height) / 2;
    const gx = (box.width * 0.07 + ox) / s, gy = (box.height * 0.30 + oy) / s;
    const gw = (box.width * 0.86) / s, gh = (box.height * 0.40) / s;
    const canvas = prep(v, gx, gy, gw, gh, 1400);
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
    try { text = await ocr(canvas); } catch (e) { status("인식 오류: " + e.message); await sleep(800); continue; }
    if (!running) break;
    if (text.trim()) showOcr(text);
    res = res.concat(Matcher.match(IDX, text));
    const before = new Set([...found.entries()].filter(([, r]) => r.level === "확인").map(([k]) => k));
    render(res, { searched: true });
    const fresh = res.filter(r => r.level === "확인" && !before.has(r.id));
    if (fresh.length) {
      $("#guide").classList.add("hit");
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      paused = true; $("#camPause").textContent = "계속 읽기";
      status("마약류 관련 성분을 찾았습니다. 결과를 확인하세요.");
      document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      status(text.trim() ? "계속 읽는 중… 글자가 칸 안에 크게 들어오게 해 주세요" : "글자를 찾는 중…");
    }
    await sleep(250);
  }
}
$("#camStart").onclick = camStart;
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
$("#photoInput").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const url = URL.createObjectURL(f);
  const img = $("#photoImg"); img.src = url; img.style.display = "block"; $("#photoOver").style.display = "none";
  await img.decode().catch(() => {});
  status("사진에서 글자 읽는 중…");
  let res = [];
  if (barcode) {
    try {
      for (const b of await barcode.detect(img)) {
        const g = Matcher.gtin(DICT, b.rawValue);
        if (g) res = res.concat(g.ids.map(id => ({ id, ing: DICT.ing[id], level: "확인", evidence: [{ term: b.rawValue, orig: g.name, type: "바코드(영국)", how: "일치", caution: false }] })));
      }
    } catch (e) {}
  }
  try {
    const c = prep(img, 0, 0, img.naturalWidth, img.naturalHeight, 2000);
    const text = await ocr(c);
    showOcr(text);
    res = res.concat(Matcher.match(IDX, text));
    render(res, { searched: true });
    status(res.length ? "판정 완료" : "판정 완료 — 사전에서 찾지 못했습니다");
  } catch (err) { status("인식 오류: " + err.message); }
  e.target.value = "";
};

/* ---------- 직접 입력 ---------- */
$("#textGo").onclick = () => {
  const t = $("#textIn").value;
  if (!t.trim()) return;
  found.clear(); showOcr("");
  const r = judge(t, { searched: true });
  status(r.length ? "" : "사전에서 찾지 못했습니다");
};
$("#textClr").onclick = () => { $("#textIn").value = ""; };
$("#textIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#textGo").click(); } });

/* ---------- 시작 ---------- */
(async () => {
  setNet(); banners();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  try { await loadDict(); } catch (e) { status("사전을 불러오지 못했습니다. 처음 한 번은 인터넷 연결이 필요합니다."); return; }
  // 엔진은 미리 준비(첫 실행 시 데이터 저장)
  getWorker().then(() => status("준비 완료 — 오프라인에서도 사용할 수 있습니다")).catch(() => {});
})();
