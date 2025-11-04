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

import { expect, test } from './ui-mode-fixtures';

test('should filter network requests by resource type', async ({ runUITest, server }) => {
  server.setRoute('/api/endpoint', (_, res) => res.setHeader('Content-Type', 'application/json').end());

  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  const networkItems = page.getByRole('list', { name: 'Network requests' }).getByRole('listitem');

  await page.getByText('JS', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('script.js')).toBeVisible();

  await page.getByText('CSS', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('style.css')).toBeVisible();

  await page.getByText('Image', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('image.png')).toBeVisible();

  await page.getByText('Fetch', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('endpoint')).toBeVisible();

  await page.getByText('HTML', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('network.html')).toBeVisible();

  await page.getByText('Font', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('font.woff2')).toBeVisible();
});

test('should filter network requests by multiple resource types', async ({ runUITest, server }) => {
  server.setRoute('/api/endpoint', (_, res) => res.setHeader('Content-Type', 'application/json').end());

  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  const networkItems = page.getByRole('list', { name: 'Network requests' }).getByRole('listitem');
  await expect(networkItems).toHaveCount(9);

  await page.getByText('JS', { exact: true }).click();
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('script.js')).toBeVisible();

  await page.getByText('CSS', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect(networkItems.getByText('script.js')).toBeVisible();
  await expect(networkItems.getByText('style.css')).toBeVisible();
  await expect(networkItems).toHaveCount(2);

  await page.getByText('Image', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect(networkItems.getByText('image.png')).toBeVisible();
  await expect(networkItems).toHaveCount(3);

  await page.getByText('CSS', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect(networkItems).toHaveCount(2);
  await expect(networkItems.getByText('script.js')).toBeVisible();
  await expect(networkItems.getByText('image.png')).toBeVisible();

  await page.getByText('All', { exact: true }).click();
  await expect(networkItems).toHaveCount(9);
});

test('should filter network requests by url', async ({ runUITest, server }) => {
  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  const networkItems = page.getByRole('list', { name: 'Network requests' }).getByRole('listitem');

  await page.getByPlaceholder('Filter network').fill('script.');
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('script.js')).toBeVisible();

  await page.getByPlaceholder('Filter network').fill('png');
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('image.png')).toBeVisible();

  await page.getByPlaceholder('Filter network').fill('api/');
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('endpoint')).toBeVisible();

  await page.getByPlaceholder('Filter network').fill('End');
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('endpoint')).toBeVisible();

  await page.getByPlaceholder('Filter network').fill('FON');
  await expect(networkItems).toHaveCount(1);
  await expect(networkItems.getByText('font.woff2')).toBeVisible();
});

test('should format JSON request body', async ({ runUITest, server }) => {
  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  await page.getByText('post-data-1').click();

  await expect(page.locator('.CodeMirror-code .CodeMirror-line')).toHaveText([
    '{',
    '  "data": {',
    '    "key": "value",',
    '    "array": [',
    '      "value-1",',
    '      "value-2"',
    '    ]',
    '  }',
    '}',
  ], { useInnerText: true });

  await page.getByText('post-data-2').click();

  await expect(page.locator('.CodeMirror-code .CodeMirror-line')).toHaveText([
    '{',
    '  "data": {',
    '    "key": "value",',
    '    "array": [',
    '      "value-1",',
    '      "value-2"',
    '    ]',
    '  }',
    '}',
  ], { useInnerText: true });
});

test('should display list of query parameters (only if present)', async ({ runUITest, server }) => {
  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  await page.getByText('call-with-query-params').click();

  await expect(page.getByText('Query String Parameters')).toBeVisible();
  await expect(page.getByText('param1: value1')).toBeVisible();
  await expect(page.getByText('param1: value2')).toBeVisible();
  await expect(page.getByText('param2: value2')).toBeVisible();

  await page.getByText('endpoint').click();

  await expect(page.getByText('Query String Parameters')).not.toBeVisible();
});

test('should not duplicate network entries from beforeAll', {
  annotation: [
    { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/34404' },
    { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/33106' },
  ]
}, async ({ runUITest, server }) => {
  const { page } = await runUITest({
    'playwright.config.ts': `
      module.exports = { use: { trace: 'on' } };
    `,
    'a.spec.ts': `
      import { test as base, expect, request, type APIRequestContext } from '@playwright/test';

      const test = base.extend<{}, { apiRequest: APIRequestContext }>({
        apiRequest: [async ({ }, use) => {
          const apiContext = await request.newContext();
          await use(apiContext);
          await apiContext.dispose();
        }, { scope: 'worker' }]
      });

      test.beforeAll(async ({ apiRequest }) => {
        await apiRequest.get("${server.EMPTY_PAGE}");
      });

      test('first test', async ({ }) => { });

      test.afterAll(async ({ apiRequest }) => { });
    `,
  });

  await page.getByText('first test').dblclick();
  await page.getByText('Network', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Network requests' }).getByText('empty.html')).toHaveCount(1);
});

test('should download network logs as HAR', async ({ runUITest, server }) => {
  server.setRoute('/api/endpoint', (_, res) => res.setHeader('Content-Type', 'application/json').end('{"result": "ok"}'));

  const { page } = await runUITest({
    'network-tab.test.ts': `
      import { test, expect } from '@playwright/test';
      test('network tab test', async ({ page }) => {
        await page.goto('${server.PREFIX}/network-tab/network.html');
        await page.evaluate(() => (window as any).donePromise);
      });
    `,
  });

  await page.getByText('network tab test').dblclick();
  await page.getByText('Network', { exact: true }).click();

  // Wait for network resources to be displayed
  const networkItems = page.getByRole('list', { name: 'Network requests' }).getByRole('listitem');
  await expect(networkItems.first()).toBeVisible();

  // Set up download promise before clicking
  const downloadPromise = page.waitForEvent('download');

  // Click the download button
  await page.getByRole('button', { name: 'Download network logs as HAR' }).click();

  // Wait for download
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^network-logs-.*\.har$/);

  // Verify the HAR file contents
  const path = await download.path();
  const fs = await import('fs');
  const harContent = fs.readFileSync(path, 'utf-8');
  const har = JSON.parse(harContent);

  // Verify HAR structure
  expect(har.log).toBeDefined();
  expect(har.log.version).toBe('1.2');
  expect(har.log.creator).toBeDefined();
  expect(har.log.creator.name).toBe('Playwright');
  expect(har.log.entries).toBeDefined();
  expect(Array.isArray(har.log.entries)).toBe(true);
  expect(har.log.entries.length).toBeGreaterThan(0);

  // Verify entries have required HAR fields
  const entry = har.log.entries[0];
  expect(entry.request).toBeDefined();
  expect(entry.response).toBeDefined();
  expect(entry.request.method).toBeDefined();
  expect(entry.request.url).toBeDefined();
  expect(entry.response.status).toBeDefined();
});
