import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    // lib/tiers.ts holds shared Tailwind class fragments for tier accent
    // colors (TIER_ACCENT) — needs to be scanned or the JIT purges them.
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gamee: {
          purple: "#a855f7",
          cyan: "#06b6d4",
          teal: "#22d3ee",
          dark: "#0a0a0f",
          darker: "#0c0c14",
          surface: "rgba(255,255,255,0.02)",
          border: "rgba(255,255,255,0.06)",
          muted: "#64748b",
          text: "#e2e2e8",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in-up": "fadeInUp 0.6s ease-out",
        "spin-slow": "spin 4s linear infinite",
      },
      keyframes: {
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
