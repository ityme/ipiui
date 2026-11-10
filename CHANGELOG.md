# Changelog

## [1.2.0]

- Disable shared title synchronization by default; retain explicit group opt-in.
- Add an independent, session-persistent title activity indicator, enabled by default.

## [1.1.1]

- Add selectable Chase and Rainbow status row themes with per-session settings.
- Add English and Simplified Chinese panels with `/ipiui language en|zh`.
- Restore theme and language from the active Pi session branch on reload and tree navigation.
- Improve settings layout and add explicit status row on/off choices.
- Add fixed field colors, multicolor thinking levels and a running highlight chase.
- Show lowercase working/thinking activity labels.
- Recover title synchronization after temporary-directory cleanup and transient failures.

## [1.0.0]

- Package the extension for installation with `pi install` from a local directory, Git repository or npm after publication.
- Show a compact, bracketed status row above Pi's native editor.
- Provide `/ipiui` commands for status row visibility, pane names and title groups.
- Aggregate pane titles with in-memory braille animation and temporary-file state synchronization.
- Use the GPL-3.0-only license.
