/**
 * The QR code library, loaded when a screen first draws a code.
 *
 * `public/vendor/qrcode-1.0.0.min.js` (qrcodejs, 20 KB) used to be a script
 * tag in the document's head, fetched and run before first paint on every
 * load. Three places draw a code, and none of them is the first screen: the
 * wallet sheet's Receive panel, Settings › Homeroom Wallet, and the "Get the
 * app" sheet. Each of them asks here instead (request #7165, point 3).
 *
 * The file is still in the service worker's SHELL_ASSETS, so it is in the
 * offline cache from install and a code can be drawn with no connection. The
 * address is `assetUrl(...)`: the build-scoped form the worker stored it
 * under in a deploy, the plain path in a checkout.
 *
 * A failed load is forgotten, so the next open tries again; the caller draws
 * no code and keeps the text beside it (the address, the store links), which
 * is what each of them did when the global was missing.
 */
import { assetUrl } from './asset-url';

export const QR_CODE_SRC = '/vendor/qrcode-1.0.0.min.js';

export type QRCodeLibrary = {
  new (el: HTMLElement, options: Record<string, unknown>): unknown;
  CorrectLevel: Record<string, number>;
};

type Host = { QRCode?: QRCodeLibrary };

let library: Promise<QRCodeLibrary> | null = null;

export function loadQRCode(): Promise<QRCodeLibrary> {
  const host = window as unknown as Host;
  if (typeof host.QRCode === 'function') return Promise.resolve(host.QRCode);
  if (library) return library;
  const p = new Promise<QRCodeLibrary>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = assetUrl(QR_CODE_SRC);
    s.async = true;
    s.onload = () => {
      if (typeof host.QRCode === 'function') resolve(host.QRCode);
      else reject(new Error('the QR code library did not load'));
    };
    s.onerror = () => { s.remove(); reject(new Error('the QR code library did not load')); };
    document.head.appendChild(s);
  });
  library = p;
  p.catch(() => { if (library === p) library = null; });
  return p;
}
