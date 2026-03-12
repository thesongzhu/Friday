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
        wom: {
          navy: "#1E3A5F",
          "navy-light": "#2A4A73",
          "navy-dark": "#152B47",
          coral: "#E8A87C",
          "coral-light": "#F5C9A8",
          "coral-dark": "#D4885A",
          "warm-white": "#FEFDFB",
          cream: "#F5F3F0",
          "cream-dark": "#EBE8E3",
        },
        background: "#FEFDFB",
        foreground: "#152B47",
        border: "#EBE8E3",
        ring: "#E8A87C",
        primary: {
          DEFAULT: "#1E3A5F",
          foreground: "#FEFDFB",
        },
        accent: {
          DEFAULT: "#E8A87C",
          foreground: "#152B47",
        },
        muted: {
          DEFAULT: "#F5F3F0",
          foreground: "#2A4A73",
        },
        success: "#10B981",
        warning: "#F59E0B",
        destructive: "#E74C3C",
      },
      width: {
        sidebar: "200px",
      },
      borderRadius: {
        card: "1rem",
        btn: "0.75rem",
        lg: "1rem",
        md: "0.75rem",
        sm: "0.5rem",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.08)",
        "card-hover": "0 10px 25px rgba(0,0,0,0.10)",
      },
    },
  },
  plugins: [animate],
};

export default config;
