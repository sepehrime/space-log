/* graph.js — draws the commit graph as SVG.
 * Columns = time (oldest left), rows = the branch each commit was made on.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const GAP_X = 132, GAP_Y = 88, PAD_L = 132, PAD_T = 96;
  const LANE_COLORS = ['var(--green)', 'var(--cyan)', 'var(--amber)', 'var(--magenta)', 'var(--orange)', 'var(--lime)'];

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function text(parent, x, y, str, attrs = {}) {
    const t = el('text', { x, y, ...attrs }, parent);
    t.textContent = str;
    return t;
  }

  const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function empty(container, title, sub) {
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'graph-empty';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = title;
    const small = document.createElement('div');
    small.textContent = sub;
    box.append(big, small);
    container.appendChild(box);
  }

  function render(container, s) {
    const G = global.GitSim;
    const R = G.findRepo(s);
    if (!R) return empty(container, 'NO REPOSITORY', 'Create a folder, cd into it, and run git init.');
    const repo = R.repo;

    const local = new Set();
    [...Object.values(repo.branches), ...Object.values(repo.tracking)]
      .forEach((t) => G.ancestors(s, t).forEach((c) => local.add(c)));
    const all = new Set(local);
    for (const r of Object.values(repo.remotes)) {
      Object.values(r.branches).forEach((t) => G.ancestors(s, t).forEach((c) => all.add(c)));
    }
    if (!all.size) return empty(container, 'NO COMMITS YET', `On branch ${repo.HEAD}. Stage a file and commit it to draw the first node.`);

    const commits = [...all].map((id) => s.commits[id]).sort((a, b) => a.time - b.time);
    const lanes = [];
    commits.forEach((c) => { if (!lanes.includes(c.lane)) lanes.push(c.lane); });
    lanes.sort((a, b) => (b === 'main') - (a === 'main'));

    const pos = {};
    commits.forEach((c, i) => {
      const lane = lanes.indexOf(c.lane);
      pos[c.id] = { x: PAD_L + i * GAP_X, y: PAD_T + lane * GAP_Y, color: LANE_COLORS[lane % LANE_COLORS.length] };
    });

    // Labels for each commit: HEAD, branches, origin/* and "still only on GitHub" pointers.
    const refs = {};
    const addRef = (id, label, kind) => { if (id && pos[id]) (refs[id] = refs[id] || []).push({ label, kind }); };
    for (const [b, id] of Object.entries(repo.branches)) addRef(id, b === repo.HEAD ? `HEAD → ${b}` : b, b === repo.HEAD ? 'head' : 'branch');
    for (const [t, id] of Object.entries(repo.tracking)) addRef(id, t, 'remote');
    for (const [rn, r] of Object.entries(repo.remotes)) {
      for (const [b, id] of Object.entries(r.branches)) {
        if (repo.tracking[`${rn}/${b}`] !== id) addRef(id, `☁ github/${b}`, 'cloud');
      }
    }

    const W = Math.max(container.clientWidth - 2, PAD_L + (commits.length - 1) * GAP_X + 150);
    const H = Math.max(container.clientHeight - 2, PAD_T + (lanes.length - 1) * GAP_Y + 64);
    container.innerHTML = '';
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'graph-svg', role: 'img', 'aria-label': 'Commit graph' }, container);

    const defs = el('defs', {}, svg);
    const f = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: '3', result: 'b' }, f);
    const m = el('feMerge', {}, f);
    el('feMergeNode', { in: 'b' }, m);
    el('feMergeNode', { in: 'SourceGraphic' }, m);

    // lanes (labels are drawn last, in a layer that sticks to the left edge while scrolling)
    const labelLayer = el('g', { class: 'lane-labels' });
    lanes.forEach((name, i) => {
      const y = PAD_T + i * GAP_Y;
      const color = LANE_COLORS[i % LANE_COLORS.length];
      el('line', { x1: 14, y1: y, x2: W - 14, y2: y, class: 'lane-line', style: `stroke:${color}` }, svg);
      const label = trunc(name, 14);
      el('rect', { x: 8, y: y - 21, width: label.length * 7 + 12, height: 18, class: 'lane-label-bg' }, labelLayer);
      text(labelLayer, 14, y - 8, label, { class: 'lane-label', style: `fill:${color}` });
    });

    // edges (parent → child)
    for (const c of commits) {
      const b = pos[c.id];
      for (const p of c.parents) {
        const a = pos[p];
        if (!a) continue;
        const d = a.y === b.y
          ? `M${a.x},${a.y} L${b.x},${b.y}`
          : `M${a.x},${a.y} C${a.x + GAP_X * 0.6},${a.y} ${b.x - GAP_X * 0.6},${b.y} ${b.x},${b.y}`;
        el('path', {
          d,
          class: `edge${local.has(c.id) ? '' : ' ghost'}`,
          style: `stroke:${a.y === b.y ? b.color : (c.parents.length > 1 && p !== c.parents[0] ? a.color : b.color)}`,
        }, svg);
      }
    }

    // nodes
    const headId = G.headId(repo);
    for (const c of commits) {
      const { x, y, color } = pos[c.id];
      const g = el('g', { class: `node${local.has(c.id) ? '' : ' ghost'}${c.id === headId ? ' is-head' : ''}` }, svg);
      const title = el('title', {}, g);
      title.textContent = `${c.id} · ${c.msg}\nauthor: ${c.author}${c.parents.length > 1 ? `\nmerge of ${c.parents.join(' + ')}` : ''}${local.has(c.id) ? '' : '\n(only on GitHub — git pull to download)'}`;
      if (c.id === headId) el('circle', { cx: x, cy: y, r: 16, class: 'head-ring' }, g);
      if (c.parents.length > 1) el('circle', { cx: x, cy: y, r: 13, class: 'merge-ring', style: `stroke:${color}` }, g);
      el('circle', { cx: x, cy: y, r: 8, class: 'dot', style: `fill:${color};stroke:${color}`, filter: 'url(#glow)' }, g);
      text(g, x, y + 32, c.id, { class: 'node-id', 'text-anchor': 'middle' });
      text(g, x, y + 46, trunc(c.msg, 18), { class: 'node-msg', 'text-anchor': 'middle' });

      (refs[c.id] || []).forEach((r, k) => {
        const w = r.label.length * 7.4 + 14;
        const ty = y - 28 - k * 21;
        el('rect', { x: x - w / 2, y: ty - 12, width: w, height: 17, rx: 2, class: `ref ref-${r.kind}` }, g);
        text(g, x, ty + 1, r.label, { class: `ref-text ref-text-${r.kind}`, 'text-anchor': 'middle' });
      });
    }

    svg.appendChild(labelLayer);
    container.onscroll = () => labelLayer.setAttribute('transform', `translate(${container.scrollLeft},0)`);
    container.scrollLeft = container.scrollWidth;
    container.onscroll();
  }

  global.GitGraph = { render };
})(window);
