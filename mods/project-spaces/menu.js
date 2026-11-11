import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, notify, exec, setShared, window } from "herdr";
import { TEXT, RADIUS, SIZE, Icon } from "./ui.js";

export default class SubrepoMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    const p = props() ?? {};
    const isGit = p.isGit !== false;
    const items = [];
    if (isGit) {
      items.push(
        {
          label: "Switch branch…",
          icon: "git-branch",
          action: "branch-switch",
        },
        {
          label: "Show in Changes",
          icon: "panel-right",
          action: "changes",
        },
        {
          label: "Fetch origin",
          icon: "refresh-cw",
          action: "fetch",
        },
        {
          label: "Pull (fast-forward)",
          icon: "download",
          action: "pull",
        }
      );
    }
    items.push(
      {
        label: "Open in new tab",
        icon: "plus",
        action: "tab.new",
      },
      {
        label: "Split right",
        icon: "panel-right",
        action: "pane.split",
      },
      {
        label: "Copy path",
        icon: "copy",
        action: "copy",
      },
      {
        label: "Reveal in Explorer",
        icon: "folder",
        action: "reveal",
      }
    );
    return items;
  }

  choose(i, cx) {
    const list = this.items();
    const it = list[i];
    if (!it) return;
    const p = props() ?? {};
    closeOverlay(p.overlay);

    if (it.action === "branch-switch") {
      openOverlay({
        mod: "project-spaces",
        kind: "dialog",
        width: 480,
        height: 420,
        props: {
          role: "branch-switcher",
          sub: p.sub,
          spaceId: p.spaceId,
          machine: p.machine,
          folder: p.folder,
        },
      });
    } else if (it.action === "changes") {
      if (p.folder) {
        setShared("project_changes.target_repo", p.folder);
        run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: "changes" });
      }
    } else if (it.action === "fetch") {
      const name = p.sub?.name || "repository";
      notify({ title: "Git Fetch", body: `Fetching ${name}...`, timeout: 2000 });
      exec("git", ["fetch"], { cwd: p.folder, on: p.machine })
        .then((r) => {
          if (r.code === 0) {
            notify({ title: "Git Fetch", body: `Fetched ${name}`, timeout: 2500 });
            setShared("project_spaces.refresh_git", Date.now());
          } else {
            notify({
              title: "Git Fetch Failed",
              body: r.stderr || "Fetch failed",
              level: "warning",
              timeout: 4000,
            });
          }
        })
        .catch((err) => {
          notify({ title: "Git Fetch Error", body: String(err), level: "error" });
        });
    } else if (it.action === "pull") {
      const name = p.sub?.name || "repository";
      notify({ title: "Git Pull", body: `Pulling ${name} (--ff-only)...`, timeout: 2000 });
      exec("git", ["pull", "--ff-only"], { cwd: p.folder, on: p.machine })
        .then((r) => {
          if (r.code === 0) {
            notify({
              title: "Git Pull",
              body: r.stdout.trim() || `Pulled latest changes in ${name}`,
              level: "success",
              timeout: 3000,
            });
            setShared("project_spaces.refresh_git", Date.now());
          } else {
            notify({
              title: "Git Pull Failed",
              body: r.stderr || "Could not fast-forward",
              level: "warning",
              timeout: 5000,
            });
          }
        })
        .catch((err) => {
          notify({ title: "Git Pull Error", body: String(err), level: "error" });
        });
    } else if (it.action === "tab.new") {
      if (p.spaceId) run("space.select", { id: p.spaceId });
      run("tab.new", { space: p.spaceId, folder: p.folder, name: p.sub?.name });
    } else if (it.action === "pane.split") {
      if (p.spaceId) run("space.select", { id: p.spaceId });
      run("terminal.open", { folder: p.folder, place: "right" });
    } else if (it.action === "copy") {
      if (p.folder) {
        cx.write_to_clipboard(p.folder);
        notify({ body: `Path copied: ${p.folder}`, timeout: 2000 });
      }
    } else if (it.action === "reveal") {
      if (p.folder) {
        const plat = window()?.platform;
        const cmd = plat === "windows" ? "explorer.exe" : (plat === "macos" ? "open" : "xdg-open");
        exec(cmd, [p.folder], { on: p.machine });
      }
    }
  }

  render(cx) {
    const t = theme();
    const list = this.items();
    const p = props() ?? {};

    return v_flex()
      .id("subrepo-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .gap(1)
      .rounded(RADIUS.row)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_size(TEXT.menu)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .px(8)
          .py(5)
          .items_center()
          .gap(6)
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .child(Icon(p.isGit === false ? "folder" : "branch", 12).text_color(t.dim))
          .child(
            div()
              .truncate()
              .font_medium()
              .child(p.sub?.name ?? (p.isGit === false ? "Folder" : "Sub-repository"))
          )
      )
      .child(div().mx(4).my(2).h(1).bg(t.border))
      .children(
        list.map((it, i) =>
          h_flex()
            .id(`smi-${i}`)
            .h(SIZE.menu)
            .px(8)
            .gap(8)
            .rounded(RADIUS.control)
            .items_center()
            .text_color(t.foreground)
            .cursor_pointer()
            .when(i === this.at, (el) => el.bg(t.selected))
            .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(Icon(it.icon, 14).text_color(t.muted))
            .child(div().flex_1().child(it.label))
        )
      );
  }
}

