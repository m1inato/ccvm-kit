import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 打包后的界面只从 file:// 加载自己的脚本；开发服务器需要内联预加载脚本，所以 CSP 只在 build 时加
const csp: Plugin = {
  name: 'ccvm-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'" />`,
    );
  },
};

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 }, // xterm 较大，界面从本地文件加载
  server: { port: 5199, strictPort: true },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
