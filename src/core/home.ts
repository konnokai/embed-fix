/**
 * The home page served at `/` (every domain except the legacy Naver one), and
 * the page for paths that are not a supported post link.
 *
 * The converter runs in the browser, so pasted links never reach the server.
 * It only swaps the domain and drops tracking parameters; whether the path is
 * a supported post is still decided by the router when the link is opened.
 */

import { escapeHtml, SERVICE_NAME } from "./page";
import type { HealthStatus } from "./health";
import { FACEBOOK_HOST, INSTAGRAM_HOST, MAIN_HOST } from "../router";

/** Browsers may keep the page this long; the status block changes at most once an hour. */
export const HOME_CACHE_TTL = 300;

/**
 * Besides the inline style and script, only the scripts Cloudflare injects on
 * the proxied domain may run: Web Analytics (`static.cloudflareinsights.com`,
 * reporting to `cloudflareinsights.com` or `/cdn-cgi/rum`) and Zaraz
 * (`/cdn-cgi/zaraz/`), hence `'self'`.
 */
export const HOME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "connect-src 'self' https://cloudflareinsights.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const DESCRIPTION = "把 Threads、Facebook、Instagram、Naver Cafe 的貼文網址換成 ebfix 的網域，貼到 Discord 就有預覽。";

/** A check older than this means the cron stopped and the status is no longer current. */
const STALE_AFTER = 2 * 60 * 60 * 1000;

const STYLE = `:root{color-scheme:light dark;--fg:#222;--muted:#666;--bg:#fff;--line:#ddd;--accent:#2f5bd3;--ok:#1a7f37;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--muted:#9a9a9a;--bg:#16171a;--line:#34373c;--accent:#8ab4ff;--ok:#5cc97a;--bad:#ff7b72}}
body{margin:0 auto;padding:1.5rem 1rem;max-width:44rem;font:16px/1.7 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:1.6rem;line-height:1.3;margin:0 0 .25rem}
h2{font-size:1.1rem;margin:2.25rem 0 .5rem}
a{color:var(--accent)}
.meta{color:var(--muted);font-size:.9rem}
label{display:block;font-weight:600;margin:1.5rem 0 .35rem}
input{box-sizing:border-box;width:100%;padding:.6rem .75rem;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.result{display:flex;gap:.75rem;align-items:center;margin:.75rem 0 0;padding:.6rem .75rem;border:1px solid var(--line);border-radius:6px}
.result a{flex:1;min-width:0;overflow-wrap:anywhere}
button{flex:none;font:inherit;font-size:.9rem;padding:.3rem .8rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.error{color:var(--bad);margin:.75rem 0 0}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{text-align:left;vertical-align:top;padding:.5rem .5rem .5rem 0;border-bottom:1px solid var(--line)}
th{font-weight:600;white-space:nowrap}
code{font-size:.9em;overflow-wrap:break-word}
.status{list-style:none;padding:0;margin:0}
.status li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--line)}
.ok{color:var(--ok)}.failing{color:var(--bad)}.unknown{color:var(--muted)}
[hidden]{display:none!important}`;

/**
 * Plain ES2017 so it runs in any browser that can open Discord. Hosts are
 * filled in by the server; everything else is static.
 */
