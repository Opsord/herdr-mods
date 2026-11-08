import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, exec } from "herdr";

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
      placeholder: "Buscar rama local o remota...",
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
        // 1. Cargar ramas existentes al instante
        await this.loadBranches(p.folder, p.machine);
        cx.notify();

        // 2. Comprobar si hay remotes antes de hacer fetch
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

        // Omitir referencias simbólicas de remotos como origin/HEAD
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
          // Extraer nombre simple de la rama remota (después de refs/remotes/<remote>/)
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

      // Si no se encontró rama actual (HEAD detached), buscar commit corto
      if (!foundHead) {
        const headCheck = await exec(
          "git",
          ["rev-parse", "--short", "HEAD"],
          { cwd, on }
        );
        if (headCheck.code === 0 && headCheck.stdout.trim()) {
          this.currentBranch = `detached (${headCheck.stdout.trim()})`;
        }
      }

      // Priorizar: ramas locales primero, luego ramas remotas no existentes localmente
      const localNames = new Set(locals.map((b) => b.simpleName));
      const filteredRemotes = remotes.filter(
        (b) => !localNames.has(b.simpleName)
      );

      this.branches = [...locals, ...filteredRemotes];
    } catch {}
  }

  shown() {
    const q = this.text.trim().toLowerCase();
    if (!q) return this.branches;
    return this.branches.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.simpleName.toLowerCase().includes(q)
    );
  }

  async checkout(item, cx) {
    if (!item || this.busy) return;
    const p = props() ?? {};

    if (item.isCurrent) {
      closeOverlay(p.overlay);
      return;
    }

    this.busy = true;
    this.error = "";
    cx.notify();

    try {
      let args;
      if (item.isRemote) {
        const localExists = this.branches.some(
          (b) => !b.isRemote && b.simpleName === item.simpleName
        );
        if (localExists) {
          args = ["checkout", item.simpleName];
        } else {
          args = ["checkout", "-b", item.simpleName, "--track", item.name];
        }
      } else {
        args = ["checkout", item.simpleName];
      }

      const r = await exec("git", args, {
        cwd: p.folder,
        on: p.machine,
      });

      this.busy = false;

      if (r.code === 0) {
        closeOverlay(p.overlay);
      } else {
        this.error = (r.stderr || r.stdout || "Error al cambiar de rama").trim();
        cx.notify();
      }
    } catch (e) {
      this.busy = false;
      this.error = String(e?.message ?? e);
      cx.notify();
    }
  }

  key(e, cx) {
    if (e.key === "escape") {
      cx.stop_propagation();
      return closeOverlay(props()?.overlay);
    }
    const list = this.shown();
    if (!list.length) return;

    if (e.key === "down") {
      this.at = (this.at + 1) % list.length;
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "up") {
      this.at = (this.at + list.length - 1) % list.length;
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
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                svg("mods/workspace-chrome/git-branch.svg")
                  .size(16)
                  .text_color(t.accent)
              )
              .child(
                v_flex()
                  .child(
                    div()
                      .font_semibold()
                      .text_color(t.foreground)
                      .child(`Cambiar de rama: ${p.sub?.name ?? "Repositorio"}`)
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(
                        this.currentBranch
                          ? `Rama actual: ${this.currentBranch}`
                          : "Leyendo ramas..."
                      )
                  )
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .when(this.fetching, (el) =>
                el
                  .child(
                    svg("mods/workspace-chrome/spinner.svg")
                      .size(12)
                      .spin(900)
                      .text_color(t.dim)
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child("Actualizando remotas…")
                  )
              )
              .child(
                h_flex()
                  .size(24)
                  .rounded(4)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .on_click(() => closeOverlay(p.overlay))
                  .child(
                    svg("mods/workspace-chrome/x.svg").size(14).text_color(t.dim)
                  )
              )
          )
      )
      .child(
        Input.new(this.input)
          .h(32)
          .px(10)
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background)
          .text_color(t.foreground)
      )
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .p(8)
            .rounded(6)
            .bg(t.surface)
            .border(1)
            .border_color(t.blocked)
            .text_size(11.5)
            .text_color(t.blocked)
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
                    .h(32)
                    .px(10)
                    .gap(8)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(on, (el) => el.bg(t.selected))
                    .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
                    .on_click(() => this.checkout(b, cx))
                    .child(
                      svg("mods/workspace-chrome/git-branch.svg")
                        .size(13)
                        .flex_none()
                        .text_color(b.isCurrent ? t.accent : t.dim)
                    )
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .text_color(b.isCurrent ? t.accent : t.foreground)
                        .font_medium()
                        .child(b.name)
                    )
                    .when(b.isCurrent, (el) =>
                      el.child(
                        div()
                          .flex_none()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.accent)
                          .child("actual")
                      )
                    )
                    .when(!b.isCurrent && b.isRemote, (el) =>
                      el.child(
                        div()
                          .flex_none()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child("remota")
                      )
                    );
                })
              )
              .when(rows.length === 0, (el) =>
                el.child(
                  div()
                    .p(12)
                    .text_center()
                    .text_color(t.dim)
                    .child(
                      this.fetching
                        ? "Buscando ramas..."
                        : "No se encontraron ramas que coincidan."
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
          .text_size(11)
          .text_color(t.dim)
          .child(
            div().child(
              this.busy
                ? "Cambiando de rama..."
                : `${rows.length} ramas disponibles`
            )
          )
          .child(div().child("↑↓ elegir · ↵ cambiar · esc cancelar"))
      );
  }
}
