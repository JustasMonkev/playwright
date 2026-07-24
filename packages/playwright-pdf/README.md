# @playwright/pdf

Capture an existing PDF response through a Playwright page and stream its bytes to a caller-provided sink.

This package captures PDF documents. It does not generate PDFs like `page.pdf()` and it does not parse or render PDF contents.

## Install

```bash
npm install @playwright/pdf playwright-core
```

`@playwright/pdf` and `playwright-core` should use compatible versions.

## Quick start

```js
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { capturePdf } from '@playwright/pdf';

const browser = await chromium.launch();
const page = await browser.newPage();
const pdfUrl = 'https://example.com/report.pdf';
const response = await page.goto(pdfUrl, { waitUntil: 'commit' });
const file = await fs.promises.open('report.pdf', 'w');

try {
  await capturePdf({
    page,
    url: response.url(),
    response,
    write: chunk => file.write(chunk),
  });
} finally {
  await file.close();
  await browser.close();
}
```

CommonJS is also supported:

```js
const { capturePdf } = require('@playwright/pdf');
```

## API

### `capturePdf(options)`

Fetches the URL inside the supplied page, verifies a successful PDF response, and passes each byte chunk to `write` in order.

| Option | Type | Description |
| --- | --- | --- |
| `page` | `Page` | Playwright page whose browser session, cookies, routes, and origin are used. |
| `url` | `string` | Absolute `http:`, `https:`, `blob:`, or `data:` URL. |
| `write` | `(chunk: Uint8Array) => void \| Promise<void>` | Required streaming sink. Backpressure is preserved by awaiting each call. |
| `response` | `Response` | Optional original navigation response. Safe request headers are reused when present. |
| `local` | `boolean` | Optional override for `blob:`/`data:` URL detection. |
| `timeout` | `number` | Timeout in milliseconds. Defaults to 30 seconds; `0` disables it. |
| `signal` | `AbortSignal` | Cancels the browser fetch and rejects the operation. |
| `checkNetworkUrlAllowed` | `(url: string) => void` | Optional policy callback, checked for the initial URL and every redirect. Throw to block a request. |
| `onInternalRequests` | `(requests: ReadonlySet<Request>) => void` | Optional cleanup hook for embedders that collect page network events. |

The promise rejects when the request is blocked, aborted, times out, returns a non-2xx response, has a non-PDF media type, or cannot expose a readable body.

### URL helpers

- `isPdfContentType(value)` matches the exact `application/pdf` media type case-insensitively and accepts parameters.
- `isLocalPdfUrl(url)` identifies `blob:` and `data:` URLs.
- `urlWithoutFragment(url)` removes viewer fragments such as `#page=2`.
- `suggestedPdfFilename(url)` returns a sanitized `.pdf` filename when the URL has one.

## Browser support

Network capture currently requires Chromium because request-header preservation and redirect policy checks use a Chrome DevTools Protocol session. `blob:` and `data:` URLs are fetched inside their owning page without CDP.

The Playwright MCP integration therefore enables PDF-document handling in Chrome and Chromium and deliberately skips viewer behavior in Firefox and WebKit.

## Security model

- Fetching happens in the page so existing cookies, credentials, and Playwright routes remain effective.
- The optional network policy is checked before the request and again for redirected URLs.
- Browser-computed transport headers such as `Host`, `Content-Length`, `Range`, and proxy headers are not copied from the original navigation.
- Cookies are not added when the original navigation did not send a `Cookie` header.
- The caller owns the output path and file permissions; this package only emits byte chunks.

## arm64 and other CPU architectures

The package contains JavaScript, type declarations, and documentation only. It has no native addon or architecture-specific binary, so its API and package contents are identical on arm64 and x64. Browser availability still follows the installed `playwright-core` version and platform support. On Apple Silicon, install and launch the normal Playwright arm64 browser build; no Rosetta-specific setup is required by this package.

## Development

From the Playwright repository root:

```bash
npm run build
npm run ctest -- tests/library/unit/playwright-pdf.spec.ts tests/page/playwright-pdf.spec.ts
npm run test-mcp -- pdf.spec.ts
npm run itest -- playwright-pdf-package.spec.ts
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the package boundary, request flow, failure behavior, and Playwright MCP integration.
