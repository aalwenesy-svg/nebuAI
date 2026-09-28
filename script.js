const $ = id => document.getElementById(id);

// ---------- Ayarlar ----------
// Anahtarı uygulamada ⚙ Ayarlar'dan girebilirsin. İstersen buraya da yazabilirsin;
// ama buraya yazarsan APK'yı kimseyle paylaşma (içinden çıkarılabilir).
const DEFAULT_KEY = "";
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const PROMPT = [
  "Bu fotoğraftaki BASKIN bitki, hayvan veya nesneyi tanımla.",
  "Yalnızca tek bir JSON nesnesi döndür, başka hiçbir metin yazma:",
  '{"category":"Bitki|Hayvan|Nesne|Belirsiz","name":"Türkçe yaygın adı","latin_name":"bilimsel adı, yoksa boş metin","description":"2-3 cümlelik sıcak, doğal Türkçe açıklama","facts":["3-5 kısa ve ilginç bilgi, her biri tek cümle"],"confidence":0-100 arası tam sayı}',
  'Emin değilsen category "Belirsiz" olsun ve description içinde nedenini açıkla.',
  "Tüm metinleri Türkçe yaz."
].join("\n");

function getCfg() {
  let key = "", model = "";
  try { key = localStorage.getItem("nebu_key") || ""; model = localStorage.getItem("nebu_model") || ""; } catch (e) {}
  return { key: (key || DEFAULT_KEY).trim(), model: (model || DEFAULT_MODEL).trim() };
}

let stream = null, facing = "environment", busy = false;
let history = [];
try { history = JSON.parse(localStorage.getItem("nebu_history") || "[]"); } catch (e) { history = []; }

function on(id, fn) { const el = $(id); if (el) el.addEventListener("click", fn); }

function toast(t) {
  const el = $("toast");
  el.textContent = t; el.style.display = "block";
  clearTimeout(toast.t); toast.t = setTimeout(() => el.style.display = "none", 3500);
}

// ---------- Kamera ----------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $("permission").classList.remove("hidden"); return; }
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing } } });
    const v = $("video");
    v.srcObject = stream;
    const s = stream.getVideoTracks()[0].getSettings();
    v.classList.toggle("mirror", (s.facingMode || facing) === "user");
    await v.play().catch(() => {});
    $("permission").classList.add("hidden");
  } catch (e) {
    $("permission").classList.remove("hidden");
  }
}
on("grantBtn", startCamera);
on("flipBtn", () => { facing = facing === "environment" ? "user" : "environment"; startCamera(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (!stream || !stream.active)) startCamera();
});

// ---------- Çekim ----------
function capture() {
  const v = $("video"), c = $("canvas");
  if (!v.videoWidth) return "";
  const r = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
  c.width = Math.round(v.videoWidth * r); c.height = Math.round(v.videoHeight * r);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", .82);
}

function makeThumb(src) {
  return new Promise(resolve => {
    const i = new Image();
    i.onload = () => {
      const r = Math.min(1, 480 / Math.max(i.width, i.height));
      const c = document.createElement("canvas");
      c.width = Math.round(i.width * r); c.height = Math.round(i.height * r);
      c.getContext("2d").drawImage(i, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", .7));
    };
    i.onerror = () => resolve(src);
    i.src = src;
  });
}

// ---------- Groq ----------
function post(body, key) {
  return fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(body)
  });
}
function apiError(status, msg) {
  if (status === 401 || /invalid api key/i.test(msg)) return "API anahtarı geçersiz. ⚙ Ayarlar'dan kontrol et.";
  if (status === 404 || /model.*(not found|does not exist|decommissioned)/i.test(msg)) return "Model bulunamadı. ⚙ Ayarlar'dan model adını kontrol et.";
  if (status === 429) return "Kullanım limiti aşıldı. Biraz sonra tekrar dene.";
  if (status === 413) return "Fotoğraf çok büyük, tekrar dene.";
  return "Hata (" + status + "): " + (msg || "bilinmeyen");
}
function parseJson(text) {
  text = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try { return JSON.parse(text); } catch (e) {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}
async function analyze(img, cfg) {
  const body = {
    model: cfg.model, temperature: 0.6, reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: img } }
    ] }]
  };
  let res;
  try { res = await post(body, cfg.key); }
  catch (e) { throw new Error("Bağlantı kurulamadı. İnternetini kontrol et."); }
  if (res.status === 400) { // bazı modeller reasoning_effort'u kabul etmez; onsuz tekrar dene
    delete body.reasoning_effort;
    try { res = await post(body, cfg.key); }
    catch (e) { throw new Error("Bağlantı kurulamadı. İnternetini kontrol et."); }
  }
  let data = {}; try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(apiError(res.status, data && data.error && data.error.message));
  const parsed = parseJson(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  if (!parsed) throw new Error("Yanıt çözümlenemedi, tekrar dene.");
  return parsed;
}

