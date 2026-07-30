import { useState, useRef, useCallback, useEffect } from 'react';
import IconButton from './IconButton.jsx';

export default function Sheet({ open, onClose, title, children }) {
  const sheetRef = useRef(null);
  const dragRef = useRef(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Drag can start from anywhere on the panel (not just the handle). A touch
  // only ever turns into a dismiss-drag once the gesture is moving downward
  // AND the panel's own scroll is already at the top — otherwise it's left
  // alone so scrolling long sheet content (e.g. Settings) still works.
  const onDragStart = useCallback((e) => {
    const point = e.touches ? e.touches[0] : e;
    dragRef.current = { startY: point.clientY, lastY: point.clientY, lastT: Date.now(), velocity: 0, dy: 0 };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const point = e.touches ? e.touches[0] : e;
      const now = Date.now();
      const dt = now - d.lastT;
      if (dt > 0) d.velocity = (point.clientY - d.lastY) / dt;
      d.lastY = point.clientY;
      d.lastT = now;

      const rawDy = point.clientY - d.startY;
      const atTop = !sheetRef.current || sheetRef.current.scrollTop <= 0;
      if (rawDy > 0 && atTop) {
        d.dy = rawDy;
        setDragY(rawDy);
        if (e.cancelable) e.preventDefault();
      } else if (d.dy !== 0) {
        d.dy = 0;
        setDragY(0);
      }
    };
    const onEnd = () => {
      const d = dragRef.current;
      const shouldClose = d && d.dy > 0 && (d.dy > 60 || d.velocity > 0.6);
      dragRef.current = null;
      setDragging(false);
      if (shouldClose) {
        onClose();
      }
      setDragY(0);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    return () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
    };
  }, [dragging, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} style={{ opacity: dragging ? Math.max(0.2, 1 - dragY / 300) : 1 }} />
      <div
        ref={sheetRef}
        className={`${dragging ? '' : 'sheet-up'} relative w-full max-w-md bg-zinc-950 border-t border-white/10 rounded-t-3xl px-6 pt-5 pb-8 landscape:pt-3 landscape:pb-5 max-h-[85dvh] landscape:max-h-[90vh] overflow-y-auto landscape:overflow-y-auto cursor-grab`}
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)',
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 0.2s ease',
        }}
      >
        <div
          className="flex justify-center items-center -mx-6 -mt-5 landscape:-mt-3 mb-4 landscape:mb-2 py-3 landscape:py-1.5"
          onTouchStart={onDragStart}
          onMouseDown={onDragStart}
        >
          <div className="h-1.5 w-12 rounded-full bg-white/20" />
        </div>
        <div className="flex items-center justify-between mb-5 landscape:mb-3">
          <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
          <IconButton name="X" onClick={onClose} size={18} label="Close" />
        </div>
        {children}
      </div>
    </div>
  );
}
