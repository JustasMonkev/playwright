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
import { randomUUID } from 'crypto';

import type { CDPSession, Page, Request, Response } from 'playwright-core';

export type PdfCaptureOptions = {
  /** Page whose browser session and credentials are used for the request. */
  page: Page;
  /** Absolute `http:`, `https:`, `blob:`, or `data:` URL to capture. */
  url: string;
  /** Original navigation response, used to preserve safe request headers. */
  response?: Response;
  /** Override local URL detection for an embedder that already classified the URL. */
  local?: boolean;
  /** Capture timeout in milliseconds. Defaults to 30 seconds; zero disables it. */
  timeout?: number;
  /** Cancels the browser fetch and rejects the capture. */
  signal?: AbortSignal;
  /** Receives PDF bytes in order without buffering the full document. */
  write: (chunk: Uint8Array) => Promise<void> | void;
  /** Optional network policy, applied to the initial URL and every redirect. */
  checkNetworkUrlAllowed?: (url: string) => void;
  /** Reports package-owned fetch requests so an embedder can hide internal traffic. */
  onInternalRequests?: (requests: ReadonlySet<Request>) => void;
  /** Origin to permit when the supplied page cannot be loaded on the PDF origin. */
  corsOrigin?: string;
};

/**
 * Captures PDF bytes by fetching inside the page and streaming chunks to Node.
 * Network URLs require Chromium because redirect and header handling uses CDP.
 */
