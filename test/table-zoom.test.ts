import { describe, expect, it } from "vitest";
import {
  MAX_TABLE_SCALE,
  MIN_TABLE_SCALE,
  attachPinchZoom,
  clampTableScale,
  scaleFromPinch,
  scaleFromWheel,
  stepTableScale,
} from "@/lib/table-zoom";

function fakeElement() {
  const listeners = new Map<string, EventListener[]>();
  const node = {
    addEventListener(type: string, listener: EventListener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((item) => item !== listener),
      );
    },
  };
  return {
    node: node as unknown as HTMLElement,
    fire(type: string, event: object) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

describe("table zoom", () => {
  it("clamps pinch and wheel changes so the table can grow without collapsing", () => {
    expect(MIN_TABLE_SCALE).toBe(1);
    expect(scaleFromPinch(1, 100, 200)).toBeCloseTo(2);
    expect(scaleFromPinch(2, 100, 40)).toBe(MIN_TABLE_SCALE);
    expect(scaleFromPinch(2, 100, 400)).toBe(MAX_TABLE_SCALE);
    expect(scaleFromWheel(1, -40)).toBeGreaterThan(1);
    expect(scaleFromWheel(1, 80)).toBe(MIN_TABLE_SCALE);
    expect(scaleFromWheel(2, 0)).toBe(2);
    expect(stepTableScale(1, 1)).toBeCloseTo(1.1);
    expect(stepTableScale(1, -1)).toBe(MIN_TABLE_SCALE);
    expect(clampTableScale(Number.NaN)).toBe(MIN_TABLE_SCALE);
  });

  it("pinches and ctrl-wheels the region, and leaves a normal scroll alone", () => {
    const target = fakeElement();
    let scale = 1;
    const detach = attachPinchZoom(target.node, {
      getScale: () => scale,
      setScale: (value) => {
        scale = value;
      },
    });

    let scrollPrevented = false;
    target.fire("wheel", {
      ctrlKey: false,
      metaKey: false,
      deltaY: -40,
      preventDefault() {
        scrollPrevented = true;
      },
    });
    expect(scrollPrevented).toBe(false);
    expect(scale).toBe(1);

    let wheelPrevented = false;
    target.fire("wheel", {
      ctrlKey: true,
      metaKey: false,
      deltaY: -20,
      preventDefault() {
        wheelPrevented = true;
      },
    });
    expect(wheelPrevented).toBe(true);
    expect(scale).toBeGreaterThan(1);

    scale = 1;
    target.fire("touchstart", {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 80, clientY: 0 },
      ],
    });
    let pinchPrevented = false;
    target.fire("touchmove", {
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 160, clientY: 0 },
      ],
      preventDefault() {
        pinchPrevented = true;
      },
    });
    expect(pinchPrevented).toBe(true);
    expect(scale).toBeCloseTo(2);

    let oneFingerPrevented = false;
    target.fire("touchend", { touches: [] });
    target.fire("touchstart", { touches: [{ clientX: 0, clientY: 0 }] });
    target.fire("touchmove", {
      touches: [{ clientX: 0, clientY: 30 }],
      preventDefault() {
        oneFingerPrevented = true;
      },
    });
    expect(oneFingerPrevented).toBe(false);

    detach();
    expect(target.listenerCount("wheel")).toBe(0);
    expect(target.listenerCount("touchmove")).toBe(0);
  });
});
