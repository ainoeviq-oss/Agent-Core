---
name: safe-skill
description: Review a TypeScript project and suggest small, testable fixes.
---

# Safe Skill

Read relevant source files, identify the smallest defensible change, edit only the required files, run the project's existing tests, and report verification evidence.

Required tools: read_file, search_files, edit_file, execute_command.
Do not install packages, elevate privileges, access secrets, or contact external services.
