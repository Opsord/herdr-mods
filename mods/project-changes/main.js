import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, appHome, window, shared, setShared } from "herdr";
import { TEXT, RADIUS, SIZE, Badge, Icon } from "./ui.js";

function place(s, ps) {
  if (!s) return null;
  const activeTab = s.tabs?.find((t) => t.active);
  if (activeTab) {
    const pane = ps.find((p) => p.tab === activeTab.id && p.cwd);
    if (pane?.cwd) return pane.cwd;
  }
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const ps = panes();
  const pane = f?.pane ? ps.find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || place(space, ps) || space?.folder;
  return { cwd, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.open = null; this.handle = cx.focus_handle();
    this.repos = [];
    this.selectedRepoPath = null;
    this.userSelectedRepo = null;
    this.lastCwdRepoPath = null;
    this.loadVersion = 0;
    this.pendingRefresh = false;
    this.repoMenuOpen = false;
    this.spaceId = null;
    this.lastBaseFolder = null;
    this.lastScanTime = 0;
    let treeView = true;
    try {
      const stored = localStorage.getItem("changes.tree_view");
      if (stored !== null) treeView = JSON.parse(stored);
    } catch { treeView = true; }
    this.treeView = treeView;

    let folded = [];
    try {
      const stored = localStorage.getItem("changes.folded_folders");
      if (stored !== null) folded = JSON.parse(stored);
    } catch { folded = []; }
    this.foldedFolders = new Set(Array.isArray(folded) ? folded : []);

    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  toggleTreeView(cx) {
    this.treeView = !this.treeView;
    localStorage.setItem("changes.tree_view", JSON.stringify(this.treeView));
    cx.notify();
  }

  toggleFolder(path, cx) {
    if (this.foldedFolders.has(path)) {
      this.foldedFolders.delete(path);
    } else {
      this.foldedFolders.add(path);
    }
    localStorage.setItem("changes.folded_folders", JSON.stringify([...this.foldedFolders]));
    cx.notify();
  }

  getAllDirPaths(node, paths = []) {
    for (const dir of node.dirs.values()) {
      paths.push(dir.path);
      this.getAllDirPaths(dir, paths);
    }
    return paths;
  }

  collapseAll(cx) {
    if (!this.treeView) {
      this.treeView = true;
      localStorage.setItem("changes.tree_view", "true");
    }
    const tree = this.buildChangesTree(this.files);
    const allPaths = this.getAllDirPaths(tree);
    for (const p of allPaths) {
      this.foldedFolders.add(p);
    }
    localStorage.setItem("changes.folded_folders", JSON.stringify([...this.foldedFolders]));
    cx.notify();
  }

  expandAll(cx) {
    if (!this.treeView) {
      this.treeView = true;
      localStorage.setItem("changes.tree_view", "true");
    }
    this.foldedFolders.clear();
    localStorage.setItem("changes.folded_folders", "[]");
    cx.notify();
  }

  selectRepo(path, cx) {
    if (this.selectedRepoPath === path) {
      this.repoMenuOpen = false;
      cx.notify();
      return;
    }
    this.userSelectedRepo = path;
    this.selectedRepoPath = path;
    this.repoMenuOpen = false;
    this.open = null;
    this.setLines([]);
    this.files = [];
    const space = spaces().find((s) => s.active);
    if (space?.id) {
      localStorage.setItem(`changes.selected_repo:${space.id}`, path);
    }
    this.refresh(cx);
    cx.notify();
  }

  async discoverRepos(folder, on, force = false) {
    if (!folder) return [];
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const cleanFolder = norm(folder);
    const now = Date.now();

    if (!force && this.lastBaseFolder === cleanFolder && this.repos.length > 0 && now - this.lastScanTime < 30000) {
      return this.repos;
    }

    const repos = [];

    // 1. Check if folder itself is a git repo
    try {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: cleanFolder, on });
      if (r.code === 0 && r.stdout.trim()) {
        const top = norm(r.stdout.trim());
        if (top.toLowerCase() === cleanFolder.toLowerCase()) {
          const branch = await this.getRepoBranch(cleanFolder, on);
          repos.push({
            name: cleanFolder.split("/").pop() || cleanFolder,
            rel: cleanFolder.split("/").pop() || cleanFolder,
            path: cleanFolder,
            branch,
          });
        }
      }
    } catch {}

    // 2. Scan subdirectories (depth 3) for nested git repositories
    try {
      const candidatePaths = [];
      const isWin = !on && window()?.platform === "windows";
      if (isWin) {
        const home = appHome().replace(/\\/g, "/");
        const modScript = `${home}/mods/project-changes/scan.ps1`;
        const r = await exec("powershell", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          modScript,
          "-Path",
          cleanFolder,
          "-Depth",
          "3",
        ]);
        if (r.code === 0 && r.stdout) {
          const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            const full = norm(line);
            if (
              full &&
              !candidatePaths.some((p) => p.toLowerCase() === full.toLowerCase()) &&
              !repos.some((rep) => rep.path.toLowerCase() === full.toLowerCase())
            ) {
              candidatePaths.push(full);
            }
          }
        }
      } else {
        // macOS, Linux, or remote machine
        const r = await exec("sh", ["-c", "find . -maxdepth 4 -name .git -print"], { cwd: cleanFolder, on });
        if (r.code === 0 && r.stdout) {
          const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            const cleaned = line.replace(/\/\.git$/, "").replace(/^\.\//, "");
            if (!cleaned) continue;
            const full = norm(`${cleanFolder}/${cleaned}`);
            if (
              !candidatePaths.some((p) => p.toLowerCase() === full.toLowerCase()) &&
              !repos.some((rep) => rep.path.toLowerCase() === full.toLowerCase())
            ) {
              candidatePaths.push(full);
            }
          }
        }
      }

      if (candidatePaths.length > 0) {
        const subrepos = await Promise.all(
          candidatePaths.map(async (full) => {
            const rel = full.slice(cleanFolder.length).replace(/^\/+/, "");
            const branch = await this.getRepoBranch(full, on);
            return {
              name: full.split("/").pop(),
              rel: rel.replace(/\//g, " / "),
              path: full,
              branch,
            };
          })
        );
        repos.push(...subrepos);
      }
    } catch {}

    repos.sort((a, b) => a.rel.localeCompare(b.rel));
    this.lastBaseFolder = cleanFolder;
    this.lastScanTime = now;
    return repos;
  }

  async getRepoBranch(cwd, on) {
    try {
      const r = await exec("git", ["branch", "--show-current"], { cwd, on });
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
      const head = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd, on });
      if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
    } catch {}
    return "";
  }

  repoSelectorPill(t) {
    const current = this.repos.find((r) => r.path === this.selectedRepoPath) || this.repos[0];
    const displayName = current?.name ?? "Select repo";

    return h_flex()
      .id("changes-repo-selector")
      .h(22)
      .max_w(145)
      .min_w(0)
      .px(6)
      .gap(4)
      .flex_none()
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(this.repoMenuOpen ? t.accent : t.border)
      .bg(this.repoMenuOpen ? t.raised : t.background)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).border_color(t.dim))
      .tooltip(`Repository: ${current?.rel ?? displayName}${current?.branch ? ` (${current.branch})` : ""} · Click to switch`)
      .on_click((_e, cx) => {
        this.repoMenuOpen = !this.repoMenuOpen;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        Icon("git-branch", 11)
          .text_color(t.accent)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT.caption)
          .font_medium()
          .text_color(t.foreground)
          .child(displayName)
      )
      .child(
        Icon(this.repoMenuOpen ? "chevron-down" : "chevron-right", 10)
          .text_color(t.muted)
      );
  }

  repoDropdown(t) {
    return v_flex()
      .id("changes-repo-dropdown")
      .absolute()
      .top(66)
      .left(10)
      .right(10)
      .bg(t.popover)
      .border_1()
      .border_color(t.border)
      .rounded(8)
      .shadow_lg()
      .p(5)
      .gap(2)
      .child(
        h_flex()
          .px(6)
          .py(3)
          .items_center()
          .justify_between()
          .text_size(10)
          .font_semibold()
          .text_color(t.dim)
          .child("REPOSITORIES")
          .child(`${this.repos.length} found`)
      )
      .child(div().h(1).bg(t.border).my(2))
      .child(
        div()
          .relative()
          .max_h(220)
          .min_h(0)
          .child(
            v_flex()
              .id("changes-repo-scroll-list")
              .size_full()
              .max_h(220)
              .overflow_y_scroll()
              .gap(2)
              .children(
                this.repos.map((repo) => {
                  const isSelected = repo.path === this.selectedRepoPath;
                  return h_flex()
                    .id(`repo-opt-${repo.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`)
                    .h(32)
                    .px(8)
                    .gap(8)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(isSelected, (s) => s.bg(t.raised))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.selectRepo(repo.path, cx))
                    .child(
                      Icon("git-branch", 13)
                        .text_color(isSelected ? t.accent : t.muted)
                    )
                    .child(
                      v_flex()
                        .flex_1()
                        .min_w(0)
                        .justify_center()
                        .child(
                          div()
                            .truncate()
                            .text_size(TEXT.label)
                            .font_medium()
                            .text_color(isSelected ? t.foreground : t.muted)
                            .child(repo.rel || repo.name)
                        )
                        .when(Boolean(repo.branch), (el) =>
                          el.child(
                            div()
                              .truncate()
                              .text_size(TEXT.badge)
                              .text_color(t.dim)
                              .child(repo.branch)
                          )
                        )
                    )
                    .when(isSelected, (el) =>
                      el.child(
                        Icon("check", 12)
                          .text_color(t.accent)
                      )
                    );
                })
              )
          )
          .child(
            Scrollbar.vertical("changes-repo-scroll-list")
              .viewport_from_layout()
              .absolute()
              .inset_0()
          )
      );
  }

  buildChangesTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const cleanPath = (f.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = cleanPath.split("/");
      if (parts.length <= 1) {
        root.files.push(f);
      } else {
        let current = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const dirName = parts[i];
          if (!current.dirs.has(dirName)) {
            const dirPath = parts.slice(0, i + 1).join("/");
            current.dirs.set(dirName, {
              name: dirName,
              path: dirPath,
              dirs: new Map(),
              files: [],
              add: 0,
              del: 0,
            });
          }
          const dirNode = current.dirs.get(dirName);
          dirNode.add += f.add || 0;
          dirNode.del += f.del || 0;
          current = dirNode;
        }
        current.files.push(f);
      }
    }
    return root;
  }

  renderTreeRows(node, depth, isRoot, t, out = []) {
    const dirList = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fileList = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

    for (const dir of dirList) {
      const isFolded = this.foldedFolders.has(dir.path);
      out.push(this.treeFolderRow(dir, depth, isFolded, t));
      if (!isFolded) {
        this.renderTreeRows(dir, depth + 1, false, t, out);
      }
    }

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const isLast = i === fileList.length - 1;
      out.push(this.treeFileRow(f, depth, isLast, !isRoot, t));
    }

    return out;
  }

  treeFolderRow(dir, depth, isFolded, t) {
    const indent = 8 + depth * 14;

    return h_flex()
      .id(`change-folder-${dir.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`)
      .h(28)
      .flex_none()
      .px(8)
      .pl(indent)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(isFolded ? `Expand ${dir.name}` : `Collapse ${dir.name}`)
      .on_click((_e, cx) => this.toggleFolder(dir.path, cx))
      .child(
        Icon(isFolded ? "chevron-right" : "chevron-down", 11)
          .text_color(t.dim)
      )
      .child(
        Icon("folder", 13)
          .text_color(t.dim)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12)
          .font_medium()
          .text_color(t.foreground)
          .child(dir.name)
      )
      .when(dir.add > 0, (e) =>
        e.child(div().text_size(11).text_color(t.ansi2).child(`+${dir.add}`))
      )
      .when(dir.del > 0, (e) =>
        e.child(div().text_size(11).text_color(t.ansi1).child(`−${dir.del}`))
      );
  }

  treeFileRow(f, depth, isLast, hasParentFolder, t) {
    const name = f.path.split("/").pop();
    const indent = 8 + depth * 14;

    return h_flex()
      .id(`change-${f.path}`)
      .h(28)
      .flex_none()
      .px(8)
      .pl(indent)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .when(hasParentFolder, (e) =>
        e.child(
          div()
            .font_family("JetBrains Mono")
            .text_size(11)
            .flex_none()
            .text_color(t.dim)
            .child(isLast ? "└─" : "├─")
        )
      )
      .child(
        div()
          .w(14)
          .text_size(11)
          .text_color(
            f.status === "A"
              ? t.ansi2
              : f.status === "D"
              ? t.ansi1
              : f.status === "U"
              ? t.ansi1
              : t.blocked
          )
          .child(f.status)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12)
          .text_color(this.open === f.path ? t.foreground : t.muted)
          .child(name)
      )
      .when(f.add > 0, (e) =>
        e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))
      )
      .when(f.del > 0, (e) =>
        e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`))
      );
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.loadVersion = (this.loadVersion || 0) + 1;
    const version = this.loadVersion;

    if (this.loading) {
      this.pendingRefresh = true;
      return;
    }

    const { cwd, on } = location(), context = key();
    const space = spaces().find((s) => s.active);
    const spaceId = space?.id ?? null;

    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
      if (this.spaceId !== spaceId) {
        this.spaceId = spaceId;
        this.selectedRepoPath = null;
        this.userSelectedRepo = null;
        this.lastCwdRepoPath = null;
        this.repos = [];
        this.repoMenuOpen = false;
        this.lastBaseFolder = null;
        this.lastScanTime = 0;
      }
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const cleanCwd = norm(cwd);
        const spaceFolder = space?.folder ? norm(space.folder) : null;

        // Bound discovery strictly to the active space root (never scan higher than space.folder)
        let baseFolder = spaceFolder || cleanCwd;
        if (spaceFolder && cleanCwd && !cleanCwd.toLowerCase().startsWith(spaceFolder.toLowerCase())) {
          baseFolder = cleanCwd;
        }

        let discovered = await this.discoverRepos(baseFolder, on);
        if (discovered.length === 0 && cleanCwd && cleanCwd !== baseFolder) {
          discovered = await this.discoverRepos(cleanCwd, on);
        }

        if (this.loadVersion !== version || key() !== context) return;
        this.repos = discovered;

        // 2. Determine target repository path
        const cwdRepo = discovered.find((r) => {
          const rp = r.path.toLowerCase();
          return cleanCwd.toLowerCase() === rp || cleanCwd.toLowerCase().startsWith(rp + "/");
        });
        const cwdRepoPath = cwdRepo?.path || null;
        const terminalRepoChanged = cwdRepoPath && cwdRepoPath !== this.lastCwdRepoPath;
        this.lastCwdRepoPath = cwdRepoPath;

        let target = null;
        if (terminalRepoChanged) {
          target = cwdRepoPath;
          this.userSelectedRepo = null;
        } else if (this.userSelectedRepo && discovered.some((r) => r.path === this.userSelectedRepo)) {
          target = this.userSelectedRepo;
        } else if (this.selectedRepoPath && discovered.some((r) => r.path === this.selectedRepoPath)) {
          target = this.selectedRepoPath;
        } else if (cwdRepoPath) {
          target = cwdRepoPath;
        } else if (spaceId) {
          const saved = localStorage.getItem(`changes.selected_repo:${spaceId}`);
          if (saved && discovered.some((r) => r.path === saved)) {
            target = saved;
          }
        }

        if (!target && discovered.length > 0) {
          target = discovered[0].path;
        }
        if (!target) {
          target = cwd;
        }
        this.selectedRepoPath = target;

        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: target, on });
        if (this.loadVersion !== version || key() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.files = []; this.setLines([]); this.open = null;
          this.error = discovered.length === 0 ? "Not a git repository" : "Select a repository above";
          return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          if (entry.length < 4) continue;
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (this.loadVersion !== version || key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.loadVersion === version && key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.loadVersion === version && key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    const targetRepo = shared("project_changes.target_repo");
    if (targetRepo && targetRepo !== this.selectedRepoPath) {
      setShared("project_changes.target_repo", null);
      this.selectRepo(targetRepo, cx);
    }
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);

    let fileRows;
    if (this.treeView) {
      const tree = this.buildChangesTree(this.files);
      fileRows = this.renderTreeRows(tree, 0, true, t, []);
    } else {
      fileRows = this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(this.open === f.path, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      });
    }

    const rowCount = fileRows.length;

    return v_flex().id("changes").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.repoMenuOpen) {
            this.repoMenuOpen = false;
            cx.stop_propagation();
            cx.notify();
          } else if (this.typing) {
            this.typing = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
          } else if (this.open) {
            this.open = null;
            this.setLines([]);
            cx.stop_propagation();
            cx.notify();
          }
        }
      })
      .child(
        v_flex()
          .flex_none()
          .px(12)
          .py(6)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().font_semibold().child("Changes"))
                  .child(
                    div()
                      .px(5)
                      .py(1)
                      .rounded(4)
                      .border_1()
                      .border_color(t.border)
                      .text_size(10)
                      .text_color(t.muted)
                      .child(`${this.files.length} ${this.files.length === 1 ? "file" : "files"}`)
                  )
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
                  .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
              )
          )
          .child(
            h_flex()
              .flex_wrap()
              .gap(6)
              .items_center()
              .when(this.repos.length > 1, (el) =>
                el.child(this.repoSelectorPill(t))
              )
              .child(
                h_flex()
                  .id("changes-tree-toggle")
                  .h(22)
                  .px(6)
                  .gap(5)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(this.treeView ? t.accent : t.border)
                  .bg(this.treeView ? t.raised : t.background)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip(this.treeView ? "Switch to list view" : "Switch to tree view")
                  .on_click((_e, cx) => this.toggleTreeView(cx))
                  .child(
                    h_flex()
                      .size(12)
                      .flex_none()
                      .rounded(3)
                      .border_1()
                      .border_color(this.treeView ? t.accent : t.dim)
                      .items_center()
                      .justify_center()
                      .when(this.treeView, (el) => el.bg(t.accent))
                      .when(this.treeView, (el) =>
                        el.child(
                          Icon("check", 8)
                            .text_color("#ffffff")
                        )
                      )
                  )
                  .child(
                    div()
                      .text_size(TEXT.caption)
                      .font_medium()
                      .text_color(this.treeView ? t.foreground : t.muted)
                      .child("Tree")
                  )
              )
              .when(this.treeView, (el) =>
                el
                  .child(
                    h_flex()
                      .id("changes-collapse-all")
                      .size(22)
                      .flex_none()
                      .items_center()
                      .justify_center()
                      .rounded(RADIUS.small)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).border_color(t.dim))
                      .tooltip("Collapse all folders")
                      .on_click((_e, cx) => this.collapseAll(cx))
                      .child(
                        Icon("chevron-right", 12)
                          .text_color(t.muted)
                      )
                  )
                  .child(
                    h_flex()
                      .id("changes-expand-all")
                      .size(22)
                      .flex_none()
                      .items_center()
                      .justify_center()
                      .rounded(RADIUS.small)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).border_color(t.dim))
                      .tooltip("Expand all folders")
                      .on_click((_e, cx) => this.expandAll(cx))
                      .child(
                        Icon("chevron-down", 12)
                          .text_color(t.muted)
                      )
                  )
              )
          )
      )
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(
        div()
          .flex_1()
          .min_h(44)
          .when(Boolean(this.open), (el) =>
            el.max_h(rowCount * 28 + 12).border_b(1).border_color(t.border)
          )
          .relative()
          .child(
            v_flex()
              .id("changes-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .children(fileRows)
              .when(!this.files.length, (e) =>
                e.child(
                  div()
                    .p(8)
                    .text_color(t.dim)
                    .child(
                      this.error ||
                        (this.loading
                          ? "Loading changes…"
                          : this.root
                          ? "No uncommitted changes"
                          : "No folder")
                    )
                )
              )
          )
          .child(Scrollbar.vertical("changes-list").absolute().inset_0())
      )
      .when(this.limited, (el) =>
        el.child(
          div()
            .px(12)
            .py(4)
            .text_size(11)
            .text_color(t.dim)
            .child("Showing the first 1,000 changed files")
        )
      )
      .when(Boolean(this.open), (el) =>
        el.child(
          div()
            .flex_1()
            .min_h(0)
            .relative()
            .font_family(settings().font_family ?? "JetBrains Mono")
            .text_size(11)
            .child(
              div()
                .id("changes-diff-x")
                .size_full()
                .overflow_x_scrollbar()
                .child(
                  div()
                    .w_full()
                    .min_w(this.diffWidth)
                    .h_full()
                    .child(
                      v_virtual_list(
                        "changes-diff",
                        this.rows.length,
                        20,
                        (i) => String(i),
                        (range) =>
                          this.rows
                            .slice(range.start, range.end)
                            .map((row) => this.diffRow(row, t))
                      ).size_full()
                    )
                )
            )
            .child(
              Scrollbar.vertical("changes-diff")
                .viewport_from_layout()
                .absolute()
                .inset_0()
            )
        )
      )
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")))
      .when(this.repoMenuOpen && this.repos.length > 1, (el) =>
        el
          .child(
            div()
              .id("changes-repo-backdrop")
              .absolute()
              .inset_0()
              .bg("#00000001")
              .on_mouse_down("left", (_e, cx) => {
                this.repoMenuOpen = false;
                cx.stop_propagation();
                cx.notify();
              })
              .on_click((_e, cx) => {
                this.repoMenuOpen = false;
                cx.stop_propagation();
                cx.notify();
              })
          )
          .child(this.repoDropdown(t))
      );
  }
}

