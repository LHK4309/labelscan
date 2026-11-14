/* 오프라인 캐시 — 사전·엔진을 폰에 저장. 버전을 올리면 다음 접속 때 새 파일로 교체 */
const VER = "lbs-2026-11-14-14";
const CORE = ["./", "index.html", "app.js", "match.js", "manifest.webmanifest", "data/dict.json",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
  "vendor/tesseract.min.js", "vendor/worker.min.js", "vendor/lang/eng.traineddata.gz"];
self.addEventListener("install", e => {
  // 브라우저 HTTP 캐시를 거치지 않고 서버에서 새로 받아 저장
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const heavy = u.pathname.includes("/vendor/");
  e.respondWith(caches.open(VER).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit && heavy) return hit;                       // 엔진·언어 데이터: 저장본 우선
    const net = fetch(e.request, heavy ? undefined : { cache: "no-cache" }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    return hit ? (net.catch(() => {}), hit) : net;     // 나머지: 저장본 먼저 보여주고 뒤에서 갱신
  }));
});
