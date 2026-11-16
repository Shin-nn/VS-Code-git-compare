# Git Compare with Ref

Compare the working tree with any branch, tag or commit, in the Source Control side bar. Diffs open inline or side by side.

## What it does

- **Compare with Ref** view in Source Control, also in the `…` menu of the Git provider. *Compare with Branch, Tag or Commit…* opens a picker: HEAD, local and remote branches, tags, the last 200 commits of HEAD. You can also type any revision, such as `HEAD~3`, a hash or `main@{yesterday}`. The view then lists every file that differs between that commit and the working tree, staged or not. Each file has an A/M/D/R status, and renames show the old path.
- **Compare with Merge Base…** compares with `merge-base(<ref>, HEAD)`. You see only what changed since your branch left `<ref>`, like a merge request diff, but including uncommitted work.
- A branch or a typed revision is resolved again on every refresh, so the comparison follows the branch when it moves. A commit picked from the list stays fixed.
- **Inline / side by side**:
  - Click a file to open its diff in the current layout, or in the layout set by `gitCompare.diffLayout`.
  - Each file has two inline buttons, *Open Changes Inline* and *Open Changes Side by Side*. They are also in its context menu.
  - The view's title bar switches the layout. Open diff editors switch right away.
  - The layout is VS Code's `diffEditor.renderSideBySide`, the same setting its *Toggle Inline View* changes. A narrow editor (under ~900 px) falls back to inline while `diffEditor.useInlineViewWhenSpaceIsLimited` is on, so asking for side by side turns that off too (`gitCompare.forceSideBySide`).
- **Open All Changes** (`$(diff-multiple)`): every changed file in one scrollable multi-diff editor.
- **One file or folder**: *Compare with Branch, Tag or Commit…* in the explorer, editor tab and editor context menus. On a file it opens that file's diff right away. On a folder it starts the view's comparison limited to that folder.
- *Compare Active File with the Current Compare Base* (editor tab menu) diffs the active file against the view's commit.
- The right side of a diff is the real file, so you can edit it there. The left side is read-only.
- Untracked files are listed in their own collapsed group (`gitCompare.showUntracked`).
- Tree or list view, a refresh on file changes (`gitCompare.autoRefresh`), and the comparison is restored after a reload.

- **Updates**: once a day the extension checks the [GitHub releases](https://github.com/Shin-nn/vs-code-git-compare/releases) for a newer version. If there is one, it offers to install it, show the release notes or skip that version. *Git Compare: Check for Updates…* runs the check right away. You can turn off the daily check with `gitCompare.checkForUpdates`.

## Build

```sh
npm install
npm run package          # → vs-code-git-compare-<version>.vsix
code --install-extension vs-code-git-compare-*.vsix
```

Packaging needs Node 22+. The extension needs VS Code 1.86+ and `git` (or `git.path`).

## CI and releases

[.github/workflows/build.yml](.github/workflows/build.yml) builds the `.vsix` on every push and pull request. You can download it from the run as the `vsix` artifact.

To release:

1. Raise `version` in `package.json` and commit.
2. Push a matching tag, e.g. `git tag v0.2.0 && git push origin v0.2.0`.

The workflow checks that the tag matches the version and publishes a GitHub release with the `.vsix` attached. If you create the release in the GitHub UI instead (with a new tag `vX.Y.Z`), the workflow only attaches the `.vsix` to it. Installed copies find that release with their update check.
