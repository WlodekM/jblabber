// import esbuildPluginTsc from 'esbuild-plugin-tsc';
import * as esbuild from 'esbuild'
import fs from 'node:fs';
if (!fs.existsSync('dist'))
	fs.mkdirSync('dist')

await esbuild.build({
	entryPoints: ['client.ts'],
	bundle: true,
	outfile: 'dist/client.js',
	// plugins: [esbuildPluginTsc()],
	format: 'esm',
	external: ['esbuild'],
	// minify: true,
	minifyIdentifiers: true,
	tsconfig: 'tsconfig.json',
	minifyWhitespace: true,
	sourcemap: true,
	// minifySyntax: true
	platform: 'node',
})
