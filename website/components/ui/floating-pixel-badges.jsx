"use client";
import React, { useEffect, useState } from "react";

export function FloatingPixelBadges() {
  const [ditherSrc, setDitherSrc] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    // Generate dithered shader version of /arbit_3_4_view.png on offscreen canvas
    const img = new Image();
    img.src = "/arbit_3_4_view.png";
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const width = 64; // Retro pixelated grid width
      const height = 64; // Retro pixelated grid height
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const imgData = ctx.getImageData(0, 0, width, height);
      const data = imgData.data;

      // 4x4 Bayer Matrix for authentic Aceternity style dither shader
      const bayer = [
        [ 0,  8,  2, 10],
        [12,  4, 14,  6],
        [ 3, 11,  1,  9],
        [15,  7, 13,  5]
      ];

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const a = data[idx + 3];
          if (a < 20) continue; // Keep background transparent

          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];

          // Grayscale / Brightness calculation
          const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
          const threshold = (bayer[y % 4][x % 4] / 16 - 0.5) * 55;
          const val = brightness + threshold;

          if (val > 155) {
            // Bright Highlight -> Pure White
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
          } else if (val > 85) {
            // Midtone -> Electric Blue (#016EFE)
            data[idx] = 1;
            data[idx + 1] = 110;
            data[idx + 2] = 254;
          } else if (val > 45) {
            // Deep Blue Tone
            data[idx] = 1;
            data[idx + 1] = 30;
            data[idx + 2] = 110;
          } else {
            // Dark Shadow
            data[idx] = 0;
            data[idx + 1] = 8;
            data[idx + 2] = 35;
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      setDitherSrc(canvas.toDataURL());
    };
  }, []);

  // Sequential cycle timer: Every 3.0s, advance to the next spot
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % 6);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // 6 distinct positions interleaved (Left / Right) across the screen
  const badgePositions = [
    { id: "L1", top: "14%", left: "4%", size: 104 },   // Index 0: Top Left
    { id: "R2", top: "48%", right: "7%", size: 124 },  // Index 1: Mid Right
    { id: "L3", top: "72%", left: "5%", size: 96 },   // Index 2: Bottom Left
    { id: "R1", top: "16%", right: "5%", size: 108 },  // Index 3: Top Right
    { id: "L2", top: "44%", left: "8%", size: 120 },   // Index 4: Mid Left
    { id: "R3", top: "74%", right: "4%", size: 92 }    // Index 5: Bottom Right
  ];

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-10 select-none">
      {badgePositions.map((b, idx) => {
        const isActive = activeIdx === idx;
        return (
          <div
            key={b.id}
            className="absolute flex items-center justify-center transition-all duration-700 ease-out"
            style={{
              top: b.top,
              left: b.left,
              right: b.right,
              width: b.size,
              height: b.size,
              opacity: isActive ? 1 : 0,
              transform: isActive
                ? "translateY(0px) scale(1) rotate(0deg)"
                : "translateY(32px) scale(0.55) rotate(-14deg)",
              filter: isActive ? "blur(0px)" : "blur(10px)",
              pointerEvents: isActive ? "auto" : "none"
            }}
          >
            <div
              className="relative w-full h-full flex items-center justify-center"
              style={{
                animation: isActive ? "subtleBob 3s ease-in-out infinite" : "none"
              }}
            >
              {/* Ambient Electric Glow */}
              <div
                className="absolute inset-0 rounded-full blur-md opacity-70 transition-opacity duration-700"
                style={{
                  background: "radial-gradient(circle, rgba(1, 110, 254, 0.6) 0%, transparent 70%)"
                }}
              />
              {/* Pixelated Dithered Badge Image */}
              <img
                src={ditherSrc || "/arbit_3_4_view.png"}
                alt="Arbit Dither Emblem"
                className="w-full h-full object-contain relative z-10"
                style={{
                  imageRendering: "pixelated",
                  filter: ditherSrc
                    ? "drop-shadow(0 0 18px rgba(1, 110, 254, 0.85)) contrast(1.3)"
                    : "drop-shadow(0 0 10px rgba(1, 110, 254, 0.4))"
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
