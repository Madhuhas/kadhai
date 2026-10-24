# Theme

The look of Kadhai is copied from the **Sai** portfolio project (`C:\Users\dell\Desktop\M\Pro\Sai`, a Next.js "Portfolio OS"). This file records that design as read from its source (`app/globals.css`, `app/components/Window.tsx`, `app/components/WindowManager.tsx` and the files in `app/windows/`), and then how it is applied here.

One addition is Kadhai's own: **no emoji, no pictures, no logos.** Everything that is not text is ASCII art, and anything that moves is an ASCII animation.

## 1. The idea

A small retro desktop. A grey dotted canvas, a thin taskbar across the top, and plain white windows with grey title bars floating on it. Everything is set in one monospaced typeface, small and quiet. Colour is almost absent: the interface is black, white and greys, and colour is saved for meaning (an error, a category, a terminal).

Light (this look) is the default; under more -> Theme there are eight more: Normal light (VS Code's Light Modern), Solarized light, Dark, Dracula, Nord, Cyberpunk, Amber CRT and High contrast, added at the user's request (2026-10-19). Each is a variable set in themes.css plus a personality in looks.css - its own typefaces (system fonts only), corners, window frames, background, motion and the characters the 3D kitchen is drawn with - so they differ in more than colour. The rules in this file (one monospaced face, radii up to 5px, almost no colour) describe Light and Dark, which are unchanged; the other themes deliberately depart from them. Dark follows VS Code's "Dark Modern": flat grey panels with 1px frames, no dots or hard shadows, one blue accent (`#0078d4`) for primary buttons, focus and the tab in front.

## 2. Colour

### Light (default)

| Token | Value | Used for |
| --- | --- | --- |
| canvas | `#e6e6e6` | the desktop behind the windows |
| canvas dot | `#b8b8b8` | 1px dots on a 22px grid |
| bar | `rgba(196,196,196,0.94)`, border `#aaa`, text `#2a2a2a` | the taskbar (with an 8px backdrop blur) |
| window | background `#ffffff`, border `#999`, shadow `rgba(0,0,0,0.16)` | window chrome |
| title bar | gradient `#dcdcdc` to `#cacaca`, border `#aaa`, text `#1a1a1a` | window title bars |
| button, on | `#ffffff` / `#111` | open or hovered taskbar button |
| button, off | `#c0c0c0` / `#777`, border `#999` | closed taskbar button |
| content text | `#111111`, then `#555`, `#888`, `#aaa`, `#ccc` | five steps of text, strongest to faintest |
| content lines | `#f0f0f0`, `#e0e0e0`, divider `#eeeeee` | row borders and rules |
| card | `#fafafa`, hover `#f8f8f8` | cards and hovered rows |

### Dark

| Token | Value |
| --- | --- |
| canvas | `#181818`, no dots |
| bar | `#181818`, border `#2b2b2b`, text `#cccccc` |
| window | background `#1f1f1f`, 1px border `#2b2b2b`, no shadow |
| title bar | flat `#181818`, border `#2b2b2b`, text `#cccccc` |
| button, on | `#2a2d2e` / `#ffffff` |
| button, off | `#181818` / `#9d9d9d`, border `#2b2b2b` |
| content text | `#cccccc`, then `#9d9d9d`, `#5a5a5a`; inputs `#313131` with border `#3c3c3c` |
| content lines | `#252526`, `#2b2b2b` |
| card | `#252526`, hover `#2a2d2e` |

### Colour with a meaning

- Close button on hover: `#d05050` with white text. Errors in text: `#c66`.
- Category colours (the skills window): blue `#5b9cf6`, purple `#c084fc`, orange `#fb923c`, green `#4ade80`, cyan `#22d3ee`, amber `#fbbf24`. Each is used at full strength for a label, at 20% for a rule and at about 10% for a tinted background.
- The terminal is its own world in both themes: a plain dark terminal, background `#0c0c0c`, text `#cccccc`, typed commands `#ffffff`, dim text `#808080`, errors `#f14c4c`, caret `#ffffff`. No scanlines or glow. Commands, typed and shown, are coloured like a shell with syntax highlighting: program `#f9f1a5`, flags `#6cb6ff`, strings `#ce9178`, operators `#d670d6`, variables `#4ec9b0`, numbers `#b5cea8`, comments `#6a9955`.

## 3. Type

- One family everywhere: **JetBrains Mono**, falling back to Courier New and the system monospace. Weights 400 for text, 500 for emphasis and titles, 600 for the few headings.
- Small sizes that grow slightly on very wide screens: `clamp(8.5px, 0.60vw, 11px)` for badges, up to `clamp(12px, 0.83vw, 16px)` for titles. Body text is `clamp(11px, 0.76vw, 14.5px)`.
- Labels are UPPERCASE with `0.05em` to `0.08em` letter-spacing, in a faint grey (`CONTACT`, `PROJECTS`).
- Section headings are written like code comments: `// languages & frameworks` followed by a 1px rule that fills the row.
- File-like names instead of plain titles: `about.script`, `sai.exe`, `skills.sys`, `recent.log`, `readme.md`.
- Line height 1.5 for text, 1.7 for lists.

## 4. Shape

- **Windows:** 2px solid border, 5px radius, and a hard offset shadow `4px 4px 0` with no blur. Title bar 30px high, 8px side padding, title on the left in weight 500, buttons on the right.
- **Window buttons:** 18px squares, 1px border, 3px radius, in the "off" button colour at 65% opacity; full opacity and the "on" colour on hover. Close turns red.
- **Taskbar:** 36px high, fixed to the top, three zones (left, centre title, right). Buttons are 24px high, `2px 10px` padding, 1px border, 3px radius. Hover adds a soft glow `0 0 8px` in the shadow colour; an open one gets a 1px hard shadow.
- **Cards and rows:** 1px border, 4px radius, `#fafafa` background; hover darkens the border and background slightly. Lists are rows separated by 1px lines, with a hover background.
- **Keycaps:** small chips with a hard bottom edge (`0 3px 0` in the border colour) that press down 2px on hover.
- **Scrollbars:** 6px, square track, 3px rounded thumb.
- Radii never exceed 5px. Nothing is pill-shaped.

## 5. Motion

- Windows open with a short scale-and-fade (0.32s, ease `cubic-bezier(0.16, 1, 0.3, 1)`) and close faster (0.12s).
- Hover transitions are quick: 0.08s to 0.12s.
- A blinking block cursor: 1.06s, step-end.
- Nothing bounces or glows for decoration.

## 6. Text as decoration

- A directory tree drawn with box-drawing characters (`├──`, `│`, `└──`) is the navigation.
- The terminal greets with an ASCII "neofetch" block.
- Small text symbols stand in for icons: `×` to close, `↗` for an outside link, `↓` to scroll.

## 7. How Kadhai applies it

| Sai | Kadhai |
| --- | --- |
| Dotted canvas | The page background, behind three windows |
| Taskbar | The top bar: `\___/ kadhai`, the crew as a drop-down list (with a button beside it for whoever is working), then providers, terminal, keys, connect and theme |
| Windows | `files.dir` (left), the stage (middle, its tabs are the title bar), `chat.log` (right), and every dialog |
| Directory tree | The file list, drawn with `├─ │ └─` |
| Terminal | Command cards and an agent's thought stream: green on near-black with scanlines |
| Comment headings | Section headings inside dialogs and the agent tab (`// what it is thinking ────`) |
| Keycaps | Filter chips, the steps of a plan, the crew's stations in the kitchen |
| Category colours | Syntax highlighting only |
| Themes | `light` (default) and `dark`, plus `modern`, `solarized`, `dracula`, `nord`, `cyberpunk`, `amber`, `contrast` |

### ASCII instead of pictures

All of it lives in `public/js/ascii.js`.

- **The kadhai (3D).** The middle of the kitchen is a 3D kadhai rendered as text (`ascii3d.js`): bright rim, oil inside, the belly under it, a stove below. Still until work starts; while the crew cooks it turns slowly, the oil ripples and bubbles, the fire burns and steam rises. It can be dragged to spin.
- **The hand-drawn pot** (About panel, still) is a cooking pot drawn by hand in text: a domed lid with a knob, a rim, two loop handles, a shaded side, standing on a grate over a stove. It is a still drawing (lid on, stove off) until work starts. While the crew cooks, the lid rattles up and down, froth shows in the gap, steam curls up from the lid and thins out, and flames flicker under the pot and lick up its sides. When the run ends it goes still again.
- **The crew.** Each agent is a small 3D cook rendered as text (big head, round coat, its own hat and tool) for the kitchen and its own tab, and has a one-line face such as `{o_o}` for the taskbar. The house agents are told apart by hat, as a real brigade is (the Senior Cook has the tallest toque, the Taster a puffed one, Prep a beanie), and each holds a tool. They look at the mouse, wave on hover, jump when given a step, walk to the pot and back while working, cheer or slump when a run ends, blink, and doze when idle. A hired specialist gets a look derived from its id, so it never changes.
- **Agent colours.** Each agent has a hue of its own (Chef blue, Senior Cook orange, Taster purple, Fixer green, Cook cyan, Prep amber; a hire gets one derived from its name, kept clear of those six). The user can change any agent's hue with the slider in its edit dialog, where the face and the slider wear the colour being picked. It is the one place colour is used freely, because it carries meaning: you can see who is working, who ran a command and who is answering without reading a name. The lightness is chosen per theme so it reads on both.
- **Spinners.** `| / - \` wherever something is in progress.
- **Banner.** The chat opens with "Kadhai" in ASCII lettering.
- **Logos, in two dialogs only.** In keys and connections, a service shows its real logo where a freely licensed one exists (36 of them, from Simple Icons), painted in the text colour so it stays monochrome and follows the theme. The rest show a two- or three-letter tag (`GQ`, `SL`). This is the one exception to "no pictures", allowed by the user because telling services apart at a glance matters there.
- **Wires, in the flows canvas only.** A flow is drawn as nodes joined by wires, and the wires are thin SVG curves in the muted text colour (dashed for an app plugged into an agent as a tool). This is the one place a line is drawn rather than typed, at the user's request for a node-and-wire canvas. The nodes themselves follow the rules: small windows with a title bar, square ports, text marks for state. App nodes show the same monochrome logos as the connections dialog.
- Status marks are text: `[ ]`, `[x]`, `[!]`, `[lock]`.

One timer drives every animation. It stops while the tab is hidden, and with "reduce motion" switched on in the operating system everything is drawn once and stays still.

### Where Kadhai differs, and why

- **Type is larger.** Sai is a page to look at; Kadhai is read for long stretches (chat, code, diffs). The scale starts at `clamp(11.5px, 0.8vw, 14px)` and body text is `clamp(13.5px, 0.96vw, 17px)` - about two steps above Sai, at the user's request.
- **Off-state button text is darker** (`#555` on `#c0c0c0`, `#9d9d9d` in dark) than Sai's `#777` / `#44445a`, which are too faint for labels that have to be read.
- **No web font.** Kadhai must work offline, so JetBrains Mono is used when it is installed and Cascadia Mono, Consolas or the system monospace otherwise.
- **Windows do not move.** The three columns are fixed windows; dragging and resizing would get in the way of work.
- **An accent exists but is ink.** Primary buttons are solid `#111` (light) or blue `#0078d4` (dark). The accent picker in the theme menu can still change it.
- **Status colours** are added, since Sai has none: ok `#2f8f46`, warning `#a66a00`, error `#c0504d` (dark: `#89d185`, `#cca700`, `#f14c4c`).
- **Sai's photos, Polaroids, washi tape and Darth Vader pet are not copied.** They are pictures.

## 8. Rules for new UI

1. Monospace only. Sizes from `--t-micro` to `--t-title`, spacing from `--s1` to `--s6`.
2. Colour only from the variables in `public/css/themes.css`. Reach for grey first; use `--ok`, `--warn`, `--err` only for state.
3. A new surface is a window (2px border, hard shadow, title bar) or a card (1px border, 4px radius). No blur shadows, no gradients except title bars, no radius above 5px.
4. No emoji, images, icon fonts or SVG drawings, except brand logos in the keys and connections dialogs (`logos.js`). Use a word, a text symbol, or ASCII art from `ascii.js`.
5. Animate with characters, through the shared timer in `ascii.js`, and keep it still under "reduce motion".
