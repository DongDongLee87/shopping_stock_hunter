#!/usr/bin/env node
// 庫存追蹤器 — The Village Outlet / Soeur Pantalon Harold
// 偵測某個尺寸何時補貨，並用 Telegram 通知。
// 零外部套件，使用 Node 20+ 內建 fetch。
//
// 用法：
//   node monitor.mjs           長時間執行（內部迴圈，適合 GitHub Actions）
//   node monitor.mjs --once     只檢查一次、印出結果，不發通知（本機驗證用）
//   DRY_RUN=1 node monitor.mjs  檢查但永不發送 Telegram（會照常寫 state）

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 設定（可用環境變數覆蓋）----
const CONFIG = {
  productUrl:
    process.env.PRODUCT_URL ||
    "https://thevillageoutlet.com/products/soeur-pantalon-harold-48d1748f-26db-41b0-b345-3179dcc60f5f",
  targetSize: (process.env.TARGET_SIZE || "34").trim(),
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || "",
  loopMinutes: Number(process.env.LOOP_MINUTES || "14"),
  intervalSeconds: Number(process.env.INTERVAL_SECONDS || "150"),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || "20000"),
  statePath: process.env.STATE_PATH || join(__dirname, "state.json"),
};

const ONCE = process.argv.includes("--once");
const DRY_RUN = ONCE || process.env.DRY_RUN === "1";

// 擬真的瀏覽器標頭，降低被擋機率。
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const log = (...args) => console.log(`[${nowIso()}]`, ...args);

// ---- state 讀寫 ----
async function loadState() {
  try {
    const raw = await readFile(CONFIG.statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      inStock: Boolean(parsed.inStock),
      lastNotified: parsed.lastNotified || null,
      heartbeatDate: parsed.heartbeatDate || null,
    };
  } catch {
    return { inStock: false, lastNotified: null, heartbeatDate: null };
  }
}

async function saveState(state) {
  try {
    await writeFile(CONFIG.statePath, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    log("WARN 無法寫入 state.json:", err.message);
  }
}

// ---- 抓頁面 ----
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    return { ok: true, html };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "逾時" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 解析尺寸 ----
// Sylius 尺寸選單：<select id="sylius_add_to_cart_cartItem_variant_Taille"> ... </select>
// 網站只會列出「有庫存」的尺寸，所以 option 出現即代表可購買。
function parseAvailableSizes(html) {
  const selectMatch = html.match(
    /<select[^>]*id="sylius_add_to_cart_cartItem_variant_Taille"[^>]*>([\s\S]*?)<\/select>/i
  );
  if (!selectMatch) return null; // 找不到選單（頁面異常或改版）
  const optionsBlock = selectMatch[1];
  const sizes = [];
  const optRe = /<option[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRe.exec(optionsBlock)) !== null) {
    const text = m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    if (text) sizes.push(text);
  }
  return sizes;
}

// ---- Telegram 通知 ----
async function sendTelegram(text) {
  if (DRY_RUN) {
    log("DRY_RUN：略過發送 Telegram。訊息內容：\n" + text);
    return true;
  }
  if (!CONFIG.botToken || !CONFIG.chatId) {
    log("WARN 未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，無法發送通知。");
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      log("WARN Telegram 發送失敗:", res.status, JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    log("WARN Telegram 發送例外:", err.message);
    return false;
  }
}

function buildAlertMessage(sizes) {
  const sizesText = sizes.length ? sizes.join(", ") : "（無）";
  return (
    `🎉 <b>補貨通知</b>：Soeur Pantalon Harold 有 <b>Size ${CONFIG.targetSize}</b> 了！\n\n` +
    `目前可選尺寸：${sizesText}\n\n` +
    `👉 <a href="${CONFIG.productUrl}">立即前往購買</a>\n\n` +
    `<i>${nowIso()}</i>`
  );
}

// ---- 單次檢查 ----
// 回傳 { status: "in"|"out"|"error", sizes, error }
async function checkOnce() {
  const page = await fetchPage(CONFIG.productUrl);
  if (!page.ok) {
    return { status: "error", sizes: [], error: page.error };
  }
  const sizes = parseAvailableSizes(page.html);
  if (sizes === null) {
    return { status: "error", sizes: [], error: "找不到尺寸選單" };
  }
  const inStock = sizes.includes(CONFIG.targetSize);
  return { status: inStock ? "in" : "out", sizes, error: null };
}

// ---- 主流程 ----
async function main() {
  log(
    `啟動監控：size=${CONFIG.targetSize}  once=${ONCE}  dryRun=${DRY_RUN}  ` +
      `interval=${CONFIG.intervalSeconds}s  loop=${CONFIG.loopMinutes}min`
  );

  const state = await loadState();
  let prevInStock = state.inStock;

  const deadline = Date.now() + CONFIG.loopMinutes * 60 * 1000;
  let iteration = 0;
  let lastStatus = "out";

  while (true) {
    iteration += 1;
    const result = await checkOnce();
    lastStatus = result.status;

    if (result.status === "error") {
      // 不誤報無貨：出錯就略過本輪、保留上一次狀態。
      log(`第 ${iteration} 輪：檢查失敗（${result.error}），略過。`);
    } else {
      const inStock = result.status === "in";
      log(
        `第 ${iteration} 輪：size ${CONFIG.targetSize} ${
          inStock ? "✅ 有貨" : "❌ 無貨"
        }｜可選尺寸 [${result.sizes.join(", ")}]`
      );

      if (inStock && !prevInStock) {
        // 轉態：無貨 → 有貨，發一次通知。
        const sent = await sendTelegram(buildAlertMessage(result.sizes));
        if (sent) {
          state.lastNotified = nowIso();
          log("已送出補貨通知。");
        }
      }
      prevInStock = inStock;
      state.inStock = inStock;
    }

    if (ONCE) break;
    if (Date.now() + CONFIG.intervalSeconds * 1000 >= deadline) break;
    await sleep(CONFIG.intervalSeconds * 1000);
  }

  // 心跳：每天至少更新一次 heartbeatDate，讓 state.json 每天有變動、
  // 觸發一次 commit，保持 repo 活躍，避免 GitHub 60 天無活動自動暫停排程。
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  if (state.heartbeatDate !== today) {
    state.heartbeatDate = today;
    log(`心跳：heartbeatDate → ${today}（保持 repo 活躍）`);
  }

  await saveState(state);
  log(`結束本次執行。最終狀態：inStock=${state.inStock}`);

  // --once 時：只有檢查出錯才給非零 exit code（有貨/無貨都算成功）
  if (ONCE && lastStatus === "error") process.exitCode = 2;
}

main().catch((err) => {
  log("FATAL", err);
  process.exitCode = 1;
});
