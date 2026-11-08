import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  // fs-ext 是可选原生依赖：运行期动态探测，不打包进 bundle
  external: ['fs-ext'],
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      options.define = {
        ...(options.define ?? {}),
        'import.meta.url': '__filename',
      }
    }
  },
})
