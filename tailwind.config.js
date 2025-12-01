/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./outliner.jsx",
    "./**/*.{js,ts,jsx,tsx}", // Catches any other JS/TS/JSX/TSX files in other folders
    "!./node_modules/**",     // Exclude node_modules
    "!./dist/**",             // Exclude dist folder
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}