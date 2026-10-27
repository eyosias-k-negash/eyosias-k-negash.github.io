A personal Website with a personal touch.

A terminal-themed Jekyll site served by GitHub Pages at [eyosias.me](https://eyosias.me).

## Editing content

Almost everything lives in data files; no template changes needed:

| What | Where |
| --- | --- |
| Name, role line, bio, section titles, which sections show | `_config.yml` |
| Experience tree (`tree ~/experience`) | `_data/timeline.yml` |
| Skills cloud | `_data/skills-languages.yml`, `skills-frameworks.yml`, `skills-tools.yml` |
| Pseudonyms cycled by clicking the name (`su`) | `_data/pseudonyms.yml` |
| Contact list | `_data/contact-points.yml` |
| Write-ups (`ls -l ~/writeups`) | `_posts/` (set `live: true` to list a post) |
| Projects | your public GitHub repos, filtered by `projects:` in `_config.yml` |

### Blogs in chapters

Put the chapters of one blog in their own folder under `_posts/`, e.g. `_posts/ivyk8/`. Once two or more of them are live, the folder lists once in `ls -l ~/writeups` (as `ivyk8/`, with its chapters linked side by side) and each chapter links to the previous and next one. Chapters are ordered by the date in their filename; moving a post into a folder does not change its URL.

Optional front matter, read from the first chapter that sets it:

- `series_title`: the blog's title in the listing (defaults to the folder name)
- `series_tldr`: its description there (defaults to the first chapter's `tldr`)

Per chapter, `chapter_title` is an optional short name for that chapter's link in the listing; the chapter page itself keeps using `title`.

## Theme

- `_layouts/base.html` is the page shell; `default.html` (home) and `post.html` build on it.
- `assets/css/terminal.css` and `assets/js/terminal.js` are plain files with no build step.
- Pseudonym colours may reference the palette variables `--red-color`, `--blue-color` and `--green-color`.

## Local preview

```sh
bundle install
bundle exec jekyll serve --config _config.yml,_config_dev.yml
```

The projects section needs network access to the GitHub API; offline it renders empty.
