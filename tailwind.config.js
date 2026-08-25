/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // shadcn tokens (mapped to the warm light palette in index.css)
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
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
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
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // ── Human light design tokens ───────────────────────────────
        'bg-0': '#FAF9F5', // warm app canvas
        'bg-1': '#FFFFFF', // card / panel surface
        'bg-2': '#EFF1EA', // raised surface, table header
        'bg-3': '#E4E9E0', // active/selected surface, input bg
        'text-0': '#1C2B22', // primary text, numbers
        'text-1': '#56645C', // secondary text, labels
        'text-2': '#7D8981', // tertiary, placeholders, axis labels
        gain: '#0D5434',      // forest brand accent, gains, buy
        'gain-dim': '#0D543426',
        loss: '#E0543F',      // losses, sell, destructive, kill switch
        'loss-dim': '#E0543F26',
        warn: '#A76C20',      // warnings, pending, medium risk
        info: '#356F9F',      // links, info, FX module accent
        agent: '#3C7059',     // Agent/automation accent
        hairline: '#233A2C1F',
        'hairline-strong': '#233A2C38',
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['"DM Serif Display"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-xl': ['40px', { lineHeight: '44px', fontWeight: '600' }],
        'display-lg': ['32px', { lineHeight: '38px', fontWeight: '600' }],
        'display-md': ['24px', { lineHeight: '30px', fontWeight: '600' }],
        'title': ['18px', { lineHeight: '24px', fontWeight: '600' }],
        'body': ['14px', { lineHeight: '21px', fontWeight: '400' }],
        'body-strong': ['14px', { lineHeight: '21px', fontWeight: '600' }],
        'label': ['12px', { lineHeight: '16px', fontWeight: '500' }],
        'caption': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'micro': ['11px', { lineHeight: '14px', fontWeight: '500' }],
        'ticker': ['13px', { lineHeight: '18px', fontWeight: '500' }],
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        "shimmer": {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "shimmer": "shimmer 1.2s linear infinite",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
