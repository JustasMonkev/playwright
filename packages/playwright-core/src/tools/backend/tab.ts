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
  // Set for documents that never hit the network (blob: and data: urls).
  local?: boolean;
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
    if (isPdfContentType(contentType) && !disposition.toLowerCase().startsWith('attachment')) {
      const restoreUrl = this._restoreUrl(this._mainFrameUrl, response.url());
      this._pdf = { url: response.url(), method: response.request().method(), restoreUrl };
    } else {
      this._pdf = undefined;
    }
  }

  // There is an application page to restore only when the PDF displaced a real
  // page at a different url - a same-url replacement (e.g. a reload that now
  // serves a PDF) consumed the application's history entry.
  private _restoreUrl(previousUrl: string, pdfUrl: string): string | undefined {
    return previousUrl !== 'about:blank' && urlWithoutFragment(previousUrl) !== urlWithoutFragment(pdfUrl) ? previousUrl : undefined;
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
    // The PDF navigation response arrives before the frame navigation, so a
    // main frame navigation to any other url means the PDF is gone.
    if (this._pdf && urlWithoutFragment(frame.url()) !== urlWithoutFragment(this._pdf.url))
      this._pdf = undefined;
    if (!this._pdf && frame.url() !== this._mainFrameUrl) {
      this._previousMainFrameUrl = this._mainFrameUrl;
      this._mainFrameUrl = frame.url();
    }
  }

  async ensurePdfInNewTab(restoreDirection: 'back' | 'forward' = 'back'): Promise<void> {
    const pdf = this._currentPdf();
    if (!pdf?.restoreUrl)
      return;
    // Blob and data documents only resolve in the tab that owns them and
    // cannot be reproduced in another tab.
    if (pdf.local)
      return;
    // Re-opening the document issues a fresh GET, so leave the results of
    // non-idempotent requests (e.g. POST form submissions) in place.
    if (pdf.method !== 'GET')
      return;
    // Keep the application page in this tab and move the PDF into a tab of its
    // own, so that closing the PDF leaves the application unaffected.
    // _currentPdf() guarantees the page url is the same document, and unlike
    // the response url it keeps the fragment (e.g. #page=2).
    const pdfUrl = this.page.url();
    const newTab = await this.context.newTab();
    await newTab._initializedPromise.catch(e => debug('pw:tools:error')(e));
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
    if (!this._restoredFromPdf(pdf)) {
      // The application page could not be restored (e.g. the PDF replaced its
      // history entry), so return to the PDF and drop the extra tab.
      if (urlWithoutFragment(this.page.url()) !== urlWithoutFragment(pdf.url)) {
        if (restoreDirection === 'forward')
          await this.page.goBack(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
        else
          await this.page.goForward(this.navigationTimeoutOptions).catch(e => debug('pw:tools:error')(e));
      }
      await newTab.page.close().catch(e => debug('pw:tools:error')(e));
      return;
    }
    this._pdf = undefined;
    await newTab.page.waitForLoadState('load', { timeout: 5000 }).catch(e => debug('pw:tools:error')(e));
  }

  private _restoredFromPdf(pdf: PdfDocument): boolean {
    return !!pdf.restoreUrl && urlWithoutFragment(this.page.url()) === urlWithoutFragment(pdf.restoreUrl);
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

  async captureSnapshot(root: playwright.Locator | undefined, depth: number | undefined, boxes: boolean | undefined, relativeTo: string | undefined): Promise<TabSnapshot> {
    await this._initializedPromise;
    let tabSnapshot: TabSnapshot | undefined;
    const modalStates = await this._raceAgainstModalStates(async () => {
      await this._probePdfDocument();
      const pdf = this._currentPdf();
      if (pdf) {
        tabSnapshot = {
          ariaSnapshot: '',
          modalStates: [],
          events: [],
          pdf: await this._capturePdf(pdf),
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
      const restoreUrl = this._restoreUrl(this._previousMainFrameUrl, url);
      this._pdf = { url, method: 'GET', restoreUrl, local };
    }
  }

  private async _capturePdf(pdf: PdfDocument): Promise<PdfSnapshot> {
    const dedicatedTab = !pdf.restoreUrl;
    // Saving re-issues the request, which cannot reproduce non-GET results.
    if (!pdf.local && pdf.method !== 'GET')
      return { url: pdf.url, error: `The document was produced by a ${pdf.method} request and cannot be re-fetched for saving.`, dedicatedTab };
    // The output budget cleanup of a later response may have removed the file.
    if (pdf.file && !await fs.promises.access(pdf.file).then(() => true, () => false))
      pdf.file = undefined;
    if (!pdf.file) {
      try {
        // The navigation response body is the built-in PDF viewer in Chromium,
        // so re-fetch the document with the page credentials instead.
        const data = pdf.local ? await this._fetchPdfInPage(pdf.url) : await this._fetchPdf(pdf.url);
        const suggestedFilename = suggestedPdfFilename(pdf.url);
        let file = await this.context.outputFile({ prefix: 'pdf', ext: 'pdf', suggestedFilename }, { origin: 'code' });
        try {
          await fs.promises.writeFile(file, data, { flag: 'wx' });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
          const baseName = suggestedFilename?.replace(/\.pdf$/i, '') ?? 'pdf';
          file = await this.context.outputFile({ prefix: 'pdf', ext: 'pdf', suggestedFilename: `${baseName}-${createGuid()}.pdf` }, { origin: 'code' });
          await fs.promises.writeFile(file, data, { flag: 'wx' });
        }
        pdf.file = file;
      } catch (e) {
        debug('pw:tools:error')(e);
        return { url: pdf.url, error: e instanceof Error ? e.message : String(e), dedicatedTab };
      }
    }
    return { url: pdf.url, file: pdf.file, dedicatedTab };
  }

  private async _fetchPdf(url: string): Promise<Buffer> {
    for (let redirects = 0; redirects <= 20; redirects++) {
      this.context.checkNetworkUrlAllowed(url);
      const response = await this.page.request.get(url, { maxRedirects: 0 });
      try {
        const location = response.headers()['location'];
        if (response.status() >= 300 && response.status() < 400 && location) {
          url = new URL(location, url).href;
          continue;
        }
        if (!response.ok())
          throw new Error(`Failed to read the PDF content: HTTP ${response.status()} ${response.statusText()}.`);
        if (!isPdfContentType(response.headers()['content-type'] ?? ''))
          throw new Error(`Failed to read the PDF content: expected application/pdf, received ${response.headers()['content-type'] || 'no content type'}.`);
        return await response.body();
      } finally {
        await response.dispose();
      }
    }
    throw new Error('Failed to read the PDF content: too many redirects.');
  }

  private async _fetchPdfInPage(url: string): Promise<Buffer> {
    const base64 = await this.page.evaluate(async url => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize)
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      return btoa(binary);
    }, url);
    return Buffer.from(base64, 'base64');
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
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

function urlWithoutFragment(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.substring(0, hashIndex);
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
