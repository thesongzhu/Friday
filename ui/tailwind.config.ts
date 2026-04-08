import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        canvas: "var(--color-bg-base)",
        surface: {
          DEFAULT: "var(--color-bg-surface)",
          strong: "var(--color-bg-surface-strong)",
          subtle: "var(--color-bg-subtle)",
        },
        background: "var(--color-bg-base)",
        foreground: "var(--color-text-primary)",
        border: "var(--color-border-soft)",
        ring: "var(--color-accent)",
        primary: {
          DEFAULT: "var(--color-ink)",
          foreground: "var(--color-bg-base)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          foreground: "var(--color-bg-base)",
        },
        muted: {
          DEFAULT: "var(--color-bg-subtle)",
          foreground: "var(--color-text-secondary)",
        },
        ink: {
          DEFAULT: "var(--color-ink)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
          faint: "var(--color-text-faint)",
        },
        success: "var(--color-accent)",
        warning: "var(--color-text-secondary)",
        destructive: "var(--color-ink)",
      },
      width: {
        sidebar: "200px",
      },
      borderRadius: {
        card: "1.5rem",
        btn: "0.75rem",
        lg: "1.25rem",
        md: "1rem",
        sm: "0.5rem",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-strong)",
      },
    },
  },
  plugins: [animate],
};

export default config;
