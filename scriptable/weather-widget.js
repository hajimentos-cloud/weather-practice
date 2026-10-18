// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: cloud-sun;

// ============================================================
// お天気ウィジェット（iPhone のロック画面・ホーム画面用 / Scriptable アプリ用）
// 天気データ: Open-Meteo（CC BY 4.0） https://open-meteo.com/
// 使い方は、同じフォルダの README.md を見てください。
// ============================================================

// ===== 設定（ここだけ書き換えればOK）=====
// 場所の初期値。ウィジェットの「Parameter」に郵便番号（7けた）を入れると、その場所になります。
const DEFAULT_LOCATION = { name: "新宿", lat: 35.6895, lon: 139.6917 };
// ウィジェットをタップしたときに開くページ
const PAGE_URL = "https://hajime-weather.vercel.app";
// 更新の目安（分）。実際の更新タイミングは iOS が決めます
const REFRESH_MINUTES = 30;
// この降水確率（%）以上の時間を「傘が要りそうな時間」とする
const RAIN_THRESHOLD = 50;
// ========================================

// ---- 場所 ----
function onlyDigits(text) {
  return String(text || "")
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9]/g, "");
}

// 郵便番号 → 住所（zipcloud）→ 緯度・経度（国土地理院）。調べた結果は、この iPhone の中に保存して使い回す
async function lookupZip(zip) {
  const key = "weather-widget:zip:" + zip;
  if (Keychain.contains(key)) {
    try { return JSON.parse(Keychain.get(key)); } catch (e) { /* 読めなければ調べ直す */ }
  }
  const z = await new Request("https://zipcloud.ibsnet.co.jp/api/search?zipcode=" + zip).loadJSON();
  if (!z.results || z.results.length === 0) return null;
  const r = z.results[0];
  const town = r.address3.indexOf("以下に掲載がない場合") >= 0 ? "" : r.address3.replace(/（.*$/, "");
  const prefix = r.address1 + r.address2;
  async function geocode(q) {
    const list = await new Request("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q)).loadJSON();
    const hit = list.find(function (f) { return f.properties && f.properties.title && f.properties.title.indexOf(prefix) === 0; });
    return hit ? { lon: hit.geometry.coordinates[0], lat: hit.geometry.coordinates[1] } : null;
  }
  let pos = await geocode(prefix + town);
  if (!pos && town) pos = await geocode(prefix);
  if (!pos) return null;
  const loc = { name: r.address2 + town, lat: pos.lat, lon: pos.lon };
  Keychain.set(key, JSON.stringify(loc));
  return loc;
}

async function resolveLocation() {
  const zip = onlyDigits(args.widgetParameter);
  if (zip.length !== 7) return DEFAULT_LOCATION;
  try {
    const loc = await lookupZip(zip);
    if (loc) return loc;
  } catch (e) { /* 調べられなければ初期の場所にする */ }
  return DEFAULT_LOCATION;
}

// ---- 天気データ ----
async function fetchWeather(loc) {
  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + loc.lat + "&longitude=" + loc.lon
    + "&current=temperature_2m,weather_code"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    + "&hourly=precipitation_probability"
    + "&timezone=Asia%2FTokyo&forecast_days=1";
  const j = await new Request(url).loadJSON();
  if (!j.current || !j.daily || j.current.temperature_2m === null || j.current.temperature_2m === undefined) throw new Error("no data");
  const pop = j.daily.precipitation_probability_max[0];
  return {
    temp: Math.round(j.current.temperature_2m),
    code: j.current.weather_code,
    hour: parseInt(j.current.time.slice(11, 13), 10),
    max: Math.round(j.daily.temperature_2m_max[0]),
    min: Math.round(j.daily.temperature_2m_min[0]),
    pop: (pop === null || pop === undefined) ? null : Math.round(pop),
    probs: j.hourly.precipitation_probability
  };
}

// ---- 表示用の言葉・アイコン ----
function isNight(hour) { return hour >= 19 || hour < 5; }

function weatherLabel(code) {
  if (code === 0) return "快晴";
  if (code === 1) return "晴れ";
  if (code === 2) return "晴れ時々くもり";
  if (code === 3) return "くもり";
  if (code === 45 || code === 48) return "霧";
  if (code >= 51 && code <= 57) return "霧雨";
  if (code >= 61 && code <= 67) return "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "にわか雨";
  if (code === 85 || code === 86) return "にわか雪";
  if (code >= 95) return "雷雨";
  return "不明";
}
function symbolName(code, night) {
  if (code === 0 || code === 1) return night ? "moon.stars.fill" : "sun.max.fill";
  if (code === 2) return night ? "cloud.moon.fill" : "cloud.sun.fill";
  if (code === 3) return "cloud.fill";
  if (code === 45 || code === 48) return "cloud.fog.fill";
  if (code >= 51 && code <= 57) return "cloud.drizzle.fill";
  if (code >= 61 && code <= 67) return "cloud.rain.fill";
  if (code >= 71 && code <= 77) return "cloud.snow.fill";
  if (code >= 80 && code <= 82) return "cloud.heavyrain.fill";
  if (code === 85 || code === 86) return "cloud.snow.fill";
  if (code >= 95) return "cloud.bolt.rain.fill";
  return "cloud.fill";
}
function symbolImage(d) {
  const s = SFSymbol.named(symbolName(d.code, isNight(d.hour))) || SFSymbol.named("cloud.fill");
  return s.image;
}

// 「傘が要りそうな時間」（いまから先の、降水確率が高い時間）
function rainRanges(probs, fromHour) {
  const out = [];
  let start = null;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && h >= fromHour && probs[h] !== null && probs[h] !== undefined && probs[h] >= RAIN_THRESHOLD;
    if (on && start === null) start = h;
    if (!on && start !== null) { out.push(start + "〜" + h + "時"); start = null; }
  }
  return out;
}
function umbrellaText(d) {
  const ranges = rainRanges(d.probs, d.hour);
  if (ranges.length) return "傘 " + ranges[0];
  const rest = d.probs.slice(d.hour).filter(function (v) { return v !== null && v !== undefined; });
  if (rest.length && Math.max.apply(null, rest) >= 30) return "折りたたみ傘を";
  return "傘は不要";
}

