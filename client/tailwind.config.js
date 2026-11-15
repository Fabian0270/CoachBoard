/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
        sidebar: "hsl(var(--sidebar) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'system-ui', '"Segoe UI"', 'sans-serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      // Dialogs, menus and toasts. Written out here rather than taken from
      // tailwindcss-animate: the classes that plugin provides were used in the
      // components but the plugin was never installed, so nothing animated.
      //
      // Scale is animated with the separate CSS `scale` property, not
      // `transform`: a dialog is centred with a translate transform, and a
      // keyframe that sets transform would throw it off-centre for the
      // duration of the animation.
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "pop-in": { from: { opacity: "0", scale: "0.97" }, to: { opacity: "1", scale: "1" } },
        "pop-out": { from: { opacity: "1", scale: "1" }, to: { opacity: "0", scale: "0.97" } },
        "toast-in": { from: { opacity: "0", translate: "8px 0" }, to: { opacity: "1", translate: "0 0" } },
      },
      animation: {
        "fade-in": "fade-in 150ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        "fade-out": "fade-out 120ms ease-in",
        "pop-in": "pop-in 150ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        "pop-out": "pop-out 120ms ease-in",
        "toast-in": "toast-in 150ms cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
}
