/* lessons.js — the six crash-course phases as guided missions.
 *
 * Each step has:
 *   goal  – what to achieve (shown in the checklist)
 *   why   – a one-line explanation of what Git is doing
 *   cmd   – a command that completes it (used by HINT, and to replay earlier missions)
 *   check – (ctx) => boolean, looks at the simulated state to see if the goal is met
 *
 * ctx = { s, R, repo, work, st, last: { line, ok }, G }
 */
(function (global) {
  'use strict';

  const ran = (re) => (c) => c.last.ok && re.test(c.last.line);
  const head = (c) => c.repo && c.G.headId(c.repo);
  const file = (c, f = 'mission.md') => (c.work || {})[f];
  const isStaged = (c, f = 'mission.md') => !!c.st && c.st.staged.some((x) => x.f === f);
  const onBranch = (b) => (c) => !!c.repo && c.repo.HEAD === b;
  const origin = (c) => c.repo && c.repo.remotes.origin;

  const REMOTE_URL = 'https://github.com/commander/space-log.git';

  global.MISSIONS = [
    {
      code: '01', tab: 'Launch', title: 'Launching the Mission',
      story: 'Before writing code, Git needs to know who you are and where your project lives.',
      steps: [
        {
          goal: 'Tell Git your name',
          why: 'Every commit is stamped with an author. --global saves it for every repo on this Mac.',
          cmd: 'git config --global user.name "Commander"',
          check: (c) => !!c.s.config['user.name'],
        },
        {
          goal: 'Tell Git your email',
          why: 'Use the email on your GitHub account so GitHub can link commits to your profile.',
          cmd: 'git config --global user.email "commander@example.com"',
          check: (c) => !!c.s.config['user.email'],
        },
        {
          goal: 'Store your token in the macOS Keychain',
          why: 'GitHub wants a Personal Access Token, not a password. osxkeychain remembers it so you only paste it once.',
          cmd: 'git config --global credential.helper osxkeychain',
          check: (c) => !!c.s.config['credential.helper'],
        },
        {
          goal: 'Create a folder called space-log',
          why: 'A project is just a folder. Git will watch everything inside it.',
          cmd: 'mkdir space-log',
          check: (c) => !!c.s.dirs['~/space-log'],
        },
        {
          goal: 'Move into it',
          why: 'cd = change directory. Your prompt shows where you are.',
          cmd: 'cd space-log',
          check: (c) => c.s.cwd === '~/space-log',
        },
        {
          goal: 'Turn it into a repository',
          why: 'git init plants a hidden .git folder: the database where history lives. Try ls -a afterwards.',
          cmd: 'git init',
          check: (c) => !!c.R && c.R.path === '~/space-log',
        },
      ],
    },
    {
      code: '02', tab: 'First Log', title: 'Writing the First Log',
      story: "Create a captain's log, then lock it into history. Watch the three zones under the graph.",
      steps: [
        {
          goal: 'Create mission.md',
          why: '> writes text into a file (creating it). The file appears in WORKING DIRECTORY, marked U for untracked.',
          cmd: 'echo "# Captain\'s Log: Stardate 2026.1" > mission.md',
          check: (c) => file(c) !== undefined,
        },
        {
          goal: 'Check the status',
          why: 'git status is your radar. Red means Git sees the file but is not tracking it yet.',
          cmd: 'git status',
          check: ran(/^git\s+status\b/),
        },
        {
          goal: 'Stage the file',
          why: 'add copies the file into the STAGING AREA, a draft of your next snapshot.',
          cmd: 'git add mission.md',
          check: (c) => isStaged(c) || !!head(c),
        },
        {
          goal: 'Commit it',
          why: 'commit turns what is staged into a permanent snapshot. Your first node appears in the graph.',
          cmd: 'git commit -m "feat: launch mission log with initial entry"',
          check: (c) => !!head(c),
        },
      ],
    },
    {
      code: '03', tab: 'Branching', title: 'Exploring Alternate Realities',
      story: 'Never code directly on main. Build the fuel system on its own branch, ship it through a Pull Request, then sync.',
      steps: [
        {
          goal: 'Connect to GitHub',
          why: '"origin" is the usual nickname for your GitHub copy. This GitHub is simulated, so nothing leaves your browser.',
          cmd: `git remote add origin ${REMOTE_URL}`,
          check: (c) => !!origin(c),
        },
        {
          goal: 'Publish main',
          why: '-u links your local main to origin/main, so plain git push / git pull know where to go later.',
          cmd: 'git push -u origin main',
          check: (c) => !!origin(c) && !!origin(c).branches.main,
        },
        {
          goal: 'Create and switch to fuel-system',
          why: 'checkout -b = create a branch + move HEAD onto it. A branch is just a movable label on a commit.',
          cmd: 'git checkout -b fuel-system',
          check: onBranch('fuel-system'),
        },
        {
          goal: 'Append a fuel reading',
          why: '>> appends instead of overwriting. The file now shows M (modified).',
          cmd: 'echo "Fuel levels stable at 98%." >> mission.md',
          check: (c) => /fuel/i.test(file(c) || '') || (c.repo && c.repo.branches['fuel-system'] !== c.repo.branches.main),
        },
        {
          goal: 'Stage it',
          why: 'Same as before: move the change to the staging area.',
          cmd: 'git add mission.md',
          check: (c) => isStaged(c) || (c.repo && c.repo.branches['fuel-system'] !== c.repo.branches.main),
        },
        {
          goal: 'Commit on the branch',
          why: 'Watch the graph: the new node grows on its own lane while main stays put.',
          cmd: 'git commit -m "feat: add fuel system telemetry update"',
          check: (c) => !!c.repo && !!c.repo.branches['fuel-system'] && c.repo.branches['fuel-system'] !== c.repo.branches.main,
        },
        {
          goal: 'Push the branch to GitHub',
          why: 'Now GitHub has fuel-system too, and you could open a Pull Request.',
          cmd: 'git push -u origin fuel-system',
          check: (c) => !!origin(c) && !!origin(c).branches['fuel-system'],
        },
        {
          goal: 'Merge the Pull Request on GitHub',
          why: 'On github.com you would click "Merge pull request". The merge happens on GitHub, not on your laptop (dashed node).',
          cmd: 'github merge fuel-system',
          check: (c) => !!origin(c) && c.G.isAncestor(c.s, origin(c).branches['fuel-system'], origin(c).branches.main),
        },
        {
          goal: 'Switch back to main',
          why: 'Your files jump back to how main looks. The fuel line disappears (for now).',
          cmd: 'git checkout main',
          check: onBranch('main'),
        },
        {
          goal: 'Pull the merged work down',
          why: 'pull = fetch (download) + merge. Your local main catches up with GitHub.',
          cmd: 'git pull origin main',
          check: (c) => !!origin(c) && c.G.isAncestor(c.s, origin(c).branches.main, c.repo.branches.main),
        },
      ],
    },
    {
      code: '04', tab: 'History', title: 'Visualizing History & Branch Trees',
      story: 'Typing long log commands gets old. Create an alias: your own git sub-command.',
      steps: [
        {
          goal: 'Create the lg alias',
          why: 'alias.lg makes "git lg" expand to the long log command. Quotes keep it as one value.',
          cmd: 'git config --global alias.lg "log --all --decorate --oneline --graph"',
          check: (c) => !!c.s.config['alias.lg'],
        },
        {
          goal: 'Run git lg',
          why: 'One line per commit, newest first, with labels showing where each branch points.',
          cmd: 'git lg',
          check: ran(/^git\s+lg\b/),
        },
      ],
    },
    {
      code: '05', tab: 'Conflicts', title: 'Surviving the Unknown',
      story: 'A conflict happens when two branches change the same lines. Cause one on purpose, then fix it.',
      steps: [
        {
          goal: 'Create conflict-test',
          why: 'A new branch starting from the current main.',
          cmd: 'git checkout -b conflict-test',
          check: (c) => onBranch('conflict-test')(c) || !!(c.repo && c.repo.branches['conflict-test'] && c.repo.HEAD === 'main'),
        },
        {
          goal: 'Overwrite the log with a critical reading',
          why: 'A single > replaces the whole file.',
          cmd: 'echo "Fuel levels critical at 10%!" > mission.md',
          check: (c) => /critical/i.test(file(c) || '') || (c.repo && c.repo.branches['conflict-test'] !== c.repo.branches.main),
        },
        {
          goal: 'Stage it',
          why: 'Into the staging area.',
          cmd: 'git add mission.md',
          check: (c) => isStaged(c) || (c.repo && c.repo.branches['conflict-test'] !== c.repo.branches.main),
        },
        {
          goal: 'Commit on conflict-test',
          why: 'This branch now says "critical".',
          cmd: 'git commit -m "update: fuel critical on test branch"',
          check: (c) => !!c.repo && !!c.repo.branches['conflict-test'] && c.repo.branches['conflict-test'] !== c.repo.branches.main,
        },
        {
          goal: 'Go back to main',
          why: 'main still has the old text.',
          cmd: 'git checkout main',
          check: onBranch('main'),
        },
        {
          goal: 'Write a different reading on main',
          why: 'Same line, different content. This is what sets up the conflict.',
          cmd: 'echo "Fuel levels optimal at 100%!" > mission.md',
          check: (c) => /optimal/i.test(file(c) || ''),
        },
        {
          goal: 'Stage it',
          why: 'Into the staging area.',
          cmd: 'git add mission.md',
          check: (c) => isStaged(c) || /optimal/i.test((c.G.treeOf(c.s, head(c)) || {})['mission.md'] || ''),
        },
        {
          goal: 'Commit on main',
          why: 'Both branches now changed the same line since they split. The graph shows two diverging lanes.',
          cmd: 'git commit -m "update: fuel optimal on main"',
          check: (c) => /optimal/i.test((c.G.treeOf(c.s, head(c)) || {})['mission.md'] || ''),
        },
        {
          goal: 'Merge conflict-test into main',
          why: "Git can't pick a winner, so it pauses and writes both versions into the file between markers.",
          cmd: 'git merge conflict-test',
          check: (c) => !!c.repo && (!!c.repo.merging || (c.s.commits[head(c)] || { parents: [] }).parents.length > 1),
        },
        {
          goal: 'Resolve: keep the text you want, delete the markers',
          why: 'Click mission.md in WORKING DIRECTORY (or run: code mission.md), remove <<<<<<< ======= >>>>>>>, save. Or overwrite it with echo.',
          cmd: 'echo "Fuel levels optimal at 100%!" > mission.md',
          check: (c) => !!c.repo && (!c.repo.merging || !/^(<{7}|={7}|>{7})/m.test(file(c) || '')),
        },
        {
          goal: 'Mark it resolved',
          why: 'git add tells Git "this file is fixed now".',
          cmd: 'git add mission.md',
          check: (c) => !!c.repo && (c.repo.merging ? c.repo.merging.unmerged.length === 0 : true),
        },
        {
          goal: 'Finish the merge',
          why: 'The merge commit has two parents and ties the lanes together.',
          cmd: 'git commit -m "fix: resolve merge conflict for fuel levels"',
          check: (c) => !!c.repo && !c.repo.merging && (c.s.commits[head(c)] || { parents: [] }).parents.length > 1,
        },
      ],
    },
    {
      code: '06', tab: 'Broadcast', title: 'Cleaning Up & Broadcasting',
      story: 'Delete the test branch you no longer need and send main to GitHub.',
      steps: [
        {
          goal: 'Delete conflict-test',
          why: "-d refuses if the branch isn't merged, so you can't lose work by accident. Its commits stay in history.",
          cmd: 'git branch -d conflict-test',
          check: (c) => !!c.repo && !c.repo.branches['conflict-test'],
        },
        {
          goal: 'Push main to GitHub',
          why: 'origin/main catches up with your local main.',
          cmd: 'git push origin main',
          check: (c) => !!origin(c) && origin(c).branches.main === c.repo.branches.main,
        },
      ],
    },
    {
      code: '∞', tab: 'Sandbox', title: 'Sandbox',
      story: 'Free play, starting from the finished project. Try breaking things: make two branches that edit different files and merge them, push without pulling, or delete an unmerged branch.',
      steps: [],
    },
  ];
})(window);
