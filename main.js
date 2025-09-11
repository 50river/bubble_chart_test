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
    let width = rootEl.clientWidth || 960;
    let height = rootEl.clientHeight || 600;

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

    // ユーティリティ: 通貨表示
    const fmtYen = (v) => `¥${d3.format(',')(Math.round(v))}`;

    // Jenks natural breaks（k分類）
    // 参考: 動的計画法による分割（小さめの実装）
    function jenksBreaks(values, k) {
      const vals = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
      const n = vals.length;
      if (n === 0) return [];
      const unique = Array.from(new Set(vals));
      if (unique.length <= k) return unique;
      // DP テーブル
      const mat1 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
      const mat2 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
      for (let i = 1; i <= k; i++) {
        mat1[1][i] = 1;
        mat2[1][i] = 0;
        for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
      }
      let s1 = 0, s2 = 0, w = 0;
      for (let l = 2; l <= n; l++) {
        s1 = 0; s2 = 0; w = 0;
        for (let m = 1; m <= l; m++) {
          const i3 = l - m + 1;
          const val = vals[i3 - 1];
          s2 += val * val; s1 += val; w += 1;
          const v = s2 - (s1 * s1) / w; // クラス内分散
          if (i3 === 1) continue;
          for (let j = 2; j <= k; j++) {
            if (mat2[l][j] >= v + mat2[i3 - 1][j - 1]) {
              mat1[l][j] = i3;
              mat2[l][j] = v + mat2[i3 - 1][j - 1];
            }
          }
        }
        mat1[l][1] = 1;
        mat2[l][1] = s2 - (s1 * s1) / w;
      }
      const breaks = Array(k + 1).fill(0);
      breaks[k] = vals[n - 1];
      breaks[0] = vals[0];
      let kclass = k;
      let idx = n;
      while (kclass > 1) {
        const id = mat1[idx][kclass] - 1;
        breaks[kclass - 1] = vals[id];
        idx = mat1[idx][kclass] - 1;
        kclass--;
      }
      return breaks;
    }

    // 判例（カテゴリ＋サイズ）。サイズは Jenks の3分割を表示し、スケールは常に全体表示のスケールを継承
    function drawLegend() {
      const items = categories.map((c) => ({ key: c, label: c, color: color(c) }));
      // 全データの値から Jenks 3 クラスを計算
      const valuesAll = nodesData.map((d) => d.value).filter((v) => Number.isFinite(v) && v > 0);
      let breaks = [];
      if (valuesAll.length >= 3) {
        breaks = jenksBreaks(valuesAll, 3); // [min, b1, b2, max]
      } else {
        // フォールバック: 分位点
        breaks = [d3.min(valuesAll) || 1, d3.quantileSorted(valuesAll.slice().sort(d3.ascending), 1 / 3) || 1, d3.quantileSorted(valuesAll.slice().sort(d3.ascending), 2 / 3) || 1, d3.max(valuesAll) || 1];
      }
      const reps = [breaks[1], breaks[2], breaks[3]]; // 各クラスの上限値を代表に

      // 全体表示のスケール（globalRadiusK）があればそれに従って表示、なければ r を暫定利用
      const legendRadius = (val) => bubbleRadius(val);
      const sizeLegend = `
        <span class="legend-item">
          <strong>サイズ:</strong>
          ${reps
            .map((v) => {
              const rr = legendRadius(v);
              return `<span class=\"size-bubble\" style=\"width:${2 * rr}px;height:${2 * rr}px;\"></span><span class=\"size-label\">${fmtYen(v)}</span>`;
            })
            .join('')}
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
    // 全体表示（pack）から導出した半径スケール係数を全モードで共有
    // r_global = globalRadiusK * sqrt(value)
    let globalRadiusK = null;

    // 共通の半径関数（全体表示スケールを優先）
    const bubbleRadius = (val) => {
      if (globalRadiusK) return Math.max(2, globalRadiusK * Math.sqrt(val));
      return Math.max(2, r(val));
    };

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
      .attr('r', (d) => bubbleRadius(d.value))
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
    // グローバル（全体/力学）用の最小余白
    const COLLIDE_PAD = 0.8;
    // グループ内での最小余白（見た目上の微小クリアランス）
    const INNER_PAD = 0.35;
    const sim = d3
      .forceSimulation(nodes)
      .force('x', d3.forceX())
      .force('y', d3.forceY())
      // 非重なりギリギリまで詰める（反復回数を増やす）
      .force('collide', d3.forceCollide().radius((d) => bubbleRadius(d.value) + COLLIDE_PAD).strength(1).iterations(6))
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
      const rMax = d3.max(nodes, (d) => bubbleRadius(d.value)) || 20;
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
      const rMax = d3.max(nodes, (d) => bubbleRadius(d.value)) || 20;
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
    
    // クラスタ内で重ならないように円を貪欲配置し、目標座標を返す
    function packGroupGreedy(items, center, bounds) {
      const sorted = items
        .map((d) => ({ id: d.id, r: bubbleRadius(d.value) }))
        .sort((a, b) => b.r - a.r);
      const placed = [];
      const res = new Map();
      const golden = 2.399963229728653; // 黄金角
      for (const it of sorted) {
        const ri = it.r;
        let okPlaced = false;
        let k = 0;
        const maxIter = Math.max(3500, 500 + 80 * sorted.length); // 円数に応じて探索回数を増やす
        const step = Math.max(2, ri * 0.7); // 探索ステップを少し広げる
        while (k < maxIter && !okPlaced) {
          const a = k * golden;
          const rad = 0.6 * step * Math.sqrt(k);
          let x = center.cx + rad * Math.cos(a);
          let y = center.cy + rad * Math.sin(a);
          x = Math.max(bounds.x0 + ri, Math.min(bounds.x1 - ri, x));
          y = Math.max(bounds.y0 + ri, Math.min(bounds.y1 - ri, y));
          let ok = true;
          for (const p of placed) {
            const dx = x - p.x;
            const dy = y - p.y;
            if (dx * dx + dy * dy < Math.pow(ri + p.r + COLLIDE_PAD, 2)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            placed.push({ x, y, r: ri });
            res.set(it.id, { x, y });
            okPlaced = true;
          }
          k++;
        }
        if (!okPlaced) {
          // ランダムサンプリングで最終探索（矩形内一様）
          let tries = 0;
          const maxTries = Math.max(2000, 300 + 50 * sorted.length);
          while (tries < maxTries && !okPlaced) {
            let x = bounds.x0 + ri + Math.random() * Math.max(0, bounds.x1 - bounds.x0 - 2 * ri);
            let y = bounds.y0 + ri + Math.random() * Math.max(0, bounds.y1 - bounds.y0 - 2 * ri);
            let ok = true;
            for (const p of placed) {
              const dx = x - p.x;
              const dy = y - p.y;
              if (dx * dx + dy * dy < Math.pow(ri + p.r + COLLIDE_PAD, 2)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              placed.push({ x, y, r: ri });
              res.set(it.id, { x, y });
              okPlaced = true;
              break;
            }
            tries++;
          }
        }
        if (!okPlaced) {
          // まだだめなら、最も近い円から反対方向に押し出して配置
          let x = center.cx, y = center.cy;
          if (placed.length) {
            let nearest = placed[0];
            let bestD = Infinity;
            for (const p of placed) {
              const dx = center.cx - p.x;
              const dy = center.cy - p.y;
              const dd = dx * dx + dy * dy;
              if (dd < bestD) {
                bestD = dd;
                nearest = p;
              }
            }
            const ang = Math.atan2(center.cy - nearest.y, center.cx - nearest.x);
            x = nearest.x + (nearest.r + ri + COLLIDE_PAD) * Math.cos(ang);
            y = nearest.y + (nearest.r + ri + COLLIDE_PAD) * Math.sin(ang);
          }
          x = Math.max(bounds.x0 + ri, Math.min(bounds.x1 - ri, x));
          y = Math.max(bounds.y0 + ri, Math.min(bounds.y1 - ri, y));
          placed.push({ x, y, r: ri });
          res.set(it.id, { x, y });
        }
      }
      return res;
    }

    // クラスタ内の配置から、衝突を解消するように少しだけ押し広げる
    // items: ノード配列、posMap: Map(id => {x,y})
    function relaxNoOverlap(items, posMap, bounds, iter = 18, pad = COLLIDE_PAD) {
      if (!items.length) return posMap;
      const ids = items.map((d) => d.id);
      const radii = new Map(items.map((d) => [d.id, bubbleRadius(d.value)]));
      for (let t = 0; t < iter; t++) {
        let moved = false;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const idA = ids[i];
            const idB = ids[j];
            const pa = posMap.get(idA);
            const pb = posMap.get(idB);
            if (!pa || !pb) continue;
            const ra = radii.get(idA) || 0;
            const rb = radii.get(idB) || 0;
            let dx = pb.x - pa.x;
            let dy = pb.y - pa.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
            const minD = ra + rb + pad;
            if (dist < minD) {
              const push = (minD - dist) * 0.52; // 少し余裕をもって押し広げる
              dx /= dist; dy /= dist;
              pa.x -= dx * push * 0.5; pa.y -= dy * push * 0.5;
              pb.x += dx * push * 0.5; pb.y += dy * push * 0.5;
              moved = true;
            }
          }
        }
        // 枠外に出ないようクランプ
        for (const id of ids) {
          const p = posMap.get(id);
          const r = radii.get(id) || 0;
          p.x = Math.max(bounds.x0 + r, Math.min(bounds.x1 - r, p.x));
          p.y = Math.max(bounds.y0 + r, Math.min(bounds.y1 - r, p.y));
        }
        if (!moved) break;
      }
      return posMap;
    }

    // 与えられた半径でグループ内を最密に近く詰める（d3.packSiblings）
    // 返り値: { pos: Map(id=>{x,y}), bbox: {x0,y0,x1,y1}, size: number }
    function packGroupTight(items) {
      if (!items.length) return { pos: new Map(), bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, size: 0 };
      const circles = items.map((d) => ({ id: d.id, r: bubbleRadius(d.value) + INNER_PAD }));
      // d3.packSiblings は circles に x, y を与える
      d3.packSiblings(circles);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of circles) {
        x0 = Math.min(x0, c.x - c.r);
        y0 = Math.min(y0, c.y - c.r);
        x1 = Math.max(x1, c.x + c.r);
        y1 = Math.max(y1, c.y + c.r);
      }
      const pos = new Map(circles.map((c) => [c.id, { x: c.x, y: c.y, r: c.r }]));
      return { pos, bbox: { x0, y0, x1, y1 }, size: Math.max(x1 - x0, y1 - y0) };
    }

    // モード切替（'all'|'member'|'category'）
    function setMode(mode) {
      currentMode = mode;
      let centers;
      if (mode === 'member') {
        allLayout = null; // 詰め込み無効（座標のみ）
        // セルにバブルが収まるよう必要最低サイズを推定（面積ベース）
        // メンバーごとに実際の最密に近いパッキングで必要サイズを算出
        const members = Array.from(new Set(nodes.map((d) => d.memberName)));
        const packedByMember = new Map(
          members.map((mname) => {
            const groupNodes = nodes.filter((n) => n.memberName === mname);
            const res = packGroupTight(groupNodes);
            // セル内でのクリアランス確保のため、わずかに外側余白を足す
            const need = res.size + 2;
            return [mname, { ...res, need }];
          })
        );
        const minCellMember = Math.max(...Array.from(packedByMember.values()).map((v) => v.need).concat([0]));
        const grid = layoutGrid(members, 2, { minCell: minCellMember });
        centers = grid.centers;
        // シミュレーションは止め、静的目標座標へスムーズ遷移（全体モードと同じ挙動）
        sim.alpha(0).stop();
        updateGroupLabels(centers, (k) => k);
        const target = new Map();
        for (const mname of members) {
          const c = centers.get(mname);
          const b = {
            x0: c.cx - grid.cellW / 2,
            y0: c.cy - grid.cellH / 2,
            x1: c.cx + grid.cellW / 2,
            y1: c.cy + grid.cellH / 2,
          };
          const packRes = packedByMember.get(mname);
          const pos = new Map();
          const cx0 = (packRes.bbox.x0 + packRes.bbox.x1) / 2;
          const cy0 = (packRes.bbox.y0 + packRes.bbox.y1) / 2;
          packRes.pos.forEach((p, id) => {
            // d3.packSiblingsの座標をセル中心へ平行移動
            const x = c.cx + (p.x - cx0);
            const y = c.cy + (p.y - cy0);
            pos.set(id, { x, y });
          });
          // 仕上げの微調整（内側小パディングで）
          const groupNodes = nodes.filter((n) => n.memberName === mname);
          const relaxed = relaxNoOverlap(groupNodes, pos, b, 14, INNER_PAD);
          relaxed.forEach((p, id) => target.set(id, p));
        }
        nodeSel
          .transition()
          .duration(1400)
          .ease(d3.easeCubicInOut)
          .attr('cx', (d) => target.get(d.id)?.x ?? d.x)
          .attr('cy', (d) => target.get(d.id)?.y ?? d.y)
          .attr('r', (d) => bubbleRadius(d.value));
        nodes.forEach((n) => {
          const p = target.get(n.id);
          if (p) {
            n.x = p.x;
            n.y = p.y;
          }
        });
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
        allLayout = null; // 詰め込み無効（座標のみ）
        // セルにバブルが収まるよう必要最低サイズを推定（面積ベース）
        // カテゴリごとも実パッキングで必要サイズを算出
        const packedByCat = new Map(
          categories.map((cat) => {
            const groupNodes = nodes.filter((n) => n.category === cat);
            const res = packGroupTight(groupNodes);
            const need = res.size + 2;
            return [cat, { ...res, need }];
          })
        );
        const minCellCat = Math.max(...Array.from(packedByCat.values()).map((v) => v.need).concat([0]));
        const gridC = layoutGrid(categories, 2, { minCell: minCellCat });
        centers = gridC.centers;
        // シミュレーション停止し、静的目標座標へトランジション
        sim.alpha(0).stop();
        updateGroupLabels(centers, (k) => k);
        const targetC = new Map();
        for (const cat of categories) {
          const c = centers.get(cat);
          const b = {
            x0: c.cx - gridC.cellW / 2,
            y0: c.cy - gridC.cellH / 2,
            x1: c.cx + gridC.cellW / 2,
            y1: c.cy + gridC.cellH / 2,
          };
          const packRes = packedByCat.get(cat);
          const pos = new Map();
          const cx0 = (packRes.bbox.x0 + packRes.bbox.x1) / 2;
          const cy0 = (packRes.bbox.y0 + packRes.bbox.y1) / 2;
          packRes.pos.forEach((p, id) => {
            const x = c.cx + (p.x - cx0);
            const y = c.cy + (p.y - cy0);
            pos.set(id, { x, y });
          });
          const groupNodes = nodes.filter((n) => n.category === cat);
          const relaxed = relaxNoOverlap(groupNodes, pos, b, 14, INNER_PAD);
          relaxed.forEach((p, id) => targetC.set(id, p));
        }
        nodeSel
          .transition()
          .duration(1400)
          .ease(d3.easeCubicInOut)
          .attr('cx', (d) => targetC.get(d.id)?.x ?? d.x)
          .attr('cy', (d) => targetC.get(d.id)?.y ?? d.y)
          .attr('r', (d) => bubbleRadius(d.value));
        nodes.forEach((n) => {
          const p = targetC.get(n.id);
          if (p) {
            n.x = p.x;
            n.y = p.y;
          }
        });
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
        const packed = d3.pack().size([innerW, innerH]).padding(COLLIDE_PAD)(h);
        const leaves = packed.leaves();
        // pack の半径は sqrt(value) に比例するため、係数を推定して凡例に反映
        const ks = leaves
          .filter((l) => l.data.value > 0)
          .map((l) => l.r / Math.sqrt(l.data.value));
        globalRadiusK = ks.length ? d3.median(ks) : null;
        allLayout = new Map(leaves.map((l) => [l.data.id, { x: l.x, y: l.y, r: l.r }]));
        // ラベルは無し
        updateGroupLabels(new Map(), () => '');
        // 座標・半径をスムーズに遷移（はみ出し防止）
        nodeSel
          .transition()
          .duration(1400)
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
        // SVGは表示領域サイズに戻す（スクロールコンテナにフィット）
        svg.attr('viewBox', [0, 0, width, height]).attr('height', '100%');
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
      height = rootEl.clientHeight || height;
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
})();
