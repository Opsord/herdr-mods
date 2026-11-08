import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
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
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.treeView = JSON.parse(localStorage.getItem("changes.tree_view") ?? "true");
    this.foldedFolders = new Set(JSON.parse(localStorage.getItem("changes.folded_folders") ?? "[]"));
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

  buildChangesTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
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
        svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`)
          .size(11)
          .flex_none()
          .text_color(t.dim)
      )
      .child(
        svg("mods/workspace-chrome/folder.svg")
          .size(13)
          .flex_none()
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
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
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
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
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
    this.closed = !this.open;
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

    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
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
                      .child(`${this.files.length} files`)
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
                          svg("mods/workspace-chrome/check.svg")
                            .size(8)
                            .text_color("#ffffff")
                        )
                      )
                  )
                  .child(
                    div()
                      .text_size(10.5)
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
                      .h(22)
                      .px(6)
                      .gap(4)
                      .flex_none()
                      .items_center()
                      .rounded(5)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).border_color(t.dim))
                      .tooltip("Collapse all folders")
                      .on_click((_e, cx) => this.collapseAll(cx))
                      .child(
                        svg("mods/workspace-chrome/chevron-right.svg")
                          .size(11)
                          .flex_none()
                          .text_color(t.muted)
                      )
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child("Collapse")
                      )
                  )
                  .child(
                    h_flex()
                      .id("changes-expand-all")
                      .h(22)
                      .px(6)
                      .gap(4)
                      .flex_none()
                      .items_center()
                      .rounded(5)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).border_color(t.dim))
                      .tooltip("Expand all folders")
                      .on_click((_e, cx) => this.expandAll(cx))
                      .child(
                        svg("mods/workspace-chrome/chevron-down.svg")
                          .size(11)
                          .flex_none()
                          .text_color(t.muted)
                      )
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child("Expand")
                      )
                  )
              )
          )
      )
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(rowCount * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(fileRows)
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
