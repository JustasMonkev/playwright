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

import { test as it, expect } from '@playwright/test';
import { isLocalPdfUrl, isPdfContentType, suggestedPdfFilename, urlWithoutFragment } from '../../../packages/playwright-pdf/lib/index';

it('recognizes exact PDF media types', () => {
  expect(isPdfContentType('Application/PDF; charset=binary')).toBe(true);
  expect(isPdfContentType('application/pdfx')).toBe(false);
});

it('derives safe filenames from PDF URLs', () => {
  expect(suggestedPdfFilename('https://example.com/reports/July%202026.pdf#page=2')).toBe('July-2026.pdf');
  expect(suggestedPdfFilename('https://example.com/CON.pdf')).toBe('_CON.pdf');
  expect(Buffer.byteLength(suggestedPdfFilename(`https://example.com/${'a'.repeat(300)}.pdf`)!)).toBe(200);
  expect(suggestedPdfFilename('https://example.com/report')).toBeUndefined();
});

it('compares PDF URLs without viewer fragments', () => {
  expect(urlWithoutFragment('https://example.com/report.pdf#page=2')).toBe('https://example.com/report.pdf');
  expect(urlWithoutFragment('https://example.com/report.pdf')).toBe('https://example.com/report.pdf');
});

it('identifies browser-local PDF URLs', () => {
  expect(isLocalPdfUrl('blob:https://example.com/id')).toBe(true);
  expect(isLocalPdfUrl('data:application/pdf;base64,JVBERg==')).toBe(true);
  expect(isLocalPdfUrl('https://example.com/report.pdf')).toBe(false);
});
