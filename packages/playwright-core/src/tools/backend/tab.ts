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
import { EventEmitter } from 'events';
import debug from 'debug';
import { asLocator } from '@isomorphic/locatorGenerators';
import { locatorOrSelectorAsSelector } from '@isomorphic/locatorParser';
import { ManualPromise } from '@isomorphic/manualPromise';
import { eventsHelper } from '@utils/eventsHelper';
import { createGuid } from '@utils/crypto';
import { disposeAll } from '@isomorphic/disposable';
import { waitForCompletion, eventWaiter } from './utils';
import { LogFile } from './logFile';
import { ModalState } from './tool';
import { handleDialog } from './dialogs';
import { uploadFile } from './files';

import type { Disposable } from '@isomorphic/disposable';
import type { Context, ContextConfig } from './context';
import type * as playwright from '../../..';

const TabEvents = {
  modalState: 'modalState'
};

type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

type Download = {
  download: playwright.Download;
  finished: boolean;
  outputFile: string;
};

type ConsoleLogEntry = {
  type: 'console';
  wallTime: number;
  message: ConsoleMessage;
};

type DownloadStartLogEntry = {
  type: 'download-start';
  wallTime: number;
  download: Download;
};

type DownloadFinishLogEntry = {
  type: 'download-finish';
  wallTime: number;
  download: Download;
};

type RequestLogEntry = {
  type: 'request';
  wallTime: number;
  request: playwright.Request;
};

type EventEntry = ConsoleLogEntry | DownloadStartLogEntry | DownloadFinishLogEntry | RequestLogEntry;


export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
  crashed: boolean;
  mainDocumentStatus?: { status: number, statusText: string };
  console: { total: number, warnings: number, errors: number };
};

type PdfDocument = {
  url: string;
  method: string;
  // The application page displaced by this PDF navigation, when restorable.
  restoreUrl?: string;
  response?: playwright.Response;
  // Set for documents that never hit the network (blob: and data: urls).
  local?: boolean;
  moveAttempted?: boolean;
  file?: string;
};

type PdfSnapshot = {
  url: string;
  file?: string;
  error?: string;
  // Set when the tab contains nothing but the PDF, so closing it is safe.
  dedicatedTab: boolean;
};

