import { useCallback, useRef, useState } from "react";
import { attachPinchZoom, clampTableScale } from "@/lib/table-zoom";

export function usePinchZoom() {
  const [scale, setScaleState] = useState(1);
  const scaleRef = useRef(1);

  const setScale = useCallback((value: number) => {
    const next = clampTableScale(value);
    scaleRef.current = next;
    setScaleState(next);
  }, []);

  const bind = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    return attachPinchZoom(node, {
      getScale: () => scaleRef.current,
      setScale,
    });
  }, [setScale]);

  return { scale, setScale, bind };
}
