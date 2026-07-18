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

test('pdf opened from a blob url is detected and read', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/app', `
    <title>App</title>
    <button onclick="window.open(window.URL.createObjectURL(new Blob(['%PDF-1.4 blob content'], { type: 'application/pdf' })))">Print</button>
  `, 'text/html');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  const navigateResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/app' },
  });
  const ref = parseResponse(navigateResponse, testInfo.outputPath()).snapshot.match(/button "Print".*\[ref=(e\d+)\]/)?.[1];
  expect(ref).toBeTruthy();

  expect(await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Print button', target: ref },
  })).toHaveResponse({
    tabs: expect.stringContaining('blob:'),
  });

  expect(await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'select', index: 1 },
  })).toHaveResponse({
    result: expect.stringContaining('1: (current)'),
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('- PDF document: blob:'),
  });

  const pdfFiles = fs.readdirSync(testInfo.outputPath('output')).filter(f => f.endsWith('.pdf'));
  expect(pdfFiles).toHaveLength(1);
  expect(fs.readFileSync(testInfo.outputPath('output', pdfFiles[0]), 'utf-8')).toBe('%PDF-1.4 blob content');

  // Closing the PDF tab returns to the application.
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'close', index: 1 },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Print'),
  });
});

test('pdf produced by a form post stays in the same tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/app', `
    <title>App</title>
    <form method="post" action="${server.PREFIX}/report.pdf">
      <button type="submit">Generate report</button>
    </form>
  `, 'text/html');
  server.setRoute('/report.pdf', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end('%PDF-1.4 post result');
  });
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  const navigateResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/app' },
  });
  const ref = parseResponse(navigateResponse, testInfo.outputPath()).snapshot.match(/button "Generate report".*\[ref=(e\d+)\]/)?.[1];
  expect(ref).toBeTruthy();

  // The POST result cannot be reproduced by a fresh GET, so the PDF is kept in place.
  const clickResponse = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Generate report button', target: ref },
  });
  expect(clickResponse).toHaveResponse({
    tabs: undefined,
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/report.pdf`),
  });
  const parsed = parseResponse(clickResponse, testInfo.outputPath());
  expect(parsed.inlineSnapshot).toContain('cannot be re-fetched');
  expect(parsed.inlineSnapshot).not.toContain('own tab');
});

test('pdf link with a fragment opens in a new tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
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
    arguments: { url: server.PREFIX + '/empty.pdf#page=1' },
  })).toHaveResponse({
    tabs: expect.stringContaining('1: (current)'),
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });

  expect(fs.existsSync(testInfo.outputPath('output', 'empty.pdf'))).toBeTruthy();
});

test('pdf content type is matched case-insensitively', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setRoute('/upper.pdf', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'Application/PDF; charset=binary' });
    res.end('%PDF-1.4 upper case');
  });
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/upper.pdf' },
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/upper.pdf`),
  });
});

test('pdf content type requires an exact media type', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/not-a-pdf', '<title>Plain document</title><body>Not a PDF</body>', 'application/pdfx');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/not-a-pdf' },
  });
  expect(parseResponse(response, testInfo.outputPath()).text).not.toContain('PDF document');
});

test('pdf artifacts with the same basename use separate files', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/accounts/report.pdf', '%PDF-1.4 accounts', 'application/pdf');
  server.setContent('/orders/report.pdf', '%PDF-1.4 orders', 'application/pdf');
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/accounts/report.pdf' },
  });
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.PREFIX + '/orders/report.pdf' },
  });

  const pdfContents = fs.readdirSync(outputDir)
      .filter(file => file.endsWith('.pdf'))
      .map(file => fs.readFileSync(path.join(outputDir, file), 'utf8'));
  expect(pdfContents).toEqual(expect.arrayContaining(['%PDF-1.4 accounts', '%PDF-1.4 orders']));
  expect(pdfContents).toHaveLength(2);
});

test('failed pdf refetch is reported', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  let requests = 0;
  server.setRoute('/once.pdf', (req, res) => {
    if (++requests === 1) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end('%PDF-1.4 once');
    } else {
      res.writeHead(410, { 'Content-Type': 'text/html' });
      res.end('expired');
    }
  });
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/once.pdf' },
  });
  expect(parseResponse(response, testInfo.outputPath()).inlineSnapshot).toContain('HTTP 410 Gone');
  expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(file => file.endsWith('.pdf')) : []).toHaveLength(0);
});

test('pdf refetch follows the network origin policy across redirects', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  let requests = 0;
  let blockedRequests = 0;
  server.setRoute('/redirecting.pdf', (req, res) => {
    if (++requests === 1) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end('%PDF-1.4 redirect');
    } else {
      res.writeHead(302, { location: server.CROSS_PROCESS_PREFIX + '/blocked.pdf' });
      res.end();
    }
  });
  server.setRoute('/blocked.pdf', (req, res) => {
    blockedRequests++;
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end('%PDF-1.4 blocked');
  });
  const { client } = await startClient({
    config: {
      outputDir: testInfo.outputPath('output'),
      network: { allowedOrigins: [server.PREFIX], blockedOrigins: [server.CROSS_PROCESS_PREFIX] },
    },
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/redirecting.pdf' },
  });
  expect(parseResponse(response, testInfo.outputPath()).inlineSnapshot).toContain('blocked by the network origin policy');
  expect(blockedRequests).toBe(0);
});

test('pdf reached with location.replace stays in the original tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/older', '<title>Older</title><body>Older page</body>', 'text/html');
  server.setContent('/app', '<button onclick="location.replace(\'/report.pdf\')">Open report</button>', 'text/html');
  server.setContent('/report.pdf', '%PDF-1.4 report', 'application/pdf');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/older' } });
  const appResponse = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/app' } });
  const ref = parseResponse(appResponse, testInfo.outputPath()).snapshot.match(/button "Open report".*\[ref=([^\]]+)\]/)?.[1];
  expect(ref).toBeTruthy();

  const pdfResponse = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Open report button', target: ref },
  });
  expect(pdfResponse).toHaveResponse({
    tabs: undefined,
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/report.pdf`),
  });
  expect(parseResponse(pdfResponse, testInfo.outputPath()).inlineSnapshot).not.toContain('own tab');

  expect(await client.callTool({ name: 'browser_navigate_back' })).toHaveResponse({
    snapshot: expect.stringContaining('Older page'),
  });
});