const SCRIPT = `(function () {
  var HOSTS = { main: ${JSON.stringify(MAIN_HOST)}, facebook: ${JSON.stringify(FACEBOOK_HOST)}, instagram: ${JSON.stringify(INSTAGRAM_HOST)} };
  var TARGETS = {
    "threads.com": "main", "threads.net": "main",
    "cafe.naver.com": "main", "m.cafe.naver.com": "main",
    "instagram.com": "instagram",
    "cafe.konnokai.me": "main"
  };
  TARGETS[HOSTS.main] = "main";
  TARGETS[HOSTS.facebook] = "facebook";
  TARGETS[HOSTS.instagram] = "instagram";
  // 伺服器端 Facebook 只看這幾個參數，其他平台的參數都丟掉。
  var FACEBOOK_PARAMS = ["story_fbid", "id", "fbid", "v", "multi_permalinks"];

  function convert(text) {
    var input = text.trim();
    if (!input) return null;
    if (!/^https?:\\/\\//i.test(input)) input = "https://" + input;
    var url;
    try { url = new URL(input); } catch (e) { return { error: "看不懂這個網址。" }; }
    var host = url.hostname.toLowerCase().replace(/^www\\./, "");
    if (host === "fb.watch") return { error: "不支援 fb.watch 短網址。請在 Facebook 打開影片，再複製網址列的網址。" };
    var target = TARGETS[host] || (/(^|\\.)facebook\\.com$/.test(host) ? "facebook" : null);
    if (!target) return { error: "不支援這個網站。目前支援 Threads、Facebook、Instagram、Naver Cafe。" };
    if (url.pathname === "/") return { error: "這是網站首頁，請貼上單篇貼文的網址。" };
    if (/^\\/stories\\//.test(url.pathname)) return { error: "不支援限時動態。" };
    var query = "";
    if (target === "facebook") {
      var kept = new URLSearchParams();
      FACEBOOK_PARAMS.forEach(function (name) {
        var value = url.searchParams.get(name);
        if (value !== null) kept.set(name, value);
      });
      query = kept.toString() ? "?" + kept.toString() : "";
    }
    return { url: "https://" + HOSTS[target] + url.pathname + query };
  }

  var input = document.getElementById("source");
  var result = document.getElementById("result");
  var link = document.getElementById("converted");
  var copy = document.getElementById("copy");
  var error = document.getElementById("error");

  function update() {
    var converted = convert(input.value);
    result.hidden = !(converted && converted.url);
    error.hidden = !(converted && converted.error);
    if (converted && converted.url) {
      link.href = converted.url;
      link.textContent = converted.url;
      copy.textContent = "複製";
    }
    if (converted && converted.error) error.textContent = converted.error;
  }

  document.getElementById("convert").addEventListener("submit", function (event) { event.preventDefault(); update(); });
  input.addEventListener("input", update);
  copy.addEventListener("click", function () {
    navigator.clipboard.writeText(link.href).then(function () {
      copy.textContent = "已複製";
    }, function () {
      getSelection().selectAllChildren(link);
    });
  });

  // 伺服器輸出的是台北時間，這裡換成訪客自己的時區。
  Array.prototype.forEach.call(document.querySelectorAll("time[datetime]"), function (node) {
    node.textContent = formatTime(new Date(node.dateTime));
  });
  function formatTime(date) {
    return date.toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  update();
})();`;

const TAIPEI_TIME = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function timeTag(epochMs: number): string {
  const date = new Date(epochMs);
  return `<time datetime="${date.toISOString()}">${escapeHtml(TAIPEI_TIME.format(date))}</time>`;
}

/** Supported paths per platform, the short form of the README table. */
const PLATFORMS: { id: string; name: string; host: string; paths: string[] }[] = [
  { id: "threads", name: "Threads", host: MAIN_HOST, paths: ["/@{username}/post/{code}", "/t/{code}", "/share/{code}"] },
  {
    id: "facebook",
    name: "Facebook",
    host: FACEBOOK_HOST,
    paths: ["/{user}/posts/{id}", "/reel/{id}", "/watch/?v={id}", "/groups/{group}/posts/{id}", "/share/p/{hash}"],
  },
  { id: "instagram", name: "Instagram", host: INSTAGRAM_HOST, paths: ["/p/{code}", "/reel/{code}", "/share/{code}"] },
  { id: "naver", name: "Naver Cafe", host: MAIN_HOST, paths: ["/f-e/cafes/{cafeId}/articles/{articleId}"] },
];

