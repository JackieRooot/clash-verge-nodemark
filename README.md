**中文** | [English](README.en.md)

# clash-verge-nodemark

给 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的节点标记实际使用体验：在浏览器里打开一个和 Clash Verge 代理页一样的页面，右键节点卡片，标记为 ✓ 好用 / ! 一般 / ✕ 不建议，标记会直接显示在卡片上。

不改 Clash Verge 的任何设置，也不用改它的源码重新编译。本工具直接连接 Clash Verge 自带的 mihomo 内核，读到的代理组、当前节点、延迟和 Clash Verge 里看到的一致。只有一个 Node.js 脚本，没有依赖。

![页面截图：右键节点卡片弹出标记菜单，已标记的卡片显示绿、黄、红三色](docs/screenshot.jpg)

<sub>截图用的是演示模式的假数据（`node nodemark.js --demo`）。</sub>

## 功能

- **镜像代理组**：分组顺序、当前选中的节点、节点类型、延迟都和 Clash Verge 一样，每 3 秒刷新一次。
- **右键标记**：好用 / 一般 / 不建议 / 清除。标记后卡片显示对应颜色的边框、底色和右上角徽标，组标题旁显示每档数量。
- **左键切换节点**：和在 Clash Verge 里点一样，Clash Verge 会同步变化。
- **测延迟**：点卡片右下角测单个节点，点「测全组」测整组。测速地址和超时沿用 Clash Verge 的设置。
- **筛选和排序**：搜索；按默认顺序 / 延迟 / 标记 / 标记+延迟 / 名称排序；隐藏不建议的节点；只看已标记的节点。
- **多订阅**：标记按订阅分开存，切换订阅不会串。
- **自动跟随节点变化**：每个订阅的节点清单以内核里的真实清单为准，自动增删（见下文「标记数据」）。

## 环境要求

