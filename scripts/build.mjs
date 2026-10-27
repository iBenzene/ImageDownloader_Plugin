import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const userscriptHeader = `// ==UserScript==
// @name         苯苯存图
// @namespace    https://github.com/ibenzene/image-downloader
// @version      ${pkg.version}
// @updateURL    https://github.com/iBenzene/ImageDownloader_Plugin/releases/latest/download/benben-image-downloader.meta.js
// @downloadURL  https://github.com/iBenzene/ImageDownloader_Plugin/releases/latest/download/benben-image-downloader.user.js
// @description  批量保存来自各种 App 的图片或视频！
// @author       iBenzene
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      localhost
// @connect      127.0.0.1
// @connect      xhscdn.com
// @connect      xiaohongshu.com
// @connect      xhslink.com
// @connect      xhslink.cn
// @connect      *
// @run-at       document-idle
// ==/UserScript==
`;

const distDir = path.join(rootDir, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const outfile = path.join(distDir, 'benben-image-downloader.user.js');

await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'index.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    outfile,
    banner: {
        js: userscriptHeader,
    },
    charset: 'utf8',
    legalComments: 'none',
    minify: false,
});

const stat = fs.statSync(outfile);
console.log(`Built ${outfile} (${(stat.size / 1024).toFixed(1)} KB)`);
const metafile = path.join(distDir, 'benben-image-downloader.meta.js');
fs.writeFileSync(metafile, userscriptHeader);
console.log(`Built ${metafile}`);
