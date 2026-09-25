import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Конфигурация Vite для SPA «Просмотрщик учебных материалов ДГТУ»
export default defineConfig({
  plugins: [react()],
  base: './', // относительные пути — удобно для любого хостинга (Vercel, GitHub Pages)
  build: {
    chunkSizeWarningLimit: 2000, // материалы большие, предупреждения о размере чанков ожидаемы
  },
});
