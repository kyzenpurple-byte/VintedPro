// Configuration Tailwind (même thème que le site d'origine).
// Le CSS est compilé dans public/app.css : voir README, section « Modifier le design ».
module.exports = {
  content: ['./public/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        vinted: { 50: '#e6f7f5', 100: '#cceee9', 400: '#33c3ae', 500: '#00a88f', 600: '#008a76', 700: '#006d5d', 800: '#005045' },
        pro: { bg: '#090d16', surface: '#0f172a', card: '#131c2e', border: '#1e293b', hover: '#334155', muted: '#94a3b8' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
};