export async function capturePdf(options: PdfCaptureOptions): Promise<void> {
  const { page, url, response, signal, write, checkNetworkUrlAllowed, onInternalRequests, corsOrigin } = options;
  const local = options.local ?? isLocalPdfUrl(url);
  if (!local)
    checkNetworkUrlAllowed?.(url);
  throwIfAborted(signal);

  const requestHeaders = response && urlWithoutFragment(response.url()) === urlWithoutFragment(url) ? await response.request().allHeaders() : {};
  const hasOriginalCookieHeader = Object.keys(requestHeaders).some(name => name.toLowerCase() === 'cookie');
  const originalReferrer = requestHeaders['referer'];
  const sameOriginReferrer = originalReferrer && sameOrigin(originalReferrer, page.url()) ? originalReferrer : undefined;
  let blockedUrl: string | undefined;
  let pdfNetworkId: string | undefined;
  let pdfRequestHeadersApplied = false;
  const internalRequests = new Set<Request>();
  const requestListener = (request: Request) => {
    if ((request.resourceType() === 'fetch' && urlWithoutFragment(request.url()) === urlWithoutFragment(url)) || (request.redirectedFrom() && internalRequests.has(request.redirectedFrom()!)))
      internalRequests.add(request);
  };
  const bindingSuffix = randomUUID().replace(/-/g, '');
  const bindingName = `__pwPdfChunk_${bindingSuffix}`;
  const cancelBindingName = `__pwPdfAbort_${bindingSuffix}`;
  let chunkBinding: { dispose(): Promise<void> } | undefined;
  let cdpSession: CDPSession | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cancelPdfRequest = () => void page.evaluate(name => {
    const windowBindings = globalThis as unknown as Record<string, ((payload?: string) => void) | undefined>;
    const abort = windowBindings[name];
    if (typeof abort === 'function')
      abort();
  }, cancelBindingName).catch(() => {});
  const checkBlockedUrl = () => {
    if (!blockedUrl)
      return;
    checkNetworkUrlAllowed?.(blockedUrl);
    blockedUrl = undefined;
  };

  page.on('request', requestListener);
  try {
    chunkBinding = await page.exposeBinding(bindingName, async (_source, base64: string) => {
      if (base64)
        await write(Buffer.from(base64, 'base64'));
    });
    const abortPromise = signal ? new Promise<never>((_, reject) => {
      if (signal.aborted)
        throwIfAborted(signal);
      onAbort = () => {
        void cancelPdfRequest();
        reject(signal.reason instanceof Error ? signal.reason : new Error('The PDF capture operation was aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted)
        onAbort();
    }) : undefined;
    const timeout = options.timeout ?? 30_000;
    const timeoutPromise = timeout ? new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        void cancelPdfRequest();
        reject(new Error(`The PDF capture operation timed out after ${timeout}ms.`));
      }, timeout);
    }) : undefined;

    throwIfAborted(signal);
    cdpSession = !local ? await page.context().newCDPSession(page) : undefined;
    if (cdpSession) {
      const patterns: { urlPattern: string, requestStage: 'Request' | 'Response' }[] = [
        { urlPattern: '*', requestStage: 'Request' },
      ];
      if (corsOrigin)
        patterns.push({ urlPattern: '*', requestStage: 'Response' });
      await cdpSession.send('Fetch.enable', { patterns });
      throwIfAborted(signal);
      cdpSession.on('Fetch.requestPaused', event => {
        const responseStage = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
        if (responseStage) {
          if (corsOrigin && pdfNetworkId && event.networkId === pdfNetworkId && event.responseStatusCode !== undefined) {
            const responseHeaders = (event.responseHeaders ?? []).filter(header => {
              const name = header.name.toLowerCase();
              return name !== 'access-control-allow-origin' && name !== 'access-control-allow-credentials';
            });
            responseHeaders.push(
                { name: 'Access-Control-Allow-Origin', value: corsOrigin },
                { name: 'Access-Control-Allow-Credentials', value: 'true' });
            void cdpSession!.send('Fetch.continueResponse', {
              requestId: event.requestId,
              responseCode: event.responseStatusCode,
              responsePhrase: event.responseStatusText,
              responseHeaders,
            }).catch(() => {});
          } else {
            void cdpSession!.send('Fetch.continueResponse', { requestId: event.requestId }).catch(() => {});
          }
          return;
        }
        if (!pdfNetworkId && (event.resourceType === 'XHR' || event.resourceType === 'Fetch') && urlWithoutFragment(event.request.url) === urlWithoutFragment(url))
          pdfNetworkId = event.networkId;
        if (pdfNetworkId && event.networkId === pdfNetworkId && checkNetworkUrlAllowed) {
          try {
            checkNetworkUrlAllowed(event.request.url);
          } catch {
            blockedUrl = event.request.url;
            void cdpSession!.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
            return;
          }
        }
        let headers: { name: string, value: string }[] | undefined;
        if (pdfNetworkId && event.networkId === pdfNetworkId && !pdfRequestHeadersApplied) {
          pdfRequestHeadersApplied = true;
          const mergedHeaders = new Map(Object.entries(event.request.headers).map(([name, value]) => [name.toLowerCase(), { name, value: String(value) }]));
          for (const [name, value] of Object.entries(requestHeaders)) {
            const lowerName = name.toLowerCase();
            if (isReusablePdfRequestHeader(lowerName))
              mergedHeaders.set(lowerName, { name, value });
          }
          if (!hasOriginalCookieHeader)
            mergedHeaders.delete('cookie');
          if (originalReferrer && !sameOriginReferrer)
            mergedHeaders.set('referer', { name: 'Referer', value: originalReferrer });
          headers = [...mergedHeaders.values()];
        }
        void cdpSession!.send('Fetch.continueRequest', { requestId: event.requestId, ...(headers ? { headers } : {}) }).catch(() => {});
      });
    }

    await page.evaluate(name => {
      const windowBindings = globalThis as unknown as Record<string, (() => void) | undefined>;
      if (!windowBindings[name])
        windowBindings[name] = () => {};
    }, cancelBindingName).catch(() => {});
    throwIfAborted(signal);
    const fetchResultPromise = page.evaluate(async ({ url, referrer, bindingName, cancelBindingName }) => {
      const toBase64 = (bytes: Uint8Array) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      };

      const windowBindings = window as unknown as Record<string, ((payload?: string) => void) | undefined>;
      const controller = new AbortController();
      windowBindings[cancelBindingName] = () => controller.abort();
      try {
        const response = await fetch(url, {
          credentials: 'include',
          ...(referrer ? { referrer } : { referrerPolicy: 'no-referrer' }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Failed to read the PDF content: HTTP ${response.status} ${response.statusText}.`);
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/pdf')
          throw new Error(`Failed to read the PDF content: expected application/pdf, received ${contentType || 'no content type'}.`);

        const reader = response.body?.getReader();
        if (!reader)
          throw new Error('Response has no readable body');
        while (true) {
          const item = await reader.read();
          if (item.done)
            break;
          if (item.value.length)
            await windowBindings[bindingName]?.(toBase64(item.value));
        }
        return { ok: response.ok, status: response.status, statusText: response.statusText, contentType };
      } finally {
        delete windowBindings[cancelBindingName];
      }
    }, { url, referrer: sameOriginReferrer, bindingName, cancelBindingName });

    type PdfFetchResult = { ok: boolean, status: number, statusText: string, contentType: string };
    const resultPromises: Promise<PdfFetchResult>[] = [fetchResultPromise];
    if (abortPromise)
      resultPromises.push(abortPromise);
    if (timeoutPromise)
      resultPromises.push(timeoutPromise);
    const result = await Promise.race(resultPromises);
    checkBlockedUrl();
    if (!result.ok)
      throw new Error(`Failed to read the PDF content: HTTP ${result.status} ${result.statusText}.`);
    if (!isPdfContentType(result.contentType))
      throw new Error(`Failed to read the PDF content: expected application/pdf, received ${result.contentType || 'no content type'}.`);
  } catch (error) {
    checkBlockedUrl();
    throw error;
  } finally {
    if (signal && onAbort)
      signal.removeEventListener('abort', onAbort);
    if (timeoutHandle)
      clearTimeout(timeoutHandle);
    await chunkBinding?.dispose().catch(() => {});
    page.off('request', requestListener);
    onInternalRequests?.(internalRequests);
    await cdpSession?.detach().catch(() => {});
  }
}

/** Returns whether a Content-Type header denotes the PDF media type. */
export function isPdfContentType(contentType: string): boolean {
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/pdf';
}

/** Removes a PDF viewer fragment such as `#page=2` from a URL. */
export function urlWithoutFragment(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.substring(0, hashIndex);
}

/** Returns whether the PDF URL only exists inside its owning browser page. */
export function isLocalPdfUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

/** Returns a filesystem-safe PDF filename when the URL already names a PDF. */
export function suggestedPdfFilename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const baseName = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1));
    if (baseName.toLowerCase().endsWith('.pdf')) {
      const sanitized = sanitizeForFilePath(baseName);
      const extension = sanitized.slice(-4);
      return truncateToUtf8Bytes(sanitized.slice(0, -4), 200 - Buffer.byteLength(extension)) + extension;
    }
  } catch {
  }
  return undefined;
}

function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes)
      break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function sanitizeForFilePath(value: string): string {
  const sanitize = (part: string) => part.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = value.lastIndexOf('.');
  const result = separator === -1 ? sanitize(value) : sanitize(value.substring(0, separator)) + '.' + sanitize(value.substring(separator + 1));
  const stem = result.split('.', 1)[0];
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${result}` : result;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted)
    return;
  if (signal.reason instanceof Error)
    throw signal.reason;
  throw new Error('The PDF capture operation was aborted');
}

function isReusablePdfRequestHeader(name: string): boolean {
  return !['connection', 'content-length', 'host', 'range', 'if-range', 'transfer-encoding'].includes(name) && !name.startsWith('proxy-');
}