type TabSnapshot = {
  ariaSnapshot: string;
  modalStates: ModalState[];
  events: EventEntry[];
  consoleLink?: string;
  pdf?: PdfSnapshot;
};

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: playwright.Page;
  private _lastHeader: TabHeader = { title: 'about:blank', url: 'about:blank', current: false, crashed: false, console: { total: 0, warnings: 0, errors: 0 } };
  private _downloads: Download[] = [];
  private _requests: playwright.Request[] = [];
  private _mainDocumentStatus: { status: number, statusText: string } | undefined;
  private _onPageClose: (tab: Tab) => void;
  crashed = false;
  private _modalStates: ModalState[] = [];
  private _pdf: PdfDocument | undefined;
  private _mainFrameUrl: string;
  private _previousMainFrameUrl: string = 'about:blank';
  private _pdfProbedUrl: string | undefined;
  private _nextPdfIsDedicated = false;
  private _initializedPromise: Promise<void>;
  private _recentEventEntries: EventEntry[] = [];
  private _consoleLog: LogFile;
  private _disposables: Disposable[];
  readonly actionTimeoutOptions: { timeout?: number; };
  readonly navigationTimeoutOptions: { timeout?: number; };
  readonly expectTimeoutOptions: { timeout?: number; };

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page;
    this._onPageClose = onPageClose;
    // Existing pages (e.g. when attaching to a running browser) never emit an
    // initial framenavigated event, so seed the url from the page itself.
    this._mainFrameUrl = page.url();
    const p = page;
    this._disposables = [
      eventsHelper.addEventListener(p, 'console', event => this._handleConsoleMessage(messageToConsoleMessage(event))),
      eventsHelper.addEventListener(p, 'pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error))),
      eventsHelper.addEventListener(p, 'request', request => this._handleRequest(request)),
      eventsHelper.addEventListener(p, 'response', response => this._handleResponse(response)),
      eventsHelper.addEventListener(p, 'requestfailed', request => this._handleRequestFailed(request)),
      eventsHelper.addEventListener(p, 'framenavigated', frame => this._handleFrameNavigated(frame)),
      eventsHelper.addEventListener(p, 'close', () => this._onClose()),
      eventsHelper.addEventListener(p, 'crash', () => { this.crashed = true; }),
      eventsHelper.addEventListener(p, 'filechooser', chooser => {
        this.setModalState({
          type: 'fileChooser',
          description: 'File chooser',
          fileChooser: chooser,
          clearedBy: { tool: uploadFile.schema.name, skill: 'upload' }
        });
      }),
      eventsHelper.addEventListener(p, 'dialog', dialog => this._dialogShown(dialog)),
      eventsHelper.addEventListener(p, 'download', download => {
        void this._downloadStarted(download);
      }),
    ];
    // eslint-disable-next-line no-restricted-syntax
    (page as any)[tabSymbol] = this;
    const wallTime = Date.now();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
    this._initializedPromise = this._initialize();
    this.actionTimeoutOptions = { timeout: context.config.timeouts?.action };
    this.navigationTimeoutOptions = { timeout: context.config.timeouts?.navigation };
    this.expectTimeoutOptions = { timeout: context.config.timeouts?.expect };
  }

  async dispose() {
    await disposeAll(this._disposables);
    this._consoleLog.stop();
  }

  async waitForInitialized() {
    await this._initializedPromise;
  }

  static forPage(page: playwright.Page): Tab | undefined {
    // eslint-disable-next-line no-restricted-syntax
    return (page as any)[tabSymbol];
  }

  static async collectConsoleMessages(page: playwright.Page): Promise<ConsoleMessage[]> {
    const result: ConsoleMessage[] = [];
    const messages = await page.consoleMessages().catch(() => []);
    for (const message of messages)
      result.push(messageToConsoleMessage(message));
    const errors = await page.pageErrors().catch(() => []);
    for (const error of errors)
      result.push(pageErrorToConsoleMessage(error));
    return result;
  }

  private async _initialize() {
    for (const message of await Tab.collectConsoleMessages(this.page))
      this._handleConsoleMessage(message);
    const requests = await this.page.requests().catch(() => []);
    for (const request of requests.filter(r => r.existingResponse() || r.failure()))
      this._requests.push(request);
    for (const initPage of this.context.config.browser?.initPage || []) {
      try {
        const { default: func } = require(initPage);
        await func({ page: this.page });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to load init page "${initPage}": ${reason}`, { cause: e });
      }
    }
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState) {
    this._modalStates.push(modalState);
    this.emit(TabEvents.modalState, modalState);
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  private _dialogShown(dialog: playwright.Dialog) {
    this.setModalState({
      type: 'dialog',
      description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
      dialog,
      clearedBy: { tool: handleDialog.schema.name, skill: 'dialog-accept or dialog-dismiss' }
    });
  }

  private async _downloadStarted(download: playwright.Download) {
    // Do not trust web names.
    const outputFile = await this.context.outputFile({ suggestedFilename: sanitizeForFilePath(download.suggestedFilename()), prefix: 'download', ext: 'bin' }, { origin: 'code' });
    const entry = {
      download,
      finished: false,
      outputFile,
    };
    this._downloads.push(entry);
    this._addLogEntry({ type: 'download-start', wallTime: Date.now(), download: entry });
    await download.saveAs(entry.outputFile);
    entry.finished = true;
    this._addLogEntry({ type: 'download-finish', wallTime: Date.now(), download: entry });
  }

  private _clearCollectedArtifacts() {
    this._downloads.length = 0;
    this._requests.length = 0;
    this._mainDocumentStatus = undefined;
    this._recentEventEntries.length = 0;
    this._resetLogs();
  }

  private _resetLogs() {
    const wallTime = Date.now();
    this._consoleLog.stop();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
  }

  private _handleRequest(request: playwright.Request) {
    this._requests.push(request);
    // TODO: request start time is not available for fetch() before the
    // response is received, so we use Date.now() as a fallback.
    const wallTime = request.timing().startTime || Date.now();
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleResponse(response: playwright.Response) {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === this.page.mainFrame() && !request.redirectedTo())
      this._mainDocumentStatus = { status: response.status(), statusText: response.statusText() };
    const timing = request.timing();
    const wallTime = timing.responseStart + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request });
    this._trackPdfDocument(response);
  }

  private _trackPdfDocument(response: playwright.Response) {
    if (!response.request().isNavigationRequest() || response.frame() !== this.page.mainFrame())
      return;
    const contentType = response.headers()['content-type'] ?? '';
    // Attachments trigger a download instead of committing a navigation.
    const disposition = response.headers()['content-disposition'] ?? '';
    const isAttachmentPdf = isPdfContentType(contentType) && disposition.toLowerCase().startsWith('attachment');
    if (isPdfContentType(contentType) && !disposition.toLowerCase().startsWith('attachment')) {
      const dedicated = this._nextPdfIsDedicated;
      this._nextPdfIsDedicated = false;
      const restoreUrl = dedicated ? undefined : this._restoreUrl(this._mainFrameUrl);
      this._pdf = { url: response.url(), method: response.request().method(), restoreUrl, response };
      return;
    }
    if (response.request().redirectedTo())
      return;
    if (isAttachmentPdf) {
      const samePdf = this._pdf && urlWithoutFragment(this._pdf.url) === urlWithoutFragment(response.url());
      if (samePdf) {
        this._nextPdfIsDedicated = false;
        return;
      }
    }
    this._nextPdfIsDedicated = false;
    this._pdf = undefined;
    this.context.clearTabCloseTarget(this);
  }

  // There is an application page to restore only when the PDF displaced a real
  // page at a different url - a same-url replacement (e.g. a reload that now
  // serves a PDF) consumed the application's history entry.
  private _restoreUrl(previousUrl: string): string | undefined {
    return previousUrl !== 'about:blank' ? previousUrl : undefined;
  }

  // A PDF response that never committed (e.g. one that triggered a download)
  // leaves the page on its previous url - drop the stale record. Response urls
  // have the fragment stripped while page urls keep it, so compare without it.
  private _currentPdf(): PdfDocument | undefined {
    if (this._pdf && urlWithoutFragment(this.page.url()) !== urlWithoutFragment(this._pdf.url))
      this._pdf = undefined;
    return this._pdf;
  }

  private _handleFrameNavigated(frame: playwright.Frame) {
    if (frame !== this.page.mainFrame())
      return;
    this._pdfProbedUrl = undefined;
    // The PDF navigation response arrives before the frame navigation, so a
    // main frame navigation to any other url means the PDF is gone.
    if (this._pdf && urlWithoutFragment(frame.url()) !== urlWithoutFragment(this._pdf.url)) {
      this._pdf = undefined;
      this.context.clearTabCloseTarget(this);
    }
    if (!this._pdf && frame.url() !== this._mainFrameUrl) {
      this._previousMainFrameUrl = this._mainFrameUrl;
      this._mainFrameUrl = frame.url();
    }
  }

  async ensurePdfInNewTab(restoreDirection: 'back' | 'forward' = 'back'): Promise<void> {
    const pdf = this._currentPdf();
    if (!pdf?.restoreUrl || pdf.moveAttempted)
      return;
    // Blob and data documents only resolve in the tab that owns them and
    // cannot be reproduced in another tab.
    if (pdf.local)
      return;
    // Re-opening the document issues a fresh GET, so leave the results of
    // non-idempotent requests (e.g. POST form submissions) in place.
    if (pdf.method !== 'GET')
      return;
    pdf.moveAttempted = true;
    // Keep the application page in this tab and move the PDF into a tab of its
    // own, so that closing the PDF leaves the application unaffected.
    // _currentPdf() guarantees the page url is the same document, and unlike
    // the response url it keeps the fragment (e.g. #page=2).
    const pdfUrl = this.page.url();
    const newTab = await this.context.newTab();
    this.context.setTabCloseTarget(newTab, this);
    await newTab._initializedPromise.catch(e => debug('pw:tools:error')(e));
    newTab._nextPdfIsDedicated = true;
    await newTab.page.goto(pdfUrl, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions }).catch(e => debug('pw:tools:error')(e));
    // Only give up this tab's copy once the new tab shows the same document.
    if (newTab._currentPdf()?.url === pdf.url) {
      // A PDF reached via the Back button displaced the page that history
      // navigation left, which sits in the forward direction.
      if (restoreDirection === 'forward')
        await this.page.goForward(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
      else
        await this.page.goBack(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
    }
    if (!await this._restoredFromPdf(pdf)) {
      // The application page could not be restored (e.g. the PDF replaced its
      // history entry), so return to the PDF and drop the extra tab.
      if (urlWithoutFragment(this.page.url()) !== urlWithoutFragment(pdf.url)) {
        if (restoreDirection === 'forward')
          await this.page.goBack(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
        else
          await this.page.goForward(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
      }
      const currentPdf = this._currentPdf();
      if (currentPdf)
        currentPdf.moveAttempted = true;
      await newTab.page.close().catch(e => debug('pw:tools:error')(e));
      return;
    }
    this._pdf = undefined;
    await newTab.page.waitForLoadState('load', { timeout: 5000 }).catch(e => debug('pw:tools:error')(e));
  }

  private async _restoredFromPdf(pdf: PdfDocument): Promise<boolean> {
    if (!pdf.restoreUrl || urlWithoutFragment(this.page.url()) !== urlWithoutFragment(pdf.restoreUrl))
      return false;
    const contentType = await this.page.evaluate(() => document.contentType).catch(() => undefined);
    return contentType !== undefined && !isPdfContentType(contentType);
  }

  private _handleRequestFailed(request: playwright.Request) {
    const timing = request.timing();
    const wallTime = timing.responseEnd + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    const wallTime = message.timestamp;
    this._addLogEntry({ type: 'console', wallTime, message });
    if (shouldIncludeMessage(this.context.config.console?.level, message.type))
      this._consoleLog.appendLine(wallTime, message.toString());
  }

  logErrorMessage(text: string) {
    this._handleConsoleMessage(pageErrorToConsoleMessage(new Error(text)));
  }

  private _addLogEntry(entry: EventEntry) {
    this._recentEventEntries.push(entry);
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async headerSnapshot(): Promise<TabHeader & { changed: boolean }> {
    let title: string | undefined;
    let consoleCounts = { total: 0, errors: 0, warnings: 0 };
    if (!this.crashed) {
      await this._raceAgainstModalStates(async () => {
        title = await this.page.title();
      });
      consoleCounts = await this.consoleMessageCount();
    }
    const newHeader: TabHeader = {
      title: title ?? '',
      url: this.page.url(),
      current: this.isCurrentTab(),
      crashed: this.crashed,
      mainDocumentStatus: this._mainDocumentStatus,
      console: consoleCounts,
    };

    if (!tabHeaderEquals(this._lastHeader, newHeader)) {
      this._lastHeader = newHeader;
      return { ...this._lastHeader, changed: true };
    }
    return { ...this._lastHeader, changed: false };
  }

  isCurrentTab(): boolean {
    return this === this.context.currentTab();
  }

  async waitForLoadState(state: 'load', options?: { timeout?: number }): Promise<void> {
    await this._initializedPromise;
    await this.page.waitForLoadState(state, options).catch(e => debug('pw:tools:error')(e));
  }

  async checkUrlAndNavigate(url: string): Promise<string> {
    try {
      new URL(url);
    } catch (e) {
      if (url.startsWith('localhost'))
        url = 'http://' + url;
      else
        url = 'https://' + url;
    }
    this.context.checkUrlAllowed(url);
    await this.navigate(url);
    return url;
  }

  async navigate(url: string) {
    await this._initializedPromise;
    this._clearCollectedArtifacts();

    const { promise: downloadEvent, abort: abortDownloadEvent } = eventWaiter<playwright.Download>(this.page, 'download', 3000);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions });
      abortDownloadEvent();
    } catch (_e: unknown) {
      const e = _e as Error;
      const mightBeDownload =
        e.message.includes('net::ERR_ABORTED') // chromium
        || e.message.includes('Download is starting'); // firefox + webkit
      if (!mightBeDownload)
        throw e;
      // on chromium, the download event is fired *after* page.goto rejects, so we wait a lil bit
      const download = await downloadEvent;
      if (!download)
        throw e;
      // Make sure other "download" listeners are notified first.
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }

    // Cap load event to 5 seconds, the page is operational at this point.
    await this.waitForLoadState('load', { timeout: 5000 });
    await this.ensurePdfInNewTab();
  }

  async consoleMessageCount(): Promise<{ total: number, errors: number, warnings: number }> {
    await this._initializedPromise;
    const messages = await this.page.consoleMessages({ filter: 'since-navigation' });
    const pageErrors = await this.page.pageErrors({ filter: 'since-navigation' });
    let errors = pageErrors.length;
    let warnings = 0;
    for (const message of messages) {
      if (message.type() === 'error')
        errors++;
      else if (message.type() === 'warning')
        warnings++;
    }
    return { total: messages.length + pageErrors.length, errors, warnings };
  }

  async consoleMessages(level: ConsoleMessageLevel, all?: boolean): Promise<ConsoleMessage[]> {
    await this._initializedPromise;
    const result: ConsoleMessage[] = [];
    const messages = await this.page.consoleMessages({ filter: all ? 'all' : 'since-navigation' });
    for (const message of messages) {
      const cm = messageToConsoleMessage(message);
      if (shouldIncludeMessage(level, cm.type))
        result.push(cm);
    }
    if (shouldIncludeMessage(level, 'error')) {
      const errors = await this.page.pageErrors({ filter: all ? 'all' : 'since-navigation' });
      for (const error of errors)
        result.push(pageErrorToConsoleMessage(error));
    }
    return result;
  }

  async clearConsoleMessages() {
    await this._initializedPromise;
    await Promise.all([
      this.page.clearConsoleMessages(),
      this.page.clearPageErrors()
    ]);
  }

  async requests(): Promise<playwright.Request[]> {
    await this._initializedPromise;
    return this._requests;
  }

  async clearRequests() {
    await this._initializedPromise;
    this._requests.length = 0;
  }

  async captureSnapshot(root: playwright.Locator | undefined, depth: number | undefined, boxes: boolean | undefined, relativeTo: string | undefined, signal?: AbortSignal): Promise<TabSnapshot> {
    await this._initializedPromise;
    throwIfAborted(signal);
    let tabSnapshot: TabSnapshot | undefined;
    const modalStates = await this._raceAgainstModalStates(async () => {
      await this._probePdfDocument();
      const pdf = this._currentPdf();
      if (pdf) {
        tabSnapshot = {
          ariaSnapshot: '',
          modalStates: [],
          events: [],
          pdf: await this._capturePdf(pdf, signal),
        };
        return;
      }
      const ariaSnapshot = root
        ? await root.ariaSnapshot({ mode: 'ai', depth, boxes })
        : await this.page.ariaSnapshot({ mode: 'ai', depth, boxes });
      tabSnapshot = {
        ariaSnapshot,
        modalStates: [],
        events: [],
      };
    });
    if (tabSnapshot) {
      tabSnapshot.consoleLink = await this._consoleLog.take(relativeTo);
      tabSnapshot.events = this._recentEventEntries;
      this._recentEventEntries = [];
    }

    return tabSnapshot ?? {
      ariaSnapshot: '',
      modalStates,
      events: [],
    };
  }

  // Blob and data urls never produce a network response, and pages that were
  // already open when attaching produced theirs before we listened - probe the
  // document itself, once per url.
  private async _probePdfDocument() {
    if (this._pdf)
      return;
    const url = this.page.url();
    if (url === 'about:blank' || this._pdfProbedUrl === url)
      return;
    this._pdfProbedUrl = url;
    const contentType = await this.page.evaluate(() => document.contentType).catch(() => undefined);
    if (contentType === 'application/pdf' && this.page.url() === url) {
      const local = url.startsWith('blob:') || url.startsWith('data:');
      const restoreUrl = this._restoreUrl(this._previousMainFrameUrl);
      this._pdf = { url, method: 'GET', restoreUrl, local };
    }
  }

  private async _capturePdf(pdf: PdfDocument, signal?: AbortSignal): Promise<PdfSnapshot> {
    const dedicatedTab = !pdf.restoreUrl;
    throwIfAborted(signal);
    // Saving re-issues the request, which cannot reproduce non-GET results.
    if (!pdf.local && pdf.method !== 'GET')
      return { url: pdf.url, error: `The document was produced by a ${pdf.method} request and cannot be re-fetched for saving.`, dedicatedTab };
    // The output budget cleanup of a later response may have removed the file.
    if (pdf.file && !await fs.promises.access(pdf.file).then(() => true, () => false))
      pdf.file = undefined;
    if (!pdf.file) {
      let file = await this.context.outputFile({
        prefix: 'pdf',
        ext: 'pdf',
        suggestedFilename: suggestedPdfFilename(pdf.url),
      }, { origin: 'code' });
      let fileHandle: fs.promises.FileHandle | undefined;
      try {
        try {
          fileHandle = await fs.promises.open(file, 'wx');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
          const baseName = suggestedPdfFilename(pdf.url)?.replace(/\.pdf$/i, '') ?? 'pdf';
          file = await this.context.outputFile({ prefix: 'pdf', ext: 'pdf', suggestedFilename: `${baseName}-${createGuid()}.pdf` }, { origin: 'code' });
          fileHandle = await fs.promises.open(file, 'wx');
        }
        throwIfAborted(signal);
        await this._fetchPdf(pdf, fileHandle, signal);
        pdf.file = file;
      } catch (e) {
        await fileHandle?.close().catch(() => {});
        await fs.promises.unlink(file).catch(() => {});
        debug('pw:tools:error')(e);
        return { url: pdf.url, error: e instanceof Error ? e.message : String(e), dedicatedTab };
      } finally {
        await fileHandle?.close().catch(() => {});
      }
    }
    return { url: pdf.url, file: pdf.file, dedicatedTab };
  }

  private async _fetchPdf(pdf: PdfDocument, fileHandle: fs.promises.FileHandle, signal?: AbortSignal): Promise<void> {
    if (!pdf.local)
      this.context.checkNetworkUrlAllowed(pdf.url);
    throwIfAborted(signal);
    const requestHeaders = pdf.response ? await pdf.response.request().allHeaders() : {};
    const hasOriginalCookieHeader = Object.keys(requestHeaders).some(name => name.toLowerCase() === 'cookie');
    const originalReferrer = requestHeaders['referer'];
    const sameOriginReferrer = originalReferrer && sameOrigin(originalReferrer, this.page.url()) ? originalReferrer : undefined;
    let blockedUrl: string | undefined;
    let pdfNetworkId: string | undefined;
    let pdfRequestHeadersApplied = false;
    const internalRequests = new Set<playwright.Request>();
    const requestListener = (request: playwright.Request) => {
      if ((request.resourceType() === 'fetch' && urlWithoutFragment(request.url()) === urlWithoutFragment(pdf.url)) || (request.redirectedFrom() && internalRequests.has(request.redirectedFrom()!)))
        internalRequests.add(request);
    };
    this.page.on('request', requestListener);
    const bindingName = `__pwPdfChunk_${createGuid()}`;
    const cancelBindingName = `__pwPdfAbort_${createGuid()}`;
    const chunkBinding = await this.page.exposeBinding(bindingName, async (_source, base64: string) => {
      if (!base64)
        return;
      await fileHandle.write(Buffer.from(base64, 'base64'));
    });
    if (signal?.aborted)
      throwIfAborted(signal);
    const cdpSession = !pdf.local ? await this.page.context().newCDPSession(this.page) : undefined;
    if (cdpSession) {
      await cdpSession.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      if (signal?.aborted)
        throwIfAborted(signal);
      cdpSession.on('Fetch.requestPaused', event => {
        if (!pdfNetworkId && (event.resourceType === 'XHR' || event.resourceType === 'Fetch') && urlWithoutFragment(event.request.url) === urlWithoutFragment(pdf.url))
          pdfNetworkId = event.networkId;
        if (pdfNetworkId && event.networkId === pdfNetworkId) {
          try {
            this.context.checkNetworkUrlAllowed(event.request.url);
          } catch {
            blockedUrl = event.request.url;
            void cdpSession.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
            return;
          }
        }
        let headers: { name: string, value: string }[] | undefined;
        if (pdfNetworkId && event.networkId === pdfNetworkId && !pdfRequestHeadersApplied) {
          pdfRequestHeadersApplied = true;
          const mergedHeaders = new Map(Object.entries(event.request.headers).map(([name, value]) => [name.toLowerCase(), { name, value: String(value) }]));
          for (const [name, value] of Object.entries(requestHeaders)) {
            const lowerName = name.toLowerCase();
            if (!isReusablePdfRequestHeader(lowerName))
              continue;
            mergedHeaders.set(lowerName, { name, value });
          }
          if (!hasOriginalCookieHeader)
            mergedHeaders.delete('cookie');
          if (originalReferrer && !sameOriginReferrer)
            mergedHeaders.set('referer', { name: 'Referer', value: originalReferrer });
          headers = [...mergedHeaders.values()];
        }
        void cdpSession.send('Fetch.continueRequest', { requestId: event.requestId, ...(headers ? { headers } : {}) }).catch(() => {});
      });
    }
    const timeout = this.actionTimeoutOptions.timeout ?? 30_000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const cancelPdfRequest = () => void this.page.evaluate(name => {
      const windowBindings = globalThis as unknown as Record<string, ((payload?: string) => void) | undefined>;
      const abort = windowBindings[name];
      if (typeof abort === 'function')
        abort();
    }, cancelBindingName).catch(() => {});
    let onAbort: (() => void) | undefined;
    const abortPromise = signal ? new Promise<never>((_, reject) => {
      if (signal.aborted)
        throwIfAborted(signal);
      onAbort = () => {
        void cancelPdfRequest();
        reject(signal.reason instanceof Error ? signal.reason : new Error('The PDF refetch operation was aborted'));
      };
      signal.addEventListener('abort', onAbort);
      if (signal.aborted)
        onAbort();
    }) : undefined;
    const timeoutPromise = timeout ? new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        void cancelPdfRequest();
        reject(new Error(`The PDF refetch operation timed out after ${timeout}ms.`));
      }, timeout);
    }) : undefined;
    throwIfAborted(signal);
    const fetchResultPromise = this.page.evaluate(async ({ url, referrer, bindingName, cancelBindingName }) => {
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

        const reader = response.body?.getReader();
        if (!reader)
          throw new Error('Response has no readable body');

        while (true) {
          const item = await reader.read();
          if (item.done)
            break;
          const chunk = item.value;
          if (!chunk.length)
            continue;
          await windowBindings[bindingName]?.(toBase64(chunk));
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get('content-type') ?? '',
        };
      } finally {
        delete windowBindings[cancelBindingName];
      }
    }, {
      url: pdf.url,
      referrer: sameOriginReferrer,
      bindingName,
      cancelBindingName,
    });
    type PdfFetchResult = { ok: boolean, status: number, statusText: string, contentType: string };
    const resultPromises: Promise<PdfFetchResult>[] = [fetchResultPromise];
    if (abortPromise)
      resultPromises.push(abortPromise);
    if (timeoutPromise)
      resultPromises.push(timeoutPromise);
    try {
      const result = await Promise.race(resultPromises);
      if (blockedUrl)
        this.context.checkNetworkUrlAllowed(blockedUrl);
      if (!result.ok)
        throw new Error(`Failed to read the PDF content: HTTP ${result.status} ${result.statusText}.`);
      if (!isPdfContentType(result.contentType))
        throw new Error(`Failed to read the PDF content: expected application/pdf, received ${result.contentType || 'no content type'}.`);
    } catch (error) {
      throw error;
    } finally {
      if (signal && onAbort)
        signal.removeEventListener('abort', onAbort);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      await chunkBinding.dispose().catch(() => {});
      this.page.off('request', requestListener);
      this._requests = this._requests.filter(request => !internalRequests.has(request));
      await cdpSession?.detach().catch(() => {});
    }
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    return await Promise.race([
      action().then(() => {
        this.off(TabEvents.modalState, listener);
        return [];
      }),
      promise,
    ]);
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._initializedPromise;
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async targetLocator(params: { element?: string, target: string }): Promise<{ locator: playwright.Locator, resolved: string }> {
    await this._initializedPromise;
    return (await this.targetLocators([params]))[0];
  }

  async targetLocators(params: { element?: string, target: string }[]): Promise<{ locator: playwright.Locator, resolved: string }[]> {
    await this._initializedPromise;
    return Promise.all(params.map(async param => {
      if (!param.target.match(/^(f\d+)?e\d+$/)) {
        const selector = locatorOrSelectorAsSelector('javascript', param.target, this.context.config.testIdAttribute || 'data-testid');
        const handle = await this.page.$(selector);
        if (!handle)
          throw new Error(`"${param.target}" does not match any elements.`);
        handle.dispose().catch(() => {});
        return { locator: this.page.locator(selector), resolved: asLocator('javascript', selector) };
      } else {
        try {
          let locator = this.page.locator(`aria-ref=${param.target}`);
          if (param.element)
            locator = locator.describe(param.element);
          const resolved = await locator.normalize();
          return { locator, resolved: resolved.toString() };
        } catch (e) {
          throw new Error(`Ref ${param.target} not found in the current page snapshot. Try capturing new snapshot.`);
        }
      }
    }));
  }

  async waitForTimeout(time: number) {
    if (this._javaScriptBlocked()) {
      await new Promise(f => setTimeout(f, time));
      return;
    }

    await this.page.evaluate(ms => new Promise(f => setTimeout(f, ms)), time).catch(() => {});
  }
}

export type ConsoleMessage = {
  type: ReturnType<playwright.ConsoleMessage['type']>;
  timestamp: number;
  text: string;
  toString(): string;
};

function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  return {
    type: message.type(),
    timestamp: message.timestamp(),
    text: message.text(),
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`,
  };
}

function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
  if (errorOrValue instanceof Error) {
    return {
      type: 'error',
      timestamp: Date.now(),
      text: errorOrValue.message,
      toString: () => errorOrValue.stack || errorOrValue.message,
    };
  }
  return {
    type: 'error',
    timestamp: Date.now(),
    text: String(errorOrValue),
    toString: () => String(errorOrValue),
  };
}

