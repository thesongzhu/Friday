import type { DesignTokenContract } from "../types";

export const fridayDesignTokens: DesignTokenContract = {
  colors: {
    "bg.base": "#f5efe6",
    "bg.surface": "#fffaf2",
    "bg.chrome": "#efe4d5",
    "text.primary": "#2f241a",
    "text.secondary": "#5d4e42",
    "accent.primary": "#186f65",
    "danger.fg": "#7a2525",
  },
  typography: {
    "font.display": "\"Iowan Old Style\", \"Palatino Linotype\", serif",
    "font.body": "\"IBM Plex Sans\", \"Avenir Next\", sans-serif",
    "size.md": "16px",
    "size.xl": "28px",
    "weight.semibold": 600,
  },
  spacing: {
    "space.2": "8px",
    "space.4": "16px",
    "space.6": "24px",
    "space.8": "32px",
  },
  radius: {
    "radius.sm": "10px",
    "radius.md": "16px",
    "radius.lg": "22px",
  },
  shadow: {
    "shadow.card": "0 10px 30px rgba(68, 50, 32, 0.08)",
    "shadow.overlay": "0 20px 50px rgba(31, 24, 19, 0.18)",
  },
  motion: {
    "duration.fast": "120ms",
    "duration.base": "180ms",
    "easing.standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
};
