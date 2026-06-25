# Emphant Studio

Emphant Studio is a Tauri desktop AI workspace built with React, TypeScript, Redux Toolkit, Ant Design, and pnpm workspaces.

The current app focuses on a local-first desktop workbench for AI-assisted productivity: conversations, agents, files, knowledge bases, notes, tasks, profile settings, and provider/tool configuration.

## Features

- Desktop shell powered by Tauri 2.
- React renderer with route-based workbench pages.
- Multi-topic AI chat workspace with assistant selection and structured message blocks.
- Agent, skill, file, knowledge, note, todo, profile, and settings pages.
- Mock AI runtime and local workbench state for fast UI iteration.
- Markdown rendering with GFM and syntax highlighting.
- Shared package for cross-app constants and TypeScript types.

## Tech Stack

- Tauri 2
- React 19
- TypeScript
- Vite
- Redux Toolkit
- Ant Design
- pnpm workspace
- Rust/Cargo for the native desktop layer

## Project Structure

```text
.
|-- apps/
|   `-- desktop/
|       |-- src/
|       |   `-- renderer/        # React desktop UI
|       `-- src-tauri/           # Tauri native app
|-- packages/
|   `-- shared/                  # Shared constants and TypeScript types
|-- package.json                 # Workspace scripts
|-- pnpm-lock.yaml
|-- pnpm-workspace.yaml
`-- tsconfig.base.json
```

## Requirements

- Node.js
- pnpm 10.x
- Rust toolchain
- Tauri system dependencies for your operating system

For Tauri platform setup, follow the official prerequisites for your OS before running the desktop app.

## Getting Started

Install dependencies:

```bash
pnpm install
```

Start the desktop app in development mode:

```bash
pnpm dev
```

Run type checking:

```bash
pnpm typecheck
```

Run linting:

```bash
pnpm lint
```

Build the renderer:

```bash
pnpm build
```

Run Tauri CLI commands:

```bash
pnpm tauri
```

## Workspace Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Tauri desktop app in development mode. |
| `pnpm build` | Build the desktop renderer with Vite. |
| `pnpm tauri` | Run the Tauri CLI for the desktop package. |
| `pnpm typecheck` | Run TypeScript checks for the desktop package. |
| `pnpm lint` | Run ESLint for the desktop renderer source. |

## Development Notes

- The repository intentionally ignores `node_modules/`, Vite build output, Tauri `target/`, logs, local environment files, and macOS `.DS_Store` files.
- The desktop renderer lives under `apps/desktop/src/renderer`.
- The Tauri configuration lives at `apps/desktop/src-tauri/tauri.conf.json`.
- Shared app types live in `packages/shared/src/types.ts`.

## License

Private project. Add a license file before distributing publicly.
