"use client";
import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { cn } from "../../lib/utils";

export const BackgroundRippleEffect = ({
  cellSize = 52,
  borderColor = "rgba(1, 110, 254, 0.15)",
  interactive = true,
}) => {
  const [clickedCell, setClickedCell] = useState(null);
  const [rippleKey, setRippleKey] = useState(0);
  const containerRef = useRef(null);
  const [gridDims, setGridDims] = useState({ rows: 0, cols: 0 });

  // Measure container and compute rows/cols to fill it completely
  const measure = useCallback(() => {
    if (!containerRef.current) return;
    const { clientWidth, clientHeight } = containerRef.current;
    const cols = Math.ceil(clientWidth / cellSize) + 1;
    const rows = Math.ceil(clientHeight / cellSize) + 1;
    setGridDims((prev) =>
      prev.rows === rows && prev.cols === cols ? prev : { rows, cols }
    );
  }, [cellSize]);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const { rows, cols } = gridDims;

  // Trigger an initial demo ripple when loaded so user immediately sees the effect
  useEffect(() => {
    if (rows === 0 || cols === 0) return;
    const timer = setTimeout(() => {
      setClickedCell({ row: Math.floor(rows / 2), col: Math.floor(cols / 2) });
      setRippleKey((k) => k + 1);
    }, 600);
    return () => clearTimeout(timer);
  }, [rows, cols]);

  const cells = useMemo(
    () => (rows && cols ? Array.from({ length: rows * cols }, (_, idx) => idx) : []),
    [rows, cols]
  );

  const gridStyle = {
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
    gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
    width: cols * cellSize,
    height: rows * cellSize,
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full pointer-events-auto overflow-hidden bg-black select-none"
      style={{
        background: "radial-gradient(ellipse 80% 60% at 50% 50%, #01072D 0%, #000000 100%)"
      }}
    >
      {/* Radial vignette mask so the grid fades smoothly at the edges */}
      <div
        className="relative z-[2] w-full h-full overflow-hidden"
        style={{
          maskImage: "radial-gradient(ellipse 85% 85% at 50% 50%, black 50%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 85% 85% at 50% 50%, black 50%, transparent 100%)",
        }}
      >
        <div key={`ripple-grid-${rippleKey}`} className="relative z-[3]" style={gridStyle}>
          {cells.map((idx) => {
            const rowIdx = Math.floor(idx / cols);
            const colIdx = idx % cols;
            const distance = clickedCell
              ? Math.hypot(clickedCell.row - rowIdx, clickedCell.col - colIdx)
              : 0;
            const delay = clickedCell ? Math.max(0, distance * 55) : 0; // ms
            const duration = 250 + distance * 65; // ms

            const style = clickedCell
              ? {
                  "--delay": `${delay}ms`,
                  "--duration": `${duration}ms`,
                }
              : {};

            return (
              <div
                key={idx}
                className={cn(
                  "relative border transition-colors duration-150 cursor-pointer will-change-transform",
                  "hover:!bg-[#016EFE]/30 hover:!border-[#016EFE] hover:shadow-[0_0_16px_rgba(1,110,254,0.6)]",
                  clickedCell && "animate-cell-ripple",
                  !interactive && "pointer-events-none"
                )}
                style={{
                  backgroundColor: "transparent",
                  borderColor: borderColor,
                  ...style,
                }}
                onClick={
                  interactive
                    ? () => {
                        setClickedCell({ row: rowIdx, col: colIdx });
                        setRippleKey((k) => k + 1);
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