on("captureBtn", async () => {
  if (busy) return;
  const cfg = getCfg();
  if (!cfg.key) { toast("Önce ⚙ Ayarlar'dan Groq API anahtarını gir."); openSettings(); return; }
  const img = capture();
  if (!img) { toast("Kamera henüz hazır değil, bir saniye bekle."); return; }
  busy = true; $("loading").classList.remove("hidden");
  try {
    const data = await analyze(img, cfg);
    showResult(data, img);
    saveHistory(data, img);
  } catch (e) {
    toast(e.message || "Analiz başarısız oldu.");
  } finally {
    busy = false; $("loading").classList.add("hidden");
  }
});

// ---------- Sonuç ----------
function showResult(d, img) {
  $("resultImage").src = img; $("resultTag").textContent = d.category || "Tanımlama";
  $("resultName").textContent = d.name || "Tanımlanamadı"; $("resultLatin").textContent = d.latin_name || "";
  $("resultDescription").textContent = d.description || "";
  $("confidence").textContent = d.confidence ? d.confidence + "%" : "—";
  $("facts").innerHTML = (Array.isArray(d.facts) ? d.facts : []).slice(0, 6).map(x => `<li>${escapeHtml(x)}</li>`).join("");
  $("result").classList.remove("hidden");
}
on("closeResult", () => $("result").classList.add("hidden"));
on("retakeBtn", () => $("result").classList.add("hidden"));

// ---------- Geçmiş ----------
async function saveHistory(d, img) {
  try {
    const thumb = await makeThumb(img);
    history.unshift({ name: d.name || "Tanımlanamadı", category: d.category || "", description: d.description || "",
      latin_name: d.latin_name || "", facts: Array.isArray(d.facts) ? d.facts : [], confidence: d.confidence || 0,
      image: thumb, date: new Date().toLocaleString("tr-TR") });
    history = history.slice(0, 30);
    localStorage.setItem("nebu_history", JSON.stringify(history));
    renderHistory();
  } catch (e) { /* depolama dolu olabilir; sonuç zaten gösterildi */ }
}
function renderHistory() {
  $("historyList").innerHTML = history.length
    ? history.map((x, i) => `<div class="history-item" data-i="${i}"><img src="${x.image}" alt=""><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.category)} · ${escapeHtml(x.date)}</small></div></div>`).join("")
    : `<p style="color:#aaa;text-align:center">Henüz bir tanımlama yok.</p>`;
}
$("historyList").addEventListener("click", e => {
  const el = e.target.closest(".history-item"); if (!el) return;
  const x = history[+el.dataset.i]; if (!x) return;
  showResult(x, x.image); $("history").classList.add("hidden");
});
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

on("historyBtn", () => { $("history").classList.remove("hidden"); renderHistory(); });
on("closeHistory", () => $("history").classList.add("hidden"));

// ---------- Ayarlar paneli ----------
function openSettings() {
  let key = "", model = "";
  try { key = localStorage.getItem("nebu_key") || ""; model = localStorage.getItem("nebu_model") || ""; } catch (e) {}
  $("apiKey").value = key; $("apiModel").value = model;
  $("settings").classList.remove("hidden");
}
on("settingsBtn", openSettings);
on("closeSettings", () => $("settings").classList.add("hidden"));
on("saveSettings", () => {
  try {
    localStorage.setItem("nebu_key", $("apiKey").value.trim());
    localStorage.setItem("nebu_model", $("apiModel").value.trim());
    toast("Kaydedildi.");
  } catch (e) { toast("Kaydedilemedi."); }
  $("settings").classList.add("hidden");
});
on("clearHistory", () => {
  history = []; try { localStorage.removeItem("nebu_history"); } catch (e) {}
  renderHistory(); toast("Geçmiş temizlendi.");
});

// ---------- Başlat ----------
renderHistory();
startCamera();
