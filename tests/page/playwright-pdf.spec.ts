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

import { Buffer } from 'buffer';
import { capturePdf } from '../../packages/playwright-pdf/lib/index';
import { test, expect } from './pageTest';

test('captures a PDF through the package API', async ({ browserName, page, server }) => {
  test.skip(browserName !== 'chromium', 'Network PDF capture uses a Chromium CDP session.');
  const body = '%PDF-1.4 package API';
  server.setContent('/package.pdf', body, 'application/pdf');
  await page.goto(server.EMPTY_PAGE);

  const chunks: Buffer[] = [];
  await capturePdf({
    page,
    url: server.PREFIX + '/package.pdf',
    write: chunk => chunks.push(Buffer.from(chunk)),
  });

  expect(Buffer.concat(chunks).toString()).toBe(body);
});

test('does not replay headers from an unrelated response', async ({ browserName, page, server }) => {
  test.skip(browserName !== 'chromium', 'Network PDF capture uses a Chromium CDP session.');
  server.setContent('/source', '<title>Source</title>', 'text/html');
  let authorization: string | undefined;
  server.setRoute('/target.pdf', (request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end('%PDF-1.4 target');
  });
  await page.route('**/source', route => route.continue({
    headers: { ...route.request().headers(), authorization: 'Bearer secret' },
  }));
  const sourceResponse = await page.goto(server.PREFIX + '/source');
  await page.unrouteAll();
  await page.goto(server.EMPTY_PAGE);

  await capturePdf({
    page,
    url: server.PREFIX + '/target.pdf',
    response: sourceResponse!,
    write: () => {},
  });

  expect(authorization).toBeUndefined();
});

test('rejects invalid PDF media types before writing', async ({ browserName, page, server }) => {
  test.skip(browserName !== 'chromium', 'Network PDF capture uses a Chromium CDP session.');
  server.setContent('/invalid.pdf', 'not a pdf', 'application/pdfx');
  await page.goto(server.EMPTY_PAGE);

  const chunks: Buffer[] = [];
  await expect(capturePdf({
    page,
    url: server.PREFIX + '/invalid.pdf',
    write: chunk => chunks.push(Buffer.from(chunk)),
  })).rejects.toThrow('expected application/pdf');

  expect(chunks).toEqual([]);
});

test('aborts an in-progress package capture', async ({ browserName, page, server }) => {
  test.skip(browserName !== 'chromium', 'Network PDF capture uses a Chromium CDP session.');
  let requestStarted!: () => void;
  const requestStartedPromise = new Promise<void>(resolve => requestStarted = resolve);
  server.setRoute('/abort.pdf', (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.write('%PDF-1.4 partial');
    requestStarted();
  });
  await page.goto(server.EMPTY_PAGE);

  const controller = new AbortController();
  const capturePromise = capturePdf({
    page,
    url: server.PREFIX + '/abort.pdf',
    signal: controller.signal,
    write: () => {},
  });
  const rejection = expect(capturePromise).rejects.toThrow('user cancelled');
  await requestStartedPromise;
  controller.abort(new Error('user cancelled'));
  await rejection;
});

test('times out an in-progress package capture', async ({ browserName, page, server }) => {
  test.skip(browserName !== 'chromium', 'Network PDF capture uses a Chromium CDP session.');
  server.setRoute('/timeout.pdf', (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.write('%PDF-1.4 partial');
  });
  await page.goto(server.EMPTY_PAGE);

  await expect(capturePdf({
    page,
    url: server.PREFIX + '/timeout.pdf',
    timeout: 100,
    write: () => {},
  })).rejects.toThrow('timed out after 100ms');
});
