# バブルチャート（議員 × 支出項目）

シンプルな静的サイトで、`members_expenses.json` を読み込み、D3.js を使って議員ごとの支出項目をバブルチャートで可視化します。表示モード（全体／議員ごと／項目ごと）を切り替えられます。

- 使用技術: D3.js v7（CDN）、プレーン HTML/CSS/JS
- 配布形態: ビルド不要の静的ファイル（`index.html` / `styles.css` / `main.js` / JSON）
- 動作環境: 近年のモダンブラウザ（CDN 利用のためインターネット接続が必要）

## デモの起動方法（ローカル）

`fetch` を使って JSON を読み込むため、`file://` 直接オープンは CORS で失敗します。必ずローカルサーバで配信してください。

1. ターミナルで本ディレクトリへ移動
2. 簡易サーバを起動（どちらか）
   - Python 3: `python3 -m http.server 8000`
   - Node.js(npx): `npx serve -l 8000`（serve が未インストールなら `npm i -g serve`）
3. ブラウザで `http://localhost:8000/` を開く

同階層の `members_expenses.json` が自動で読み込まれ、チャートが表示されます。

## GitHub Pages での公開

1. 本リポジトリを GitHub に push
2. GitHub のリポジトリ設定 → Pages → `Deploy from a branch` を選択
3. Branch を `main`（または `master`）/ `/ (root)` に設定して保存
4. 数分後に表示される URL にアクセス

Pages 配信であれば `fetch('./members_expenses.json')` がそのまま動作します。

## ファイル構成

- `index.html`: チャート本体（UIの骨組み）
- `styles.css`: スタイル（レイアウト/凡例/ボタンなど）
- `main.js`: ロジック（描画、力学レイアウト、モード切替）
- `members_expenses.json`: データサンプル（同ディレクトリから自動読み込み）

## データ形式（JSON）

`members_expenses.json` は以下のような配列です。

```json
[
  {
    "id": "m01",
    "name": "田中 太郎",
    "expenses": [
      { "category": "広報", "value": 145000 },
      { "category": "研修", "value": 145000 },
      { "category": "調査", "value": 100000 },
      { "category": "交通", "value": 100000 }
    ]
  }
]
```

`index.html` 内でこの階層データを以下のフラット形式に変換して描画します：

```js
// { id, memberId, memberName, category, value }
{ id: "m01-広報", memberId: "m01", memberName: "田中 太郎", category: "広報", value: 145000 }
```

- `category`: 任意の文字列（カテゴリ名）
- `value`: 数値（バブルの大きさに反映。単位は任意）

## 使い方（UI / 操作）

- 「全体」: すべての支出を 1 つのパックレイアウトで表示
- 「議員ごと」: 議員ごとのセルにクラスタリングして表示
- 「項目ごと」: 項目カテゴリごとのセルにクラスタリングして表示
- ツールチップ: バブルにマウスオーバーで詳細（氏名／カテゴリ／金額）
- 凡例: カテゴリ色とサイズの目安（¥1,000 / ¥10,000）を上部に表示

レスポンシブ対応：表示領域のリサイズ（ウィンドウサイズ変更）に追従します。

## カスタマイズのポイント

- カラー: `d3.schemeTableau10` を使用。カテゴリ数が多い場合は自動ループ（`range(CATEGORY_COLORS.concat(CATEGORY_COLORS))`）。
- 半径スケール: `d3.scaleSqrt()`。値の最小・最大から `[6, 28]px` にマップ。見た目調整は `range` を変更。
- 初期モード: `createBubbleChart(el, bubbles, 'all')` の第3引数で変更可能（`'all' | 'member' | 'category'`）。
- データ項目名: データ構造を変えたい場合は `flattenMembers()` を編集。
- タイトル等: `<title>` や `<header>` 内文言を編集。

## よくあるハマりどころ

