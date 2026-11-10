# Vendored third-party code

`qrcode.js` is **qrcode-generator 1.4.4** by Kazuhiko Arase (MIT licence, header kept in the file),
copied unchanged from the npm package. It draws the verification QR code in the browser, so the code
never leaves the page and no QR service is called.

It is not an npm dependency of this project. It was checked by generating QR codes for
verification-style URLs and decoding them with an independent decoder (jsQR); see docs/TRUST.md.
The file is served as a classic script from the same origin (the CSP allows `script-src 'self'`).
