const LONG_PRESS_DELAY_MS = 600;
const MOVE_TOLERANCE_PX = 12;

type ActivePress = {
  pointerId: number;
  target: Element;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
};

function preservesNativeTouchBehavior(target: Element) {
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-long-press-disabled]',
    ),
  );
}

/**
 * Makes a deliberate touch hold bubble through the same `contextmenu` handlers
 * used by mouse right-clicks. Movement, scrolling, multi-touch, and editable
 * controls cancel the gesture so native mobile behavior remains available.
 */
export function installLongPressContextMenu(
  root: Document = document,
  delayMs = LONG_PRESS_DELAY_MS,
) {
  let active: ActivePress | null = null;
  let suppressNextClick = false;

  const cancel = () => {
    if (active) clearTimeout(active.timer);
    active = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (
      event.pointerType !== "touch" ||
      !event.isPrimary ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      preservesNativeTouchBehavior(event.target)
    ) {
      cancel();
      return;
    }

    cancel();
    const target = event.target;
    const x = event.clientX;
    const y = event.clientY;
    const pointerId = event.pointerId;
    const timer = setTimeout(() => {
      if (!active || active.pointerId !== pointerId || !target.isConnected) return;
      active = null;
      suppressNextClick = true;
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 2,
          buttons: 0,
        }),
      );
    }, delayMs);
    active = { pointerId, target, x, y, timer };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointerId) return;
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > MOVE_TOLERANCE_PX) {
      cancel();
    }
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (active?.pointerId === event.pointerId) cancel();
  };

  const onClick = (event: MouseEvent) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("pointermove", onPointerMove, true);
  root.addEventListener("pointerup", onPointerEnd, true);
  root.addEventListener("pointercancel", onPointerEnd, true);
  root.addEventListener("scroll", cancel, true);
  root.addEventListener("click", onClick, true);

  return () => {
    cancel();
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("pointermove", onPointerMove, true);
    root.removeEventListener("pointerup", onPointerEnd, true);
    root.removeEventListener("pointercancel", onPointerEnd, true);
    root.removeEventListener("scroll", cancel, true);
    root.removeEventListener("click", onClick, true);
  };
}
