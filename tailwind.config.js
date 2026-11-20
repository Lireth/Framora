/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        app: 'var(--c-bg)',
        panel: 'var(--c-panel)',
        raised: 'var(--c-raised)',
        hover: 'var(--c-hover)',
        line: 'var(--c-line)',
        ink: 'var(--c-ink)',
        ink2: 'var(--c-ink-2)',
        ink3: 'var(--c-ink-3)',
        accent: 'var(--c-accent)',
        'accent-hover': 'var(--c-accent-hover)',
        'accent-soft': 'var(--c-accent-soft)'
      },
      fontFamily: {
        sans: [
          '"Segoe UI Variable Display"',
          '"Segoe UI"',
          'system-ui',
          '"Microsoft YaHei"',
          'sans-serif'
        ]
      },
      borderRadius: {
        win: '10px'
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        popIn: {
          from: { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' }
        },
        shimmer: {
          '0%': { opacity: '0.5' },
          '50%': { opacity: '0.9' },
          '100%': { opacity: '0.5' }
        }
      },
      animation: {
        fadeIn: 'fadeIn 0.15s ease-out',
        popIn: 'popIn 0.16s ease-out',
        shimmer: 'shimmer 1.4s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