// ---- ロック画面（丸型・長方形・1行）----
function buildCircular(w, d) {
  w.addSpacer();
  const img = w.addImage(symbolImage(d));
  img.imageSize = new Size(22, 22);
  img.centerAlignImage();
  const t = w.addText(d.temp + "°");
  t.font = Font.boldSystemFont(16);
  t.centerAlignText();
  t.minimumScaleFactor = 0.6;
  w.addSpacer();
}

function buildRectangular(w, d, loc) {
  const top = w.addStack();
  top.centerAlignContent();
  const img = top.addImage(symbolImage(d));
  img.imageSize = new Size(16, 16);
  top.addSpacer(4);
  const t1 = top.addText(d.temp + "°  " + weatherLabel(d.code));
  t1.font = Font.boldSystemFont(14);
  t1.lineLimit = 1;
  t1.minimumScaleFactor = 0.7;
  const l2 = w.addText(loc.name + "　最高" + d.max + "° 最低" + d.min + "°");
  l2.font = Font.systemFont(11);
  l2.lineLimit = 1;
  l2.minimumScaleFactor = 0.7;
  const l3 = w.addText("降水 " + (d.pop === null ? "-" : d.pop + "%") + "　" + umbrellaText(d));
  l3.font = Font.systemFont(11);
  l3.lineLimit = 1;
  l3.minimumScaleFactor = 0.7;
}

function buildInline(w, d, loc) {
  const t = w.addText(loc.name + " " + d.temp + "° " + weatherLabel(d.code) + " 降水" + (d.pop === null ? "-" : d.pop + "%"));
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
}

