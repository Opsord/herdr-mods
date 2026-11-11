// Design tokens and reusable UI primitives for project-spaces
// Inspired by the Herdr Orca layout conventions
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { theme } from "herdr";

export const TEXT = {
  badge: 10,
  avatar: 10.5,
  caption: 11,
  label: 11.5,
  small: 12,
  menu: 12.8,
  body: 13,
};

export const RADIUS = {
  small: 4,
  control: 6,
  row: 7,
};

export const SIZE = {
  group: 30,
  menu: 30,
  row: 28,
  rowDetail: 44,
  icon: 24,
  iconSmall: 18,
};

export const Icon = (name, size = 14) =>
  svg(`mods/project-spaces/icons/${name}.svg`).size(size).flex_none();

export function Badge(text, variant = "default") {
  const t = theme();
  let bg = null;
  let textColor = t.muted;
  let borderColor = t.border;

  if (variant === "accent" || variant === "current") {
    textColor = t.accent;
    borderColor = t.accent;
    bg = t.raised;
  } else if (variant === "dim") {
    textColor = t.dim;
  } else if (variant === "success") {
    textColor = t.ansi2 ?? "#3fae6a";
  } else if (variant === "warning") {
    textColor = t.ansi3 ?? "#e3814f";
  }

  return div()
    .flex_none()
    .px(5)
    .py(1)
    .rounded(RADIUS.small)
    .border_1()
    .border_color(borderColor)
    .when(Boolean(bg), (el) => el.bg(bg))
    .text_size(TEXT.badge)
    .font_medium()
    .text_color(textColor)
    .child(String(text));
}

export function IconButton({ id, icon, label, onClick, iconSize = 14, muted = false }) {
  const t = theme();
  return div()
    .id(id)
    .size(SIZE.icon)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(RADIUS.control)
    .text_color(muted ? t.dim : t.foreground)
    .cursor_pointer()
    .accessibility_label(label)
    .tooltip(label)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .when(Boolean(onClick), (el) =>
      el.on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
    )
    .child(Icon(icon, iconSize));
}

// Popover container anchored to a trigger
export function PopoverMenu({ id, open, onOpenChange, focus, trigger, children, width = 220 }) {
  const t = theme();
  const body = v_flex()
    .id(`${id}-body`)
    .w(width)
    .p(4)
    .gap(1)
    .rounded(RADIUS.row)
    .border_1()
    .border_color(t.border)
    .bg(t.popover)
    .text_color(t.foreground)
    .track_focus(focus)
    .on_key_down((event, cx) => {
      if (event.key === "escape") {
        cx.stop_propagation();
        onOpenChange(false, cx);
      }
    })
    .children(children);

  return Popover.new(id)
    .open(open)
    .anchor("bottom_left")
    .track_focus(focus)
    .on_open_change((value, cx) => onOpenChange(value, cx))
    .trigger(trigger)
    .when(open, (el) => el.content(body));
}

export function MenuLabel(text) {
  const t = theme();
  return div()
    .px(8)
    .pt(6)
    .pb(2)
    .text_size(TEXT.caption)
    .font_medium()
    .text_color(t.dim)
    .child(text);
}

export function MenuOption({ id, icon, label, selected, onClick }) {
  const t = theme();
  return h_flex()
    .id(id)
    .h(SIZE.menu)
    .flex_none()
    .px(8)
    .gap(8)
    .items_center()
    .rounded(RADIUS.control)
    .cursor_pointer()
    .text_size(TEXT.menu)
    .role("menu_item_radio")
    .aria_selected(Boolean(selected))
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .when(Boolean(icon), (el) => el.child(Icon(icon, 14).text_color(t.muted)))
    .child(div().flex_1().truncate().child(label))
    .when(selected, (el) => el.child(Icon("check", 13).text_color(t.accent)));
}