test('navigating back to a pdf in history moves it to a new tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/empty.pdf' },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  // History navigation into a PDF also moves it to a tab of its own, and the
  // page the back navigation came from is restored via forward.
  expect(await client.callTool({
    name: 'browser_navigate_back',
  })).toHaveResponse({
    tabs: expect.stringContaining('hello-world'),
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });

  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'close' },
  });
  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Hello, world!'),
  });
});

test('pdf opened in the same tab via a blob url stays there', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  server.setContent('/app', `
    <title>App</title>
    <button onclick="location.href = window.URL.createObjectURL(new Blob(['%PDF-1.4 inline blob'], { type: 'application/pdf' }))">View PDF</button>
  `, 'text/html');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  const navigateResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/app' },
  });
  const ref = parseResponse(navigateResponse, testInfo.outputPath()).snapshot.match(/button "View PDF".*\[ref=(e\d+)\]/)?.[1];
  expect(ref).toBeTruthy();

  // Blob urls cannot be reproduced in another tab, so the PDF stays here and
  // the response must not advise closing the tab.
  const clickResponse = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'View PDF button', target: ref },
  });
  expect(clickResponse).toHaveResponse({
    tabs: undefined,
    inlineSnapshot: expect.stringContaining('- PDF document: blob:'),
  });
  expect(parseResponse(clickResponse, testInfo.outputPath()).inlineSnapshot).not.toContain('own tab');

  // Going back restores the application in place.
  expect(await client.callTool({
    name: 'browser_navigate_back',
  })).toHaveResponse({
    snapshot: expect.stringContaining('View PDF'),
  });
});

test('pdf survives the output budget cleanup', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'PDF viewer is only available in Chromium.');
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output'), outputMaxSize: 1 },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/empty.pdf' },
  });

  // A tool without a snapshot in its response still captures the PDF; the
  // budget cleanup must not delete it.
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'list' },
  });
  expect(fs.existsSync(testInfo.outputPath('output', 'empty.pdf'))).toBeTruthy();

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('[PDF content](output/empty.pdf)'),
  });
  expect(fs.existsSync(testInfo.outputPath('output', 'empty.pdf'))).toBeTruthy();
});

test('pdf already open when attaching is detected', async ({ cdpServer, startClient, server }, testInfo) => {
  const browserContext = await cdpServer.start();
  const [page] = browserContext.pages();
  await page.goto(server.PREFIX + '/empty.pdf');

  const { client } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`],
    config: { outputDir: testInfo.outputPath('output') },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- PDF document: ${server.PREFIX}/empty.pdf`),
  });
  expect(fs.existsSync(testInfo.outputPath('output', 'empty.pdf'))).toBeTruthy();
});

test('pdf attachment triggers a download instead of a pdf tab', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!!mcpBrowser && !['chromium', 'chrome', 'msedge'].includes(mcpBrowser), 'Behavior is only deterministic in Chromium.');
  server.setRoute('/attachment.pdf', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="attachment.pdf"' });
    res.end('%PDF-1.4 attachment');
  });
  const { client } = await startClient({
    config: { outputDir: testInfo.outputPath('output') },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/attachment.pdf' },
  });
  expect(parseResponse(response, testInfo.outputPath()).text).not.toContain('PDF document');

  // The tab still shows the application page.
  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('Hello, world!'),
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
