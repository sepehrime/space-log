# 🚀 Space Log: The Ultimate Mac Terminal Git & GitHub Crash Course

Welcome aboard, Commander! This crash course turns your Mac Terminal and VS Code into a command center. By the end of this journey, you will have created a real project, mastered version control, resolved merge conflicts, and pushed your repository live to GitHub.

---

## Phase 1: Launching the Mission (Setup & Init)

Before writing code, Git needs to know who you are and where your project lives.

### 1. Configure Your Identity
Tell Git your name and GitHub email so your commits are properly stamped:
```bash
git config --global user.name "Your Name"
git config --global user.email "your_email@example.com"
```

### 2. Set Up Secure Authentication (Mac Keychain)
GitHub requires a **Personal Access Token (PAT)** instead of a password. Configure your Mac to securely remember it:
```bash
git config --global credential.helper osxkeychain
```
*(If you don't have a PAT yet, generate one on GitHub under Settings -> Credentials -> Personal access tokens -> Generate new token (classic) with `repo` scope enabled). When pushing a commit to Github, use this PAT when asked for password.*

### 3. Initialize Your Repository
Create a project folder, enter it, and turn it into a Git repository:
```bash
mkdir space-log
cd space-log
git init
```
* **What happened:** `git init` planted a hidden `.git` folder inside your project, transforming it into a tracked repository.

---

## Phase 2: Writing the First Log (Add & Commit)

Let's create our first file—a captain's log—and save our progress to history.

1. **Create the file:**
   ```bash
   echo "# Captain's Log: Stardate 2026.1" > mission.md
   ```
2. **Check status:**
   ```bash
   git status
   ```
   *(You'll see `mission.md` glowing in red, meaning Git sees it but isn't tracking it yet).*
3. **Stage and commit:**
   ```bash
   git add mission.md
   git commit -m "feat: launch mission log with initial entry"
   ```
* **What happened:** `add` moves files to the staging area, and `commit` permanently locks them into Git history with a message.

---

## Phase 3: Exploring Alternate Realities (Branching & Merging)

Never code directly on your main line. Isolate new features on branches.

### 1. Create and Switch to a Feature Branch
```bash
git checkout -b fuel-system
```

### 2. Make Changes and Commit
```bash
echo "Fuel levels stable at 98%." >> mission.md
git add mission.md
git commit -m "feat: add fuel system telemetry update"
```

### 3. Push the Branch and Open a Pull Request (PR)
```bash
git push -u origin fuel-system
```
*Go to your repository on GitHub, click **"Compare & pull request"**, review your changes, and merge them into `main`.*

### 4. Sync Your Local Main
Once merged on GitHub, head back to your terminal, switch to `main`, and pull down the updates:
```bash
git checkout main
git pull origin main
```

---

## Phase 4: Visualizing History & Branch Trees

Typing out long history logs gets tedious. Let's create a custom shortcut (an **alias**) to view a visual ASCII branch tree.

1. **Set up the alias:**
   ```bash
   git config --global alias.lg "log --all --decorate --oneline --graph"
   ```
2. **Use it anytime:**
   ```bash
   git lg
   ```

---

## Phase 5: Surviving the Unknown (Handling Merge Conflicts)

A merge conflict happens when Git doesn't know which version of a file to keep because changes were made to the exact same line in two different places.

1. **Simulate a conflict branch:**
   ```bash
   git checkout -b conflict-test
   echo "Fuel levels critical at 10%!" > mission.md
   git add mission.md
   git commit -m "update: fuel critical on test branch"
   ```
2. **Trigger the conflict on main:**
   ```bash
   git checkout main
   echo "Fuel levels optimal at 100%!" > mission.md
   git add mission.md
   git commit -m "update: fuel optimal on main"
   
   git merge conflict-test
   ```
   *(Git will pause and flag a **CONFLICT**).*
3. **Resolve in VS Code:** Open `mission.md`, remove the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`), keep your preferred text, and save (`Cmd + S`).
4. **Complete the merge:**
   ```bash
   git add mission.md
   git commit -m "fix: resolve merge conflict for fuel levels"
   ```

---

## Phase 6: Cleaning Up & Broadcasting to GitHub

### 1. Delete Unused Local Branches
```bash
git branch -d conflict-test
```

### 2. Push Your Final Project to GitHub
```bash
git push origin main
```

---

## 🧭 Quick Reference Cheat Sheet
* `git status` — Check modified and staged files.
* `git add .` — Stage all changes.
* `git commit -m "message"` — Save a history snapshot.
* `git lg` — View your visual branch tree.
* `git pull` — Download updates from GitHub.
* `git push` — Upload updates to GitHub.