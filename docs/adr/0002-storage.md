# ADR 0002: Document storage

- **Status:** Proposed (applies in S4; owner confirms provider)
- **Context:** The MVP stores files on the local disk (`UPLOAD_DIR`). Render's ordinary filesystem is ephemeral, and a persistent disk is paid and limits the service to one instance.
- **Decision:**
  - Introduce a storage interface with a local adapter (development and tests) and an S3-compatible adapter (Cloudflare R2 recommended for lower egress cost; AWS S3 also works).
  - Private bucket, keys prefixed by tenant, downloads streamed through the API after authorisation or via short-lived signed URLs.
  - Keep the magic-byte check and add malware scanning (ClamAV) before a file is accepted.
- **Until S4:** deployments must not rely on the local disk for anything that has to survive a redeploy (see `docs/DEPLOYMENT.md`).
- **Consequences:** Orphan-file cleanup job; adapter tests run against both adapters.
