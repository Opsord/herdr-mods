import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, exec } from "herdr";
import { TEXT, RADIUS, SIZE, Badge, Icon } from "./ui.js";

export default class BranchSwitcher extends View {
  init(_props, cx) {
    this.branches = [];
    this.currentBranch = "";
    this.fetching = false;
    this.busy = false;
    this.error = "";
    this.at = 0;
    this.text = "";

    this.input = InputState.new({
      value: "",
      placeholder: "Search local or remote branch…",
    });
    this.inputFocused = true;
    this.input.on("change", () => {
      this.text = this.input.value();
      this.at = 0;
      this.error = "";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      const list = this.shown();
      if (list[this.at]) this.checkout(list[this.at], cx);
    });
    this.input.on("focus", () => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", () => {
      this.inputFocused = false;
      cx.notify();
    });

    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(200, () => this.input.focus());

    const p = props() ?? {};
    if (p.folder) {
      cx.spawn(async (cx) => {
        // 1. Load existing branches immediately
        await this.loadBranches(p.folder, p.machine);
        cx.notify();

        // 2. Check if remotes exist before fetching
        try {
          const remotesCheck = await exec("git", ["remote"], {
            cwd: p.folder,
            on: p.machine,
          });
          const hasRemotes =
            remotesCheck.code === 0 && remotesCheck.stdout.trim().length > 0;

          if (hasRemotes) {
            this.fetching = true;
            cx.notify();

            await exec("git", ["fetch", "--prune", "--no-tags"], {
              cwd: p.folder,
              on: p.machine,
            });
            await this.loadBranches(p.folder, p.machine);
          }
        } catch {
        } finally {
          this.fetching = false;
          cx.notify();
        }
      });
    }
  }

  async loadBranches(cwd, on) {
    try {
      const r = await exec(
        "git",
        [
          "for-each-ref",
          "--format=%(refname)%09%(refname:short)%09%(HEAD)",
          "refs/heads/",
          "refs/remotes/",
        ],
        { cwd, on }
      );

      if (r.code !== 0) return;

      const lines = r.stdout.split(/\r?\n/).filter(Boolean);
      const locals = [];
      const remotes = [];
      let foundHead = false;

      for (const line of lines) {
        const [fullRef, shortRef, head] = line.split("\t");
        if (!fullRef) continue;

        // Skip symbolic remote references like origin/HEAD
        if (
          fullRef.startsWith("refs/remotes/") &&
          (shortRef.endsWith("/HEAD") || !shortRef.includes("/"))
        ) {
          continue;
        }

        const isHead = head === "*";
        const isLocal = fullRef.startsWith("refs/heads/");
        const isRemote = fullRef.startsWith("refs/remotes/");

        if (isLocal) {
          const branchName = fullRef.slice("refs/heads/".length);
          if (isHead) {
            this.currentBranch = branchName;
            foundHead = true;
          }
          locals.push({
            name: branchName,
            simpleName: branchName,
            fullRef,
            isRemote: false,
            isCurrent: isHead,
          });
        } else if (isRemote) {
          const remotePath = fullRef.slice("refs/remotes/".length);
          const slashIdx = remotePath.indexOf("/");
          const remoteName = slashIdx !== -1 ? remotePath.slice(0, slashIdx) : "";
          const branchName =
            slashIdx !== -1 ? remotePath.slice(slashIdx + 1) : remotePath;

          remotes.push({
            name: shortRef,
            simpleName: branchName,
            remoteName,
            fullRef,
            isRemote: true,
            isCurrent: isHead,
          });
        }
      }

      if (!foundHead) {
        const headCheck = await exec(
          "git",
          ["rev-parse", "--short", "HEAD"],
          { cwd, on }
        );
        if (headCheck.code === 0) {
          this.currentBranch = `HEAD (${headCheck.stdout.trim()})`;
        }
      }

      // De-duplicate: filter out remotes that have an identical local branch
      const localNames = new Set(locals.map((l) => l.name));
      const filteredRemotes = remotes.filter(
        (r) => !localNames.has(r.simpleName)
      );

      // Sort: current branch first, then locals alphabetically, then remotes alphabetically
      locals.sort((a, b) => {
        if (a.isCurrent) return -1;
        if (b.isCurrent) return 1;
        return a.name.localeCompare(b.name);
      });
      filteredRemotes.sort((a, b) => a.name.localeCompare(b.name));

      this.branches = [...locals, ...filteredRemotes];
    } catch {}
  }

  shown() {
    const q = this.text.trim().toLowerCase();
    if (!q) return this.branches;
    return this.branches.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.simpleName && b.simpleName.toLowerCase().includes(q))
    );
  }

  checkout(branch, cx) {
    const p = props() ?? {};
    if (!p.folder || this.busy) return;

    if (branch.isCurrent) {
      closeOverlay(p.overlay);
      return;
    }

    this.busy = true;
    this.error = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        let checkoutTarget = branch.name;
        if (branch.isRemote && branch.simpleName) {
          checkoutTarget = branch.simpleName;
        }

        const r = await exec("git", ["checkout", checkoutTarget], {
          cwd: p.folder,
          on: p.machine,
        });

        if (r.code !== 0) {
          this.error = (r.stderr || r.stdout || "Checkout failed").trim();
          this.busy = false;
          cx.notify();
          return;
        }

        closeOverlay(p.overlay);
      } catch (err) {
        this.error = err.message || "Failed to switch branch";
        this.busy = false;
        cx.notify();
      }
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      cx.stop_propagation();
      closeOverlay(props()?.overlay);
      return;
    }

    const list = this.shown();
    if (e.key === "down") {
      this.at = (this.at + 1) % Math.max(1, list.length);
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "up") {
      this.at = (this.at + list.length - 1) % Math.max(1, list.length);
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "enter") {
      cx.stop_propagation();
      if (list[this.at]) this.checkout(list[this.at], cx);
    }
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const rows = this.shown();

    return v_flex()
      .id("branch-switcher")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .rounded(RADIUS.row)
      .border_1()
      .border_color(t.border)
      .text_size(TEXT.body)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(Icon("git-branch", 16).text_color(t.accent))
              .child(
                v_flex()
                  .child(
                    div()
                      .font_semibold()
                      .text_size(TEXT.body)
                      .text_color(t.foreground)
                      .child(`Switch branch: ${p.sub?.name ?? "Repository"}`)
                  )
                  .child(
                    div()
                      .text_size(TEXT.caption)
                      .text_color(t.dim)
                      .child(
                        this.currentBranch
                          ? `Current: ${this.currentBranch}`
                          : "Loading branches…"
                      )
                  )
              )
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(this.fetching, (el) =>
                el
                  .child(
                    svg("mods/project-spaces/icons/chevron-down.svg")
                      .size(12)
                      .text_color(t.dim)
                  )
                  .child(
                    div()
                      .text_size(TEXT.caption)
                      .text_color(t.dim)
                      .child("Fetching remotes…")
                  )
              )
              .child(
                h_flex()
                  .size(SIZE.iconSmall)
                  .rounded(RADIUS.small)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .on_click(() => closeOverlay(p.overlay))
                  .child(
                    div()
                      .text_size(TEXT.caption)
                      .text_color(t.dim)
                      .child("✕")
                  )
              )
          )
      )
      .child(
        Input.new(this.input)
          .h(30)
          .px(10)
          .items_center()
          .rounded(RADIUS.control)
          .border(1)
          .border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background)
          .text_size(TEXT.body)
          .text_color(t.foreground)
      )
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .p(8)
            .rounded(RADIUS.control)
            .bg(t.surface)
            .border(1)
            .border_color(t.blocked ?? "#ef4444")
            .text_size(TEXT.caption)
            .text_color(t.blocked ?? "#ef4444")
            .child(this.error)
        )
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("branch-list")
              .size_full()
              .overflow_y_scroll()
              .gap(2)
              .children(
                rows.map((b, i) => {
                  const on = i === this.at;
                  return h_flex()
                    .id(`branch-${i}`)
                    .flex_none()
                    .h(SIZE.row)
                    .px(8)
                    .gap(8)
                    .items_center()
                    .rounded(RADIUS.control)
                    .cursor_pointer()
                    .when(on, (el) => el.bg(t.selected))
                    .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
                    .on_click(() => this.checkout(b, cx))
                    .child(
                      Icon("git-branch", 13).text_color(
                        b.isCurrent ? t.accent : t.dim
                      )
                    )
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .text_size(TEXT.body)
                        .text_color(b.isCurrent ? t.accent : t.foreground)
                        .font_medium()
                        .child(b.name)
                    )
                    .when(b.isCurrent, (el) =>
                      el.child(Badge("current", "accent"))
                    )
                    .when(!b.isCurrent && b.isRemote, (el) =>
                      el.child(Badge("remote", "dim"))
                    );
                })
              )
              .when(rows.length === 0, (el) =>
                el.child(
                  div()
                    .p(12)
                    .text_center()
                    .text_color(t.dim)
                    .text_size(TEXT.caption)
                    .child(
                      this.fetching
                        ? "Loading branches…"
                        : "No matching branches found."
                    )
                )
              )
          )
          .child(Scrollbar.vertical("branch-list").absolute().inset_0())
      )
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .child(
            div().child(
              this.busy
                ? "Switching branch…"
                : `${rows.length} ${rows.length === 1 ? "branch" : "branches"} available`
            )
          )
          .child(div().child("↑↓ choose · ↵ switch · esc cancel"))
      );
  }
}
