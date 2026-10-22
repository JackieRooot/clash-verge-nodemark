[中文](README.md) | **English**

# clash-verge-nodemark

Rate the nodes in [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) by how well they actually work for you. It opens a page in your browser that mirrors the Clash Verge proxies page. Right-click a node card to mark it ✓ good / ! so-so / ✕ avoid, and the mark shows on the card.

It changes no Clash Verge settings and needs no patched build. It talks to the mihomo core that Clash Verge already runs, so the groups, selected nodes and delays match what Clash Verge shows. It is a single Node.js script with no dependencies.

![Screenshot: right-clicking a node card opens the mark menu; marked cards show green, amber or red](docs/screenshot.jpg)

<sub>The screenshot uses the fake data of demo mode (`node nodemark.js --demo`).</sub>

> The page itself is in Chinese. The labels are few: 好用 = good, 一般 = so-so, 不建议 = avoid, 测全组 = test the whole group, 测速 = test delay.

## Features

- **Mirrored proxy groups**: same group order, selected node, node type and delay as Clash Verge, refreshed every 3 seconds.
- **Right-click to mark**: good / so-so / avoid / clear. Marked cards get a colored border, a tinted background and a badge in the top-right corner. Each group header shows how many nodes carry each mark.
- **Left-click to switch**: works like clicking in Clash Verge, and Clash Verge follows the change.
- **Delay tests**: click the delay at the bottom-right of a card to test one node, or 测全组 to test a whole group. The test URL and timeout come from your Clash Verge settings.
- **Filter and sort**: search; sort by default order, delay, mark, mark then delay, or name; hide nodes marked avoid; show only marked nodes.
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

This starts the service in the background and opens http://127.0.0.1:9099 in your default browser. If the service is already running, it only opens the browser. Closing the terminal does not stop the service.

| Command | What it does |
|---|---|
| `node nodemark.js` | Start the service in the background if needed, then open the browser |
| `node nodemark.js --no-open` | Start the service without opening the browser |
| `node nodemark.js stop` | Stop the background service. Once started, the service keeps running in the background; use this when you no longer need it |
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

Marks are matched by node name, so if your provider renames a node, its old mark no longer applies. If `marks.json` is corrupted, it is copied to `marks.json.broken-<timestamp>` and a fresh file is started.

## How it works

Clash Verge Rev writes the control endpoint it uses to talk to the core into its runtime config `clash-verge.yaml`: a named pipe on Windows (`external-controller-pipe`) and a Unix socket on macOS / Linux (`external-controller-unix`). This tool reads the endpoint and secret from that file and uses the same interface to read groups, switch nodes and test delays, so you don't need to turn on Clash Verge's "External Controller". If there is no pipe or socket but the external controller is on, it falls back to that HTTP address.

Clash Verge's data folder is, by default:

| OS | Location |
|---|---|
| Windows | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` |
| macOS | `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev` |
| Linux | `~/.local/share/io.github.clash-verge-rev.clash-verge-rev` |

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

**Port already in use**: pick another one with `--port`.

**Flags show as two letters**: Windows fonts don't draw flag emoji, so the page loads a flags-only font from jsDelivr. If jsDelivr is unreachable you see letters instead, and everything else still works.

**The background service failed**: check `nodemark.log` in the same folder as `marks.json`, or run `node nodemark.js serve` to see the output directly.

## License

[MIT](LICENSE)
