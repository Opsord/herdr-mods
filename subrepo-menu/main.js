import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, notify } from "herdr";

export default class SubrepoMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    return [
      {
        label: "Switch branch…",
        icon: "mods/workspace-chrome/git-branch.svg",
        action: "branch-switch",
      },
      {
        label: "Open in new tab",
        icon: "mods/workspace-chrome/plus.svg",
        action: "tab.new",
      },
      {
        label: "Split right",
        icon: "mods/workspace-chrome/panel-right.svg",
        action: "pane.split",
      },
      {
        label: "Copy path",
        icon: "mods/workspace-chrome/folder.svg",
        action: "copy",
      },
    ];
  }

  choose(i, cx) {
    const list = this.items();
    const it = list[i];
    if (!it) return;
    const p = props() ?? {};
    closeOverlay(p.overlay);

    if (it.action === "branch-switch") {
      openOverlay({
        mod: "branch-switcher",
        kind: "dialog",
        width: 500,
        height: 440,
        props: {
          sub: p.sub,
          spaceId: p.spaceId,
          machine: p.machine,
          folder: p.folder,
        },
      });
    } else if (it.action === "tab.new") {
      if (p.spaceId) run("space.select", { id: p.spaceId });
      run("tab.new", { space: p.spaceId, folder: p.folder, name: p.sub?.name });
    } else if (it.action === "pane.split") {
      if (p.spaceId) run("space.select", { id: p.spaceId });
      run("pane.split", { direction: "right", folder: p.folder });
    } else if (it.action === "copy") {
      if (p.folder) {
        cx.write_to_clipboard(p.folder);
        notify({ body: `Path copied: ${p.folder}`, timeout: 2000 });
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
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
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
          .py(4)
          .items_center()
          .gap(6)
          .text_size(11)
          .text_color(t.dim)
          .child(svg("mods/workspace-chrome/folder.svg").size(11).text_color(t.dim))
          .child(div().truncate().child(p.sub?.name ?? "Sub-repository"))
      )
      .child(div().mx(4).my(2).h(1).bg(t.border))
      .children(
        list.map((it, i) =>
          h_flex()
            .id(`smi-${i}`)
            .h(30)
            .px(8)
            .gap(9)
            .rounded(6)
            .items_center()
            .text_color(t.foreground)
            .cursor_pointer()
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(it.icon).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it.label))
        )
      );
  }
}
