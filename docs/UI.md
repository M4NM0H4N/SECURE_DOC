# UI design system (branch `ui-redesign`)

Dark-first interface built from the approved mockup. Vanilla CSS/JS only; no inline scripts or styles (strict CSP).

## Palette
| Role | Value |
|---|---|
| Background / cards | `#121212` / `#1C1C1C` (light theme: `#F4F7FB` / white) |
| Lime | `#A6E35B`: primary actions, active navigation, verified marks |
| Violet | `#7657FF`: identity and validation (text uses the lighter tint `#A99BFF`, since raw violet is 3.7:1 on a dark card) |
| Cyan | `#20CFFF`: proof, verification, current step, focus ring |
| Status | Pending amber, Under review cyan, Approved/Fulfilled green, Rejected red (each shown as text, never colour alone) |

Tokens live in `client/css/tokens.css`. The theme is `html[data-theme="dark|light"]`: dark by default, set before first paint by `/js/theme.js` (external script, so the CSP stays strict), switched with the "Light mode / Dark mode" button and remembered in the browser only. An institution's own brand colour is applied in the light theme only.

## Pieces
- **Landing** (`/t/<slug>/` when signed out): `home.html` + `css/landing.css`. Hero "REQUEST. APPROVE. PROVE." with an SVG of three glass layers (Identity, Validation, Proof). Signed-in visitors are redirected to their dashboard.
- **Shell**: sidebar on screens 1100px and wider (role-specific links built in `js/layout.js`), collapsible top bar on tablets and phones.
- **Student dashboard**: welcome card with quick actions, live statistics, request cards with a progress track (`css/dashboard.css`).
- **Verify page**: a code box (when opened without a code) and a verdict icon (genuine, superseded, withdrawn).

## Copy rules
The copy describes only what exists: tamper-evident hash-chained audit log, private document storage, signed verification codes. It does not claim blockchain, and it does not claim that documents are not stored.

## Accessibility and tests
WCAG 2.1 A/AA scans (axe) run on every page in both themes (`e2e/a11y.spec.js`); layout checks at 320, 375 and 768px (`e2e/responsive.spec.js`). The theme is selected in tests the same way a person selects it (saved choice).

## Phase C (staff, detail and analytics screens)
- **Clerk / HOD / Principal dashboards:** welcome card, live status tiles (Pending, Under review, Approved, Fulfilled, Rejected). Each tile is a button that filters the list below and shows which filter is active (`aria-pressed`). Request cards carry the same progress track as the student view.
- **Shared progress track:** `progress()` in `js/format.js` (Submitted → Review → Approved → Issued, or stops at Rejected).
- **Request details:** progress track at the top and a history timeline whose dot colour follows the status reached (violet pending, cyan under review, lime approved, green fulfilled, red rejected, amber needs information); the document card has a cyan accent.
- **Analytics:** summary figures as tiles; bars use a violet-to-cyan gradient.
- **Admin, audit, settings, account pages:** pick up the new theme and sidebar automatically; their tables and forms use the same tokens.

## Landing page (dynamic)
Public page at `/t/<slug>/` (`home.html`, `js/landing.js`, `css/landing.css`). Signed-in visitors are redirected to their dashboard.
- **From the server, per institution:** name, logo, tagline and brand colour (branding endpoint); the departments it serves (public list); a live status pill from `/readyz` (booleans only). No request numbers or personal data are shown.
- **Interactive:** the hero stack tilts with the mouse; an example request steps through Request, Review, Approve, Issue (auto-plays, stops when the visitor chooses a step) and lights the Identity, Validation and Proof layers; role tabs (keyboard: arrows, Home, End); FAQ; inline "verify a document" box (a plain GET form, so it works without scripting); light/dark switch.
- **Safe by construction:** no inline scripts or styles, no HTML strings (DOM methods only), animation is transform-only so text is never hidden, everything stops under "reduce motion".
- **Honest copy:** says hash-chained audit log and signed verification codes; says plainly it is not a blockchain.
- **Tests:** `e2e/landing.spec.js` (9 tests) plus the page in the accessibility (both themes) and layout (320/375/768px) scans.
