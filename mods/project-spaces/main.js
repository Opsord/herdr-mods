// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, appHome, readTextFile, props } from "herdr";
import SubrepoMenu from "./menu.js";
import BranchSwitcher from "./branch-switcher.js";
import { TEXT, RADIUS, SIZE, Badge, Icon, IconButton } from "./ui.js";

const ROLES = {
  menu: SubrepoMenu,
  "branch-switcher": BranchSwitcher,
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role];
    if (R) {
      this.delegate = new R();
      this.delegate.init?.(pr, cx);
      return;
    }
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    this.subrepos = {}; // space.id -> [ { name, path, relative, spaceId, machine } ]
    this.subreposScanning = new Set();
    this.subreposChecked = {}; // space.id -> timestamp
    this.subreposConfig = { max_depth: 2 };
    this.subreposFolded = new Set(JSON.parse(localStorage.getItem("spaces.subrepos_folded") ?? "[]"));
    this.subfoldersFolded = new Set(JSON.parse(localStorage.getItem("spaces.subfolders_folded") ?? "[]"));
    this.searchOpen = false;
    this.searchQuery = "";
    this.lastSharedGitRefresh = null;
    this.searchInput = InputState.new({ placeholder: "Filter repositories…" });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = (this.searchInput.value() || "").trim();
      cx.notify();
    });
    this.loadSubreposConfig(cx);
    this.checkSubrepos(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  toggleSubrepos(spaceId, cx) {
    if (this.subreposFolded.has(spaceId)) {
      this.subreposFolded.delete(spaceId);
    } else {
      this.subreposFolded.add(spaceId);
    }
    localStorage.setItem("spaces.subrepos_folded", JSON.stringify([...this.subreposFolded]));
    cx.notify();
  }

  toggleSubfolder(spaceId, relPath, cx) {
    const key = `${spaceId}:${relPath}`;
    if (this.subfoldersFolded.has(key)) {
      this.subfoldersFolded.delete(key);
    } else {
      this.subfoldersFolded.add(key);
    }
    localStorage.setItem("spaces.subfolders_folded", JSON.stringify([...this.subfoldersFolded]));
    cx.notify();
  }

  loadSubreposConfig(cx) {
    cx.spawn(async () => {
      try {
        const raw = await readTextFile("subrepos.json");
        if (raw) {
          const cfg = JSON.parse(raw);
          if (typeof cfg.max_depth === "number") this.subreposConfig.max_depth = cfg.max_depth;
          if (Array.isArray(cfg.exclude)) this.subreposConfig.exclude = cfg.exclude;
        }
      } catch {}
    });
  }

  checkSubrepos(cx) {
    const sp = spaces();
    const now = Date.now();
    const ps = panes();
    for (const space of sp) {
      const lastCheck = this.subreposChecked[space.id] ?? 0;
      const currentFolder = place(space, ps);
      const folderChanged = this.subreposFolder?.[space.id] !== currentFolder;
      const interval = space.active ? 20000 : 60000;
      if ((now - lastCheck > interval || folderChanged || !(space.id in this.subrepos)) && !this.subreposScanning.has(space.id)) {
        this.scanSpaceSubrepos(space, cx);
      }
    }
  }

  scanSpaceSubrepos(space, cx) {
    const ps = panes();
    const folder = place(space, ps);
    if (!folder) {
      this.subrepos[space.id] = [];
      this.subreposChecked[space.id] = Date.now();
      return;
    }
    this.subreposFolder ??= {};
    this.subreposFolder[space.id] = folder;
    this.subreposScanning.add(space.id);
    this.subreposChecked[space.id] = Date.now();

    cx.spawn(async (cx) => {
      try {
        const depth = this.subreposConfig.max_depth ?? 2;
        const exclusions = (this.subreposConfig.exclude ?? [
          "node_modules", "dist", "target", ".venv", "vendor", ".cache", "build", ".next", ".git"
        ]).join(",");

        let list = [];
        const isWin = !space.machine && window()?.platform === "windows";
        if (isWin) {
          // Local Windows machine: use fast scan.ps1
          const scriptPath = `${appHome().replace(/\\/g, "/")}/mods/project-spaces/scan.ps1`;
          const r = await exec("powershell", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Path",
            folder,
            "-Depth",
            String(depth),
            "-Exclude",
            exclusions,
          ]);

          if (r.code === 0 && r.stdout) {
            const lines = r.stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            list = lines.map((line) => {
              const p = line.replace(/\\/g, "/");
              return {
                name: base(p),
                path: p,
                spaceId: space.id,
                machine: null,
              };
            });
          }
        } else {
          // macOS, Linux, or remote machine: use cross-platform find
          const r = await exec("sh", ["-c", `find . -maxdepth ${depth + 1} -name .git -print`], { cwd: folder, on: space.machine ?? null });
          if (r.code === 0 && r.stdout) {
            const rawLines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            list = rawLines.map(line => {
              const cleaned = line.replace(/\/\.git$/, "").replace(/^\.\//, "");
              const full = cleaned ? `${folder}/${cleaned}` : folder;
              return { name: base(full), path: full.replace(/\\/g, "/"), spaceId: space.id, machine: space.machine ?? null };
            }).filter(item => item.path !== folder.replace(/\\/g, "/"));
          }
        }

        this.subrepos[space.id] = list;

        // Request git status for discovered child repos
        const gitKeys = list.map((item) => JSON.stringify([item.machine, item.path]));
        if (gitKeys.length) this.refreshGit(gitKeys, cx);
      } catch {
        this.subrepos[space.id] = [];
      } finally {
        this.subreposScanning.delete(space.id);
        cx.notify();
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    this.checkSubrepos(cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  subrepoMenu(space, sub) {
    openOverlay({
      mod: "project-spaces",
      kind: "popup",
      width: 220,
      height: 320,
      props: {
        role: "menu",
        sub,
        spaceId: space.id,
        machine: space.machine ?? null,
        folder: sub.path,
        isGit: true,
      },
    });
  }

  folderMenu(space, dir) {
    openOverlay({
      mod: "project-spaces",
      kind: "popup",
      width: 220,
      height: 130,
      props: {
        role: "menu",
        sub: { name: dir.name },
        spaceId: space.id,
        machine: space.machine ?? null,
        folder: dir.fullPath,
        isGit: false,
      },
    });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  buildSubrepoTree(subs, rootFolder) {
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const rootNorm = norm(rootFolder);

    const rootNode = {
      dirs: new Map(),
      repos: [],
    };

    for (const sub of subs) {
      const subNorm = norm(sub.path);
      let rel = subNorm;
      if (subNorm.toLowerCase().startsWith(rootNorm.toLowerCase() + "/")) {
        rel = subNorm.slice(rootNorm.length + 1);
      }
      const parts = rel.split("/").filter(Boolean);
      if (parts.length <= 1) {
        // Direct child repository of the space
        rootNode.repos.push({ ...sub, relPath: rel });
      } else {
        // Nested inside intermediate directories
        let current = rootNode;
        for (let i = 0; i < parts.length - 1; i++) {
          const dirName = parts[i];
          if (!current.dirs.has(dirName)) {
            const dirRelPath = parts.slice(0, i + 1).join("/");
            const dirFullPath = `${rootNorm}/${dirRelPath}`;
            current.dirs.set(dirName, {
              name: dirName,
              relPath: dirRelPath,
              fullPath: dirFullPath,
              dirs: new Map(),
              repos: [],
            });
          }
          current = current.dirs.get(dirName);
        }
        current.repos.push({ ...sub, relPath: rel });
      }
    }

    return rootNode;
  }

  renderSubrepoTree(space, node, depth, hasParentFolder, activeCwds, t, ps) {
    const rows = [];
    const dirList = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const repoList = [...node.repos].sort((a, b) => a.name.localeCompare(b.name));
    const q = (this.searchQuery || "").toLowerCase();

    for (const dir of dirList) {
      const isFolded = q ? false : this.subfoldersFolded.has(`${space.id}:${dir.relPath}`);
      rows.push(this.subfolderRow(space, dir, depth, activeCwds, t));
      if (!isFolded) {
        rows.push(...this.renderSubrepoTree(space, dir, depth + 1, true, activeCwds, t, ps));
      }
    }

    for (let i = 0; i < repoList.length; i++) {
      const repo = repoList[i];
      const isLast = i === repoList.length - 1;
      rows.push(this.subrepoRow(space, repo, depth, isLast, hasParentFolder, activeCwds, t, ps));
    }

    return rows;
  }

  subfolderRow(space, dir, depth, activeCwds, t) {
    const isFolded = this.subfoldersFolded.has(`${space.id}:${dir.relPath}`);
    const indent = 16 + depth * 14;
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const isCurrent = activeCwds.has(norm(dir.fullPath));

    return h_flex()
      .id(`subfolder-${space.id}-${dir.relPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`)
      .h(SIZE.row)
      .flex_none()
      .px(8)
      .pl(indent)
      .gap(6)
      .items_center()
      .rounded(RADIUS.control)
      .cursor_pointer()
      .tooltip(isFolded ? `Expand ${dir.name}` : `Collapse ${dir.name}`)
      .when(isCurrent, (el) => el.bg(t.raised))
      .when(!isCurrent, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!space.active) {
          run("space.select", { id: space.id });
        }
        this.toggleSubfolder(space.id, dir.relPath, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.folderMenu(space, dir);
      })
      .child(
        Icon(isFolded ? "chevron-right" : "chevron-down", 11)
          .text_color(t.dim)
      )
      .child(
        Icon("folder", 13)
          .text_color(isCurrent ? t.accent : t.dim)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT.body)
          .font_medium()
          .text_color(isCurrent ? t.foreground : t.muted)
          .child(dir.name)
      );
  }

  focusPaneOrAgent(space, targetPane, cx) {
    if (!targetPane) return;
    if (!space.active) {
      run("space.select", { id: space.id });
    }
    const activeTab = space.tabs?.find((t) => t.active);
    if (!activeTab || activeTab.id !== targetPane.tab) {
      run("tab.select", { id: targetPane.tab });
    }
    run("pane.focus", { pane: targetPane.pane });
    if (targetPane.terminal && (targetPane.status || targetPane.program?.agent || targetPane.app)) {
      run("agent.focus", { terminal: targetPane.terminal });
    }
    cx.notify();
  }

  subrepoLiveBadges(space, subPath, ps, isCurrent, t) {
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const targetNorm = norm(subPath);
    const spaceTabIds = new Set((space.tabs ?? []).map((tab) => tab.id));

    const matchingPanes = (ps ?? []).filter((p) => {
      if (!p.cwd || !spaceTabIds.has(p.tab)) return false;
      const cwdNorm = norm(p.cwd);
      return cwdNorm === targetNorm || cwdNorm.startsWith(targetNorm + "/");
    });

    if (!matchingPanes.length) return [];

    const terminalsCount = matchingPanes.filter((p) => p.terminal).length;
    const agentsInRepo = matchingPanes.filter((p) => Boolean(p.status || p.program?.agent || p.app));

    let mostUrgent = null;
    const priorities = { blocked: 4, done: 3, working: 2, idle: 1 };
    for (const a of agentsInRepo) {
      const s = a.status ?? (a.program?.agent ? "working" : "idle");
      if (!mostUrgent || (priorities[s] ?? 0) > (priorities[mostUrgent] ?? 0)) {
        mostUrgent = s;
      }
    }

    const badges = [];

    // Terminal count badge (interactive: click to focus pane)
    if (terminalsCount > 0) {
      const firstTerm = matchingPanes.find((p) => p.terminal) || matchingPanes[0];
      badges.push(
        h_flex()
          .gap(3)
          .items_center()
          .px(4)
          .py(1)
          .rounded(RADIUS.small)
          .border_1()
          .border_color(isCurrent ? t.accent : t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`${terminalsCount} terminal${terminalsCount === 1 ? "" : "s"} open (click to focus)`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.focusPaneOrAgent(space, firstTerm, cx);
          })
          .child(Icon("terminal", 10).text_color(isCurrent ? t.accent : t.dim))
          .child(
            div()
              .text_size(TEXT.badge)
              .font_medium()
              .text_color(isCurrent ? t.accent : t.muted)
              .child(String(terminalsCount))
          )
      );
    }

    // Agent status badge (interactive: click to focus agent)
    if (agentsInRepo.length > 0) {
      let statusColor = t.dim;
      if (mostUrgent === "blocked") statusColor = t.blocked ?? "#ef4444";
      else if (mostUrgent === "working") statusColor = t.ansi3 ?? "#e3814f";
      else if (mostUrgent === "done") statusColor = t.ansi2 ?? "#3fae6a";

      const targetAgent = agentsInRepo.find(
        (a) => (a.status ?? (a.program?.agent ? "working" : "idle")) === mostUrgent
      ) || agentsInRepo[0];

      const agentName = agentsInRepo.length === 1
        ? (agentsInRepo[0].program?.name || agentsInRepo[0].app || "Agent")
        : `${agentsInRepo.length} agents`;

      const label = mostUrgent === "blocked" ? "needs you" : agentName;

      badges.push(
        h_flex()
          .gap(3)
          .items_center()
          .px(4)
          .py(1)
          .rounded(RADIUS.small)
          .border_1()
          .border_color(statusColor)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`${agentName} (${mostUrgent ?? "idle"}) - click to focus`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.focusPaneOrAgent(space, targetAgent, cx);
          })
          .child(Icon("bot", 11).text_color(statusColor))
          .child(
            div()
              .text_size(TEXT.badge)
              .font_medium()
              .text_color(statusColor)
              .child(label)
          )
      );
    }

    return badges;
  }

  subrepoRow(space, sub, depth, isLast, hasParentFolder, activeCwds, t, ps) {
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const subNorm = norm(sub.path);
    const isCurrent = activeCwds.has(subNorm);

    const gitKey = JSON.stringify([sub.machine, sub.path]);
    const g = this.git[gitKey];
    const liveBadges = this.subrepoLiveBadges(space, sub.path, ps, isCurrent, t);
    const subGit = this.gitSubtitle(g, sub.name, t, liveBadges);
    const height = subGit ? SIZE.rowDetail : SIZE.row;
    const indent = 16 + depth * 14;

    return v_flex()
      .id(`subrepo-${space.id}-${(sub.relPath || sub.name).replace(/[^a-zA-Z0-9_-]/g, "-")}`)
      .px(8)
      .pl(indent)
      .h(height)
      .flex_none()
      .justify_center()
      .rounded(RADIUS.row)
      .cursor_pointer()
      .when(isCurrent, (el) => el.bg(t.raised))
      .when(!isCurrent, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        // If clicking a subrepo of a space that is not active, select the space first
        if (!space.active) {
          run("space.select", { id: space.id });
        }
        const psList = ps ?? panes();
        const spaceTabIds = new Set((space.tabs ?? []).map((tab) => tab.id));
        const existingPane = psList.find(
          (p) =>
            spaceTabIds.has(p.tab) &&
            p.cwd &&
            norm(p.cwd) === subNorm
        );

        if (existingPane) {
          run("tab.select", { id: existingPane.tab });
        } else {
          run("tab.new", { space: space.id, folder: sub.path, name: sub.name });
        }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.subrepoMenu(space, sub);
      })
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            Icon("branch", 13)
              .text_color(isCurrent ? t.accent : t.dim)
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(TEXT.body)
              .font_medium()
              .text_color(isCurrent ? t.foreground : t.muted)
              .child(sub.name)
          )
          .child(
            h_flex()
              .flex_none()
              .gap(1)
              .items_center()
              .child(
                IconButton({
                  id: `new-tab-${sub.name}`,
                  icon: "plus",
                  label: "New tab in this repo",
                  iconSize: 11,
                  muted: true,
                  onClick: (cx) => {
                    if (!space.active) run("space.select", { id: space.id });
                    run("tab.new", { space: space.id, folder: sub.path, name: sub.name });
                    cx.notify();
                  },
                })
              )
              .child(
                IconButton({
                  id: `split-right-${sub.name}`,
                  icon: "panel-right",
                  label: "Split terminal right",
                  iconSize: 11,
                  muted: true,
                  onClick: (cx) => {
                    if (!space.active) run("space.select", { id: space.id });
                    run("terminal.open", { folder: sub.path, place: "right" });
                    cx.notify();
                  },
                })
              )
              .child(
                IconButton({
                  id: `subrepo-menu-btn-${sub.name}`,
                  icon: "ellipsis",
                  label: "More options…",
                  iconSize: 11,
                  muted: true,
                  onClick: (_cx) => {
                    this.subrepoMenu(space, sub);
                  },
                })
              )
          )
      )
      .when(Boolean(subGit), (el) => el.child(subGit));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const ps = panes();
    const q = (this.searchQuery || "").toLowerCase();

    const draw = (r) => {
      if (collapsed) return [this.compact(r, t)];
      const mainRow = this.row(r, t, ps);

      let subs = this.subrepos[r.w.id] ?? [];
      const isScanning = this.subreposScanning.has(r.w.id);

      if (q) {
        const spaceMatches = (r.w.name || "").toLowerCase().includes(q);
        subs = subs.filter((s) => {
          const branch = this.git[JSON.stringify([s.machine, s.path])]?.branch || "";
          return (
            (s.name || "").toLowerCase().includes(q) ||
            (s.relPath || "").toLowerCase().includes(q) ||
            branch.toLowerCase().includes(q)
          );
        });
        if (!spaceMatches && !subs.length) {
          return [];
        }
      }

      const isFolded = q ? false : this.subreposFolded.has(r.w.id);
      if (isFolded) return [mainRow];

      const activeTab = r.w.tabs?.find((tab) => tab.active);
      const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const activeCwds = new Set(
        ps.filter((p) => p.tab === activeTab?.id && p.cwd).map((p) => norm(p.cwd))
      );

      const tree = this.buildSubrepoTree(subs, place(r.w, ps));
      const subRows = this.renderSubrepoTree(r.w, tree, 0, false, activeCwds, t, ps);
      if (isScanning && !subs.length) {
        subRows.push(
          h_flex()
            .id(`scanning-${r.w.id}`)
            .h(22)
            .pl(28)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child("Scanning repos…")
        );
      }
      return [mainRow, ...subRows];
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(Icon(m ? "server" : "monitor", 13))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(Icon(folded ? "chevron-right" : "chevron-down", 11)));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(RADIUS.control)
        .text_size(TEXT.body).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(Icon("plus", 12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  gitSubtitle(g, name, t, liveBadges = []) {
    const hasBranch = Boolean(g && g.branch);
    const hasBadges = Boolean(liveBadges && liveBadges.length);
    if (!hasBranch && !hasBadges) return null;

    const same = (a) => (name ?? "").toLowerCase() === (g?.name ?? "").toLowerCase();
    const repo = same(name) ? "" : (g?.name ?? "");
    const branch = g?.branch ?? "";
    const label = [repo, branch].filter(Boolean).join(" · ");

    return h_flex()
      .h(16)
      .gap(5)
      .items_center()
      .text_size(TEXT.label)
      .text_color(t.dim)
      .when(Boolean(label), (el) =>
        el
          .child(Icon("git-branch", 11).text_color(t.dim))
          .child(div().min_w(0).truncate().child(label))
      )
      .child(div().flex_1())
      .when(g?.ahead > 0, (el) => el.child(Badge(`↑${g.ahead}`, "success")))
      .when(g?.behind > 0, (el) => el.child(Badge(`↓${g.behind}`, "warning")))
      .children(liveBadges);
  }

  spaceLiveBadges(space, ps, t) {
    const spaceTabIds = new Set((space.tabs ?? []).map((tab) => tab.id));
    const matchingPanes = (ps ?? []).filter((p) => spaceTabIds.has(p.tab));
    if (!matchingPanes.length) return [];

    const terminalsCount = matchingPanes.filter((p) => p.terminal).length;
    const agentsInSpace = matchingPanes.filter((p) => Boolean(p.status || p.program?.agent || p.app));

    let mostUrgent = null;
    const priorities = { blocked: 4, done: 3, working: 2, idle: 1 };
    for (const a of agentsInSpace) {
      const s = a.status ?? (a.program?.agent ? "working" : "idle");
      if (!mostUrgent || (priorities[s] ?? 0) > (priorities[mostUrgent] ?? 0)) {
        mostUrgent = s;
      }
    }

    const badges = [];
    if (terminalsCount > 0) {
      const firstTerm = matchingPanes.find((p) => p.terminal) || matchingPanes[0];
      badges.push(
        h_flex()
          .gap(3)
          .items_center()
          .px(4)
          .py(1)
          .rounded(RADIUS.small)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`${terminalsCount} terminal${terminalsCount === 1 ? "" : "s"} in this space (click to focus)`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.focusPaneOrAgent(space, firstTerm, cx);
          })
          .child(Icon("terminal", 10).text_color(t.dim))
          .child(
            div()
              .text_size(TEXT.badge)
              .font_medium()
              .text_color(t.muted)
              .child(String(terminalsCount))
          )
      );
    }

    if (agentsInSpace.length > 0) {
      let statusColor = t.dim;
      if (mostUrgent === "blocked") statusColor = t.blocked ?? "#ef4444";
      else if (mostUrgent === "working") statusColor = t.ansi3 ?? "#e3814f";
      else if (mostUrgent === "done") statusColor = t.ansi2 ?? "#3fae6a";

      const targetAgent = agentsInSpace.find(
        (a) => (a.status ?? (a.program?.agent ? "working" : "idle")) === mostUrgent
      ) || agentsInSpace[0];

      const agentName = agentsInSpace.length === 1
        ? (agentsInSpace[0].program?.name || agentsInSpace[0].app || "Agent")
        : `${agentsInSpace.length} agents`;

      const label = mostUrgent === "blocked" ? "needs you" : agentName;

      badges.push(
        h_flex()
          .gap(3)
          .items_center()
          .px(4)
          .py(1)
          .rounded(RADIUS.small)
          .border_1()
          .border_color(statusColor)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`${agentName} (${mostUrgent ?? "idle"}) - click to focus`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.focusPaneOrAgent(space, targetAgent, cx);
          })
          .child(Icon("bot", 11).text_color(statusColor))
          .child(
            div()
              .text_size(TEXT.badge)
              .font_medium()
              .text_color(statusColor)
              .child(label)
          )
      );
    }

    return badges;
  }

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" · ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(TEXT.label)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(Badge(`↑${g.ahead}`, "success")))
      .when(g.behind > 0, (el) => el.child(Badge(`↓${g.behind}`, "warning")));
  }

  row({ w, i, g, tree }, t, ps) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);

    const subs = this.subrepos[w.id] ?? [];
    const isScanning = this.subreposScanning.has(w.id);
    const hasSubs = subs.length > 0 || isScanning;
    const isFolded = this.subreposFolded.has(w.id);
    const liveBadges = this.spaceLiveBadges(w, ps, t);
    const subGit = this.gitSubtitle(g, w.name, t, liveBadges);
    const height = subGit ? SIZE.rowDetail : (tree ? SIZE.row : SIZE.row + 2);

    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(height)
      .flex_none()
      .justify_center()
      .rounded(RADIUS.row)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(Boolean(tree), el => el.pl(20).child(Icon("branch", 13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(RADIUS.small).bg(fill).items_center().justify_center().text_size(TEXT.avatar).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .justify_center()
              .gap(1)
              .child(div().min_w(0).truncate().text_size(TEXT.body).font_medium().text_color(t.foreground).child(w.name))
              .when(Boolean(subGit), el => el.child(subGit))
          )
          .when(hasSubs, el => el.child(
            h_flex()
              .id(`fold-btn-${w.id}`)
              .size(20)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(RADIUS.small)
              .hover(s => s.bg(t.hover))
              .cursor_pointer()
              .tooltip(isFolded ? "Expand sub-repositories" : "Collapse sub-repositories")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.toggleSubrepos(w.id, cx);
              })
              .child(Icon(isFolded ? "chevron-right" : "chevron-down", 12).text_color(t.dim))
          ))
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render(cx) {
    if (this.delegate) return this.delegate.render(cx);
    const refreshReq = shared("project_spaces.refresh_git");
    if (refreshReq && refreshReq !== this.lastSharedGitRefresh) {
      this.lastSharedGitRefresh = refreshReq;
      const keys = Object.keys(this.git);
      if (keys.length) this.refreshGit(keys, cx);
    }
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(TEXT.body)
      .child(
        h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(TEXT.caption).text_color(t.dim)
          .when(!collapsed, el => el.child("Spaces"))
          .child(
            h_flex().gap(2).items_center()
              .when(!collapsed, el => el.child(
                IconButton({
                  id: "toggle-search",
                  icon: "search",
                  label: "Filter spaces and repositories",
                  iconSize: 13,
                  muted: !this.searchOpen,
                  onClick: (cx) => {
                    this.searchOpen = !this.searchOpen;
                    if (!this.searchOpen) {
                      this.searchQuery = "";
                      this.searchInput?.set_value("");
                    }
                    cx.notify();
                  }
                })
              ))
              .child(
                IconButton({
                  id: "space-new",
                  icon: "plus",
                  label: "New space",
                  iconSize: 14,
                  muted: true,
                  onClick: () => run("space.new")
                })
              )
          )
      )
      .when(this.searchOpen && !collapsed, el =>
        el.child(
          h_flex()
            .h(28)
            .mx(8)
            .mb(6)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(RADIUS.control)
            .border_1()
            .border_color(t.border)
            .bg(t.raised)
            .on_key_down((e, cx) => {
              if (e.key === "escape") {
                this.searchOpen = false;
                this.searchQuery = "";
                this.searchInput?.set_value("");
                cx.stop_propagation();
                cx.notify();
              }
            })
            .child(Icon("search", 12).text_color(t.dim))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .h_full()
                .flex()
                .items_center()
                .child(
                  Input.new(this.searchInput)
                    .h_full()
                    .text_size(TEXT.caption)
                    .text_color(t.foreground)
                )
            )
            .when(Boolean(this.searchQuery), e =>
              e.child(
                IconButton({
                  id: "clear-search",
                  icon: "x",
                  label: "Clear filter",
                  iconSize: 11,
                  muted: true,
                  onClick: (cx) => {
                    this.searchQuery = "";
                    this.searchInput?.set_value("");
                    cx.notify();
                  }
                })
              )
            )
        )
      )
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}


