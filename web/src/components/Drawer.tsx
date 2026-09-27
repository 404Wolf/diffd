import type { JSX } from "solid-js";
import type { Drawer as DrawerState } from "../state/view";

const MIN = 160;
const MAX = 520;
/** Dragging narrower than this collapses the drawer to its handle. */
const COLLAPSE_BELOW = 110;

/**
 * A side panel you resize by dragging its edge. Drag it to the edge of the
 * window and only a thin handle remains; click the handle to bring it back.
 */
export function Drawer(props: {
  side: "left" | "right";
  label: string;
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  /** Shown on the collapsed handle, e.g. unread activity. */
  badge?: boolean;
  children: JSX.Element;
}) {
  let root: HTMLElement | undefined;

  const onPointerDown = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const box = root?.parentElement?.getBoundingClientRect();
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      if (!moved || !box) return;
      const width = props.side === "left" ? ev.clientX - box.left : box.right - ev.clientX;
      if (width < COLLAPSE_BELOW) props.onChange({ size: props.state.size, collapsed: true });
      else props.onChange({ size: Math.max(MIN, Math.min(MAX, width)), collapsed: false });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      if (!moved && props.state.collapsed) props.onChange({ ...props.state, collapsed: false });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onChange({ ...props.state, collapsed: !props.state.collapsed });
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const grow = (e.key === "ArrowRight") === (props.side === "left");
      props.onChange({
        size: Math.max(MIN, Math.min(MAX, props.state.size + (grow ? 16 : -16))),
        collapsed: false,
      });
    }
  };

  return (
    <aside
      ref={root}
      aria-label={props.label}
      class="relative flex min-h-0 min-w-0 bg-panel"
      classList={{
        "border-r border-line": props.side === "left",
        "flex-row-reverse border-l border-line": props.side === "right",
      }}
      style={{ width: props.state.collapsed ? "11px" : `${props.state.size}px` }}
    >
      <div class="min-w-0 flex-1 overflow-auto" classList={{ hidden: props.state.collapsed }}>
        {props.children}
      </div>
      {/* A focusable window splitter (WAI-ARIA): arrows resize, enter collapses. <hr> can't hold the grip. */}
      {/* biome-ignore lint/a11y/useSemanticElements: see above */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${props.label.toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={MAX}
        aria-valuenow={props.state.collapsed ? 0 : props.state.size}
        tabindex="0"
        title={
          props.state.collapsed
            ? `Open ${props.label.toLowerCase()}`
            : "Drag to resize · double-click to close"
        }
        class="group relative z-[4] flex-none touch-none"
        classList={{
          "w-[7px] cursor-col-resize": !props.state.collapsed,
          "-mr-1": !props.state.collapsed && props.side === "left",
          "-ml-1": !props.state.collapsed && props.side === "right",
          "w-[11px] cursor-pointer": props.state.collapsed,
        }}
        onPointerDown={onPointerDown}
        onDblClick={() => props.onChange({ ...props.state, collapsed: !props.state.collapsed })}
        onKeyDown={onKey}
      >
        <span
          class="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors group-hover:bg-accent"
          classList={{ hidden: props.state.collapsed }}
        />
        <span
          class="absolute top-1/2 left-1 h-8 w-[3px] -translate-y-1/2 rounded-sm bg-line-strong group-hover:bg-accent"
          classList={{ hidden: !props.state.collapsed }}
        />
        <span
          class="absolute top-2 left-px size-[9px] rounded-full bg-accent"
          classList={{ hidden: !(props.state.collapsed && props.badge) }}
        />
      </div>
    </aside>
  );
}
