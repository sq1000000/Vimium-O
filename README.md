# Vimium O

[Vimium](https://github.com/philc/vimium) commands, ported to Obsidian.

![GitHub Repo stars](https://img.shields.io/github/stars/sq1000000/Vimium-O?color=%23eac54f&style=flat-square) ![GitHub issues](https://img.shields.io/github/issues/sq1000000/Vimium-O?color=%232da44e&style=flat-square) ![GitHub closed issues](https://img.shields.io/github/issues-closed/sq1000000/Vimium-O?color=%238250df&style=flat-square)

This plugin for Obsidian brings [Vimium-style navigation](https://github.com/philc/vimium) to Obsidian Reading View. This allows the user to navigate Obsidian almost entirely without needing a mouse.

This is not to be confused with ['Vim key bindings'](https://publish.obsidian.md/hub/04+-+Guides%2C+Workflows%2C+%26+Courses/for+Vim+users) in Obsidian. That is intended for the text editing experience. 'Vimium in Obsidian' is mainly built for navigating the user interface.

## Features
- **Vimium-style Navigation**: Navigate Obsidian without touching the mouse.
- **Link Hints**: Quickly open all clickable elements using keyboard shortcuts.
- **Global Marks**: Create and jump to marks across different files and tabs.
- **Advanced Find**: Vim-like search with visual feedback.
- **Tab & Window Management**: Manage tabs, history, bookmarks, and windows using keyboard commands.

## Installation
1. In [Obsidian](https://obsidian.md/), navigate to `Settings/Community plugins/Browse`.
2. Search for "Vimium".
3. Select the "Vimium in Obsidian" box.
4. Select the "Install" box.
5. Select the "Enable" box.
6. Restart Obsidian.

## Keyboard Bindings
You can view the full list of key bindings at any time within Obsidian by pressing `?`.

Navigating the Page:

```
k       Scroll up
j       Scroll down
h       Scroll left
l       Scroll right
gg      Scroll to top
G       Scroll to bottom
zH      Scroll to far left
zL      Scroll to far right
u       Scroll up (faster)
d       Scroll down (faster)
yy      Copy file path to clipboard
f       Open Link Hints (current tab)
F       Open Link Hints (new tab)
i       Enter insert mode
esc     Leave insert mode
[[      Jump to previous heading
]]      Jump to next heading
```

Files & Commands:

```
o       Open quick switcher (files)
O       Open quick switcher in new tab
e       Open command palette
b       Open a bookmark
B       Open a bookmark in a new tab
T       Search through open tabs
```

Using Marks:

```
m*      Create a new mark (replace * with a letter)
`*      Jump to a mark
md      Clear marks on current tab
ml      List/Search all marks (opens modal)
```

Navigating History:

```
H       Go back in history
L       Go forward in history
```

Using Find:

```
/       Enter find mode (supports Regex)
n       Cycle forward to the next find match
N       Cycle backward to the previous find match
```

> Pressing `i` after searching with `/` will switch to Editing View and jump to the selected text.

Manipulating Tabs:

```
t       Create new tab
J, gT   Go one tab left
K, gt   Go one tab right
^       Go to previously-visited tab
g0      Go to the first tab
g$      Go to the last tab
yt      Duplicate current tab
p       Pin/Unpin current tab
x       Close current tab
X       Restore closed tab
W       Move tab to new window
<<      Move tab to the left
>>      Move tab to the right
zi      Zoom in content
zo      Zoom out content
z0      Reset zoom
```

Miscellaneous:

```
r       Reload Obsidian
R       Open random note
gs      Open current file in default app
?       Show Help
```

## Todo

- Implement proper tab moving with `>>` & `<<`.
- Implement command repetition. For example, typing `5t` will open 5 tabs.

## Contribute
If there's something you don't particularly like about this extension. That's alright. Fix it yourself with a [pull request](https://github.com/sq1000000/Vimium-Read/pulls), or beg [sq1000000](https://github.com/sq1000000) to fix the the issue in [issues](https://github.com/sq1000000/Vimium-Read/issues).

## Credits
- [philc](https://github.com/philc) for the [Vimium](https://github.com/philc/vimium) browser extension that I took the keybindings from.

- [LukasKorotaj ](https://github.com/LukasKorotaj) for the [extension](https://github.com/LukasKorotaj/Scroll-With-j-k-in-Obsidian) that this was originally built off of.