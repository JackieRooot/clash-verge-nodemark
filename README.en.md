[中文](README.md) | **English**

# clash-verge-nodemark

Rate the nodes in [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) by how well they actually work for you. It opens a page in your browser that mirrors the Clash Verge proxies page. Right-click a node card to mark it ✓ good / ! so-so / ✕ avoid, and the mark shows on the card.

It changes no Clash Verge settings and needs no patched build. It talks to the mihomo core that Clash Verge already runs, so the groups, selected nodes and delays match what Clash Verge shows. It is a single Node.js script with no dependencies.

![Screenshot: right-clicking a node card opens the mark menu; marked cards show green, amber or red](docs/screenshot.jpg)

<sub>The screenshot uses the fake data of demo mode (`node nodemark.js --demo`).</sub>

> The page itself is in Chinese. The labels are few: 好用 = good, 一般 = so-so, 不建议 = avoid, 测全组 = test the whole group, 测速 = test delay, 用户标记 = user marks, 系统标记 = system rating.

## Features

- **Mirrored proxy groups**: same group order, selected node, node type and delay as Clash Verge, refreshed every 3 seconds.
- **Right-click to mark**: good / so-so / avoid / unmark. Marked cards get a tinted background and a badge in the top-right corner (the colored frame is reserved for the currently selected node). Each group header shows how many nodes carry each mark. 取消全部标记 in the top bar removes every mark in the current profile (it asks first, and this can't be undone).
- **Left-click to switch**: works like clicking in Clash Verge, and Clash Verge follows the change.
- **Two modes**: switch between 用户标记 (user marks) and 系统标记 (system rating) in the top bar. User marks are the manual marks described here; the system rating gives each node stars automatically from its history of whole-group tests (see "System rating" below).
- **Delay tests** (user-marks mode): click the delay at the bottom-right of a card to test one node, 测全组 to test a whole group, 仅测 ✓ ! to test only the group's nodes marked good or so-so, 仅测未标记 to test only the group's unmarked nodes, or 仅测 ✕ to test only the group's nodes marked avoid (to see whether they have improved). The test URL and timeout come from your Clash Verge settings.
- **Filter and sort**: search; sort by default order, CV order (按cv), delay, mark, mark then delay, or name; hide nodes marked avoid; show only marked nodes.
- **CV order (按cv)**: each proxy group uses the sort order it has on the Clash Verge proxies page (default / by delay / by name). The group header shows which one applies (see "CV order" below).
- **Columns inside each group**: proxy groups are stacked top to bottom, and the nodes inside each group are split into three columns with two nodes per row; nodes fill the first column before moving to the next. Narrow windows fall back to two columns, then one.
- **Multiple subscriptions**: marks are stored per subscription, so switching subscriptions never mixes them up.
- **Follows node changes**: each subscription's node list follows the core's live list, adding and removing nodes automatically (see "Mark data" below).

## Requirements

- Clash Verge Rev 2.x, running.
- [Node.js](https://nodejs.org/) 16 or later.

Tested on Windows 11 with Clash Verge Rev 2.5.8 (mihomo v1.19.32). macOS and Linux support follows the paths in the Clash Verge Rev source but has not been tested yet. Issues are welcome.

## Install and run

Option 1: clone and run

```bash
git clone https://github.com/JackieRooot/clash-verge-nodemark.git
cd clash-verge-nodemark
node nodemark.js
```

Option 2: install globally as the `nodemark` command

```bash
npm install -g github:JackieRooot/clash-verge-nodemark
nodemark
```

This starts the service in the background and, after a 3-second countdown, opens http://127.0.0.1:9099 in your default browser (press Ctrl+C during the countdown to skip opening it).

When the background service exits:

- **Only closing the last page stops the service.** Running `node nodemark.js` several times opens several tabs, but they all share one background service. Close some of them and, as long as one page is still open, the service keeps running and the remaining pages work as before.
- 15 seconds after all pages are closed, the service exits on its own. A page reload doesn't count as closing; just run the command again next time.
- Closing the terminal you ran the command in does not stop the service.
- If the service is already running, running the command again doesn't start a second service; it just opens another page.

| Command | What it does |
|---|---|
| `node nodemark.js` | Start the service in the background if needed, then open the browser |
| `node nodemark.js --keep` | Same, but the service keeps running after you close the pages |
| `node nodemark.js --no-open` | Start the service without opening the browser; it does not exit on its own |
| `node nodemark.js stop` | Stop the background service by hand: for services started with `--keep` or `--no-open`, or to stop one right away |
| `node nodemark.js serve` | Run the service in the current terminal with its log printed there; press Ctrl+C to stop. Not needed day to day, only for troubleshooting |
| `node nodemark.js --demo` | Demo mode: fake node data, no Clash Verge needed, marks kept in memory only. Default port 9098; stop it with `node nodemark.js stop --demo` |
| `--port <port>` | Use another port (default 9099); works with every command |

To see what it looks like first, just run `node nodemark.js --demo`.

### A short command (optional)

PowerShell: add a function to your `$PROFILE`, using your own path:

```powershell
function jd { node "D:\path\to\clash-verge-nodemark\nodemark.js" @args }
```

bash / zsh: add this to `~/.bashrc` or `~/.zshrc`:

```bash
alias jd='node ~/path/to/clash-verge-nodemark/nodemark.js'
```

With the global install, just type `nodemark`.

## System rating

After you switch the top bar to 系统标记, the page hides the manual marks and shows each node's rating instead: 0–5 stars in half-star steps, meant to measure how a node performs on average over a longer period.

- Only 测全组 (test the whole group) is available: no single-node tests, no 仅测 buttons, no right-click mark menu. Each whole-group test records one sample for every real node in the group (proxy groups, DIRECT and the like are skipped) and updates the ratings right away. Whole-group tests run in user-marks mode are not recorded.
- Each node keeps its latest 30 samples. A node that appears in several groups has a single shared history.
- Cards show the stars, the sample count and the number of timeouts; nodes with fewer than 3 samples are labeled 样本不足 (too few samples). Hover over the stars to see the unrounded score and whether timeouts capped it. The sort menu has 按推荐指数 (by rating).

### Scoring rules

Each sample is first turned into a single-test score by its delay. The band table depends on whether Clash Verge's "unified delay" was on during the test (every sample records that setting, so after you toggle it, old and new samples each use their own bands):

| Band | Unified delay off | Unified delay on | Score | Weight |
|---|---|---|---|---|
| S | < 800 ms | < 200 ms | 5 | 1 |
| A | 800–1100 ms | 200–400 ms | 4 | 1 |
| B | 1100–1500 ms | 400–700 ms | 3 | 1.5 |
| C | 1500–2200 ms | 700–1200 ms | 2 | 2 |
| D | 2200–3500 ms | 1200–2500 ms | 1 | 3 |
| Timeout | ≥ 3500 ms, timeout or failure | ≥ 2500 ms, timeout or failure | 0 | 6 |

Worse bands weigh more, so bad results pull the rating down harder than good results push it up. The "unified delay on" bands have not been tested against real data yet; they are estimates.

Rating = (Σ weight × score + 3) ÷ (Σ weight + 1), rounded to the nearest half star. The extra term acts like one made-up result of 3, so a new node can't get full marks from one test: it takes 7 straight S-band results to reach 5 stars.

The result is then capped by the timeouts among the latest 30 samples (results slower than the last band also count as timeouts):

| Timeouts | Highest rating |
|---|---|
| None | No cap |
| 1 | 2 stars |
| 2 or more, or a timeout rate ≥ 15% | 1 star |
| Timeout rate ≥ 40% | 0 stars |

If a group has at least 4 nodes and 60% or more of them time out in one test, the problem is most likely your own network, so that whole round is discarded and the page tells you so.

## Mark data

Marks are saved in `marks.json`, grouped by subscription (the uid in Clash Verge's `profiles.yaml`):

| OS | Location |
|---|---|
| Windows | `%APPDATA%\clash-verge-nodemark\marks.json` |
| macOS | `~/Library/Application Support/clash-verge-nodemark/marks.json` |
| Linux | `~/.local/share/clash-verge-nodemark/marks.json` (under `XDG_DATA_HOME` if set) |

How the node list stays in sync:

- New nodes are added to the list without a mark.
- Nodes that no longer exist are removed from the list. If a removed node had a mark, it goes into that subscription's `removed` list (the latest 200 are kept), and the latest entries appear at the bottom of the page, so you can re-mark nodes after a rename.
- Only the current subscription is synced; the others stay as they are.
- To avoid wrong deletions, the list is synced only after the same subscription has reported the same node list for at least 5 seconds. This covers the moment when you switch subscriptions.

The system rating's test history is also saved in `marks.json`, under each node (`samples`), and is deleted together with the node when it leaves the list.

Marks and test history are matched by node name, so if your provider renames a node, its old records no longer apply. If `marks.json` is corrupted, it is copied to `marks.json.broken-<timestamp>` and a fresh file is started.

## How it works

Clash Verge Rev writes the control endpoint it uses to talk to the core into its runtime config `clash-verge.yaml`: a named pipe on Windows (`external-controller-pipe`) and a Unix socket on macOS / Linux (`external-controller-unix`). This tool reads the endpoint and secret from that file and uses the same interface to read groups, switch nodes and test delays, so you don't need to turn on Clash Verge's "External Controller". If there is no pipe or socket but the external controller is on, it falls back to that HTTP address.

Clash Verge's data folder is, by default:

| OS | Location |
|---|---|
| Windows | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` |
| macOS | `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev` |
| Linux | `~/.local/share/io.github.clash-verge-rev.clash-verge-rev` |

### CV order

Clash Verge stores each group's sort order on its proxies page (the sort button in the group header) in the localStorage of its built-in WebView2, under the key `proxy-head-state`, separately for each subscription. This tool reads that data directly from `%LOCALAPPDATA%\io.github.clash-verge-rev.clash-verge-rev\EBWebView\Default\Local Storage\leveldb`, a LevelDB database. It only reads and never writes.

- "By delay" follows the same rules as Clash Verge: measured nodes first (fastest first), then timeouts, then failures, then untested nodes. The timeout threshold comes from your Clash Verge settings.
- After you change the sort order in Clash Verge, the WebView takes a few seconds to write it to disk, so this page may follow a few seconds later.
- Windows only. The WebView on macOS / Linux uses a different storage format, so there 按cv shows every group in default order, and the group header says so.

### Environment variables

All optional; the defaults need none of them.

| Variable | Purpose |
|---|---|
| `NODEMARK_PORT` | Page port, default 9099 (`--port` takes precedence) |
| `NODEMARK_DATA_DIR` | Folder for the mark file and log |
| `NODEMARK_TEST_URL` | Delay test URL; defaults to the Clash Verge setting, or `https://cp.cloudflare.com/generate_204` if that is empty |
| `VERGE_DIR` | Clash Verge data folder, for non-default installs such as portable builds |
| `CLASH_API` | The core's HTTP control address, e.g. `http://127.0.0.1:9097` |
| `CLASH_SOCKET` | Path of a named pipe or Unix socket to use directly |
| `CLASH_SECRET` | The core's control secret |

With `CLASH_API` you can also point it at other clients built on the mihomo / Clash Meta core. Without Clash Verge's subscription info, all marks are stored under a subscription named `default`.

## Security

- The service listens on `127.0.0.1` only and accepts only requests whose Host is `127.0.0.1` or `localhost`.
- The API requires a custom request header. A cross-origin request from another web page triggers a browser preflight, which the service does not answer, so other sites cannot quietly switch your nodes.
- The page can switch nodes and run delay tests. Do not expose it to your LAN or the internet through port forwarding or similar.

## Troubleshooting

**The page says it can't reach the mihomo core**: Clash Verge is not running, or the core is restarting. Open Clash Verge and wait a few seconds; the page recovers on its own.

**The page says the local service has stopped**: the background service exited on its own; run `node nodemark.js` again. If this happens while the page is still open, the browser's memory saving (for example Chrome's Memory Saver) has most likely frozen a tab you hadn't looked at for a while, so the service thought the page was closed. Start with `--keep` to avoid it.

**With 按cv selected, group headers say the background service is outdated (or 取消全部标记, or 测全组 in system-rating mode, says so)**: after you update the code, a page reload picks up the new page, but the background service only updates when restarted. Run `node nodemark.js stop`, then `node nodemark.js` again.

**Port already in use**: pick another one with `--port`.

**Flags show as two letters**: Windows fonts don't draw flag emoji, so the page loads a flags-only font from jsDelivr. If jsDelivr is unreachable you see letters instead, and everything else still works.

**The background service failed, or you don't know when or why it exited**: check `nodemark.log` in the same folder as `marks.json`. Every line is timestamped. It records each start (including whether the service will exit on its own), pages connecting and disconnecting, waking up after the computer slept or hibernated, and why the service exited: all pages closed, `stop`, a system signal, or an error. Each start appends to the file instead of clearing the previous run; once it grows past 1 MB, the next start renames it to `nodemark.old.log` and begins a new one. If the last entries are not followed by a "进程退出" (process exited) line, the process was killed forcibly (for example from Task Manager or with `taskkill /F`). You can also run `node nodemark.js serve` to see the output directly.

## License

[MIT](LICENSE)
