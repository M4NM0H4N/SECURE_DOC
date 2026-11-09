# Software Requirements Specification

**Project:** Secure Document Request and Approval Workflow
**Primary SDG:** SDG 16 - Peace, Justice and Strong Institutions
**Version:** 1.0 (reflects the implemented system)

## 1. Introduction

### 1.1 Purpose
This document specifies what the system does and the constraints it works under. It is written against the implemented code, and every requirement points to where it is implemented and tested.

### 1.2 Problem statement
Institutions often handle document requests manually, which makes it hard to track request status, manage approvals, control who may see what, and prove who did what. This system digitises the process with role-based access control, a fixed approval workflow, private document storage and an audit trail.

### 1.3 Objectives
1. Let students request official documents and track them.
2. Let authorised staff review, approve or reject, and fulfil requests through fixed stages.
3. Keep every document private and every action attributable.
4. Make the rules enforceable on the server, not in the user interface.

### 1.4 SDG alignment
| Target | How the system supports it |
|---|---|
| 16.6 Effective, accountable and transparent institutions | Fixed approval stages, mandatory rejection reasons, full per-request history, append-only audit trail with named actors |
| 16.10 Public access to information and fundamental freedoms | Students can see the status, decision history and reason for every request of their own, and download the issued document at any time |
| 16.7 Responsive and inclusive decision-making (supporting) | Clear queues per department, no hidden steps, mobile-friendly interface |

### 1.5 Scope
In scope: registration and login, four roles, request submission, Clerk review, HOD approval or rejection, document upload and secure download, status tracking, admin user management, audit log, validation and security controls, automated tests, responsive UI.
Out of scope (not built): AI approval, QR verification, SMS/email notifications, payments, ERP integration, analytics/NAAC reporting, multi-institution SaaS, SLA automation, blockchain audit, password change/reset.

### 1.6 Definitions
| Term | Meaning |
|---|---|
| Request | A student's application for one official document |
| Department | One of CSE, ME, CIVIL, ECE, EEE; scopes Clerk and HOD access |
| Fulfilled | The official document has been uploaded and the student can download it |
| Audit record | An append-only entry naming the actor, action, time and request |

## 2. Overall description

### 2.1 Users
| Role | Description |
|---|---|
| Student | Registers publicly; requests documents; sees only their own requests |
| Clerk | Department staff; moves requests to review; uploads the final document |
| HOD | Head of department; approves or rejects requests of their department |
| Admin | Creates staff accounts, activates/deactivates users, reads the audit log; has no approval powers |

### 2.2 Operating environment
Node.js 20+ server, MongoDB 7 as a replica set (transactions), any modern browser. Delivery by Docker Compose (local database) and a Jenkins pipeline. The production target is MongoDB Atlas + Render ([DEPLOYMENT.md](DEPLOYMENT.md)); it is prepared but has not been deployed.

### 2.3 Constraints and assumptions
- Staff accounts are created only by the Admin or the one-time seed script.
- The Admin is bootstrapped once from environment variables; no credentials are hardcoded.
- Documents are issued by staff; the system does not generate them.
- The audit log is application-level append-only, not absolutely immutable (database administrators can still change it).

## 3. Functional requirements

| ID | Requirement | Implemented in | Verified by |
|---|---|---|---|
| FR-01 | Students shall be able to register and log in. | `authController`, `authService`, `register.html`, `login.html` | `auth.test.js` |
| FR-02 | The system shall authenticate users securely (hashed passwords, signed token in an HttpOnly cookie, active-account check on every request). | `authService`, `middleware/authenticate.js` | `auth.test.js` (hashing, cookie flags, invalid/expired JWT, deactivated user) |
| FR-03 | The system shall enforce role-based access control on the server. | `middleware/authorize.js`, `requestService.scopeFilter`, route definitions | `workflow`, `requests`, `admin`, `e2e` suites |
| FR-04 | Students shall be able to submit document requests. | `POST /api/requests`, `student.js` | `requests.test.js` |
| FR-05 | Students shall be able to view their own request history, status and rejection reasons. | `GET /api/requests`, `/:id`, `request.html` | `requests.test.js`, `workflow.test.js` |
| FR-06 | Clerks shall be able to review requests and move them to Under Review. | `PATCH /:id/review`, `staff.js` | `workflow.test.js` |
| FR-07 | HODs shall be able to approve or reject requests of their department. | `PATCH /:id/approve`, `/reject` | `workflow.test.js` |
| FR-08 | Rejection shall require a reason. | `rejectRules` validator | `workflow.test.js` (7 bad-reason cases) |
| FR-09 | Clerks shall be able to upload the approved document, which fulfils the request. | `documentService.uploadFulfilment` | `documents.test.js` |
| FR-10 | Students shall be able to download their fulfilled document. | `documentService.resolveDownload` | `documents.test.js`, `e2e.test.js` |
| FR-11 | The system shall record audit events for important actions. | `auditService`, `AuditLog` | `audit.test.js` |
| FR-12 | Admins shall be able to manage user accounts and read the audit log. | `adminController`, `admin/*.html` | `admin.test.js`, `audit.test.js` |

