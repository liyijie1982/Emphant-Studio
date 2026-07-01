# Emphant Studio

Emphant Studio is an open-source Tauri desktop AI workspace for local-first productivity workflows. It brings together conversations, agents, files, knowledge bases, notes, tasks, profile settings, and provider/tool configuration in a single desktop workbench.

The project is built with Tauri 2, React, TypeScript, Redux Toolkit, Ant Design, Rust, and pnpm workspaces.

## Status

Emphant Studio is under active early development. APIs, storage formats, and desktop behavior may change before a stable release.

## Features

- Local-first desktop shell powered by Tauri 2.
- Route-based React workbench for chat, agents, skills, files, knowledge, notes, todos, profile, and settings.
- Multi-topic AI chat workspace with assistant selection and structured message blocks.
- Provider and tool configuration screens for AI-assisted workflows.
- Markdown rendering with GitHub Flavored Markdown and syntax highlighting.
- Shared workspace package for cross-app constants and TypeScript types.
- Mock AI runtime and local workbench state for fast UI iteration.

## Tech Stack

- Tauri 2
- Rust and Cargo
- React 19
- TypeScript
- Vite
- Redux Toolkit
- Ant Design
- pnpm workspace

## Project Structure

```text
.
|-- apps/
|   `-- desktop/
|       |-- src/
|       |   `-- renderer/        # React desktop UI
|       `-- src-tauri/           # Tauri native desktop layer
|-- packages/
|   `-- shared/                  # Shared constants and TypeScript types
|-- package.json                 # Workspace scripts
|-- pnpm-lock.yaml
|-- pnpm-workspace.yaml
`-- tsconfig.base.json
```

## Requirements

- Node.js 20 or newer is recommended.
- pnpm 10.x.
- Rust stable toolchain.
- Tauri system dependencies for your operating system.

Before running the app, install the official Tauri prerequisites for your platform:

- [Tauri prerequisites](https://tauri.app/start/prerequisites/)

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

Build the desktop renderer:

```bash
pnpm build
```

Run Tauri CLI commands for the desktop package:

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

## Releases

GitHub Releases are built by `.github/workflows/release.yml`.

The release workflow publishes desktop bundles for:

- Windows x86_64
- macOS Apple Silicon
- Linux x86_64
- Linux ARM64

To publish `v0.1.0`, push the release tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow creates a draft release first, uploads all platform artifacts, and publishes the release only after all builds succeed.

## Development Notes

- The desktop renderer lives in `apps/desktop/src/renderer`.
- The Tauri application lives in `apps/desktop/src-tauri`.
- Shared app types live in `packages/shared/src/types.ts`.
- Generated dependencies, build output, Tauri targets, logs, local environment files, and macOS `.DS_Store` files are intentionally ignored.

## Contributing

Contributions are welcome. To contribute:

1. Fork the repository.
2. Create a feature branch.
3. Make a focused change with matching checks where practical.
4. Run `pnpm typecheck` and `pnpm lint` before submitting.
5. Open a pull request with a clear description of the change.

Please keep issues and pull requests focused, reproducible, and respectful.

## Security

Please do not disclose security issues publicly before maintainers have had time to review them. If you find a vulnerability, open a private security advisory on GitHub or contact the maintainers through the repository's published security contact.

## License

Emphant Studio is open source software licensed under the [MIT License](./LICENSE).
