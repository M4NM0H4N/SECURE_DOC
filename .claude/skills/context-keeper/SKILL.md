---
name: context-keeper
description: Helps store and maintain a concise, precise summary of the project structure, goals, and state to keep context updated.
---
# Context Keeper Skill

This skill defines how to maintain a highly compact, accurate, and up-to-date representation of the project context in a `.context.md` file at the root of the workspace.

## Guidelines

1. **Maintain `.context.md`**:
   - If `.context.md` does not exist in the workspace root, create it.
   - Keep it short and precise (under 100 lines).

2. **File Structure**:
   The `.context.md` file should contain:
   - **Project Goal**: A single sentence explaining the main objective of the project.
   - **Tech Stack**: List of languages, frameworks, and key libraries.
   - **Architecture**: A brief summary of key design decisions (e.g., frontend/backend structure).
   - **Core Files**: A list of the most important files and their purpose.
   - **Current Focus / TODO**: The immediate next steps or current work-in-progress.

3. **Keep it Updated**:
   - Whenever a major component is created, modified, or deleted, update the `.context.md` file accordingly.
   - Keep the file clean and avoid details that can be read directly from code.

4. **Explicit Confirmation**:
   - At the end of any response where you updated `.context.md`, include a brief, clean status line confirming that the project context has been updated and is complete (e.g., `> **Context Synced:** [.context.md](file:///D:/My_Projects/Antigravity/.context.md) is updated and complete.`).