// ---- ホーム画面（小・中・大）。ロック画面と同じ内容を、天気に合わせた背景色で ----
const GRADIENTS = {
  sunny: ["#3d9be9", "#7cc0f5"], cloudy: ["#6b7a8c", "#98a6b5"], fog: ["#7d868f", "#a3abb3"],
  rain: ["#2f3d52", "#4a5c75"], snow: ["#6f8fb0", "#a9c3dc"], storm: ["#221f38", "#3d3858"], night: ["#070b22", "#27386b"]
};
function gradientKey(d) {
  if (isNight(d.hour)) return "night";
  if (d.code <= 2) return "sunny";
  if (d.code === 3) return "cloudy";
  if (d.code === 45 || d.code === 48) return "fog";
  if ((d.code >= 71 && d.code <= 77) || d.code === 85 || d.code === 86) return "snow";
  if (d.code >= 95) return "storm";
  return "rain";
}
function buildHome(w, d, loc) {
  const g = new LinearGradient();
  const colors = GRADIENTS[gradientKey(d)];
  g.colors = [new Color(colors[0]), new Color(colors[1])];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 14, 14, 14);

  const name = w.addText(loc.name);
  name.font = Font.mediumSystemFont(13);
  name.textColor = Color.white();
  name.lineLimit = 1;
  w.addSpacer(4);

  const row = w.addStack();
  row.centerAlignContent();
  const img = row.addImage(symbolImage(d));
  img.imageSize = new Size(34, 34);
  img.tintColor = Color.white();
  row.addSpacer(8);
  const temp = row.addText(d.temp + "°");
  temp.font = Font.boldSystemFont(36);
  temp.textColor = Color.white();

  const label = w.addText(weatherLabel(d.code));
  label.font = Font.mediumSystemFont(14);
  label.textColor = Color.white();
  w.addSpacer();

  const hl = w.addText("最高" + d.max + "°  最低" + d.min + "°");
  hl.font = Font.systemFont(12);
  hl.textColor = Color.white();
  const rain = w.addText("降水 " + (d.pop === null ? "-" : d.pop + "%") + "　" + umbrellaText(d));
  rain.font = Font.systemFont(12);
  rain.textColor = Color.white();
  rain.lineLimit = 1;
  rain.minimumScaleFactor = 0.7;
}

function buildError(w) {
  const t = w.addText("天気を取得できません");
  t.font = Font.systemFont(12);
  t.lineLimit = 2;
  t.minimumScaleFactor = 0.7;
}

function buildWidget(family, d, loc) {
  const w = new ListWidget();
  if (!d) buildError(w);
  else if (family === "accessoryCircular") buildCircular(w, d);
  else if (family === "accessoryRectangular") buildRectangular(w, d, loc);
  else if (family === "accessoryInline") buildInline(w, d, loc);
  else buildHome(w, d, loc);
  w.url = PAGE_URL;
  // 取得に失敗したときは、早めにもう一度試す
  w.refreshAfterDate = new Date(Date.now() + (d ? REFRESH_MINUTES : 10) * 60 * 1000);
  return w;
}

// Scriptable アプリの中で実行したときは、見た目のプレビューを出す
async function preview(d, loc) {
  const menu = new Alert();
  menu.title = "プレビュー";
  menu.message = "どのウィジェットを見ますか？";
  const items = [
    ["ロック画面（長方形）", "accessoryRectangular", "presentAccessoryRectangular"],
    ["ロック画面（丸型）", "accessoryCircular", "presentAccessoryCircular"],
    ["ロック画面（1行）", "accessoryInline", "presentAccessoryInline"],
    ["ホーム画面（小）", "small", "presentSmall"],
    ["ホーム画面（中）", "medium", "presentMedium"]
  ];
  items.forEach(function (it) { menu.addAction(it[0]); });
  menu.addCancelAction("閉じる");
  const i = await menu.presentSheet();
  if (i < 0) return;
  const w = buildWidget(items[i][1], d, loc);
  try {
    await w[items[i][2]]();
  } catch (e) {
    const a = new Alert();
    a.title = "このバージョンの Scriptable では、このプレビューを出せません";
    a.message = "ウィジェットとしては動きます。ロック画面に追加して確認してください。";
    a.addAction("OK");
    await a.present();
  }
}

async function main() {
  const loc = await resolveLocation();
  let d = null;
  try { d = await fetchWeather(loc); } catch (e) { d = null; }
  if (config.runsInWidget) {
    Script.setWidget(buildWidget(config.widgetFamily, d, loc));
  } else {
    await preview(d, loc);
  }
  Script.complete();
}

await main();
