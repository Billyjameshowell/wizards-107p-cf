export const MIN_TABLE_SCALE = 1;
export const MAX_TABLE_SCALE = 2.5;
export const TABLE_ZOOM_STEP = 1.1;
const WHEEL_SENSITIVITY = 0.01;

export function clampTableScale(value: number): number {
  if (!Number.isFinite(value)) return MIN_TABLE_SCALE;
  return Math.min(MAX_TABLE_SCALE, Math.max(MIN_TABLE_SCALE, value));
}

export function scaleFromPinch(startScale: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return clampTableScale(startScale);
  return clampTableScale(startScale * (distance / startDistance));
}

export function scaleFromWheel(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampTableScale(current);
  return clampTableScale(current * Math.exp(-deltaY * WHEEL_SENSITIVITY));
}

export function stepTableScale(current: number, direction: 1 | -1): number {
  const factor = direction === 1 ? TABLE_ZOOM_STEP : 1 / TABLE_ZOOM_STEP;
  return clampTableScale(current * factor);
}

type ZoomController = {
  getScale: () => number;
  setScale: (value: number) => void;
};

type GestureLike = Event & { scale?: number };

export function attachPinchZoom(node: HTMLElement, controller: ZoomController): () => void {
  let mode: "none" | "touch" | "gesture" = "none";
  let startDistance = 0;
  let startScale = controller.getScale();

  function onTouchStart(event: TouchEvent) {
    if (event.touches.length !== 2) return;
    mode = "touch";
    startDistance = Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
    startScale = controller.getScale();
  }

  function onTouchMove(event: TouchEvent) {
    if (mode !== "touch" || event.touches.length !== 2 || !(startDistance > 0)) return;
    event.preventDefault();
    const distance = Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
    controller.setScale(scaleFromPinch(startScale, startDistance, distance));
  }

  function onTouchEnd(event: TouchEvent) {
    if (event.touches.length < 2) {
      mode = "none";
      startDistance = 0;
    }
  }

  function onGestureStart(event: Event) {
    if (mode === "touch") return;
    event.preventDefault();
    mode = "gesture";
    startScale = controller.getScale();
  }

  function onGestureChange(event: Event) {
    if (mode !== "gesture") return;
    event.preventDefault();
    const factor = (event as GestureLike).scale;
    if (typeof factor !== "number" || !Number.isFinite(factor)) return;
    controller.setScale(clampTableScale(startScale * factor));
  }

  function onGestureEnd() {
    if (mode === "gesture") mode = "none";
  }

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    controller.setScale(scaleFromWheel(controller.getScale(), event.deltaY));
  }

  node.addEventListener("touchstart", onTouchStart, { passive: true });
  node.addEventListener("touchmove", onTouchMove, { passive: false });
  node.addEventListener("touchend", onTouchEnd);
  node.addEventListener("touchcancel", onTouchEnd);
  node.addEventListener("gesturestart", onGestureStart);
  node.addEventListener("gesturechange", onGestureChange);
  node.addEventListener("gestureend", onGestureEnd);
  node.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    node.removeEventListener("touchstart", onTouchStart);
    node.removeEventListener("touchmove", onTouchMove);
    node.removeEventListener("touchend", onTouchEnd);
    node.removeEventListener("touchcancel", onTouchEnd);
    node.removeEventListener("gesturestart", onGestureStart);
    node.removeEventListener("gesturechange", onGestureChange);
    node.removeEventListener("gestureend", onGestureEnd);
    node.removeEventListener("wheel", onWheel);
  };
}
