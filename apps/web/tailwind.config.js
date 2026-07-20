/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Lighten the muted gray steps used for secondary/label text across
        // the dark theme (readability fix) — shifts 400/500/600 one step
        // lighter than stock Tailwind slate while leaving backgrounds
        // (700/800/900/950) untouched.
        slate: {
          400: "#cbd5e1",
          500: "#94a3b8",
          600: "#64748b",
        },
      },
    },
  },
  plugins: [],
};
