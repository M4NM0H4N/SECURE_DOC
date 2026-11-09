# UML Diagrams

These diagrams describe the implemented system (not a plan). They are written in [Mermaid](https://mermaid.js.org/), which GitHub, VS Code and most Markdown viewers render directly. The source of each diagram is in `docs/diagrams/*.mmd`; this page is generated from those files.

All seven diagrams were parsed successfully with Mermaid 10.9.1 (a deliberately broken diagram is rejected by the same checker). If the implementation changes, update the `.mmd` file and regenerate this page.

## 1. Use case diagram

Who can do what. Backend middleware enforces every one of these permissions; the buttons in the UI are only a convenience.

```mermaid
flowchart LR
  student([Student])
  clerk([Clerk])
  hod([HOD])
  admin([Admin])

  subgraph system["Secure Document Request and Approval Workflow"]
    direction TB
    uc_reg(Register as student)
    uc_login(Log in / log out)
    uc_submit(Submit document request)
    uc_own(View own requests, status and history)
    uc_reason(View rejection reason)
    uc_dl(Download fulfilled document)
    uc_dept(View department requests)
    uc_review(Move request to Under Review)
    uc_upload(Upload document and fulfil request)
    uc_approve(Approve request)
    uc_reject(Reject request with reason)
    uc_staff(Create staff accounts)
    uc_users(Activate / deactivate users)
    uc_audit(View audit log)
    uc_all(View all requests - read only)
  end

  student --- uc_reg
  student --- uc_login
  student --- uc_submit
  student --- uc_own
  student --- uc_reason
  student --- uc_dl

  clerk --- uc_login
  clerk --- uc_dept
  clerk --- uc_review
  clerk --- uc_upload
  clerk --- uc_dl

  hod --- uc_login
  hod --- uc_dept
  hod --- uc_approve
  hod --- uc_reject
  hod --- uc_dl

  admin --- uc_login
  admin --- uc_staff
  admin --- uc_users
  admin --- uc_audit
  admin --- uc_all
```

## 2. Class diagram (data model)

The three persisted collections (User, Request, AuditLog) and the embedded status history. Mongoose schemas live in `server/models/`. `passwordHash` and `documentPath` are never returned by the API.

```mermaid
classDiagram
  direction LR

  class User {
    +ObjectId _id
    +String name
    +String email  «unique, lowercase»
    -String passwordHash  «bcrypt, never returned»
    +Role role
    +Department department  «null for ADMIN»
    +Boolean isActive
    +Date createdAt
    +Date updatedAt
  }

  class Request {
    +ObjectId _id
    +ObjectId studentId
    +Department department  «copied from student profile»
    +DocumentType documentType
    +String purpose  «10-500 chars»
    +Status status
    +ObjectId reviewedBy
    +ObjectId decidedBy
    +String rejectionReason
    -String documentPath  «UUID filename, never exposed»
    +Date createdAt
    +Date updatedAt
  }

  class StatusHistoryEntry {
    +Status from
    +Status to
    +ObjectId by
    +Date at
    +String note
  }

  class AuditLog {
    +ObjectId _id
    +ObjectId actorId
    +AuditAction action
    +ObjectId requestId
    +Object details  «no secrets»
    +Date timestamp
  }

  class Role {
    <<enumeration>>
    STUDENT
    CLERK
    HOD
    ADMIN
  }

  class Status {
    <<enumeration>>
    PENDING
    UNDER_REVIEW
    APPROVED
    REJECTED
    FULFILLED
  }

  class Department {
    <<enumeration>>
    CSE
    ME
    CIVIL
    ECE
    EEE
  }

  User "1" --> "0..*" Request : submits (studentId)
  User "1" --> "0..*" Request : reviews (reviewedBy)
  User "1" --> "0..*" Request : decides (decidedBy)
  Request "1" *-- "1..*" StatusHistoryEntry : statusHistory
  User "1" --> "0..*" StatusHistoryEntry : performed (by)
  User "1" --> "0..*" AuditLog : actor (actorId)
  Request "1" --> "0..*" AuditLog : subject (requestId)
  User ..> Role
  User ..> Department
  Request ..> Status
  Request ..> Department
```

## 3. Class diagram (service layer)

How controllers, middleware and services depend on each other. Business rules (scope, transitions, audit, transactions) live in `server/services/`, not in controllers.

```mermaid
classDiagram
  direction LR

  class RequestController
  class AdminController
  class AuthController

  class authenticate {
    <<middleware>>
    verifies JWT cookie
    reloads user, checks isActive
  }
  class authorize {
    <<middleware>>
    role gate
  }

  class RequestService {
    +scopeFilter(user)
    +createRequest(student, data)
    +listRequests(user, query)
    +getRequestForUser(user, id)
  }
  class TransitionService {
    +transition(actor, id, to, options)
    +findRule(to, role)
  }
  class DocumentService {
    +uploadFulfilment(actor, id, file)
    +resolveDownload(user, id)
    +validateFile(file)
  }
  class AuditService {
    +record(event, session)
    +recordSafe(event)
    +listAuditLogs(filter)
  }
  class UserService {
    +createStaff(actor, data)
    +updateUser(actor, id, changes)
    +listUsers(query)
  }
  class AuthService {
    +registerStudent(data)
    +login(email, password)
    +signToken(userId)
  }
  class Transactions {
    +runInTransaction(fn)
    +detectMode()
  }

  RequestController --> authenticate
  RequestController --> authorize
  RequestController --> RequestService
  RequestController --> TransitionService
  RequestController --> DocumentService
  AdminController --> UserService
  AdminController --> AuditService
  AuthController --> AuthService
  AuthController --> AuditService

  DocumentService --> RequestService : scopeFilter
  DocumentService --> TransitionService : APPROVED to FULFILLED
  TransitionService --> AuditService
  TransitionService --> Transactions
  RequestService --> AuditService
  RequestService --> Transactions
  UserService --> AuditService
  UserService --> Transactions
```

## 4. Sequence diagram (request and approval process)

The complete lifecycle including the transaction boundaries, the file-then-database ordering, cleanup on failure, and the download check.

```mermaid
sequenceDiagram
  autonumber
  actor S as Student
  actor C as Clerk
  actor H as HOD
  participant API as Express API
  participant DB as MongoDB
  participant FS as Private file storage

  Note over S,API: Every call: auth cookie + CSRF header, then authenticate (reload user, isActive) and authorize (role)

  S->>API: POST /api/requests {documentType, purpose}
  API->>DB: transaction: insert request (PENDING, department from profile) + audit REQUEST_SUBMITTED
  DB-->>API: committed
  API-->>S: 201 request (PENDING)

  C->>API: GET /api/requests?status=PENDING
  API->>DB: find {department = clerk.department, status}
  API-->>C: department queue
  C->>API: PATCH /api/requests/:id/review
  API->>DB: transaction: findOneAndUpdate{_id, department, status=PENDING} to UNDER_REVIEW + history + audit
  alt status was not PENDING, or other department
    DB-->>API: no match
    API-->>C: 409 invalid transition / 404
  else matched
    API-->>C: 200 request (UNDER_REVIEW)
  end

  H->>API: PATCH /api/requests/:id/approve
  API->>DB: transaction: findOneAndUpdate{status=UNDER_REVIEW} to APPROVED + history + audit
  API-->>H: 200 request (APPROVED)
  Note over H,API: Reject path: PATCH .../reject {reason} requires a 5-500 char reason, result REJECTED

  C->>API: POST /api/requests/:id/document (multipart)
  API->>API: size cap 5 MB, magic bytes (PDF/PNG/JPG), extension matches content
  API->>FS: write random-UUID file
  API->>DB: transaction: findOneAndUpdate{status=APPROVED} to FULFILLED + documentPath + audit x2
  alt database step fails
    API->>FS: delete the file
    API-->>C: error, request stays APPROVED
  else committed
    API-->>C: 200 request (FULFILLED)
  end

  S->>API: GET /api/requests/:id/document
  API->>DB: find {_id, studentId = me, status = FULFILLED}
  API->>FS: read file (validated name, inside storage folder)
  API-->>S: file as attachment (nosniff, no-store)
  API->>DB: audit DOCUMENT_DOWNLOADED (best effort)
```

## 5. Activity diagram (submission to fulfilment)

Swim lanes for Student, Clerk, HOD and System, with the decision points (valid input, approve or reject, file checks, commit).

```mermaid
flowchart TD
  start([Start]) --> s1

  subgraph Student
    s1[Log in] --> s2[Choose document type and purpose]
    s2 --> s3[Submit request]
    s9[Track status and history]
    s10[Download document]
  end

  subgraph System
    v1{Input valid?}
    p1[Create request: PENDING, department from profile, audit]
    f1{File is PDF/PNG/JPG,<br/>signature and extension match,<br/>at most 5 MB?}
    f2[Store file under random UUID name]
    f3[Mark FULFILLED + audit, one transaction]
    f4[Delete stored file, keep APPROVED]
  end

  subgraph Clerk
    c1[Open department queue: PENDING]
    c2[Check submitted information]
    c3[Move to UNDER_REVIEW]
    c4[Open APPROVED request]
    c5[Upload official document]
  end

  subgraph HOD
    h1[Open department queue: UNDER_REVIEW]
    h2{Approve?}
    h3[Approve: APPROVED]
    h4[Reject with mandatory reason: REJECTED]
  end

  s3 --> v1
  v1 -- no --> s2
  v1 -- yes --> p1 --> c1 --> c2 --> c3 --> h1 --> h2
  h2 -- yes --> h3 --> c4 --> c5 --> f1
  h2 -- no --> h4 --> s9
  f1 -- no --> c5
  f1 -- yes --> f2 --> f3
  f3 -- commit fails --> f4 --> c5
  f3 -- committed --> s9 --> s10 --> finish([End])
  h4 --> finish
```

## 6. State diagram (request status)

The only five statuses and four permitted transitions (`TRANSITIONS` in `server/config/constants.js`). Anything else returns 409.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> PENDING : Student submits request
  PENDING --> UNDER_REVIEW : Clerk reviews (same department)
  UNDER_REVIEW --> APPROVED : HOD approves (same department)
  UNDER_REVIEW --> REJECTED : HOD rejects, reason required
  APPROVED --> FULFILLED : Clerk uploads valid document
  REJECTED --> [*]
  FULFILLED --> [*]

  note right of PENDING
    Every transition is one atomic conditional update:
    filter = id + department + required current status.
    Any other transition returns 409.
  end note
```

## 7. Component diagram

Frontend, backend layers, MongoDB, private file storage and the CI/CD pieces.

```mermaid
flowchart TB
  subgraph browser["Browser (client/, served by Express, same origin)"]
    pages["HTML pages: login, register, student, clerk, hod, admin, audit, request"]
    css["CSS: tokens, base, components, requests"]
    js["ES modules: api.js, layout.js, student.js, staff.js, admin.js, audit.js, request.js"]
  end

  subgraph server["Node.js / Express (server/)"]
    direction TB
    sec["Security layer: Helmet CSP, rate limits, JSON size cap, mongo-sanitize, CSRF header check"]
    mw["authenticate, authorize, validate (express-validator), upload (Multer, memory), errorHandler"]
    routes["Routes: auth, requests, admin"]
    ctrl["Controllers (thin)"]
    svc["Services: auth, user, request, transition, document, audit"]
    tx["config/transactions: replica-set detection, runInTransaction"]
    models["Mongoose models: User, Request, AuditLog"]
  end

  db[("MongoDB single-node replica set<br/>users, requests, auditlogs")]
  files[["Private file storage<br/>server/uploads (UUID names, not served statically)"]]

  subgraph ops["Delivery"]
    jenkins["Jenkins pipeline: lint, tests, build check"]
    compose["Docker Compose: MongoDB (dev and CI)"]
  end

  js -- "fetch /api (cookie + X-Requested-With)" --> sec
  pages --> js
  css --> pages
  sec --> mw --> routes --> ctrl --> svc
  svc --> tx
  svc --> models --> db
  svc -- "write / read / delete" --> files
  jenkins -. runs .-> server
  compose -. provides .-> db
```