export function renderModalStates(config: ContextConfig, modalStates: ModalState[]): string[] {
  const result: string[] = [];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates)
    result.push(`- [${state.description}]: can be handled by ${config.skillMode ? state.clearedBy.skill : state.clearedBy.tool}`);
  return result;
}

type ConsoleMessageType = ReturnType<playwright.ConsoleMessage['type']>;
type ConsoleMessageLevel = 'error' | 'warning' | 'info' | 'debug';
const consoleMessageLevels: ConsoleMessageLevel[] = ['error', 'warning', 'info', 'debug'];

export function shouldIncludeMessage(thresholdLevel: ConsoleMessageLevel | undefined, type: ConsoleMessageType): boolean {
  const messageLevel = consoleLevelForMessageType(type);
  return consoleMessageLevels.indexOf(messageLevel) <= consoleMessageLevels.indexOf(thresholdLevel || 'info');
}

function consoleLevelForMessageType(type: ConsoleMessageType): ConsoleMessageLevel {
  switch (type) {
    case 'assert':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'count':
    case 'dir':
    case 'dirxml':
    case 'info':
    case 'log':
    case 'table':
    case 'time':
    case 'timeEnd':
      return 'info';
    case 'clear':
    case 'debug':
    case 'endGroup':
    case 'profile':
    case 'profileEnd':
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

const tabSymbol = Symbol('tabSymbol');

function sanitizeForFilePath(s: string) {
  const sanitize = (s: string) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = s.lastIndexOf('.');
  const result = separator === -1 ? sanitize(s) : sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
  const stem = result.split('.', 1)[0];
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${result}` : result;
}

function urlWithoutFragment(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.substring(0, hashIndex);
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
  if (signal?.reason instanceof Error)
    throw signal.reason;
  throw new Error('The PDF capture operation was aborted');
}

function isReusablePdfRequestHeader(name: string): boolean {
  // These are computed for the new request by the browser or transport.
  return !['connection', 'content-length', 'host', 'range', 'if-range', 'transfer-encoding'].includes(name) && !name.startsWith('proxy-');
}

function isPdfContentType(contentType: string): boolean {
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/pdf';
}

function suggestedPdfFilename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const baseName = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1));
    if (baseName.toLowerCase().endsWith('.pdf'))
      return sanitizeForFilePath(baseName);
  } catch {
  }
  return undefined;
}

function tabHeaderEquals(a: TabHeader, b: TabHeader): boolean {
  return a.title === b.title &&
      a.url === b.url &&
      a.current === b.current &&
      a.crashed === b.crashed &&
      a.mainDocumentStatus?.status === b.mainDocumentStatus?.status &&
      a.mainDocumentStatus?.statusText === b.mainDocumentStatus?.statusText &&
      a.console.errors === b.console.errors &&
      a.console.warnings === b.console.warnings &&
      a.console.total === b.console.total;
}
