# Shopping Stock Hunter 🛍️

追蹤 [The Village Outlet](https://thevillageoutlet.com) 上 **Soeur Pantalon Harold** 的 **Size 34** 何時補貨，一有貨就用 **Telegram** 通知你。

- ✅ **不依賴你的電腦開關機**：跑在 GitHub Actions（雲端），24 小時運作。
- ✅ **高頻率**：每次執行內部自我迴圈，有效約每 2.5 分鐘檢查一次。
- ✅ **零外部套件**：只用 Node 20 內建 `fetch`。

---

## 運作原理

網站是 Sylius（伺服器端渲染），商品頁的尺寸下拉選單 **只會列出有庫存的尺寸**。程式：

1. 用一般 HTTP GET 抓商品頁 HTML；
2. 解析 `<select id="sylius_add_to_cart_cartItem_variant_Taille">` 裡的 `<option>`；
3. 如果出現尺寸標籤 **`34`** → 代表補貨了 → 發 Telegram 通知。

> 註：你原始連結裡的 `taille=5e2856ff` 其實對應的是 size **42**，不是 34。所以程式是用「尺寸標籤字串 34」判斷，而非那個 hash（hash 會變，標籤穩定）。

---

## 設定步驟（一次性，約 5 分鐘）

> 這些步驟需要你的帳號/手機，必須由你本人完成。

### 1. 建立 Telegram 機器人，拿到 Bot Token

1. 手機開 Telegram，搜尋 **@BotFather**。
2. 傳 `/newbot`，依指示取名。
3. BotFather 會給你一組 **token**，長得像 `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。**複製起來。**

### 2. 拿到你的 Chat ID

1. 在 Telegram 裡**先對你剛建立的 bot 傳一則訊息**（隨便打個 `hi`）。
2. 瀏覽器打開（把 `<TOKEN>` 換成你的 token）：
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. 在回傳的 JSON 找 `"chat":{"id":123456789,...}`，那個 **id 就是你的 Chat ID**。
   - 或者：搜尋 **@userinfobot**，傳訊息給它，它會直接回你的 id。

### 3. 建立 GitHub Repo 並上傳程式

在這個資料夾執行（把 `<你的repo網址>` 換掉）：

```bash
cd /Users/s25832581/Downloads/CC_Project/Shopping_Stock_Hunter
git init
git add .
git commit -m "init: stock monitor for Soeur Harold size 34"
git branch -M main
git remote add origin <你的repo網址>
git push -u origin main
```

Repo 設 **private** 也可以正常運作。

### 4. 設定 Secrets

在 GitHub repo 頁面：**Settings → Secrets and variables → Actions → New repository secret**，新增兩個：

| Name                 | Value                    |
| -------------------- | ------------------------ |
| `TELEGRAM_BOT_TOKEN` | 第 1 步拿到的 token      |
| `TELEGRAM_CHAT_ID`   | 第 2 步拿到的 chat id    |

### 5. 啟用並測試

1. 到 repo 的 **Actions** 分頁，若看到提示就按 **Enable workflows**。
2. 左側點 **Stock Monitor** → 右邊 **Run workflow**（手動觸發一次）。
3. 看 log 確認執行成功。目前 size 34 沒貨，所以**不會**收到通知——這是正常的。

#### 想確認 Telegram 通知本身有效？

暫時把 `.github/workflows/monitor.yml` 裡的 `TARGET_SIZE` 改成 `"42"`（目前有貨），push、手動 Run 一次 → 你應該會收到 Telegram 訊息。確認後**改回 `"34"`**。

---

## 本機測試（可選，需先裝 Node 20+）

```bash
node monitor.mjs --once      # 只檢查一次、印結果、不發通知
```

預期輸出類似：

```
第 1 輪：size 34 ❌ 無貨｜可選尺寸 [42]
```

---

## 調整設定

改 `.github/workflows/monitor.yml` 裡 `env:` 區塊：

| 變數               | 說明                              | 預設   |
| ------------------ | --------------------------------- | ------ |
| `PRODUCT_URL`      | 要追蹤的商品頁網址                | Harold |
| `TARGET_SIZE`      | 要追蹤的尺寸                      | `34`   |
| `LOOP_MINUTES`     | 每次執行內部迴圈的總時長（分鐘）  | `14`   |
| `INTERVAL_SECONDS` | 每次檢查之間的間隔（秒）          | `150`  |

想追別款商品，把 `PRODUCT_URL` 換成那款商品頁網址即可（只要也是這個網站就通用）。

---

## 已知限制

- **需設為 Public repo**：本設計幾乎整段時間都在執行，Private repo 的免費 Actions 額度（2,000 分鐘/月）約 1~2 天就會用光。**Public repo 的 Actions 免費且無上限**，才能真正 24 小時運作。Telegram token/chat id 存在加密 Secrets、不在程式碼裡，公開沒有風險。
- **60 天自動暫停**：GitHub 會把連續 60 天無提交的排程停用。本程式內建**每日心跳**（每天首次執行會更新 `state.json` 的 `heartbeatDate` → 觸發一次 commit），讓 repo 每天保持活躍、不會被暫停。
- **GitHub cron 不精準**：排程可能延遲數分鐘或偶爾跳過（GitHub 的已知行為），所以「每 2.5 分鐘」是盡力值而非保證。若你要更準時的高頻檢查，可改用 **Cloudflare Workers Cron Triggers**（免費、最短 1 分鐘、serverless），邏輯完全相同，只是換執行環境。
- 通知策略是 **轉態通知**（無貨→有貨才發一次），避免洗版。若想「有貨後持續提醒直到你買到」，可以再加節流參數。
