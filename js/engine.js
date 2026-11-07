/* engine.js — a tiny in-memory zsh + Git simulator.
 *
 * Nothing touches your real disk or network. The whole "computer" is one plain
 * object (see createState), which makes undo as simple as cloning it.
 */
(function (global) {
  'use strict';

  const HOME = '~';
  const HOME_ABS = '/Users/commander';
  const USER = 'commander';

  class CmdError extends Error {
    constructor(lines, tag = 'ERR') {
      const arr = Array.isArray(lines) ? lines : [lines];
      super(arr[0]);
      this.lines = arr;
      this.tag = tag;
    }
  }

  /* ------------------------------------------------------------------ state */

  function createState() {
    return {
      cwd: HOME,
      dirs: { [HOME]: { files: {}, repo: null } },
      config: {},     // git config --global
      commits: {},    // object store shared by the local repo and "GitHub"
      clock: 0,       // logical time, orders commits
      prCount: 0,
    };
  }

  function newRepo() {
    return {
      HEAD: 'main',   // name of the checked-out branch
      branches: {},   // name -> commit id
      index: {},      // staging area: file -> content
      merging: null,  // { theirs, name, unmerged: [] } while a merge is paused
      remotes: {},    // name -> { url, branches: {} }  ← the simulated GitHub
      tracking: {},   // 'origin/main' -> commit id (what we last saw on GitHub)
      upstream: {},   // local branch -> { remote, branch }
    };
  }

  /* ------------------------------------------------------------------ paths */

  function normalize(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (out.length > 1) out.pop(); continue; }
      out.push(part);
    }
    return out.join('/') || HOME;
  }

  function resolvePath(cwd, name) {
    if (!name || name === '~') return HOME;
    if (name.startsWith(HOME_ABS)) name = HOME + name.slice(HOME_ABS.length);
    if (name.startsWith('/')) throw new CmdError(`cd: permission denied: ${name} (this simulator lives inside ${HOME_ABS})`);
    return normalize(name.startsWith('~') ? name : `${cwd}/${name}`);
  }

  const absPath = (p) => p.replace(/^~/, HOME_ABS);
  const parentOf = (p) => (p === HOME ? null : p.slice(0, p.lastIndexOf('/')));
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  function checkFileName(name) {
    if (!name) throw new CmdError('missing file name');
    if (name.includes('/')) throw new CmdError(`${name}: this simulator only supports files in the current folder`);
    return name;
  }

  function findRepo(s) {
    for (let p = s.cwd; p; p = parentOf(p)) {
      const d = s.dirs[p];
      if (d && d.repo) return { path: p, dir: d, repo: d.repo, get work() { return d.files; } };
    }
    return null;
  }

  function needRepo(s) {
    const R = findRepo(s);
    if (!R) throw new CmdError('fatal: not a git repository (or any of the parent directories): .git');
    return R;
  }

  /* --------------------------------------------------------------- helpers */

  const keysOf = (...objs) => [...new Set(objs.flatMap((o) => Object.keys(o)))].sort();
  const headId = (repo) => repo.branches[repo.HEAD] || null;
  const treeOf = (s, id) => (id ? s.commits[id].tree : {});
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('ch') ? 'es' : 's'}`;

  function sameTree(a, b) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
  }

  function changedFiles(a, b) {
    return keysOf(a, b).filter((f) => a[f] !== b[f]);
  }

  function ancestors(s, id) {
    const seen = new Set();
    const stack = id ? [id] : [];
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c) || !s.commits[c]) continue;
      seen.add(c);
      stack.push(...s.commits[c].parents);
    }
    return seen;
  }

  const isAncestor = (s, a, b) => !!a && !!b && ancestors(s, b).has(a);

  function mergeBase(s, a, b) {
    const A = ancestors(s, a);
    let best = null;
    for (const c of ancestors(s, b)) {
      if (A.has(c) && (!best || s.commits[c].time > s.commits[best].time)) best = c;
    }
    return best;
  }

  function newId(s, seed) {
    let h = 2166136261;
    const str = `${seed}|${s.clock}|${Object.keys(s.commits).length}`;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    let id = (h >>> 0).toString(16).padStart(8, '0').slice(0, 7);
    while (s.commits[id]) id = ((parseInt(id, 16) + 1) % 0xfffffff).toString(16).padStart(7, '0');
    return id;
  }

  function createCommit(s, { tree, parents, msg, lane, author }) {
    s.clock++;
    const id = newId(s, msg);
    s.commits[id] = {
      id, msg, parents, lane, time: s.clock,
      tree: { ...tree },
      author: author || s.config['user.name'] || USER,
      email: s.config['user.email'] || '',
    };
    return id;
  }

  function getStatus(s, repo, work) {
    const head = treeOf(s, headId(repo));
    const idx = repo.index;
    const unmerged = repo.merging ? repo.merging.unmerged.slice() : [];
    const staged = [], unstaged = [], untracked = [];
    for (const f of keysOf(head, idx)) {
      if (unmerged.includes(f)) continue;
      if (!(f in head)) staged.push({ f, kind: 'new file' });
      else if (!(f in idx)) staged.push({ f, kind: 'deleted' });
      else if (head[f] !== idx[f]) staged.push({ f, kind: 'modified' });
    }
    for (const f of keysOf(idx, work)) {
      if (unmerged.includes(f)) continue;
      if (!(f in idx)) untracked.push(f);
      else if (!(f in work)) unstaged.push({ f, kind: 'deleted' });
      else if (idx[f] !== work[f]) unstaged.push({ f, kind: 'modified' });
    }
    return { staged, unstaged, untracked, unmerged };
  }

  function countOnly(s, a, b) {
    const B = ancestors(s, b);
    return [...ancestors(s, a)].filter((c) => !B.has(c)).length;
  }

  function upstreamInfo(s, repo) {
    const u = repo.upstream[repo.HEAD];
    if (!u) return null;
    const name = `${u.remote}/${u.branch}`;
    const trk = repo.tracking[name];
    const local = headId(repo);
    if (!trk || !local) return null;
    return { name, ahead: countOnly(s, local, trk), behind: countOnly(s, trk, local) };
  }

  const splitLines = (t) => (t === undefined || t === '' ? [] : t.replace(/\n$/, '').split('\n'));

  // Line diff via longest-common-subsequence. Files here are tiny, so O(n·m) is fine.
  function diffLines(a, b) {
    const A = splitLines(a), B = splitLines(b);
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
    return ops;
  }

  function printStat(io, from, to) {
    for (const f of changedFiles(from, to)) {
      const ops = diffLines(from[f], to[f]);
      const add = ops.filter((o) => o[0] === '+').length;
      const del = ops.filter((o) => o[0] === '-').length;
      io.seg([` ${f} | ${add + del} `, { t: '+'.repeat(add), c: 'ok' }, { t: '-'.repeat(del), c: 'err' }]);
    }
  }

  function threeWay(base, ours, theirs, label) {
    const tree = {}, conflicts = [];
    for (const f of keysOf(base, ours, theirs)) {
      const r = global.GitMerge.mergeFile(base[f], ours[f], theirs[f], label);
      if (r.conflict) conflicts.push(f);
      if (r.content !== undefined) tree[f] = r.content;
    }
    return { tree, conflicts };
  }

  /* -------------------------------------------------------------- tokenizer */

  function tokenize(line) {
    const tokens = [];
    let cur = '', quote = null, has = false;
    const flush = () => { if (has || cur) tokens.push(cur); cur = ''; has = false; };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === quote) quote = null; else cur += c; continue; }
      if (c === '"' || c === "'") { quote = c; has = true; continue; }
      if (c === ' ' || c === '\t') { flush(); continue; }
      if (c === '>') {
        flush();
        if (line[i + 1] === '>') { tokens.push({ op: '>>' }); i++; } else tokens.push({ op: '>' });
        continue;
      }
      cur += c;
    }
    if (quote) throw new CmdError(`zsh: unmatched ${quote}`);
    flush();
    return tokens;
  }

  /* -------------------------------------------------------- branch movement */

  function moveHead(s, R, name) {
    const { repo } = R;
    if (repo.merging) throw new CmdError(['error: you need to resolve your current index first', 'hint: finish the merge (git add + git commit) or run git merge --abort']);
    const work = R.work;
    const cur = treeOf(s, headId(repo));
    const tgt = treeOf(s, repo.branches[name]);
    const st = getStatus(s, repo, work);
    const changed = [...new Set([...st.staged.map((x) => x.f), ...st.unstaged.map((x) => x.f)])];
    const blocked = changed.filter((f) => cur[f] !== tgt[f]);
    if (blocked.length) {
      throw new CmdError([
        'error: Your local changes to the following files would be overwritten by checkout:',
        ...blocked.map((f) => `\t${f}`),
        'Please commit your changes or stash them before you switch branches.',
        'Aborting',
      ]);
    }
    const clobbered = st.untracked.filter((f) => f in tgt && tgt[f] !== work[f]);
    if (clobbered.length) {
      throw new CmdError([
        'error: The following untracked working tree files would be overwritten by checkout:',
        ...clobbered.map((f) => `\t${f}`),
        'Please move or remove them before you switch branches.',
        'Aborting',
      ]);
    }
    const index = { ...tgt }, files = { ...tgt };
    for (const f of changed) {
      if (f in repo.index) index[f] = repo.index[f]; else delete index[f];
      if (f in work) files[f] = work[f]; else delete files[f];
    }
    for (const f of st.untracked) files[f] = work[f];
    repo.index = index;
    R.dir.files = files;
    repo.HEAD = name;
  }

  function mergeInto(s, R, io, targetId, name) {
    const { repo } = R;
    if (repo.merging) throw new CmdError(['error: Merging is not possible because you have unmerged files.', 'hint: finish the current merge first (git add + git commit)']);
    const st = getStatus(s, repo, R.work);
    if (st.staged.length || st.unstaged.length) {
      throw new CmdError([
        'error: Your local changes to the following files would be overwritten by merge:',
        ...[...st.staged, ...st.unstaged].map((x) => `\t${x.f}`),
        'Please commit your changes or stash them before you merge.',
        'Aborting',
      ]);
    }
    const untracked = Object.fromEntries(st.untracked.map((f) => [f, R.work[f]]));
    const head = headId(repo);

    if (head && isAncestor(s, targetId, head)) {
      io.out('Already up to date.');
      return io.done('INFO', `${repo.HEAD} already contains everything in ${name}.`);
    }

    if (!head || isAncestor(s, head, targetId)) {
      const from = treeOf(s, head), to = treeOf(s, targetId);
      io.out(`Updating ${head || '0000000'}..${targetId}`);
      io.out('Fast-forward');
      printStat(io, from, to);
      repo.branches[repo.HEAD] = targetId;
      repo.index = { ...to };
      R.dir.files = { ...to, ...untracked };
      return io.done('OK', `Fast-forward: ${repo.HEAD} simply slid forward to ${targetId}. No merge commit needed.`);
    }

    const base = mergeBase(s, head, targetId);
    const ours = treeOf(s, head), theirs = treeOf(s, targetId);
    const { tree, conflicts } = threeWay(treeOf(s, base), ours, theirs, name);
    for (const f of changedFiles(ours, tree)) {
      if (!conflicts.includes(f)) io.out(`Auto-merging ${f}`);
    }

    if (!conflicts.length) {
      repo.index = { ...tree };
      R.dir.files = { ...tree, ...untracked };
      const msg = `Merge branch '${name}'`;
      const id = createCommit(s, { tree, parents: [head, targetId], msg, lane: repo.HEAD });
      repo.branches[repo.HEAD] = id;
      io.out("Merge made by the 'ort' strategy.");
      printStat(io, ours, tree);
      return io.done('OK', `Merged ${name} into ${repo.HEAD} with merge commit ${id}.`);
    }

    const index = { ...tree };
    for (const f of conflicts) {
      io.out(`Auto-merging ${f}`);
      io.out(`CONFLICT (content): Merge conflict in ${f}`, 'err');
      if (f in ours) index[f] = ours[f]; else delete index[f];
    }
    io.out('Automatic merge failed; fix conflicts and then commit the result.', 'err');
    repo.index = index;
    R.dir.files = { ...tree, ...untracked };
    repo.merging = { theirs: targetId, name, unmerged: conflicts.slice() };
    io.done('CONFLICT', `Both branches changed ${conflicts.join(', ')}. Edit the file, remove the markers, then git add + git commit.`);
    io.fail();
  }

  function decorations(s, repo) {
    const map = {};
    const add = (id, seg) => { if (id) (map[id] = map[id] || []).push(seg); };
    for (const [b, id] of Object.entries(repo.branches)) {
      if (b === repo.HEAD) add(id, [{ t: 'HEAD -> ', c: 'info' }, { t: b, c: 'ok' }]);
    }
    for (const [b, id] of Object.entries(repo.branches)) if (b !== repo.HEAD) add(id, [{ t: b, c: 'ok' }]);
    for (const [t, id] of Object.entries(repo.tracking)) add(id, [{ t, c: 'err' }]);
    return map;
  }

  function getRemote(repo, name) {
    const r = repo.remotes[name];
    if (!r) {
      throw new CmdError([
        `fatal: '${name}' does not appear to be a git repository`,
        'fatal: Could not read from remote repository.',
        `hint: connect one first: git remote add ${name} https://github.com/${USER}/space-log.git`,
      ]);
    }
    return r;
  }

  function authLines(s, io) {
    const helper = s.config['credential.helper'];
    if (helper) {
      io.out(`🔑 Token loaded from ${helper === 'osxkeychain' ? 'macOS Keychain' : helper} (simulated)`, 'dim');
    } else {
      io.out(`Username for 'https://github.com': ${USER}`, 'dim');
      io.out(`Password for 'https://${USER}@github.com': ••••••••  ← paste your Personal Access Token`, 'dim');
      io.out('hint: git config --global credential.helper osxkeychain remembers it for you', 'warn');
    }
  }

  /* ------------------------------------------------------------------- git */

  const GIT = {
    init(s, args, io) {
      const d = s.dirs[s.cwd];
      if (d.repo) {
        io.out(`Reinitialized existing Git repository in ${absPath(s.cwd)}/.git/`);
        return io.done('INFO', 'This folder is already a repository.');
      }
      d.repo = newRepo();
      io.out(`Initialized empty Git repository in ${absPath(s.cwd)}/.git/`, 'ok');
      io.done('OK', 'A hidden .git folder now tracks everything in this directory.');
    },

    config(s, args, io) {
      const a = args.filter((x) => x !== '--global' && x !== '--local');
      if (a[0] === '--list' || a[0] === '-l') {
        Object.entries(s.config).forEach(([k, v]) => io.out(`${k}=${v}`));
        return io.done('INFO', `${plural(Object.keys(s.config).length, 'setting')}.`);
      }
      if (a[0] === '--unset') {
        delete s.config[a[1]];
        return io.done('OK', `Removed ${a[1]}.`);
      }
      const key = a[0];
      if (!key) throw new CmdError('usage: git config [--global] <key> [<value>]');
      if (!/^[a-z]+\.[\w.-]+$/i.test(key)) throw new CmdError(`error: key does not contain a section: ${key}`);
      if (a.length === 1) {
        if (key in s.config) { io.out(s.config[key]); return io.done('INFO', `${key} = ${s.config[key]}`); }
        io.fail();
        return io.done('INFO', `${key} is not set.`);
      }
      s.config[key] = a.slice(1).join(' ');
      io.done('OK', `Saved ${key} = ${s.config[key]}`);
    },

    status(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const st = getStatus(s, repo, R.work);
      const pad = (k) => `${k}:`.padEnd(12);
      io.out(`On branch ${repo.HEAD}`);
      const up = upstreamInfo(s, repo);
      if (up) {
        if (!up.ahead && !up.behind) io.out(`Your branch is up to date with '${up.name}'.`);
        else if (up.ahead && !up.behind) {
          io.out(`Your branch is ahead of '${up.name}' by ${plural(up.ahead, 'commit')}.`);
          io.out('  (use "git push" to publish your local commits)', 'dim');
        } else if (!up.ahead) {
          io.out(`Your branch is behind '${up.name}' by ${plural(up.behind, 'commit')}, and can be fast-forwarded.`);
          io.out('  (use "git pull" to update your local branch)', 'dim');
        } else io.out(`Your branch and '${up.name}' have diverged.`);
      }
      if (!headId(repo)) io.out('\nNo commits yet');
      if (repo.merging) {
        io.out('\nYou have unmerged paths.');
        io.out('  (fix conflicts and run "git commit")', 'dim');
        io.out('  (use "git merge --abort" to abort the merge)', 'dim');
      }
      if (st.staged.length) {
        io.out('\nChanges to be committed:');
        io.out('  (use "git restore --staged <file>..." to unstage)', 'dim');
        st.staged.forEach((x) => io.out(`\t${pad(x.kind)}${x.f}`, 'ok'));
      }
      if (st.unmerged.length) {
        io.out('\nUnmerged paths:');
        io.out('  (use "git add <file>..." to mark resolution)', 'dim');
        st.unmerged.forEach((f) => io.out(`\t${pad('both modified')}${f}`, 'err'));
      }
      if (st.unstaged.length) {
        io.out('\nChanges not staged for commit:');
        io.out('  (use "git add <file>..." to update what will be committed)', 'dim');
        io.out('  (use "git restore <file>..." to discard changes in working directory)', 'dim');
        st.unstaged.forEach((x) => io.out(`\t${pad(x.kind)}${x.f}`, 'err'));
      }
      if (st.untracked.length) {
        io.out('\nUntracked files:');
        io.out('  (use "git add <file>..." to include in what will be committed)', 'dim');
        st.untracked.forEach((f) => io.out(`\t${f}`, 'err'));
      }
      const dirty = st.staged.length + st.unstaged.length + st.untracked.length + st.unmerged.length;
      if (!dirty && !repo.merging) io.out('\nnothing to commit, working tree clean');
      else if (!st.staged.length && !repo.merging) {
        if (st.unstaged.length) io.out('\nno changes added to commit (use "git add" and/or "git commit -a")');
        else io.out('\nnothing added to commit but untracked files present (use "git add" to track)');
      }
      io.done('INFO', dirty
        ? `${st.staged.length} staged · ${st.unstaged.length} modified · ${st.untracked.length} untracked${st.unmerged.length ? ` · ${st.unmerged.length} in conflict` : ''}`
        : 'Working tree clean.');
    },

    add(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const work = R.work;
      if (!args.length) throw new CmdError(['Nothing specified, nothing added.', "hint: Maybe you wanted to say 'git add .'?"]);
      const all = args.some((a) => a === '.' || a === '-A' || a === '--all');
      const targets = all ? keysOf(repo.index, work) : args.filter((a) => !a.startsWith('-'));
      const touched = [];
      for (const f of targets) {
        const before = repo.index[f];
        if (f in work) repo.index[f] = work[f];
        else if (f in repo.index) delete repo.index[f];
        else throw new CmdError(`fatal: pathspec '${f}' did not match any files`);
        const wasUnmerged = repo.merging && repo.merging.unmerged.includes(f);
        if (wasUnmerged) repo.merging.unmerged = repo.merging.unmerged.filter((x) => x !== f);
        if (before !== repo.index[f] || wasUnmerged) touched.push(f);
        if (work[f] && /^(<{7}|>{7}) /m.test(work[f])) io.out(`warning: ${f} still contains conflict markers (<<<<<<< / >>>>>>>)`, 'warn');
      }
      io.done('OK', touched.length ? `Staged ${touched.join(', ')} — it will go into the next commit.` : 'Nothing new to stage.');
    },

    commit(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      let msg = null, all = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-m' || a === '--message' || a === '-am') {
          if (a === '-am') all = true;
          msg = args[++i];
          if (msg === undefined) throw new CmdError("error: switch `m' requires a value");
        } else if (a === '-a' || a === '--all') all = true;
        else throw new CmdError([`error: unknown option or path '${a}'`, 'hint: did you forget quotes around the message?  git commit -m "my message"']);
      }
      if (!s.config['user.name'] || !s.config['user.email']) {
        throw new CmdError([
          'Author identity unknown', '', '*** Please tell me who you are.', '', 'Run', '',
          '  git config --global user.email "you@example.com"',
          '  git config --global user.name "Your Name"',
        ]);
      }
      if (all) {
        for (const f of Object.keys(repo.index)) {
          if (f in R.work) repo.index[f] = R.work[f]; else delete repo.index[f];
          if (repo.merging) repo.merging.unmerged = repo.merging.unmerged.filter((x) => x !== f);
        }
      }
      const head = headId(repo);
      const headTree = treeOf(s, head);

      if (repo.merging) {
        if (repo.merging.unmerged.length) {
          throw new CmdError([
            'error: Committing is not possible because you have unmerged files.',
            "hint: Fix them up in the work tree, and then use 'git add <file>'",
            'hint: as appropriate to mark resolution and make a commit.',
            'fatal: Exiting because of an unresolved conflict.',
          ]);
        }
        msg = msg || `Merge branch '${repo.merging.name}'`;
        const id = createCommit(s, { tree: repo.index, parents: [head, repo.merging.theirs], msg, lane: repo.HEAD });
        repo.branches[repo.HEAD] = id;
        repo.merging = null;
        io.out(`[${repo.HEAD} ${id}] ${msg}`, 'ok');
        return io.done('OK', `Merge commit ${id} has two parents — the branches are joined.`);
      }

      if (sameTree(repo.index, headTree)) {
        const st = getStatus(s, repo, R.work);
        io.out(`On branch ${repo.HEAD}`);
        if (st.unstaged.length) io.out('no changes added to commit (use "git add" and/or "git commit -a")');
        else if (st.untracked.length) io.out('nothing added to commit but untracked files present (use "git add" to track)');
        else io.out('nothing to commit, working tree clean');
        io.fail();
        return io.done('WARN', 'Nothing is staged. Use git add <file> first.');
      }

      if (msg === null || !msg.trim()) {
        throw new CmdError(['Aborting commit due to empty commit message.', 'hint: this simulator has no commit editor — use: git commit -m "your message"']);
      }
      const changed = changedFiles(headTree, repo.index);
      const id = createCommit(s, { tree: repo.index, parents: head ? [head] : [], msg, lane: repo.HEAD });
      repo.branches[repo.HEAD] = id;
      io.out(`[${repo.HEAD}${head ? '' : ' (root-commit)'} ${id}] ${msg}`, 'ok');
      io.out(` ${plural(changed.length, 'file')} changed`);
      changed.filter((f) => !(f in headTree)).forEach((f) => io.out(` create mode 100644 ${f}`));
      changed.filter((f) => !(f in repo.index)).forEach((f) => io.out(` delete mode 100644 ${f}`));
      io.done('OK', `Snapshot ${id} saved to ${repo.HEAD}'s history.`);
    },

    branch(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const flags = args.filter((a) => a.startsWith('-'));
      const names = args.filter((a) => !a.startsWith('-'));

      if (flags.some((f) => f === '-d' || f === '-D' || f === '--delete')) {
        if (!names.length) throw new CmdError('fatal: branch name required');
        for (const n of names) {
          if (!(n in repo.branches)) throw new CmdError(`error: branch '${n}' not found.`);
          if (n === repo.HEAD) throw new CmdError([`error: Cannot delete branch '${n}' checked out at '${absPath(R.path)}'`, 'hint: switch to another branch first']);
          if (!flags.includes('-D') && !isAncestor(s, repo.branches[n], headId(repo))) {
            throw new CmdError([`error: the branch '${n}' is not fully merged.`, `hint: If you are sure you want to delete it, run 'git branch -D ${n}'`]);
          }
          const was = repo.branches[n];
          delete repo.branches[n];
          delete repo.upstream[n];
          io.out(`Deleted branch ${n} (was ${was}).`);
        }
        return io.done('OK', `Deleted ${names.join(', ')}. Its commits stay in history.`);
      }

      if (flags.some((f) => f === '-m' || f === '-M')) {
        const [from, to] = names.length === 1 ? [repo.HEAD, names[0]] : names;
        if (!to) throw new CmdError('usage: git branch -m [<old>] <new>');
        validateName(to);
        if (from in repo.branches) { repo.branches[to] = repo.branches[from]; delete repo.branches[from]; }
        if (repo.upstream[from]) { repo.upstream[to] = repo.upstream[from]; delete repo.upstream[from]; }
        if (repo.HEAD === from) repo.HEAD = to;
        return io.done('OK', `Renamed ${from} → ${to}.`);
      }

      if (names.length) {
        const n = names[0];
        validateName(n);
        if (n in repo.branches) throw new CmdError(`fatal: a branch named '${n}' already exists`);
        const h = headId(repo);
        if (!h) throw new CmdError([`fatal: not a valid object name: '${repo.HEAD}'`, 'hint: make your first commit before creating branches']);
        repo.branches[n] = h;
        return io.done('OK', `Created ${n} at ${h}. You're still on ${repo.HEAD} — git checkout ${n} to switch.`);
      }

      if (!flags.includes('-r')) {
        for (const b of Object.keys(repo.branches).sort()) {
          io.seg(b === repo.HEAD ? ['* ', { t: b, c: 'ok' }] : [`  ${b}`]);
        }
      }
      if (flags.includes('-a') || flags.includes('-r')) {
        for (const t of Object.keys(repo.tracking).sort()) io.seg([{ t: `  remotes/${t}`, c: 'err' }]);
      }
      io.done('INFO', `${plural(Object.keys(repo.branches).length, 'branch')}. * marks where HEAD is.`);
    },

    checkout(s, args, io) { switchCmd(s, args, io, 'checkout'); },
    switch(s, args, io) { switchCmd(s, args, io, 'switch'); },

    merge(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      if (args.includes('--abort')) {
        if (!repo.merging) throw new CmdError('fatal: There is no merge to abort (MERGE_HEAD missing).');
        const t = treeOf(s, headId(repo));
        const st = getStatus(s, repo, R.work);
        const untracked = Object.fromEntries(st.untracked.map((f) => [f, R.work[f]]));
        repo.index = { ...t };
        R.dir.files = { ...t, ...untracked };
        repo.merging = null;
        return io.done('OK', 'Merge aborted — files are back to your last commit.');
      }
      const name = args.find((a) => !a.startsWith('-'));
      if (!name) throw new CmdError('usage: git merge <branch>');
      const target = repo.branches[name] || repo.tracking[name];
      if (!target) throw new CmdError(`merge: ${name} - not something we can merge`);
      mergeInto(s, R, io, target, name);
    },

    log(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const oneline = args.includes('--oneline');
      const all = args.includes('--all');
      const graph = args.includes('--graph');
      const head = headId(repo);
      if (!head && !all) throw new CmdError(`fatal: your current branch '${repo.HEAD}' does not have any commits yet`);
      const tips = all ? [...Object.values(repo.branches), ...Object.values(repo.tracking)] : [head];
      const ids = new Set();
      tips.forEach((t) => ancestors(s, t).forEach((c) => ids.add(c)));
      const list = [...ids].map((id) => s.commits[id]).sort((a, b) => b.time - a.time);
      const decor = decorations(s, repo);
      const deco = (id) => {
        if (!decor[id]) return [];
        const out = [{ t: ' (', c: 'warn' }];
        decor[id].forEach((d, i) => { if (i) out.push({ t: ', ', c: 'warn' }); out.push(...d); });
        out.push({ t: ')', c: 'warn' });
        return out;
      };
      for (const c of list) {
        const bullet = graph ? [{ t: c.parents.length > 1 ? '*   ' : '* ', c: 'err' }] : [];
        if (oneline) {
          io.seg([...bullet, { t: c.id, c: 'warn' }, ...deco(c.id), ` ${c.msg}`]);
        } else {
          io.seg([...bullet, { t: `commit ${c.id}`, c: 'warn' }, ...deco(c.id)]);
          if (c.parents.length > 1) io.out(`Merge: ${c.parents.join(' ')}`);
          io.out(`Author: ${c.author} <${c.email}>`);
          io.out(`Date:   Stardate 2026.${String(c.time).padStart(3, '0')}`);
          io.out(`\n    ${c.msg}\n`);
        }
      }
      if (graph) io.out('(the COMMIT GRAPH panel draws the full branch tree)', 'dim');
      io.done('INFO', `${plural(list.length, 'commit')} in history${all ? ' (all branches)' : ''}.`);
    },

    diff(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const staged = args.includes('--staged') || args.includes('--cached');
      const from = staged ? treeOf(s, headId(repo)) : repo.index;
      const to = staged ? repo.index : R.work;
      const files = keysOf(from, to).filter((f) => from[f] !== to[f] && (staged || f in repo.index));
      for (const f of files) {
        io.out(`diff --git a/${f} b/${f}`, 'bold');
        io.out(`--- ${f in from ? `a/${f}` : '/dev/null'}`, 'bold');
        io.out(`+++ ${f in to ? `b/${f}` : '/dev/null'}`, 'bold');
        for (const [op, text] of diffLines(from[f], to[f])) {
          io.out(`${op}${text}`, op === '+' ? 'ok' : op === '-' ? 'err' : 'dim');
        }
      }
      io.done('INFO', files.length
        ? `${plural(files.length, 'file')} differ ${staged ? 'between last commit and staging' : 'between staging and working directory'}.`
        : staged ? 'Nothing staged.' : 'No unstaged changes. (try git diff --staged)');
    },

    restore(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const staged = args.includes('--staged') || args.includes('-S');
      let files = args.filter((a) => !a.startsWith('-'));
      if (!files.length) throw new CmdError('fatal: you must specify path(s) to restore');
      const head = treeOf(s, headId(repo));
      if (files.includes('.')) files = keysOf(staged ? repo.index : R.work, staged ? head : repo.index);
      for (const f of files) {
        if (staged) {
          if (f in head) repo.index[f] = head[f]; else delete repo.index[f];
        } else {
          if (!(f in repo.index)) throw new CmdError(`error: pathspec '${f}' did not match any file(s) known to git`);
          R.work[f] = repo.index[f];
        }
      }
      io.done('OK', staged ? `Unstaged ${files.join(', ')} (your edits are kept).` : `Discarded edits to ${files.join(', ')}.`);
    },

    remote(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const sub = args[0];
      if (!sub) { Object.keys(repo.remotes).forEach((n) => io.out(n)); return io.done('INFO', `${plural(Object.keys(repo.remotes).length, 'remote')}.`); }
      if (sub === '-v') {
        for (const [n, r] of Object.entries(repo.remotes)) { io.out(`${n}\t${r.url} (fetch)`); io.out(`${n}\t${r.url} (push)`); }
        return io.done('INFO', 'Remote URLs.');
      }
      if (sub === 'add') {
        const [, n, url] = args;
        if (!n || !url) throw new CmdError('usage: git remote add <name> <url>');
        if (repo.remotes[n]) throw new CmdError(`error: remote ${n} already exists.`);
        repo.remotes[n] = { url, branches: {} };
        return io.done('OK', `Linked '${n}' → ${url}  (a simulated GitHub — nothing leaves your browser)`);
      }
      if (sub === 'remove' || sub === 'rm') {
        const n = args[1];
        if (!repo.remotes[n]) throw new CmdError(`error: No such remote: '${n}'`);
        delete repo.remotes[n];
        for (const t of Object.keys(repo.tracking)) if (t.startsWith(`${n}/`)) delete repo.tracking[t];
        return io.done('OK', `Removed remote ${n}.`);
      }
      throw new CmdError(`error: unknown subcommand: ${sub}`);
    },

    push(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const setUp = args.includes('-u') || args.includes('--set-upstream');
      const pos = args.filter((a) => !a.startsWith('-'));
      let remoteName, branch;
      if (pos.length) { remoteName = pos[0]; branch = pos[1] || repo.HEAD; }
      else {
        const u = repo.upstream[repo.HEAD];
        if (!u) {
          throw new CmdError([
            `fatal: The current branch ${repo.HEAD} has no upstream branch.`,
            'To push the current branch and set the remote as upstream, use',
            '', `    git push --set-upstream origin ${repo.HEAD}`,
          ]);
        }
        ({ remote: remoteName, branch } = u);
      }
      const rem = getRemote(repo, remoteName);
      const local = repo.branches[branch];
      if (!local) throw new CmdError(`error: src refspec ${branch} does not match any`);
      const old = rem.branches[branch];
      if (old === local) {
        io.out('Everything up-to-date');
        if (setUp) repo.upstream[branch] = { remote: remoteName, branch };
        return io.done('INFO', `GitHub already has ${branch} at ${local}.`);
      }
      if (old && !isAncestor(s, old, local)) {
        throw new CmdError([
          `To ${rem.url}`,
          ` ! [rejected]        ${branch} -> ${branch} (fetch first)`,
          `error: failed to push some refs to '${rem.url}'`,
          'hint: Updates were rejected because the remote contains work that you do not',
          'hint: have locally. Integrate the remote changes (e.g. git pull) before pushing again.',
        ]);
      }
      authLines(s, io);
      const n = countOnly(s, local, old);
      io.out(`Enumerating objects: ${n * 3}, done.`, 'dim');
      io.out(`Writing objects: 100% (${n * 3}/${n * 3}), done.`, 'dim');
      io.out(`To ${rem.url}`);
      io.out(old ? `   ${old}..${local}  ${branch} -> ${branch}` : ` * [new branch]      ${branch} -> ${branch}`, 'ok');
      rem.branches[branch] = local;
      repo.tracking[`${remoteName}/${branch}`] = local;
      if (setUp) {
        repo.upstream[branch] = { remote: remoteName, branch };
        io.out(`branch '${branch}' set up to track '${remoteName}/${branch}'.`);
      }
      io.done('OK', `Uploaded ${plural(n, 'commit')} to GitHub (${remoteName}/${branch}).`);
    },

    fetch(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const remoteName = args.find((a) => !a.startsWith('-')) || 'origin';
      const rem = getRemote(repo, remoteName);
      let n = 0;
      for (const [b, id] of Object.entries(rem.branches)) {
        const key = `${remoteName}/${b}`;
        const old = repo.tracking[key];
        if (old === id) continue;
        if (!n++) io.out(`From ${rem.url}`);
        io.out(old ? `   ${old}..${id}  ${b.padEnd(10)} -> ${key}` : ` * [new branch]      ${b.padEnd(10)} -> ${key}`);
        repo.tracking[key] = id;
      }
      io.done('INFO', n ? `Downloaded news for ${plural(n, 'branch')}. Your own branches are unchanged — merge or pull to use it.` : 'Already up to date with GitHub.');
    },

    pull(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const pos = args.filter((a) => !a.startsWith('-'));
      let remoteName, branch;
      if (pos.length) { remoteName = pos[0]; branch = pos[1] || repo.HEAD; }
      else {
        const u = repo.upstream[repo.HEAD];
        if (!u) {
          throw new CmdError([
            'There is no tracking information for the current branch.',
            'Please specify which branch you want to merge with.', '',
            '    git pull origin <branch>',
          ]);
        }
        ({ remote: remoteName, branch } = u);
      }
      const rem = getRemote(repo, remoteName);
      const tip = rem.branches[branch];
      if (!tip) throw new CmdError(`fatal: couldn't find remote ref ${branch}`);
      io.out(`From ${rem.url}`);
      io.out(` * branch            ${branch}       -> FETCH_HEAD`);
      repo.tracking[`${remoteName}/${branch}`] = tip;
      mergeInto(s, R, io, tip, `${remoteName}/${branch}`);
    },

    '--version'(s, args, io) { io.out('git version 2.47.0 (space-log simulator)'); },
    help(s, args, io) { SHELL.help(s, args, io); },
  };

  function validateName(n) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(n) || n.includes('..')) {
      throw new CmdError(`fatal: '${n}' is not a valid branch name`);
    }
  }

  function switchCmd(s, args, io, verb) {
    const R = needRepo(s);
    const { repo } = R;
    const create = args.some((a) => (verb === 'checkout' ? ['-b', '-B'] : ['-c', '-C', '--create']).includes(a));
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) throw new CmdError(`fatal: you must specify a branch to ${verb === 'checkout' ? 'checkout' : 'switch to'}`);

    if (create) {
      validateName(name);
      if (name in repo.branches) throw new CmdError(`fatal: a branch named '${name}' already exists`);
      if (repo.merging) throw new CmdError('error: you need to resolve your current index first');
      const h = headId(repo);
      if (h) repo.branches[name] = h;
      repo.HEAD = name;
      io.out(`Switched to a new branch '${name}'`);
      return io.done('OK', `Created ${name} and moved HEAD onto it. New commits land here.`);
    }

    if (name === repo.HEAD) { io.out(`Already on '${name}'`); return io.done('INFO', `You're already on ${name}.`); }

    if (!(name in repo.branches)) {
      const trk = Object.keys(repo.tracking).find((t) => t.slice(t.indexOf('/') + 1) === name);
      if (!trk) {
        if (name in R.work) throw new CmdError([`error: '${name}' is a file, not a branch`, `hint: to discard edits use: git restore ${name}`]);
        throw new CmdError(`error: pathspec '${name}' did not match any file(s) known to git`);
      }
      moveHeadTo(s, R, name, repo.tracking[trk]);
      repo.upstream[name] = { remote: trk.split('/')[0], branch: name };
      io.out(`branch '${name}' set up to track '${trk}'.`);
    } else {
      moveHead(s, R, name);
    }
    io.out(`Switched to branch '${name}'`);
    const up = upstreamInfo(s, repo);
    if (up && up.behind) io.out(`Your branch is behind '${up.name}' by ${plural(up.behind, 'commit')}. (use "git pull")`);
    io.done('OK', `HEAD → ${name}. Your files now match that branch.`);
  }

  // Create a branch at `id` and move onto it, undoing the creation if the move fails.
  function moveHeadTo(s, R, name, id) {
    R.repo.branches[name] = id;
    try { moveHead(s, R, name); } catch (e) { delete R.repo.branches[name]; throw e; }
  }

  /* ----------------------------------------------------------------- shell */

  const SHELL = {
    git(s, args, io) {
      let [sub, ...rest] = args;
      if (!sub) {
        io.out('usage: git <command> [<args>]   — try: git status, git help');
        return io.done('INFO', 'Type help for the full command list.');
      }
      const alias = s.config[`alias.${sub}`];
      if (alias && !GIT[sub]) {
        const expanded = tokenize(alias).filter((t) => typeof t === 'string');
        sub = expanded[0];
        rest = [...expanded.slice(1), ...rest];
      }
      const fn = Object.prototype.hasOwnProperty.call(GIT, sub) ? GIT[sub] : null;
      if (!fn) throw new CmdError(`git: '${sub}' is not a git command. See 'git help'.`);
      fn(s, rest, io);
    },

    echo(s, args, io, redirect) {
      const text = args.join(' ');
      if (!redirect) { io.out(text); return; }
      const name = checkFileName(redirect.file);
      const files = s.dirs[s.cwd].files;
      const existed = name in files;
      files[name] = (redirect.op === '>>' ? files[name] || '' : '') + text + '\n';
      io.done('OK', `${redirect.op === '>>' ? 'Appended a line to' : existed ? 'Overwrote' : 'Created'} ${name}.`);
    },

    cat(s, args, io) {
      if (!args.length) throw new CmdError('usage: cat <file>');
      for (const a of args) {
        const files = s.dirs[s.cwd].files;
        if (!(a in files)) throw new CmdError(`cat: ${a}: No such file or directory`);
        for (const line of splitLines(files[a])) {
          io.out(line, /^(<{7}|={7}|>{7})/.test(line) ? 'warn' : '');
        }
      }
    },

    ls(s, args, io) {
      const showAll = args.some((a) => a.startsWith('-') && a.includes('a'));
      const d = s.dirs[s.cwd];
      const prefix = `${s.cwd}/`;
      const subdirs = Object.keys(s.dirs).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(baseName);
      const segs = [];
      if (showAll && d.repo) segs.push({ t: '.git/  ', c: 'dim' });
      subdirs.sort().forEach((n) => segs.push({ t: `${n}/  `, c: 'info' }));
      Object.keys(d.files).sort().forEach((f) => segs.push({ t: `${f}  ` }));
      if (segs.length) io.seg(segs);
    },

    mkdir(s, args, io) {
      const names = args.filter((a) => !a.startsWith('-'));
      if (!names.length) throw new CmdError('usage: mkdir <directory>');
      for (const n of names) {
        const p = resolvePath(s.cwd, n);
        if (s.dirs[p]) throw new CmdError(`mkdir: ${n}: File exists`);
        if (!s.dirs[parentOf(p)]) throw new CmdError(`mkdir: ${n}: No such file or directory`);
        s.dirs[p] = { files: {}, repo: null };
      }
      io.done('OK', `Created folder ${names.join(', ')}. Next: cd into it.`);
    },

    cd(s, args, io) {
      const p = resolvePath(s.cwd, args[0]);
      if (!s.dirs[p]) throw new CmdError(`cd: no such file or directory: ${args[0]}`);
      s.cwd = p;
      io.done('OK', `Now in ${absPath(p)}`);
    },

    pwd(s, args, io) { io.out(absPath(s.cwd)); },
    whoami(s, args, io) { io.out(USER); },

    touch(s, args, io) {
      for (const a of args) {
        const files = s.dirs[s.cwd].files;
        if (!(checkFileName(a) in files)) files[a] = '';
      }
      io.done('OK', `Touched ${args.join(', ')}.`);
    },

    rm(s, args, io) {
      const names = args.filter((a) => !a.startsWith('-'));
      if (!names.length) throw new CmdError('usage: rm <file>');
      const files = s.dirs[s.cwd].files;
      for (const n of names) {
        if (!(n in files)) throw new CmdError(`rm: ${n}: No such file or directory`);
        delete files[n];
      }
      io.done('OK', `Deleted ${names.join(', ')} from the working directory.`);
    },

    code(s, args, io) {
      const name = checkFileName(args[0] === '.' ? undefined : args[0]);
      const files = s.dirs[s.cwd].files;
      if (!(name in files)) files[name] = '';
      io.res.editor = { dir: s.cwd, file: name };
      io.done('INFO', `Opened ${name} in the editor. Save with ⌘S / Ctrl+S.`);
    },

    clear(s, args, io) { io.res.clear = true; },

    github(s, args, io) {
      const R = needRepo(s);
      const { repo } = R;
      const [sub, branch, base = 'main'] = args;
      if (sub !== 'merge' || !branch) {
        throw new CmdError(['usage: github merge <branch> [<base>]', '  simulates opening and merging a Pull Request on github.com']);
      }
      const remName = 'origin' in repo.remotes ? 'origin' : Object.keys(repo.remotes)[0];
      if (!remName) throw new CmdError(['github: this repository is not connected to GitHub yet', `hint: git remote add origin https://github.com/${USER}/space-log.git`]);
      const rem = repo.remotes[remName];
      const head = rem.branches[branch];
      if (!head) throw new CmdError(`github: branch '${branch}' isn't on GitHub yet — push it first: git push -u ${remName} ${branch}`);
      const baseTip = rem.branches[base];
      if (!baseTip) throw new CmdError(`github: base branch '${base}' isn't on GitHub yet — push it first: git push -u ${remName} ${base}`);
      if (isAncestor(s, head, baseTip)) {
        io.out(`github: ${base} already contains every commit from ${branch}.`);
        return io.done('INFO', 'Nothing to merge.');
      }
      let tree;
      if (isAncestor(s, baseTip, head)) tree = s.commits[head].tree;
      else {
        const r = threeWay(treeOf(s, mergeBase(s, baseTip, head)), treeOf(s, baseTip), treeOf(s, head), branch);
        if (r.conflicts.length) {
          throw new CmdError(['github: ✖ This branch has conflicts that must be resolved', `  merge ${base} into ${branch} locally, fix the conflict, then push again`]);
        }
        tree = r.tree;
      }
      const n = ++s.prCount;
      const msg = `Merge pull request #${n} from ${USER}/${branch}`;
      const id = createCommit(s, { tree, parents: [baseTip, head], msg, lane: base, author: 'GitHub' });
      rem.branches[base] = id;
      io.out(`🌐 ${rem.url.replace(/\.git$/, '')}/pull/${n}`, 'dim');
      io.out(`✔ Pull request #${n} merged: ${branch} → ${base}  (commit ${id})`, 'ok');
      io.out(`  Your laptop doesn't know yet. Bring it down with: git checkout ${base} && git pull ${remName} ${base}`, 'dim');
      io.done('OK', `PR #${n} merged on GitHub. The dashed node in the graph exists only on GitHub so far.`);
    },

    help(s, args, io) {
      const rows = [
        ['shell', 'ls · cd · mkdir · pwd · cat · echo "text" > file · echo "text" >> file · touch · rm · code <file> · clear'],
        ['setup', 'git config --global <key> <value> · git init'],
        ['basics', 'git status · git add <file|.> · git commit -m "msg" · git diff [--staged] · git restore [--staged] <file>'],
        ['branches', 'git branch [name|-d name] · git checkout [-b] <name> · git switch [-c] <name> · git merge <name> [--abort]'],
        ['history', 'git log [--oneline --all --graph] · git <alias>'],
        ['github', 'git remote add origin <url> · git push [-u] origin <branch> · git fetch · git pull origin <branch>'],
        ['simulated', 'github merge <branch>  — pretend you clicked "Merge pull request" on github.com'],
      ];
      rows.forEach(([k, v]) => io.seg([{ t: k.padEnd(10), c: 'warn' }, { t: v }]));
      io.done('INFO', 'Command list printed.');
    },
  };
  SHELL.nano = SHELL.vim = SHELL.open = SHELL.code;

  /* ------------------------------------------------------------------- run */

  function makeIO() {
    const res = { lines: [], tag: 'OK', msg: '', ok: true, clear: false, editor: null };
    return {
      res,
      out(t, c = '') { String(t).split('\n').forEach((line) => res.lines.push([{ t: line, c }])); },
      seg(parts) { res.lines.push(parts.map((p) => (typeof p === 'string' ? { t: p, c: '' } : p))); },
      done(tag, msg) { res.tag = tag; res.msg = msg; },
      fail() { res.ok = false; },
    };
  }

  function run(s, line) {
    const io = makeIO();
    const trimmed = line.trim();
    if (!trimmed) return io.res;
    try {
      const tokens = tokenize(trimmed);
      let redirect = null;
      const args = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (typeof t === 'object') {
          const target = tokens[i + 1];
          if (typeof target !== 'string') throw new CmdError(`zsh: parse error near \`${t.op}'`);
          redirect = { op: t.op, file: target };
          i++;
        } else args.push(t);
      }
      const [cmd, ...rest] = args;
      if (!cmd) throw new CmdError('zsh: parse error');
      const fn = Object.prototype.hasOwnProperty.call(SHELL, cmd) ? SHELL[cmd] : null;
      if (!fn) throw new CmdError([`zsh: command not found: ${cmd}`, "hint: type 'help' to list what this terminal understands"]);
      if (redirect && cmd !== 'echo') throw new CmdError('this simulator only supports > and >> with echo');
      fn(s, rest, io, redirect);
    } catch (e) {
      io.res.ok = false;
      if (e instanceof CmdError) {
        e.lines.forEach((l) => io.out(l, l.startsWith('hint:') ? 'warn' : 'err'));
        io.done(e.tag, e.lines[0]);
      } else {
        console.error(e);
        io.out(`internal simulator error: ${e.message}`, 'err');
        io.done('ERR', 'Simulator bug — see the browser console.');
      }
    }
    return io.res;
  }

  function prompt(s) {
    const R = findRepo(s);
    return {
      user: `${USER}@mac`,
      dir: s.cwd,
      branch: R ? ` (${R.repo.HEAD}${R.repo.merging ? '|MERGING' : ''})` : '',
    };
  }

  function writeFile(s, dir, name, content) {
    if (!s.dirs[dir]) return false;
    s.dirs[dir].files[name] = content;
    return true;
  }

  global.GitSim = {
    createState, run, prompt, writeFile, findRepo, getStatus,
    headId, treeOf, ancestors, isAncestor, upstreamInfo, absPath,
  };
})(window);
