import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑：同一份建置可放在網域根目錄或 GitHub Pages 的子路徑（/GGD/）
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: { phaser: ['phaser'] } } },
  },
});
