# Release & submission checklist

How to cut a release and submit **Beads** to the Obsidian community-plugin
directory. As of 2026 Obsidian submits plugins through a **developer dashboard**
(`https://community.obsidian.md`), not a pull request — the old
`obsidianmd/obsidian-releases` PR flow is disabled.

---

## 1. Cut a GitHub release

The release tag **must exactly match** `manifest.json`'s `version` — **no `v`
prefix**. Prerequisites (all present): public repo, `README.md`, `LICENSE`,
`manifest.json`, and a clean `npm run build`.

```bash
npm run build          # produces a fresh production main.js
gh release create 0.0.5 main.js manifest.json styles.css \
  --title "0.0.5" --notes "…"
```

Attach `main.js`, `manifest.json`, and `styles.css` as **individual** binary
assets (not zipped, not in a subfolder). `versions.json` maps each released
version → its `minAppVersion`.

> Bumping later: edit the version in `manifest.json` + `package.json`, add the
> mapping to `versions.json`, commit, then `gh release create <version> …`.

## 2. Submit via the developer dashboard *(Rome — needs an Obsidian account)*

1. Go to **https://community.obsidian.md** and sign in with your Obsidian account.
2. **Link your GitHub account** to your profile (ownership verification).
3. **Plugins → New plugin**.
4. Enter the repo URL: `https://github.com/Rome-1/obsidian-beads`.
5. Review the developer policies, confirm ongoing support, and **Submit**.

Automated review runs immediately (results in minutes). If it passes, the plugin
is searchable/installable in the app within ~24h. Each new release is re-scanned;
a version that fails review is pulled from search within 24h.

## 3. Address feedback

The dashboard reports any issues. Fix them in the repo, cut a **new release with
an incremented version**, and the directory re-scans automatically.

---

## Manifest compliance (verified for 0.0.6)

| Field | Value | Rule | OK |
| --- | --- | --- | --- |
| `id` | `beads-pane` | lowercase-hyphen, unique, no "obsidian", no "plugin", not `-plugin` suffix | ✅ |
| `name` | `Beads` | no "Obsidian"/"plugin", unique | ✅ |
| `description` | *(one sentence)* | no "Obsidian"/"plugin", < 250 chars | ✅ |
| `author` | `Rome Thorstenson` | present | ✅ |
| `authorUrl` | `https://github.com/Rome-1` | profile URL (not the repo, not obsidian.md) | ✅ |
| `version` | `0.0.6` | semver, no `v` prefix, matches release tag | ✅ |
| `minAppVersion` | `1.7.2` | valid, present in `versions.json` | ✅ |
| `isDesktopOnly` | `true` | required (uses `child_process`) | ✅ |

`fundingUrl` is optional and intentionally omitted.
