# Release & submission checklist

How to cut a release and submit **Beads** to the Obsidian community-plugin registry.
Everything below is **Rome's** to run — it needs a public repo, a GitHub release, and
(for the smoke-test) a desktop Obsidian. Agents prepare; Rome ships.

---

## 0. Pre-flight (agent-preparable — already done for 0.0.1)

- [x] `manifest.json` present at repo root and compliant (see **Manifest compliance** below).
- [x] `versions.json` maps the plugin version → `minAppVersion` (`{"0.0.1": "1.5.0"}`).
- [x] `README.md` (features, install, usage, security) and `LICENSE` (MIT) present.
- [x] `npm run build` produces `main.js` with no typecheck errors.
- [ ] **Demo GIF** recorded and committed at `assets/demo.gif` (see `assets/README.md`).
- [ ] **Manual smoke-test in real Obsidian** (bead `obp-j9l`) — Rome's gate; do this
      before flipping public.

## 1. Manual smoke-test (Rome — needs desktop Obsidian)

1. `npm install && npm run build` in the repo.
2. Copy `main.js`, `manifest.json`, `styles.css` into
   `<a-test-vault>/.obsidian/plugins/beads-pane/`.
3. Enable **Beads** under Community plugins (Settings → Community plugins).
4. Set **Project root** to a repo containing `.beads/`; click **Test connection**.
5. Verify: pane renders `bd list`; a checkbox closes an issue (confirm with
   `bd show <id>`); the detail modal opens; edits made by `bd` on the CLI show up on
   refresh.

## 2. Flip the repo public

- GitHub → Settings → General → Danger Zone → **Change visibility → Public**.
- Confirm `.beads/`, `mail/`, `node_modules/`, and `main.js` are gitignored (they are)
  so nothing internal ships. Skim `docs/BRIEF.md` — it references internal build
  context; decide whether to keep, trim, or remove it before going public.

## 3. Cut a GitHub release

The version tag **must exactly match** `manifest.json`'s `version` — **no `v` prefix**.

```bash
npm run build          # produces a fresh production main.js
git tag 0.0.1
git push origin 0.0.1
```

Then create the GitHub release for tag `0.0.1` and **attach these as individual binary
files** (not zipped, not in a subfolder):

- `main.js`
- `manifest.json`
- `styles.css`

> To bump versions later: `npm version patch|minor|major` runs `version-bump.mjs`,
> which syncs `manifest.json` and appends to `versions.json`. Commit, tag, release.

## 4. Submit to `obsidianmd/obsidian-releases`

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. Append this entry to the **end** of the array in `community-plugins.json`:

   ```json
   {
     "id": "beads-pane",
     "name": "Beads",
     "author": "Rome-1",
     "description": "A live, clickable pane for the Beads (bd) issue tracker. Shells out to the bd CLI and lets you close issues from a checkbox. Desktop only.",
     "repo": "Rome-1/obsidian-beads"
   }
   ```

3. Open a PR and complete the PR-template checklist (you have read the developer
   policies; the plugin has a release; etc.).
4. An automated validation bot runs, then a human review follows. Address any bot
   comments (common ones: release-asset naming, tag/version mismatch, `id` collisions).

> **Do not** self-publish or work around the review — the endgame is acceptance into
> the official registry.

---

## Manifest compliance (verified for 0.0.1)

Checked against the obsidian-releases plugin requirements:

| Field | Value | Rule | OK |
| --- | --- | --- | --- |
| `id` | `beads-pane` | lowercase-hyphen, unique, no "obsidian", no "plugin", not `-plugin` suffix | ✅ |
| `name` | `Beads` | no "Obsidian"/"plugin", unique | ✅ |
| `description` | *(one sentence)* | no "Obsidian"/"plugin", < 250 chars, not "A plugin that…" | ✅ |
| `author` | `Rome-1` | present | ✅ |
| `authorUrl` | `https://github.com/Rome-1` | profile URL (not the repo, not obsidian.md) | ✅ |
| `version` | `0.0.1` | semver, no `v` prefix | ✅ |
| `minAppVersion` | `1.5.0` | valid, present in `versions.json` | ✅ |
| `isDesktopOnly` | `true` | required (uses `child_process`) | ✅ |

`fundingUrl` is optional and intentionally omitted.
