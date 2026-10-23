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
