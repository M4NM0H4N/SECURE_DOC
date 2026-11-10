# ADR 0004: keep the vanilla JS frontend

Status: accepted (S7 decision point).

Context: the plan said to decide on React after S7. The client is about 25 small ES-module pages, no build step, strict CSP with no inline script, and every page is tested through the real server.

Decision: keep vanilla JS. A framework would add a build pipeline, a dependency tree to audit and a rewrite of every screen without adding a requirement the product has. Shared behaviour lives in `layout.js`, `api.js`, `branding.js`.

Consequences: no component library; accessibility is checked per page (S8 axe run). Revisit if a screen needs heavy client state.
