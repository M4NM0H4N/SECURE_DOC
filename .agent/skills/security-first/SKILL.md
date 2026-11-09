---
name: security-first
description: Guidelines for secure software development, vulnerability prevention (OWASP Top 10), and strict credential management.
---
# Security First Guidelines

This skill enforces high-end security practices to prevent common software vulnerabilities and protect sensitive data.

## Guidelines

1. **Credential & Secret Protection**:
   - Never hardcode secrets, passwords, API keys, private keys, or tokens in the codebase.
   - Always use environment variables (e.g. via `.env` files) and load them securely.
   - Ensure sensitive configuration files are included in `.gitignore`.

2. **Input Sanitization & Validation**:
   - Always sanitize and validate all user inputs (from forms, API parameters, or URL queries) before using them in database queries, rendering them in HTML, or passing them to OS processes.
   - Use parameterized/prepared statements for all database queries to prevent SQL injection.
   - Escapes user-generated HTML/JSON to prevent Cross-Site Scripting (XSS).

3. **Secure Communications & API Security**:
   - Enforce secure HTTPS policies.
   - Configure tight Cross-Origin Resource Sharing (CORS) policies (avoid `Access-Control-Allow-Origin: *` in production).
   - Use secure cookies with `HttpOnly`, `Secure`, and `SameSite` flags where applicable.
