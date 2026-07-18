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

import fs from 'fs';
import path from 'path';

import { test, expect, parseResponse } from './fixtures';

test('save as pdf unavailable', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(await client.callTool({
    name: 'browser_pdf_save',
  })).toHaveResponse({
    error: 'Tool "browser_pdf_save" not found',
    isError: true,
  });
});

test('save as pdf', async ({ startClient, mcpBrowser, server }, testInfo) => {
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output'), capabilities: ['pdf'] },
  });

  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'Save as PDF is only supported in Chromium.');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });

  expect(await client.callTool({
    name: 'browser_pdf_save',
  })).toHaveResponse({
    code: expect.stringContaining(`await page.pdf(`),
    result: expect.stringMatching(/\[Page as pdf\]\(.*page-[^:]+.pdf\)/),
  });
});

test('save as pdf (filename: output.pdf)', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'Save as PDF is only supported in Chromium.');
  const { client } = await startClient({
    config: { capabilities: ['pdf'] },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });

  expect(await client.callTool({
    name: 'browser_pdf_save',
    arguments: {
      filename: 'output.pdf',
    },
  })).toHaveResponse({
    result: expect.stringContaining(`output.pdf`),
    code: expect.stringContaining(`await page.pdf(`),
  });

  const files = [...fs.readdirSync(testInfo.outputPath())];

  expect(fs.existsSync(testInfo.outputPath())).toBeTruthy();
  const pdfFiles = files.filter(f => f.endsWith('.pdf'));
  expect(pdfFiles).toHaveLength(1);
  expect(pdfFiles[0]).toMatch(/^output.pdf$/);
});

test('navigating to a pdf opens it in a new tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/empty.pdf' },
  })).toHaveResponse({
    tabs: expect.stringContaining('1: (current)'),
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });

  // The PDF content is saved for reading.
  const pdfPath = testInfo.outputPath('output', 'empty.pdf');
  expect(fs.existsSync(pdfPath)).toBeTruthy();
  expect(fs.readFileSync(pdfPath).equals(fs.readFileSync(path.join(__dirname, '../assets/empty.pdf')))).toBeTruthy();

  // Closing the PDF tab returns to the application.
  expect(await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'close', index: 1 },
  })).toHaveResponse({
    result: expect.stringContaining('0: (current)'),
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Hello, world!'),
  });
});

test('clicking a link to a pdf opens it in a new tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/app', `
    <title>App</title>
    <a href="${server.PREFIX}/empty.pdf">Open PDF</a>
  `, 'text/html');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  const navigateResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/app' },
  });
  const ref = parseResponse(navigateResponse, testInfo.outputPath()).snapshot.match(/link "Open PDF".*\[ref=(e\d+)\]/)?.[1];
  expect(ref).toBeTruthy();

  expect(await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Open PDF link', target: ref },
  })).toHaveResponse({
    tabs: expect.stringContaining('1: (current)'),
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });

  // Closing the current (PDF) tab returns to the application.
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'close' },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Open PDF'),
  });
});

test('navigating to a pdf in a fresh tab keeps a single tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/empty.pdf' },
  })).toHaveResponse({
    tabs: undefined,
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });

  expect(fs.existsSync(testInfo.outputPath('output', 'empty.pdf'))).toBeTruthy();
});
