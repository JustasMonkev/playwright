/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { chromium } from '@playwright/test';
import path from 'path';
import { test, expect } from './npmTest';

test('installed package exposes types and captures a PDF with CommonJS and ESM', async ({ exec, writeFiles }) => {
  await exec('npm i @playwright/pdf playwright-core', { env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  await writeFiles({
    'capture.js': `
      const http = require('http');
      const { chromium } = require('playwright-core');
      const commonjs = require('@playwright/pdf');

      (async () => {
        const esm = await import('@playwright/pdf');
        if (typeof commonjs.capturePdf !== 'function' || typeof esm.capturePdf !== 'function')
          throw new Error('Package exports are incomplete');

        const expected = Buffer.from('%PDF-1.4 installed package');
        const server = http.createServer((request, response) => {
          if (request.url === '/document.pdf') {
            response.writeHead(200, { 'Content-Type': 'application/pdf' });
            response.end(expected);
          } else {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<title>Application</title>');
          }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        const browser = await chromium.launch({ executablePath: ${JSON.stringify(chromium.executablePath())} });
        try {
          const page = await browser.newPage();
          await page.goto(origin);
          const chunks = [];
          await commonjs.capturePdf({
            page,
            url: origin + '/document.pdf',
            write: chunk => chunks.push(Buffer.from(chunk)),
          });
          if (!Buffer.concat(chunks).equals(expected))
            throw new Error('Captured bytes do not match the PDF response');
          console.log('capture ok');
        } finally {
          await browser.close();
          await new Promise(resolve => server.close(resolve));
        }
      })().catch(error => {
        console.error(error);
        process.exit(1);
      });
    `,
    'types.ts': `
      import { capturePdf, type PdfCaptureOptions } from '@playwright/pdf';
      import type { Page } from 'playwright-core';

      const options: PdfCaptureOptions = {
        page: undefined as unknown as Page,
        url: 'data:application/pdf;base64,JVBERg==',
        write: async chunk => { void chunk.byteLength; },
      };
      void capturePdf(options);
    `,
  });

  const tsc = path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
  await exec('node', tsc, '--noEmit', '--skipLibCheck', '--module', 'Node16', '--moduleResolution', 'Node16', '--target', 'ES2020', 'types.ts');
  expect(await exec('node capture.js')).toContain('capture ok');
});
