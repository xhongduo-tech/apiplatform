/** @type {import('tailwindcss').Config} */
// 注意：调色板全部走 CSS 变量（hex），避免 Tailwind v4 的 oklch，兼容旧浏览器。
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        input: "var(--input-background)",
        ring: "var(--ring)",
        brand: "var(--brand)",
        "brand-hover": "var(--brand-hover)",
        "brand-soft": "var(--brand-soft)",
        bg: "var(--bg)",
        "bg-soft": "var(--bg-soft)",
        card: "var(--card)",
        "card-hover": "var(--card-hover)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        "fg-lead": "var(--fg-lead)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        ink: "rgba(var(--ink-rgb), <alpha-value>)",
        "block-amber": "var(--block-amber)",
        "block-sand":  "var(--block-sand)",
        "block-peach": "var(--block-peach)",
        "block-blue":  "var(--block-blue)",
        "block-ink":   "var(--block-ink)",
        "on-amber": "var(--on-amber)",
        "on-sand":  "var(--on-sand)",
        "on-peach": "var(--on-peach)",
        "on-blue":  "var(--on-blue)",
        "on-ink":   "var(--on-ink)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
        hard: "var(--shadow-hard)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
        serif: ["var(--font-serif)"],
      },
      maxWidth: { content: "1200px" },
      /* 默认边框宽度走发丝线令牌(0.5px,参考站 border-0.5;旧内核回退 1px) */
      borderWidth: { DEFAULT: "var(--hairline, 1px)" },
      borderRadius: { xl2: "12px", block: "16px", pill: "9999px" },
      fontSize: {
        display: ["clamp(2.4rem, 5vw, 4rem)", { lineHeight: "1.08", letterSpacing: "-0.01em" }],
        "display-sm": ["clamp(1.9rem, 3.5vw, 2.8rem)", { lineHeight: "1.12", letterSpacing: "-0.01em" }],
      },
    },
  },
  plugins: [],
};
