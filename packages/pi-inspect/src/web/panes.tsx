import { Cross2Icon } from "@radix-ui/react-icons";
import { Dialog, IconButton } from "@radix-ui/themes";
import { type ReactNode, type RefObject, useEffect, useState } from "react";

export function useNarrow(): boolean {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const changed = () => setWidth(window.innerWidth);
    window.addEventListener("resize", changed);
    return () => window.removeEventListener("resize", changed);
  }, []);
  return width <= 1100;
}
export function PaneDrawer({
  name,
  open,
  change,
  children,
  side,
  trigger,
  className = "",
  restoreFocus,
}: {
  name: string;
  open: boolean;
  change(open: boolean): void;
  children: ReactNode;
  side: string;
  trigger: RefObject<HTMLButtonElement | null>;
  className?: string;
  restoreFocus?(): void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Content
        className={`side-drawer side-drawer-${side} ${className}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus) restoreFocus();
          else if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
        }}
      >
        <div className="drawer-title">
          <Dialog.Title>{name}</Dialog.Title>
          <Dialog.Close>
            <IconButton aria-label={`Close ${name}`} variant="ghost">
              <Cross2Icon />
            </IconButton>
          </Dialog.Close>
        </div>
        <Dialog.Description className="sr-only">Read-only browser panel. Escape closes this drawer.</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
export function ResizeHandle({
  name,
  value,
  change,
  min,
  max,
  inverse = false,
}: {
  name: string;
  value: number;
  change(value: number): void;
  min: number;
  max: number;
  inverse?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState({ x: 0, value: 0 });
  useEffect(() => {
    if (!dragging) return;
    const controller = new AbortController();
    const move = (event: PointerEvent) =>
      change(Math.max(min, Math.min(max, start.value + (event.clientX - start.x) * (inverse ? -1 : 1))));
    const end = () => setDragging(false);
    window.addEventListener("pointermove", move, { signal: controller.signal });
    window.addEventListener("pointerup", end, { signal: controller.signal });
    window.addEventListener("pointercancel", end, { signal: controller.signal });
    window.addEventListener("blur", end, { signal: controller.signal });
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          end();
        }
      },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [dragging, start, change, min, max, inverse]);
  return (
    <hr
      aria-label={name}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="pane-resizer"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        setStart({ x: event.clientX, value });
        setDragging(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDragging(false);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        change(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : Math.max(min, Math.min(max, value + (event.key === "ArrowRight" ? 10 : -10) * (inverse ? -1 : 1))),
        );
      }}
    />
  );
}
