import type { Page, Request, Response } from 'playwright-core';

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
export declare function capturePdf(options: PdfCaptureOptions): Promise<void>;

/** Returns whether a Content-Type header denotes the PDF media type. */
export declare function isPdfContentType(contentType: string): boolean;

/** Removes a PDF viewer fragment such as `#page=2` from a URL. */
export declare function urlWithoutFragment(url: string): string;

/** Returns whether the PDF URL only exists inside its owning browser page. */
export declare function isLocalPdfUrl(url: string): boolean;

/** Returns a filesystem-safe PDF filename when the URL already names a PDF. */
export declare function suggestedPdfFilename(url: string): string | undefined;