- 直接ファイルオープン（`file://`）では JSON 読み込みに失敗します。必ず HTTP で配信してください（ローカルサーバ or GitHub Pages）。
- CDN（`https://cdn.jsdelivr.net/npm/d3@7`）にアクセスできない環境では表示できません。イントラネットで利用する場合は D3 を同梱するか、CDN ミラーをご利用ください。

## ライセンス

未定（必要に応じて追記してください）。

## 謝辞 / クレジット

- D3.js (Mike Bostock 他)
- カラースキーム: Tableau 10（D3 内蔵）

---

不明点や要望（例: 軸の追加、検索フィルタ、PNG エクスポート等）があれば Issue でお知らせください。

## 判例（Legend）の実装について

本実装では、凡例を SVG の外に HTML 要素として配置し、`#bubble-root` 内で `position: sticky; top: 0;` によりスクロール先頭固定にしています。SVG のズームや再レイアウトとは独立しており、読みやすさを優先した構成です。

- 構成: ルート要素内に先に凡例（HTML）、続いて SVG を append します。
- 固定位置: `#bubble-root` がスクロールコンテナ、凡例はその先頭で sticky 固定。
- カテゴリ色: D3 の ordinal スケール（`d3.schemeTableau10`）でカテゴリ→色を割当。
- サイズ凡例: 値（例: 1000 / 10000）を半径スケール `r()` に通して丸の直径を算出し、CSS の `width/height` へ反映。
- リサイズ対応: `ResizeObserver` でサイズ変動時に `drawLegend()` を呼び出して更新。

関連コード（抜粋, `index.html`）:

```js
// 1) 先に凡例用の HTML を用意して root に追加
const legendDiv = document.createElement('div');
legendDiv.className = 'legend-html';
rootEl.appendChild(legendDiv);

// 2) カテゴリと色の定義（カテゴリはデータからユニーク抽出）
const categories = Array.from(new Set(nodesData.map(d => d.category)));
const color = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10.concat(d3.schemeTableau10));

// 3) 半径スケール（値→半径）と凡例の描画
const r = d3.scaleSqrt().domain(d3.extent(nodesData, d => d.value)).range([6, 28]);

function drawLegend() {
  const items = categories.map(c => ({ key: c, label: c, color: color(c) }));
  const r1 = Math.max(2, r(1000));
  const r2 = Math.max(2, r(10000));
  const sizeLegend = `
    <span class="legend-item">
      <strong>サイズ:</strong>
      <span class="size-bubble" style="width:${2*r1}px;height:${2*r1}px;"></span>
      <span class="size-label">¥1,000</span>
      <span class="size-bubble" style="width:${2*r2}px;height:${2*r2}px;"></span>
      <span class="size-label">¥10,000</span>
    </span>`;
  legendDiv.innerHTML = items.map(it => `
    <span class="legend-item"><span class="dot" style="background:${it.color}"></span><span class="label">${it.label}</span></span>
  `).join('') + sizeLegend;
}

// 初期化とリサイズ時に更新
drawLegend();
const ro = new ResizeObserver(() => { drawLegend(); });
ro.observe(rootEl);
```

スタイル（`styles.css`）:

- `.legend-html`: `position: sticky; top: 0; z-index: 9; display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #eee;`
- `.legend-item`: インラインフレックスで丸とラベルを横並び表示。
- `.dot`: カテゴリ色を示す小さな丸（`width/height:10px; border-radius:50%`）。
- `.size-bubble`: サイズ凡例用の空心の丸（`border: 2px solid #666`）。直径はインラインスタイルで指定。
- `.size-label`: 目盛ラベル。

カスタマイズ例:

- サイズ凡例の値: `r(1000)` や `r(10000)` を任意の代表値に変更。
- カラーパレット: `d3.schemeTableau10` を他の配列に差し替え。カテゴリ数が多い場合は `range([...palette, ...palette])` のように繰り返し。
- 凡例の配置: sticky をやめて上部固定のヘッダ内や SVG 上（foreignObject/SVG テキスト）に移すことも可能。
