# herdr-project-spaces

Custom mod for [Herdr](https://herdr.dev) extending the Spaces sidebar to detect and display child repositories when focusing a Space.

## Features
- Displays spaces and machines as normal.
- When focusing a Space, automatically scans child directories (up to a configurable depth) for Git repositories.
- Hierarchical tree view in Spaces with collapsible intermediate folders and box-drawing tree connectors (`├─`, `└─`).
- Displays Git branches and ahead/behind statuses for child repositories.
- Allows opening tabs / panes directly inside discovered child repositories or folders.
- Right-click context menu with fast branch switcher dialog, background fetch, and checkout.
- Tree View toggle in the Changes panel: view Git changes hierarchically by folder with expand/collapse, aggregate stats (`+`/`−`), and inline diff previews.
