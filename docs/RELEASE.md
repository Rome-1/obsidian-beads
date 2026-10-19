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

Releases are built by `.github/workflows/release.yml`, not by hand, so each one
carries a provenance attestation for `main.js` and `styles.css` (Obsidian's review
recommends this):

```bash
npm version 0.1.1 --no-git-tag-version   # bumps package.json, manifest.json, versions.json
git commit -am "chore: release 0.1.1" && git push
git tag -a 0.1.1 -m "Release notes in markdown…"   # the tag message becomes the notes
git push origin 0.1.1
```

The workflow checks the tag against `manifest.json`, builds, attests, and creates
the release with `main.js`, `manifest.json`, and `styles.css` as **individual**
assets (not zipped, not in a subfolder). `versions.json` maps each released
version → its `minAppVersion`. Check a release with
`gh attestation verify main.js --repo Rome-1/obsidian-beads`.

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

## 4. Maintaining the listing

The plugin has been listed since July 2026 (0.0.6 passed automated review).
There is nothing to resubmit: every GitHub release made as in step 1 is the update.
After each release, check the dashboard for that version's review result, since a
failing version is pulled from search within 24h. Download counts per version are in
`community-plugin-stats.json` in `obsidianmd/obsidian-releases` (key `beads-pane`).

---

## Manifest compliance (verified for 0.1.1)

| Field | Value | Rule | OK |
| --- | --- | --- | --- |
| `id` | `beads-pane` | lowercase-hyphen, unique, no "obsidian", no "plugin", not `-plugin` suffix | ✅ |
| `name` | `Beads` | no "Obsidian"/"plugin", unique | ✅ |
| `description` | *(one sentence)* | no "Obsidian"/"plugin", < 250 chars | ✅ |
| `author` | `Rome Thorstenson` | present | ✅ |
| `authorUrl` | `https://github.com/Rome-1` | profile URL (not the repo, not obsidian.md) | ✅ |
| `version` | `0.1.1` | semver, no `v` prefix, matches release tag | ✅ |
| `minAppVersion` | `1.7.2` | valid, present in `versions.json` | ✅ |
| `isDesktopOnly` | `true` | required (uses `child_process`) | ✅ |

`fundingUrl` is optional and intentionally omitted.