function platformTable(): string {
  const rows = PLATFORMS.map(
    (platform) =>
      `<tr><th scope="row">${escapeHtml(platform.name)}<br><span class="meta">${escapeHtml(platform.host)}</span></th>` +
      `<td>${platform.paths.map((path) => `<code>${escapeHtml(path).replace(/(?!^)\//g, "<wbr>/")}</code>`).join("<br>")}</td></tr>`,
  );
  return `<table>\n<thead><tr><th scope="col">平台／網域</th><th scope="col">路徑（和原網址相同）</th></tr></thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table>`;
}

function statusSection(status: HealthStatus | null, now: number): string {
  if (!status) {
    return `<p class="meta">暫時讀不到檢查結果。</p>`;
  }
  const items = PLATFORMS.map((platform) => {
    const health = status.platforms[platform.id];
    const state = !health
      ? `<span class="unknown">尚未檢查</span>`
      : health.ok
        ? `<span class="ok">● 正常</span>`
        : `<span class="failing">● 異常</span> <span class="meta">（${timeTag(health.since)} 起）</span>`;
    return `<li><span>${escapeHtml(platform.name)}</span><span>${state}</span></li>`;
  });
  const checked =
    status.checkedAt === null
      ? "還沒有檢查紀錄。"
      : `每小時用一篇公開貼文檢查一次，最後檢查：${timeTag(status.checkedAt)}。` +
        (now - status.checkedAt > STALE_AFTER ? "已超過兩小時沒有檢查，狀態可能不準。" : "");
  return `<ul class="status">\n${items.join("\n")}\n</ul>\n<p class="meta">${checked}</p>`;
}

function renderShell(options: { title: string; description: string; url?: string; style: string; body: string; script?: string }): string {
  const tags = options.url
    ? [
        `<meta name="description" content="${escapeHtml(options.description)}">`,
        `<meta property="og:title" content="${escapeHtml(options.title)}">`,
        `<meta property="og:description" content="${escapeHtml(options.description)}">`,
        `<meta property="og:site_name" content="${SERVICE_NAME}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${escapeHtml(options.url)}">`,
        `<meta name="twitter:card" content="summary">`,
      ].join("\n")
    : "";
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${tags}
<style>${options.style}</style>
</head>
<body>
${options.body}
${options.script ? `<script>${options.script}</script>` : ""}
</body>
</html>`;
}

export function renderHomePage(options: { origin: string; status: HealthStatus | null; now: number }): string {
  const body = `<h1>${SERVICE_NAME}</h1>
<p>${escapeHtml(DESCRIPTION)}</p>
<form id="convert">
<label for="source">貼上原網址</label>
<input id="source" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.threads.com/@zuck/post/C-srcchPpp7">
</form>
<p id="result" class="result" aria-live="polite" hidden><a id="converted" href="#"></a><button id="copy" type="button">複製</button></p>
<p id="error" class="error" role="alert" hidden></p>
<noscript><p class="meta">沒有 JavaScript 時請手動換掉網域：依下表換成對應的網域，路徑不變。</p></noscript>
<h2>支援的網址</h2>
${platformTable()}
<p class="meta">Facebook 和 Instagram 用自己的網域，因為兩者的分享連結路徑和 Threads 重疊。網址後面的追蹤參數會丟掉。</p>
<h2>目前狀態</h2>
${statusSection(options.status, options.now)}
<h2>不支援</h2>
<ul>
<li>限時動態、精選動態、個人頁、留言</li>
<li>Facebook 私人社團、<code>fb.watch</code> 短網址</li>
<li>需登入、私人帳號或已刪除的貼文：只會顯示一張提示卡片，未登入時分不出是哪一種。</li>
</ul>`;
  return renderShell({
    title: SERVICE_NAME,
    description: DESCRIPTION,
    url: `${options.origin}/`,
    style: STYLE,
    body,
    script: SCRIPT,
  });
}

/** Paths that match no provider: still a 400, but with a way to the converter. */
export function renderUnsupportedPage(): string {
  return renderShell({
    title: "不支援的網址格式",
    description: "",
    style: STYLE,
    body: `<h1>不支援的網址格式</h1>
<p>這不是支援的貼文連結。到 <a href="https://${MAIN_HOST}/">${SERVICE_NAME} 首頁</a>貼上原網址轉換，或查看支援的網址格式。</p>`,
  });
}
