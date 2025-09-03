"use strict";

(function () {
  // =============================================
  // スクリプトの読み方（ざっくり全体像）
  // ---------------------------------------------
  // - flattenMembers(): JSON（階層）→ バブル用のフラット配列へ整形
  // - createBubbleChart(): SVGと力学レイアウトの初期化、本体のすべて
  //   - 凡例(HTML)の描画
  //   - 力学シミュレーション（forceX/forceY/collide）
  //   - グリッド配置（議員/項目）とパック配置（全体）
  //   - モード切替時の高さ調整（SVGのheight）
  // - ボタン/入力: JSON読み込み、モード切替、リサイズ追従
  // =============================================
  const el = document.querySelector('#bubble-root');
  const statusEl = document.getElementById('status');
  const btnModeAll = document.getElementById('mode-all');
  const btnModeByMember = document.getElementById('mode-by-member');
  const btnModeByCategory = document.getElementById('mode-by-category');

  const CATEGORY_COLORS = d3.schemeTableau10;

  // ---- バブルチャート（クラスタ切替対応版） ----
  /**
   * バブルチャートを生成し、モード切替APIを返す。
   * @param {HTMLElement} rootEl - ルート要素（#bubble-root）
   * @param {Array} nodesData - {id, memberId, memberName, category, value} の配列
   * @param {'all'|'member'|'category'} initialMode - 初期表示モード
   * @returns {{ setMode: (m:string)=>void, getMode: ()=>string }}
   */
  function createBubbleChart(rootEl, nodesData, initialMode = 'all') {
    rootEl.innerHTML = '';
    const margin = { top: 56, right: 16, bottom: 16, left: 16 };
    const headerEl0 = document.querySelector('header');
    const headerH0 = headerEl0 ? headerEl0.offsetHeight : 58;
    let width = rootEl.clientWidth || 960;
    let height = rootEl.clientHeight || (window.innerHeight - headerH0) || 600;

    // 凡例（HTML, sticky）を先に配置
    // 凡例（HTML要素）: sticky配置のため、SVG外にHTMLで用意
    const legendDiv = document.createElement('div');
    legendDiv.className = 'legend-html';
    rootEl.appendChild(legendDiv);

    // SVG本体（viewBoxは固定原点。高さはモードで更新）
    const svg = d3
      .select(rootEl)
      .append('svg')
      .attr('viewBox', [0, 0, width, height])
      .attr('width', '100%')
      .attr('height', '100%')
      .style('background', '#fff');

    const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
    const chartG = zoomLayer.append('g').attr('transform', `translate(${margin.left}, ${margin.top})`);
    const nodesG = chartG.append('g').attr('class', 'nodes');
    const groupsG = chartG.append('g').attr('class', 'groups'); // グループタイトル等（ノードの上に表示）
    // クラスタ（議員/カテゴリ）ごとのセル境界（x0,y0,x1,y1）に収めるためのバウンディング
    let clusterBounds = null; // Map<clusterKey, {x0,y0,x1,y1}>
    // tick 内でどのキーでクラスタリングしているかを参照する関数
    let groupKeyFn = null; // (d) => string

    // 判例（カテゴリ＋サイズ）: スクロールに対して上部固定のHTMLに描画
    // 現在モードに応じて凡例のサイズを算出
    function drawLegend() {
      const items = categories.map((c) => ({ key: c, label: c, color: color(c) }));
      const legendRadius = (val) => {
        if (currentMode === 'all' && packRadiusK) {
          return Math.max(2, packRadiusK * Math.sqrt(val));
        }
        return Math.max(2, r(val));
      };
      const r1 = legendRadius(1000);
      const r2 = legendRadius(10000);
      const sizeLegend = `
        <span class="legend-item">
          <strong>サイズ:</strong>
          <span class="size-bubble" style="width:${2 * r1}px;height:${2 * r1}px;"></span>
          <span class="size-label">¥1,000</span>
          <span class="size-bubble" style="width:${2 * r2}px;height:${2 * r2}px;"></span>
          <span class="size-label">¥10,000</span>
        </span>`;
      legendDiv.innerHTML =
        items
          .map((it) => `
        <span class="legend-item"><span class="dot" style="background:${it.color}"></span><span class="label">${it.label}</span></span>
      `)
          .join('') + sizeLegend;
    }

    // カテゴリ色（カテゴリ→色の対応を定義）
    const categories = Array.from(new Set(nodesData.map((d) => d.category)));
    const color = d3.scaleOrdinal().domain(categories).range(CATEGORY_COLORS.concat(CATEGORY_COLORS));

    // 半径スケール（値→ピクセル半径）。平方根スケールで極端な値の影響を緩和
    const vExtent = d3.extent(nodesData, (d) => d.value);
    const r = d3.scaleSqrt().domain(vExtent).range([6, 28]);
    // 全体表示（pack）時の半径スケール係数（r_pack = packRadiusK * sqrt(value)）
    let packRadiusK = null;

    // ツールチップ
    const tip = d3
      .select(rootEl)
      .append('div')
      .style('position', 'absolute')
      .style('background', 'rgba(0,0,0,0.75)')
      .style('color', '#fff')
      .style('padding', '6px 8px')
      .style('font', '12px/1.4 system-ui, sans-serif')
      .style('border-radius', '6px')
      .style('pointer-events', 'none')
      .style('opacity', 0);

    // ノード（再利用できるようデータをコピーし座標を保持）
    const nodes = nodesData.map((d) => Object.assign({}, d));

    // ノード描画（サークル）
    const nodeSel = nodesG
      .selectAll('circle')
      .data(nodes, (d) => d.id)
      .join('circle')
      .attr('r', (d) => r(d.value))
      .attr('fill', (d) => color(d.category))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1)
      .on('mousemove', (event, d) => {
        tip
          .style('left', event.clientX + 10 + 'px')
          .style('top', event.clientY + 10 + 'px')
          .style('opacity', 1)
          .html(`
            <div><strong>${d.memberName}</strong></div>
            <div>カテゴリ: ${d.category}</div>
            <div>支出: ¥${d3.format(',')(d.value)}</div>
          `);
      })
      .on('mouseout', () => tip.style('opacity', 0));

    // ズーム機能は無効（パン・拡大縮小なし）

    // レイアウト中心の算出
    function centersBy(groups, colsDesired) {
      const cols = Math.max(1, Math.min(groups.length, colsDesired || Math.ceil(Math.sqrt(groups.length))))
      const rows = Math.ceil(groups.length / cols);
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const cellW = innerW / cols;
      const cellH = innerH / rows;
      return new Map(
        groups.map((g, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const cx = cellW * col + cellW / 2;
          const cy = cellH * row + cellH / 2;
          return [g, { cx, cy }];
        })
      );
    }

    function updateGroupLabels(map, labelAccessor) {
      const data = Array.from(map.entries()).map(([key, c]) => ({ key, ...c }));
      const sel = groupsG.selectAll('g.group-label').data(data, (d) => d.key);
      const ent = sel.enter().append('g').attr('class', 'group-label');
      ent
        .append('text')
        .attr('text-anchor', 'middle')
        .style('font', '12px system-ui')
        .style('fill', '#111')
        .style('pointer-events', 'none')
        .attr('stroke', '#fff')
        .attr('stroke-width', 3)
        .attr('paint-order', 'stroke')
        .attr('stroke-linejoin', 'round');
      const merged = ent.merge(sel);
      merged.attr('transform', (d) => `translate(${d.cx}, ${d.cy})`);
      merged.select('text').text((d) => labelAccessor(d.key));
      sel.exit().remove();
      groupsG.raise(); // 常にノードより上に
    }

    // 現在モード（先に定義しておく）
    let currentMode = initialMode;

    // シミュレーション
    const COLLIDE_PAD = 0.25; // 非重なりを維持しつつ最小限の隙間
    const sim = d3
      .forceSimulation(nodes)
      .force('x', d3.forceX())
      .force('y', d3.forceY())
      // 非重なりギリギリまで詰める（反復回数を増やす）
      .force('collide', d3.forceCollide().radius((d) => r(d.value) + COLLIDE_PAD).strength(1).iterations(6))
      .alpha(1);

    // 全体モード用の詰め込み座標
    let allLayout = null; // Map(id => {x,y,r})

    sim.on('tick', () => {
      if (currentMode === 'all' && allLayout) {
        nodeSel
          .attr('cx', (d) => allLayout.get(d.id)?.x ?? d.x)
          .attr('cy', (d) => allLayout.get(d.id)?.y ?? d.y);
      } else if ((currentMode === 'category' || currentMode === 'member') && clusterBounds && groupKeyFn) {
        nodeSel.each(function (d) {
          const key = groupKeyFn(d);
          const b = clusterBounds.get(key);
          if (!b) return;
          const rr = r(d.value);
          d.x = Math.max(b.x0 + rr, Math.min(b.x1 - rr, d.x));
          d.y = Math.max(b.y0 + rr, Math.min(b.y1 - rr, d.y));
        });
        nodeSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      } else {
        nodeSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      }
    });

    // 表示幅からグリッド列数を概算（安全側の見積り）
    function suggestedColsFor(groupsCount, extraGap = 0) {
      const innerW = width - margin.left - margin.right;
      const rMax = d3.max(nodes, (d) => r(d.value)) || 20;
      // 余白を抑えてセル幅を小さく
      const cellW = Math.max(2 * rMax + 8 + extraGap, 72 + extraGap); // 余白込みの最小セル幅
      const cols = Math.floor(innerW / cellW) || 1;
      return Math.max(1, Math.min(groupsCount, cols));
    }

    /**
     * 幅に合わせたグリッド配置（グループ→セル中心座標）
     * opts:
     *  - maxInnerHeight: （任意）縦の総高さの上限。指定時は行数を抑えるために列数を増やす
     *  - minCell: （任意）セルの最小サイズ（幅・高さ）px。推定必要サイズを強制する用途
     */
    function layoutGrid(groups, extraGap = 0, opts = {}) {
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const rMax = d3.max(nodes, (d) => r(d.value)) || 20;
      // セルの基本サイズもやや小さく
      const baseCellDefault = Math.max(2 * rMax + 6 + extraGap, 68 + extraGap);
      const baseCell = Math.max(baseCellDefault, opts.minCell || 0);

      let cols;
      if (opts.maxInnerHeight) {
        const limitH = Math.max(1, Math.floor(opts.maxInnerHeight));
        const maxRows = Math.max(1, Math.floor(limitH / baseCell));
        const maxColsByWidth = Math.max(1, Math.floor(innerW / baseCell));
        cols = Math.max(1, Math.ceil(groups.length / maxRows));
        cols = Math.min(cols, groups.length, maxColsByWidth);
      } else {
        cols = Math.max(1, Math.min(groups.length, Math.floor(innerW / baseCell) || 1));
      }

      const rows = Math.ceil(groups.length / cols);
      const cellW = innerW / cols;
      const cellH = baseCell;
      const centers = new Map(
        groups.map((g, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const cx = cellW * col + cellW / 2;
          const cy = cellH * row + cellH / 2;
          return [g, { cx, cy }];
        })
      );
      return { centers, rows, cols, cellW, cellH, innerHeight: rows * cellH };
    }

    // モード切替（'all'|'member'|'category'）
    function setMode(mode) {
      currentMode = mode;
      let centers;
      if (mode === 'member') {
        allLayout = null; // 詰め込み無効
        packRadiusK = null;
        // セルにバブルが収まるよう必要最低サイズを推定（面積ベース）
        const effM = 0.85; // 充填効率を高めにしてセルをコンパクトに
        // メンバーごとに必要直径を推定
        const members = Array.from(new Set(nodes.map((d) => d.memberName)));
        const needDiamByMember = new Map(
          members.map((mname) => {
            const sumR2 = d3.sum(
              nodes.filter((n) => n.memberName === mname),
              (n) => {
                const rr = r(n.value) + COLLIDE_PAD;
                return rr * rr;
              }
            );
            const needRadius = Math.sqrt(sumR2 / effM);
            return [mname, 2 * needRadius];
          })
        );
        const minCellMember = Math.max(...Array.from(needDiamByMember.values()).concat([0]));
        // 余白を最小限にして密度を上げる（minCell を適用）
        const grid = layoutGrid(members, 4, { minCell: minCellMember });
        centers = grid.centers;
        sim.force('x').x((d) => centers.get(d.memberName).cx);
        sim.force('y').y((d) => centers.get(d.memberName).cy);
        updateGroupLabels(centers, (k) => k);
        // 半径はスムーズに戻す、物理遷移も滑らかに
        nodeSel.transition().duration(500).ease(d3.easeCubicInOut).attr('r', (d) => r(d.value));
        sim.alphaTarget(0.35).alpha(1).restart();
        d3.timeout(() => sim.alphaTarget(0), 800);
        // SVG高さを必要分だけ伸ばす（スクロール対応）
        const totalH = margin.top + grid.innerHeight + margin.bottom;
        svg.attr('viewBox', [0, 0, width, totalH]).attr('height', totalH);
        // メンバーごとのバウンディング（非重なりでギリギリまで詰める）
        clusterBounds = new Map(
          Array.from(centers.entries()).map(([k, c]) => {
            const x0 = c.cx - grid.cellW / 2,
              y0 = c.cy - grid.cellH / 2;
            const x1 = c.cx + grid.cellW / 2,
              y1 = c.cy + grid.cellH / 2;
            return [k, { x0, y0, x1, y1 }];
          })
        );
        groupKeyFn = (d) => d.memberName;
      } else if (mode === 'category') {
        allLayout = null; // 詰め込み無効
        packRadiusK = null;
        // セルにバブルが収まるよう必要最低サイズを推定（面積ベース）
        const eff = 0.85; // 充填効率を高めにしてセルをコンパクトに
        const pad = COLLIDE_PAD; // バブル周りの余白（半径に加算）を最小化
        const needDiamByCat = new Map(
          categories.map((cat) => {
            const sumR2 = d3.sum(
              nodes.filter((n) => n.category === cat),
              (n) => {
                const rr = r(n.value) + pad;
                return rr * rr;
              }
            );
            const needRadius = Math.sqrt(sumR2 / eff); // おおよその必要半径
            return [cat, 2 * needRadius]; // 直径
          })
        );
        const minCellCat = Math.max(...Array.from(needDiamByCat.values()).concat([0]));
        // 幅に合わせて列数を自動調整（縦方向は必要分だけ伸ばす＝スクロール可能）
        const gridC = layoutGrid(categories, 4, { minCell: minCellCat });
        centers = gridC.centers;
        sim.force('x').x((d) => centers.get(d.category).cx);
        sim.force('y').y((d) => centers.get(d.category).cy);
        updateGroupLabels(centers, (k) => k);
        nodeSel.transition().duration(500).ease(d3.easeCubicInOut).attr('r', (d) => r(d.value));
        sim.alphaTarget(0.35).alpha(1).restart();
        d3.timeout(() => sim.alphaTarget(0), 800);
        // SVG高さは内容に応じて拡張（縦スクロール可能に）
        const totalH = margin.top + gridC.innerHeight + margin.bottom;
        svg.attr('viewBox', [0, 0, width, totalH]).attr('height', totalH);
        // カテゴリごとのバウンディングを用意し、はみ出しを抑制
        clusterBounds = new Map(
          Array.from(centers.entries()).map(([k, c]) => {
            const x0 = c.cx - gridC.cellW / 2,
              y0 = c.cy - gridC.cellH / 2;
            const x1 = c.cx + gridC.cellW / 2,
              y1 = c.cy + gridC.cellH / 2;
            return [k, { x0, y0, x1, y1 }];
          })
        );
        groupKeyFn = (d) => d.category;
      } else {
        clusterBounds = null;
        groupKeyFn = null;
        // 全体表示は詰め込みレイアウトで必ず領域内に収める
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;
        const h = d3
          .hierarchy({ children: nodes.map((d) => ({ id: d.id, value: d.value })) })
          .sum((d) => d.value);
        // パックレイアウトの余白を最小限に（非重なりギリギリ）
        const packed = d3.pack().size([innerW, innerH]).padding(0.25)(h);
        const leaves = packed.leaves();
        // pack の半径は sqrt(value) に比例するため、係数を推定して凡例に反映
        const ks = leaves
          .filter((l) => l.data.value > 0)
          .map((l) => l.r / Math.sqrt(l.data.value));
        packRadiusK = ks.length ? d3.median(ks) : null;
        allLayout = new Map(leaves.map((l) => [l.data.id, { x: l.x, y: l.y, r: l.r }]));
        // ラベルは無し
        updateGroupLabels(new Map(), () => '');
        // 座標・半径をスムーズに遷移（はみ出し防止）
        nodeSel
          .transition()
          .duration(700)
          .ease(d3.easeCubicInOut)
          .attr('cx', (d) => allLayout.get(d.id)?.x ?? 0)
          .attr('cy', (d) => allLayout.get(d.id)?.y ?? 0)
          .attr('r', (d) => allLayout.get(d.id)?.r ?? r(d.value));
        // ノードの内部座標も同期しておく（他モード復帰時のジャンプ防止）
        nodes.forEach((n) => {
          const p = allLayout.get(n.id);
          if (p) {
            n.x = p.x;
            n.y = p.y;
          }
        });
        // シミュレーションは停止（他モードに切替時に再開）
        sim.alpha(0).stop();
        // SVGは表示領域サイズに戻す（ピクセル高さで安定させる）
        svg.attr('viewBox', [0, 0, width, height]).attr('height', height);
      }

      // モード変更に応じて凡例サイズを更新
      drawLegend();
    }

    // 初期: 凡例→マージン調整→モード適用
    drawLegend();
    setMode(initialMode);

    // リサイズ時に座標再計算
    const ro = new ResizeObserver(() => {
      width = rootEl.clientWidth || width;
      const headerEl = document.querySelector('header');
      const hHeader = headerEl ? headerEl.offsetHeight : 58;
      height = rootEl.clientHeight || (window.innerHeight - hHeader) || height;
      svg.attr('viewBox', [0, 0, width, height]);
      setMode(currentMode);
    });
    ro.observe(rootEl);

    // 現在モード参照用を返す
    return {
      setMode: (m) => {
        currentMode = m;
        setMode(m);
      },
      getMode: () => currentMode,
    };
  }

  // ---- members_expenses.json（階層）→ バブル用フラット配列へ ----
  /**
   * members_expenses.json の構造例：
   * [
   *   { id: 'm1', name: '山田太郎', expenses: [ {category:'交通費', value: 12000}, ... ] },
   *   ...
   * ]
   * これをバブル描画に適したフラット配列へ変換する。
   */
  function flattenMembers(rawMembers) {
    return rawMembers.flatMap((m) =>
      (m.expenses || []).map((e) => ({
        id: m.id + '-' + e.category,
        memberId: m.id,
        memberName: m.name,
        category: e.category,
        value: +e.value,
      }))
    );
  }

  // ---- ロード経路1: fetchで同フォルダのJSONを取る ----
  /**
   * fetch による JSON 読み込み（同ディレクトリの members_expenses.json）
   * - file:// で開くと CORS で失敗するので注意
   */
  async function loadByFetch() {
    statusEl.textContent = '読み込み中: ./members_expenses.json';
    const data = await fetch('./members_expenses.json').then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    statusEl.textContent = '読み込み成功: ./members_expenses.json';
    return flattenMembers(data);
  }

  // （ローカルファイル選択ロードは不要のため削除）

  // チャートインスタンス
  let chart = null; // createBubbleChart の戻りを保持

  // 起動時に自動でJSONを読み込む（GitHub Pages 等の同一ディレクトリを想定）
  (async () => {
    try {
      const bubbles = await loadByFetch();
      chart = createBubbleChart(el, bubbles, 'all');
      statusEl.textContent = '読み込み成功: ./members_expenses.json';
      activateModeBtn(btnModeAll);
    } catch (e) {
      statusEl.textContent = '読み込み失敗: ./members_expenses.json（GitHub Pages 等から配信してください）';
      console.error(e);
    }
  })();

  // レイアウト切替ボタン
  /** アクティブなモードボタンの見た目を更新 */
  function activateModeBtn(active) {
    for (const btn of [btnModeAll, btnModeByMember, btnModeByCategory]) {
      btn.style.background = btn === active ? '#eef4ff' : '#fff';
      btn.style.borderColor = btn === active ? '#88aaff' : '#ddd';
    }
  }
  btnModeAll.addEventListener('click', () => {
    if (chart) chart.setMode('all');
    activateModeBtn(btnModeAll);
    scrollToHeaderAndResetChart();
  });
  btnModeByMember.addEventListener('click', () => {
    if (chart) chart.setMode('member');
    activateModeBtn(btnModeByMember);
    scrollToHeaderAndResetChart();
  });
  btnModeByCategory.addEventListener('click', () => {
    if (chart) chart.setMode('category');
    activateModeBtn(btnModeByCategory);
    scrollToHeaderAndResetChart();
  });

  // モード切替時はヘッダー位置までスクロールし、チャート内スクロールも先頭へ
  function scrollToHeaderAndResetChart() {
    const headerEl = document.querySelector('header');
    if (headerEl) {
      const top = headerEl.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo({ top, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    const root = document.getElementById('bubble-root');
    if (root) root.scrollTop = 0;
  }

  // 本文へスムーススクロール（モバイルの到達性改善）
  function scrollToArticle() {
    const article = document.getElementById('article-content');
    if (!article) return;
    const headerEl = document.querySelector('header');
    const headerH = headerEl ? headerEl.offsetHeight : 58;
    const y = article.getBoundingClientRect().top + window.pageYOffset - headerH;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }
  const jumpBtn = document.getElementById('jump-to-article');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', scrollToArticle);
    const article = document.getElementById('article-content');
    if ('IntersectionObserver' in window && article) {
      const io = new IntersectionObserver((entries) => {
        const e = entries[0];
        const visible = e && e.isIntersecting;
        jumpBtn.style.opacity = visible ? '0' : '1';
        jumpBtn.style.pointerEvents = visible ? 'none' : 'auto';
      }, { threshold: 0.1 });
      io.observe(article);
    }
  }
})();