- Clash Verge Rev 2.x，运行中。
- [Node.js](https://nodejs.org/) 16 或更高版本。

在 Windows 11 + Clash Verge Rev 2.5.8（mihomo v1.19.32）上实测通过。macOS 和 Linux 按 Clash Verge Rev 源码里的配置位置实现了，但还没有实测，遇到问题欢迎提 issue。

## 安装和运行

方式一：克隆后直接运行

```bash
git clone https://github.com/JackieRooot/clash-verge-nodemark.git
cd clash-verge-nodemark
node nodemark.js
```

方式二：全局安装成 `nodemark` 命令

```bash
npm install -g github:JackieRooot/clash-verge-nodemark
nodemark
```

运行后会在后台启动服务，倒数 3 秒后用默认浏览器打开 http://127.0.0.1:9099 （倒数时按 Ctrl+C 可以取消打开浏览器）。服务已经在运行时只打开浏览器。关掉终端不影响后台服务；**关掉所有页面 15 秒后，后台服务会自动退出**（刷新页面不算关掉），下次用时再运行一次就行。

| 命令 | 作用 |
|---|---|
| `node nodemark.js` | 服务没在运行就在后台启动，然后打开浏览器 |
| `node nodemark.js --keep` | 同上，但关掉页面后服务不自动退出 |
| `node nodemark.js --no-open` | 只启动，不打开浏览器，也不自动退出 |
| `node nodemark.js stop` | 手动停掉后台服务，用于 `--keep`、`--no-open` 启动的服务，或者想立刻停掉的时候 |
| `node nodemark.js serve` | 在当前终端前台运行服务，日志直接打印出来，按 Ctrl+C 停止。平时用不到，排查问题时用 |
| `node nodemark.js --demo` | 演示模式：用假的节点数据，不需要装 Clash Verge，标记只存在内存里。默认端口 9098，停止用 `node nodemark.js stop --demo` |
| `--port <端口>` | 换端口，默认 9099，各命令都能加 |

想先看看效果，可以直接运行 `node nodemark.js --demo`。

### 设一个简写命令（可选）

PowerShell：在 `$PROFILE` 里加一个函数，把路径换成你自己的：

```powershell
function jd { node "D:\path\to\clash-verge-nodemark\nodemark.js" @args }
```

bash / zsh：在 `~/.bashrc` 或 `~/.zshrc` 里加：

```bash
alias jd='node ~/path/to/clash-verge-nodemark/nodemark.js'
```

用全局安装的话，直接输入 `nodemark` 就行。

## 标记数据

标记存在 `marks.json` 里，按订阅（Clash Verge `profiles.yaml` 里的 uid）分开记录：

| 系统 | 位置 |
|---|---|
| Windows | `%APPDATA%\clash-verge-nodemark\marks.json` |
| macOS | `~/Library/Application Support/clash-verge-nodemark/marks.json` |
| Linux | `~/.local/share/clash-verge-nodemark/marks.json`（设置了 `XDG_DATA_HOME` 时放在它下面） |

节点清单的同步规则：

- 新出现的节点自动加进清单，不带标记。
- 已经不存在的节点从清单里删掉。如果它带标记，会记进该订阅的 `removed` 列表（保留最近 200 条），页面底部显示最近的记录，方便节点改名后照着重新标。
- 只同步当前订阅，其他订阅的记录保持不动。
- 防误删：同一订阅下，同一份节点清单要稳定 5 秒以上才同步，避免切换订阅的过渡期把清单删错。

标记按节点名匹配，机场给节点改名后，原来的标记就对不上了。`marks.json` 损坏打不开时，程序会先另存一份 `marks.json.broken-<时间戳>`，再从空记录开始。

## 原理

Clash Verge Rev 会把它和内核通信用的控制接口写进运行时配置 `clash-verge.yaml`：Windows 上是命名管道（`external-controller-pipe`），macOS / Linux 上是 Unix socket（`external-controller-unix`）。本工具从这个文件读到地址和密钥，通过同一个接口读代理组、切节点、测延迟，所以不需要打开 Clash Verge 的「外部控制」。如果没有管道或 socket，但开了「外部控制」，就改用 HTTP 地址。

Clash Verge 的数据目录默认在：

| 系统 | 位置 |
|---|---|
| Windows | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` |
| macOS | `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev` |
| Linux | `~/.local/share/io.github.clash-verge-rev.clash-verge-rev` |

### 环境变量

都不是必需的，默认情况下不用设置。

| 变量 | 作用 |
|---|---|
| `NODEMARK_PORT` | 页面端口，默认 9099（`--port` 优先） |
| `NODEMARK_DATA_DIR` | 标记文件和日志放在哪个目录 |
| `NODEMARK_TEST_URL` | 测速地址，默认用 Clash Verge 的设置，没设就用 `https://cp.cloudflare.com/generate_204` |
| `VERGE_DIR` | Clash Verge 的数据目录，装在非默认位置（例如便携版）时用 |
| `CLASH_API` | 直接指定内核的 HTTP 控制地址，例如 `http://127.0.0.1:9097` |
| `CLASH_SOCKET` | 直接指定命名管道或 Unix socket 路径 |
| `CLASH_SECRET` | 内核的控制密钥 |

用 `CLASH_API` 还可以连其他基于 mihomo / Clash Meta 内核的客户端。这时没有 Clash Verge 的订阅信息，所有标记都记在名为 `default` 的订阅下。

## 安全

- 服务只监听 `127.0.0.1`，只接受 Host 为 `127.0.0.1` 或 `localhost` 的请求。
- 接口要求一个自定义请求头。其他网页的跨域请求会先触发浏览器预检，这里不应答，所以别的网页没法偷偷调用接口切换你的节点。
- 页面能切换节点、触发测速，不要通过端口转发等方式把它暴露到局域网或公网。

## 常见问题

**页面显示「连不上 mihomo 内核」**：Clash Verge 没开，或者内核正在重启。打开 Clash Verge 后等几秒，页面会自动恢复。

**页面显示「本地服务已停止」**：后台服务已经自动退出了，重新运行一次 `node nodemark.js` 就行。如果页面没关也遇到这种情况，多半是浏览器的省内存功能（比如 Chrome 的 Memory Saver）把长时间没看的标签页冻结了，服务以为页面关掉了。不想遇到的话，用 `--keep` 启动。

**提示端口被占用**：用 `--port` 换一个端口。

**国旗显示成两个字母**：Windows 自带字体不画国旗 emoji，页面会从 jsDelivr 加载一个只含国旗的字体来补。网络访问不了 jsDelivr 时就显示成字母，不影响其他功能。

**后台服务出错了**：看日志 `nodemark.log`，和 `marks.json` 在同一个目录。也可以用 `node nodemark.js serve` 在前台运行，直接看输出。

## 许可证

[MIT](LICENSE)
