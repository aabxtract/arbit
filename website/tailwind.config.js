/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        theme: {
          black: "#000000",
          navy: "#01072D",
          blue: "#016EFE",
          white: "#FFFFFF",
        },
        navy: {
          950: "#01072D",
          900: "#020e40",
          800: "#03175c",
          700: "#082485",
        },
        brand: {
          blue: "#016EFE",
          hover: "#2583FE",
          light: "#60a5fa",
          glow: "rgba(1, 110, 254, 0.35)",
        },
        background: "#000000",
        foreground: "#FFFFFF",
      },
      fontFamily: {
        sans: ["Space Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      animation: {
        "cell-ripple": "cell-ripple var(--duration, 300ms) ease var(--delay, 0ms)",
        ripple: "ripple var(--duration,2s) ease calc(var(--i, 0)*.2s) infinite",
        shimmer: "shimmer 2s linear infinite",
        "pulse-slow": "pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        "cell-ripple": {
          "0%": {
            opacity: "0.35",
            transform: "scale(1)",
          },
          "50%": {
            opacity: "1",
            transform: "scale(0.92)",
            backgroundColor: "rgba(1, 110, 254, 0.6)",
            borderColor: "#016EFE",
          },
          "100%": {
            opacity: "0.35",
            transform: "scale(1)",
          },
        },
        ripple: {
          "0%, 100%": {
            transform: "translate(-50%, -50%) scale(1)",
          },
          "50%": {
            transform: "translate(-50%, -50%) scale(0.9)",
          },
        },
        shimmer: {
          from: {
            backgroundPosition: "0 0",
          },
          to: {
            backgroundPosition: "-200% 0",
          },
        },
      },
    },
  },
  plugins: [],
};
