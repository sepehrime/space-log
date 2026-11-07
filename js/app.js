/* app.js — connects the simulator, missions and UI. */
(function () {
  'use strict';

  const G = window.GitSim;
  const MISSIONS = window.MISSIONS;
  const STORAGE_KEY = 'space-log-progress';
  const $ = (id) => document.getElementById(id);

  let state = G.createState();
  let undoStack = [];
  let missionIdx = 0;
  let stepIdx = 0;
  let history = [];
  let historyPos = 0;
  let editing = null;
  const progress = loadProgress();

  /* ------------------------------------------------------------ storage */

  function loadProgress() {
    try {
      const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (p && Array.isArray(p.done)) return p;
    } catch (e) { /* storage unavailable */ }
    return { done: [], mission: 0 };
  }

  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------- terminal */

  const out = $('term-out');
  const input = $('cmd');

  function printSegs(segs) {
    const div = document.createElement('div');
    div.className = 'line';
    for (const sg of segs) {
      const span = document.createElement('span');
      if (sg.c) span.className = `c-${sg.c}`;
      span.textContent = sg.t;
      div.appendChild(span);
    }
    out.appendChild(div);
  }
  const print = (t, c = '') => String(t).split('\n').forEach((line) => printSegs([{ t: line, c }]));
  const scrollDown = () => { out.scrollTop = out.scrollHeight; };

  function promptSegs() {
    const p = G.prompt(state);
    return [
      { t: `${p.user} `, c: 'ok' },
      { t: p.dir, c: 'info' },
      { t: p.branch, c: 'warn' },
      { t: ' $ ', c: '' },
    ];
  }

  function renderPrompt() {
    const el = $('prompt');
    el.innerHTML = '';
    promptSegs().forEach((sg, i) => {
      const span = document.createElement('span');
      span.className = `c-${sg.c || 'cmd'}${i === 0 ? ' p-user' : ''}`;
      span.textContent = sg.t;
      el.appendChild(span);
    });
  }

  function setStatus(tag, msg) {
    $('statusbar').dataset.tag = tag;
    $('status-tag').textContent = tag;
    $('status-msg').textContent = msg;
    $('status-msg').title = msg;
  }

  /* --------------------------------------------------------- execution */

  function execute(line) {
    const cmd = line.trim();
    printSegs([...promptSegs(), { t: cmd, c: 'cmd' }]);
    if (!cmd) return scrollDown();
    history.push(cmd);
    historyPos = history.length;

    undoStack.push(structuredClone(state));
    if (undoStack.length > 200) undoStack.shift();

    const res = G.run(state, cmd);
    if (res.clear) out.innerHTML = '';
    res.lines.forEach(printSegs);
    if (res.msg) setStatus(res.tag, res.msg);
    checkProgress({ line: cmd, ok: res.ok });
    render();
    scrollDown();
    if (res.editor) openEditor(res.editor);
  }

  function makeCtx(last) {
    const R = G.findRepo(state);
    return {
      s: state,
      R,
      repo: R ? R.repo : null,
      work: R ? R.work : state.dirs[state.cwd].files,
      st: R ? G.getStatus(state, R.repo, R.work) : null,
      last,
      G,
    };
  }

  function checkProgress(last) {
    const m = MISSIONS[missionIdx];
    if (!m.steps.length || stepIdx >= m.steps.length) return;
    while (stepIdx < m.steps.length) {
      let pass = false;
      try { pass = m.steps[stepIdx].check(makeCtx(last)); } catch (e) { console.error(e); }
      if (!pass) break;
      print(`  ✓ ${m.steps[stepIdx].goal}`, 'mission');
      stepIdx++;
    }
    if (stepIdx === m.steps.length) {
      if (!progress.done.includes(m.code)) progress.done.push(m.code);
      saveProgress();
      print('');
      print(`★ MISSION ${m.code} COMPLETE — ${m.title}`, 'title');
      if (missionIdx < MISSIONS.length - 1) print('  Press ▶ (top right of Mission Control) for the next mission, or keep experimenting here.', 'dim');
      setStatus('MISSION', `Mission ${m.code} complete! ${missionIdx < MISSIONS.length - 1 ? 'Press ▶ to launch the next one.' : ''}`);
    }
  }

  // Missions unlock in order: the furthest you can go is the first mission not yet completed.
  function unlockedUpTo() {
    const first = MISSIONS.findIndex((m) => !progress.done.includes(m.code));
    return first === -1 ? MISSIONS.length - 1 : first;
  }

  function startMission(i) {
    const limit = unlockedUpTo();
    if (i > limit) {
      setStatus('WARN', `Locked. Complete Mission ${MISSIONS[limit].code}: ${MISSIONS[limit].title} first.`);
      return;
    }
    missionIdx = Math.max(0, Math.min(MISSIONS.length - 1, i));
    stepIdx = 0;
    state = G.createState();
    undoStack = [];
    // Replay earlier missions silently so this one starts from where they left off.
    for (let k = 0; k < missionIdx; k++) {
      for (const step of MISSIONS[k].steps) {
        const r = G.run(state, step.cmd);
        if (!r.ok) console.warn(`replay failed: ${step.cmd}`, r.lines);
      }
    }
    progress.mission = missionIdx;
    saveProgress();

    const m = MISSIONS[missionIdx];
    out.innerHTML = '';
    print(`━━━ MISSION ${m.code} · ${m.title.toUpperCase()} ━━━`, 'title');
    print(m.story, 'dim');
    if (missionIdx > 0) print('(previous missions were replayed for you, so the project is ready)', 'dim');
    print("Type 'help' for commands. Stuck? Press [ HINT ] or click a command in the mission panel.", 'dim');
    print('');
    setStatus('MISSION', `Mission ${m.code}: ${m.title}`);
    render();
    input.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ render */

  function render() {
    renderStats();
    renderZones();
    renderMission();
    renderTrack();
    renderPrompt();
    window.GitGraph.render($('graph'), state);
  }

  function renderStats() {
    const R = G.findRepo(state);
    const st = R ? G.getStatus(state, R.repo, R.work) : null;
    $('stat-branch').textContent = R ? R.repo.HEAD : '—';
    $('stat-commits').textContent = R ? G.ancestors(state, G.headId(R.repo)).size : 0;
    $('stat-staged').textContent = st ? st.staged.length : 0;
    $('stat-changes').textContent = st ? st.unstaged.length + st.untracked.length + st.unmerged.length : 0;
    const up = R ? G.upstreamInfo(state, R.repo) : null;
    $('stat-sync').textContent = up ? `↑${up.ahead} ↓${up.behind}` : '—';
    const mode = $('stat-mode');
    mode.textContent = !R ? 'SHELL' : R.repo.merging ? 'MERGING' : 'REPO';
    mode.classList.toggle('merging', !!(R && R.repo.merging));
  }

  function chip(name, cls, badge, opts = {}) {
    const el = document.createElement(opts.onClick ? 'button' : 'div');
    el.className = `chip ${cls}`;
    if (opts.onClick) { el.type = 'button'; el.addEventListener('click', opts.onClick); }
    if (opts.title) el.title = opts.title;
    const i = document.createElement('i');
    i.textContent = badge;
    const span = document.createElement('span');
    span.textContent = name;
    el.append(i, span);
    return el;
  }

  function fillZone(id, chips, emptyText) {
    const zone = $(id);
    zone.innerHTML = '';
    if (!chips.length) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = emptyText;
      zone.appendChild(none);
    } else chips.forEach((c) => zone.appendChild(c));
  }

  function renderZones() {
    const R = G.findRepo(state);
    const dirPath = R ? R.path : state.cwd;
    const work = R ? R.work : state.dirs[state.cwd].files;
    const st = R ? G.getStatus(state, R.repo, R.work) : null;
    const edit = (f) => () => openEditor({ dir: dirPath, file: f });

    const workChips = Object.keys(work).sort().map((f) => {
      let cls = 'clean', badge = '·', tip = 'unchanged since last commit';
      if (!R) { cls = 'untracked'; badge = '?'; tip = 'not in a repository'; }
      else if (st.unmerged.includes(f)) { cls = 'conflict'; badge = '!'; tip = 'CONFLICT: click to resolve'; }
      else if (st.untracked.includes(f)) { cls = 'untracked'; badge = 'U'; tip = 'untracked: Git is not watching this file yet'; }
      else if (st.unstaged.some((x) => x.f === f)) { cls = 'modified'; badge = 'M'; tip = 'modified since it was staged / committed'; }
      return chip(f, cls, badge, { onClick: edit(f), title: `${tip}. Click to edit.` });
    });
    if (st) st.unstaged.filter((x) => x.kind === 'deleted').forEach((x) => workChips.push(chip(x.f, 'deleted', 'D', { title: 'deleted from disk' })));
    fillZone('zone-work', workChips, R ? 'empty folder' : `${G.absPath(state.cwd)} — no files`);

    if (!R) {
      fillZone('zone-stage', [], 'no repository yet');
      fillZone('zone-repo', [], 'no repository yet');
      $('zone-repo-sub').textContent = 'last commit (HEAD)';
      return;
    }

    const stageChips = Object.keys(R.repo.index).sort().map((f) => {
      const s = st.staged.find((x) => x.f === f);
      if (s) return chip(f, 'staged', s.kind === 'new file' ? 'A' : 'M', { title: `staged (${s.kind}): goes into the next commit` });
      return chip(f, 'clean', '·', { title: 'same as last commit' });
    });
    st.staged.filter((x) => x.kind === 'deleted').forEach((x) => stageChips.push(chip(x.f, 'staged', 'D', { title: 'deletion staged' })));
    fillZone('zone-stage', stageChips, 'nothing staged');

    const head = G.headId(R.repo);
    const tree = G.treeOf(state, head);
    $('zone-repo-sub').textContent = head ? `HEAD → ${R.repo.HEAD} @ ${head}` : `${R.repo.HEAD} · no commits yet`;
    fillZone('zone-repo', Object.keys(tree).sort().map((f) => chip(f, 'clean', '■', { title: tree[f] })), 'no commits yet');
  }

  function renderMission() {
    const m = MISSIONS[missionIdx];
    const box = $('mission');
    box.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'mission-head';
    const no = document.createElement('span');
    no.className = 'mission-no';
    no.textContent = `MISSION ${m.code}`;
    const h3 = document.createElement('h3');
    h3.textContent = m.title;
    head.append(no, h3);

    const story = document.createElement('p');
    story.className = 'story';
    story.textContent = m.story;
    box.append(head, story);

    if (m.steps.length) {
      const ol = document.createElement('ol');
      ol.className = 'steps';
      m.steps.forEach((step, i) => {
        const li = document.createElement('li');
        li.className = i < stepIdx ? 'done' : i === stepIdx ? 'current' : 'todo';
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = i < stepIdx ? '✓' : i === stepIdx ? '▶' : String(i + 1).padStart(2, '0');
        const goal = document.createElement('span');
        goal.textContent = step.goal;
        li.append(mark, goal);
        if (i === stepIdx) {
          const why = document.createElement('div');
          why.className = 'why';
          why.textContent = step.why;
          const cmd = document.createElement('button');
          cmd.type = 'button';
          cmd.className = 'cmd';
          cmd.textContent = step.cmd;
          cmd.title = 'Click to type this into the console';
          cmd.addEventListener('click', () => { input.value = step.cmd; input.focus(); });
          li.append(why, cmd);
        }
        ol.appendChild(li);
      });
      box.appendChild(ol);
      if (stepIdx >= m.steps.length) {
        const done = document.createElement('div');
        done.className = 'complete-banner';
        done.textContent = `★ MISSION COMPLETE${missionIdx < MISSIONS.length - 1 ? ' · PRESS ▶ TO CONTINUE' : ''}`;
        box.appendChild(done);
      }
    }

  }

  // Mission Control: the launch-sequence track, the step meter and the objective line.
  function renderTrack() {
    const track = $('track');
    if (!track.children.length) {
      MISSIONS.forEach((m, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'track-node';
        b.title = `Mission ${m.code}: ${m.title}`;
        const dot = document.createElement('span');
        dot.className = 'tn-dot';
        const name = document.createElement('span');
        name.className = 'tn-name';
        name.textContent = m.tab;
        b.append(dot, name);
        b.addEventListener('click', () => startMission(i));
        li.appendChild(b);
        track.appendChild(li);
      });
    }
    const limit = unlockedUpTo();
    [...track.children].forEach((li, i) => {
      // Only count a mission as done if everything before it is done too, so the wire is one continuous run.
      const done = i < limit;
      const locked = i > limit;
      li.className = [i === missionIdx && 'active', done && 'done', locked && 'locked'].filter(Boolean).join(' ');
      const btn = li.firstChild;
      btn.disabled = locked;
      btn.setAttribute('aria-current', i === missionIdx ? 'step' : 'false');
      btn.title = locked
        ? `Locked: complete Mission ${MISSIONS[limit].code} first`
        : `Mission ${MISSIONS[i].code}: ${MISSIONS[i].title}`;
      li.querySelector('.tn-dot').textContent = locked ? '🔒' : done && i !== missionIdx ? '✓' : MISSIONS[i].code;
    });

    // On narrow screens the track scrolls sideways: keep the active mission centred.
    const active = track.children[missionIdx];
    track.scrollLeft = active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2;

    const m = MISSIONS[missionIdx];
    const total = m.steps.length;
    const complete = total > 0 && stepIdx >= total;
    const pad = (n) => String(n).padStart(2, '0');

    $('progress-text').textContent = total ? `${pad(Math.min(stepIdx, total))} / ${pad(total)}` : 'FREE ∞';
    const seg = $('segments');
    seg.innerHTML = '';
    for (let i = 0; i < Math.max(total, 1); i++) {
      const s = document.createElement('i');
      s.className = !total ? 'free' : i < stepIdx ? 'on' : i === stepIdx ? 'now' : '';
      seg.appendChild(s);
    }

    const goal = $('obj-goal');
    goal.textContent = !total ? 'Free play: anything goes. Try branching and merging on your own.'
      : complete ? `★ Mission ${m.code} complete${missionIdx < MISSIONS.length - 1 ? ', press ▶ to launch the next one' : ''}`
      : m.steps[stepIdx].goal;
    goal.title = !total || complete ? '' : m.steps[stepIdx].why;
    goal.classList.toggle('complete', complete);
    $('btn-hint').disabled = !total || complete;

    $('btn-prev').disabled = missionIdx === 0;
    $('btn-next').disabled = missionIdx >= limit;
    $('btn-next').title = missionIdx >= limit && missionIdx < MISSIONS.length - 1
      ? 'Finish this mission to unlock the next one'
      : 'Next mission';
    $('btn-next').classList.toggle('ready', complete && missionIdx < MISSIONS.length - 1);
  }

  /* ------------------------------------------------------------ editor */

  const modal = $('editor');
  const textarea = $('editor-text');

  const hasMarkers = (t) => /^(<{7}|={7}|>{7})/m.test(t);

  function openEditor(target) {
    const dir = state.dirs[target.dir];
    if (!dir) return;
    editing = target;
    $('editor-title').textContent = `EDITOR · ${G.absPath(target.dir)}/${target.file}`;
    textarea.value = dir.files[target.file] || '';
    $('editor-hint').hidden = !hasMarkers(textarea.value);
    modal.hidden = false;
    textarea.focus();
  }

  function closeEditor() {
    modal.hidden = true;
    editing = null;
    input.focus();
  }

  function saveEditor() {
    if (!editing) return;
    let text = textarea.value;
    if (text && !text.endsWith('\n')) text += '\n';
    undoStack.push(structuredClone(state));
    G.writeFile(state, editing.dir, editing.file, text);
    print(`💾 saved ${editing.file}${hasMarkers(text) ? '  (still has conflict markers!)' : ''}`, hasMarkers(text) ? 'warn' : 'dim');
    setStatus(hasMarkers(text) ? 'WARN' : 'OK', hasMarkers(text)
      ? `${editing.file} still contains conflict markers.`
      : `Saved ${editing.file}. Run git status to see how Git sees it.`);
    closeEditor();
    checkProgress({ line: '(editor save)', ok: true });
    render();
    scrollDown();
  }

  textarea.addEventListener('input', () => { $('editor-hint').hidden = !hasMarkers(textarea.value); });
  $('editor-save').addEventListener('click', saveEditor);
  $('editor-cancel').addEventListener('click', closeEditor);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeEditor(); });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); }
  });

  /* ---------------------------------------------------------- controls */

  $('term-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    execute(v);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      if (!history.length) return;
      e.preventDefault();
      historyPos = Math.max(0, historyPos - 1);
      input.value = history[historyPos];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyPos = Math.min(history.length, historyPos + 1);
      input.value = history[historyPos] || '';
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      out.innerHTML = '';
    }
  });

  $('terminal').addEventListener('click', () => { if (!window.getSelection().toString()) input.focus(); });

  // RUN is the form's submit button, so Enter and clicking share the submit handler above.
  document.querySelectorAll('.quick').forEach((b) => {
    b.addEventListener('click', () => { execute(b.dataset.cmd); input.focus(); });
  });
  $('btn-clr').addEventListener('click', () => { out.innerHTML = ''; input.focus(); });

  $('btn-hint').addEventListener('click', () => {
    const step = MISSIONS[missionIdx].steps[stepIdx];
    if (!step) {
      setStatus('INFO', MISSIONS[missionIdx].steps.length ? 'Mission done. Press ▶ for the next one.' : 'Sandbox: anything goes. Try git log --oneline --all.');
      return;
    }
    input.value = step.cmd;
    input.focus();
    const form = $('term-form');
    form.classList.remove('flash');
    void form.offsetWidth; // restart the animation
    form.classList.add('flash');
    setStatus('MISSION', `Hint: ${step.why}`);
  });

  $('btn-undo').addEventListener('click', () => {
    if (!undoStack.length) return setStatus('UNDO', 'Nothing to undo.');
    state = undoStack.pop();
    print('↶ undo: state restored to before the last command', 'dim');
    setStatus('UNDO', 'Rewound one command. (Mission checkmarks stay.)');
    render();
    scrollDown();
    input.focus();
  });

  $('btn-reset').addEventListener('click', () => startMission(missionIdx));
  $('btn-prev').addEventListener('click', () => startMission(missionIdx - 1));
  $('btn-next').addEventListener('click', () => startMission(missionIdx + 1));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => window.GitGraph.render($('graph'), state), 120);
  });

  /* ---------------------------------------------------------- briefing */

  const briefing = $('briefing');

  function openBriefing() {
    briefing.hidden = false;
    $('briefing-go').focus();
  }

  function closeBriefing() {
    briefing.hidden = true;
    if (!progress.seenBriefing) { progress.seenBriefing = true; saveProgress(); }
    input.focus({ preventScroll: true });
  }

  $('btn-briefing').addEventListener('click', openBriefing);
  $('briefing-x').addEventListener('click', closeBriefing);
  $('briefing-go').addEventListener('click', closeBriefing);
  briefing.addEventListener('click', (e) => { if (e.target === briefing) closeBriefing(); });
  briefing.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBriefing(); });

  // A saved position past the unlocked range (e.g. from before missions were locked) falls back to the frontier.
  startMission(Math.min(progress.mission || 0, unlockedUpTo()));
  // First-time visitors get the story before anything else.
  if (!progress.seenBriefing) openBriefing();
})();