### 3.1 Business rules
| ID | Rule |
|---|---|
| BR-01 | Public registration always creates a Student; a role is never accepted from the client. |
| BR-02 | A request's department is copied from the student's profile, never taken from input. |
| BR-03 | Students see only their own requests. Clerks and HODs see only their own department. Out-of-scope requests return 404. |
| BR-04 | Only these transitions exist: PENDING to UNDER_REVIEW (Clerk), UNDER_REVIEW to APPROVED or REJECTED (HOD), APPROVED to FULFILLED (Clerk). All others are rejected with 409. |
| BR-05 | A status change must be atomic: two simultaneous actors cannot both succeed. |
| BR-06 | The Admin cannot approve, reject, upload or read document contents. |
| BR-07 | A deactivated user loses access immediately. |
| BR-08 | A request becomes Fulfilled only if the file is stored and the database change has committed. |

## 4. Non-functional requirements

| ID | Category | Requirement | How it is met |
|---|---|---|---|
| NFR-01 | Security | Prevent unauthorised access and privilege escalation | Server-side RBAC and scope checks, role never taken from input, 404 for out-of-scope resources |
| NFR-02 | Security | Protect credentials and sessions | bcrypt (cost 12), HttpOnly SameSite=Strict cookie, secrets only in environment variables, login rate limit |
| NFR-03 | Security | Resist common web attacks | Helmet CSP, CSRF header, NoSQL operator sanitising, strict input validation, no `innerHTML`, no inline scripts |
| NFR-04 | Security | Keep documents private | Files outside the web root, random names, signature-checked, downloads only via authorised endpoint |
| NFR-05 | Reliability | Keep request status consistent | Atomic conditional updates; transactions tie each change to its audit record |
| NFR-06 | Auditability | Every important action is attributable | Append-only audit records with actor, action, request and time; no secrets stored |
| NFR-07 | Usability | Simple, consistent interface | Role dashboards, status badges, loading/empty/error states, skip link |
| NFR-08 | Responsiveness | Works on phone, tablet and desktop | Mobile-first CSS; verified at 375, 768 and desktop widths; no horizontal overflow; touch targets of at least 44 px |
| NFR-09 | Maintainability | Modular code | routes, controllers, services, models, validators; one place for constants and for scope rules |
| NFR-10 | Performance | Normal responses without noticeable delay | Indexed queries, paginated lists; no load testing was done |
| NFR-11 | Scalability | Suitable for future growth | Stateless server, MongoDB indexes; multi-institution support is out of scope |

## 5. Use cases (summary)

Detailed diagrams: [UML.md](UML.md).

| Use case | Actor | Main flow |
|---|---|---|
| UC-1 Register | Student | Enter name, email, password, department; account created as Student |
| UC-2 Submit request | Student | Choose type and purpose; request created as PENDING |
| UC-3 Review request | Clerk | Open department queue; move a PENDING request to UNDER_REVIEW |
| UC-4 Decide request | HOD | Approve, or reject with a reason |
| UC-5 Fulfil request | Clerk | Upload the official document for an APPROVED request |
| UC-6 Download document | Student (also Clerk, HOD of the department) | Download a FULFILLED request's document |
| UC-7 Manage staff | Admin | Create Clerk/HOD accounts; activate or deactivate users |
| UC-8 Audit | Admin | Filter and read the audit trail |

## 6. External interfaces

- **User interface:** static HTML/CSS/JavaScript pages served by the same Express server.
- **API:** documented in [API.md](API.md).
- **Database:** MongoDB (collections `users`, `requests`, `auditlogs`).
- **File system:** private folder for uploaded documents.
- No third-party web services are used.

## 7. Acceptance criteria and status

Each criterion from the project plan, with the evidence that exists today.

| Criterion | Status | Evidence |
|---|---|---|
| Student registration and login work | Met | `auth.test.js`, browser check |
| Initial Admin seed script works | Met | `scripts/seedAdmin.js` run twice (create, then skip); no automated test |
| Admin can create staff accounts | Met | `admin.test.js`, `e2e.test.js` |
| Four roles implemented, backend RBAC enforced | Met | `workflow`, `requests`, `admin`, `documents` suites |
| Student ownership and HOD department restrictions | Met | `requests`, `workflow`, `documents`, `e2e` |
| Submit, review, approve/reject, mandatory reason | Met | `workflow.test.js` |
| Upload by Clerk, secure download by Student | Met | `documents.test.js`, `e2e.test.js`, browser check |
| Status transitions enforced | Met | `workflow.test.js` (12 invalid cases, 3 concurrency races) |
| Audit events generated | Met | `audit.test.js` |
| File upload restrictions work | Met | `documents.test.js` |
| Security test scenarios pass | Met | [TESTING.md](TESTING.md) maps all 15 required scenarios |
| MongoDB transaction limits documented and tested | Met | [TRANSACTIONS.md](TRANSACTIONS.md), `transactions.test.js` |
| Mobile and desktop layouts work | Met (manual) | measured at 375, 768 and desktop; no automated UI tests |
| Automated test results recorded | Met | 238 tests passing, [TESTING.md](TESTING.md) |
| Jenkins pipeline runs successfully | **Not yet demonstrated** | `Jenkinsfile` written; its commands pass locally, but it has not run on a Jenkins server |
| UML diagrams and SE documentation complete | Met | [UML.md](UML.md), this SRS, [API.md](API.md) |
| End-to-end demonstration works | Met | `e2e.test.js` (automated) and [DEMO.md](DEMO.md) |

## 8. Known limitations
See [LIMITATIONS.md](LIMITATIONS.md).
