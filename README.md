# 磁盘空间清理

一个在本机运行的 Windows 磁盘空间可视化分析与清理工具。会自动识别本机实际挂载的全部磁盘（盘符由系统分配，不固定为某几个字母）并切换分析对象，用方块图直接看谁在占用空间，逐层点开查看目录明细，并在同一个界面里把不需要的内容移入回收站或永久删除。

桌面版是独立的 Windows 应用，带原生窗口，不需要安装 Node.js；浏览器版仍可从源码运行。

> 只监听本机 `127.0.0.1`，扫描结果不会离开你的电脑，仓库和安装包中都不包含任何本机扫描数据。

## 下载桌面应用（推荐）

直接下载应用文件：**[DriveCleaner-1.2.1-portable.exe](https://github.com/DreamChaser-strive/drive-cleaner/releases/download/v1.2.1/DriveCleaner-1.2.1-portable.exe)**

也可以进入 **[Releases 页面](https://github.com/DreamChaser-strive/drive-cleaner/releases/latest)** 下载最新版。

> 请不要下载页面底部的 `Source code (zip)`，那只是源码压缩包，不包含应用程序。应用文件必须以 `.exe` 结尾，文件名类似 `DriveCleaner-1.2.1-portable.exe`。

如果你已经下载了源码 ZIP，解压后双击 **`download-app.bat`**，脚本会从 Releases 自动下载最新 exe 到当前目录。

双击 exe 即可运行，无需安装 Node.js，也无需打开命令行。

- 首次启动会自动扫描系统盘，通常需要约 1 分钟；顶部磁盘标签可切换到本机其他任意磁盘。
- 扫描数据保存在 `%APPDATA%\DriveCleaner\data`，每个盘符单独保存，仅在本机使用。
- 应用未做代码签名，Windows SmartScreen 可能提示「Windows 已保护你的电脑」。点击「更多信息」→「仍要运行」即可。
- 便携版可以放在任意文件夹；右键 exe →「发送到」→「桌面快捷方式」即可固定到桌面。

## 功能

- **多磁盘切换**：自动识别本机实际挂载的固定磁盘和可移动磁盘（盘符不固定），逐个标签切换；插拔 U 盘、移动硬盘后点刷新按钮或等待约 1 分钟即可重新识别。
- **方块空间图**：按文件大小绘制可交互的 treemap，单击选中、双击进入目录。
- **实时扫描**：重新扫描时方块和容量条会随着已发现的文件持续变化，不必等扫描结束。
- **目录明细**：查看子目录和文件大小，支持按大小排序、搜索和路径跳转。
- **清理建议**：系统盘区分「推荐清理」「谨慎清理」「系统项目」；其他磁盘展示大目录快捷入口。
- **两种删除方式**：默认移入回收站；永久删除需要二次勾选确认。
- **安全防护**：禁止删除磁盘根目录；系统盘保护 Windows、Program Files、ProgramData、用户主目录等；所有磁盘均保护回收站和系统保留区域。
- **本地服务**：随机请求令牌 + 仅本机访问，不依赖云端。
- **桌面封装**：Electron 原生窗口、单实例运行，关闭窗口即退出后台服务。

## 从源码运行

需要 Windows 10 / 11、[Node.js](https://nodejs.org/) 18 或更高版本。不需要管理员权限。

```bash
git clone https://github.com/DreamChaser-strive/drive-cleaner.git
cd drive-cleaner
npm install

npm start          # 以桌面窗口运行
npm run start:web  # 以浏览器模式运行：http://127.0.0.1:17878/
npm run scan       # 单独重新扫描系统盘
```

桌面版通过 `electron/main.js` 启动：自动选择本机空闲端口、启动后台服务、打开原生窗口，并在退出时结束服务与扫描进程。

### 打包 Windows 应用

```bash
npm install
npm run build:win
```

生成的文件位于 `dist/DriveCleaner-1.2.1-portable.exe`。

### 浏览器模式创建桌面快捷方式

双击 **`create-shortcut.bat`**，会生成指向浏览器模式启动入口的快捷方式。桌面版用户不需要这一步，直接给 exe 创建快捷方式即可。

## 使用说明

- 顶部「磁盘」标签会列出本机实际识别到的每个盘符、卷标和剩余空间（左侧显示识别到的磁盘总数），点击即可切换当前分析对象；标签右侧的刷新按钮可立即重新识别磁盘。
- **单击**方块：在右侧查看该目录或文件的详细信息。
- **双击**方块或点击行尾箭头：进入该目录。
- 勾选列表中的项目可批量删除；顶部「清理建议」可以快速选中常见缓存。
- 右上角「重新扫描」会实时刷新方块图；扫描期间仍可浏览和搜索，但删除按钮会暂时锁定，避免统计结果变化。
- 删除成功后，界面中的大小和总量会同步扣减，无需刷新页面。

## 关于删除

**移入回收站**是默认方式，更安全，但在清空回收站之前不会释放磁盘空间。**永久删除**不可恢复，必须额外勾选确认，请只对确认无用的缓存或测试数据使用。

以下位置不会被工具删除：任何磁盘的根目录、系统盘的 Windows、Program Files、ProgramData、用户主目录、桌面/文档/下载等个人目录、应用数据根目录、工具自身目录，以及系统关键文件。需要清理系统组件时，请使用 Windows 设置或官方卸载程序。

## 数据与隐私

- 桌面版数据目录：`%APPDATA%\DriveCleaner\data`
- 源码运行数据目录：项目下的 `data/`
- 系统盘使用 `scan.json`、`progress.json`；其他磁盘使用 `scan.D.json`、`progress.D.json` 等独立文件。
- 扫描结果包含本机真实目录路径，已加入 `.gitignore`，不会提交，也不会打包进 exe。
- 界面的所有请求只在 `127.0.0.1` 上处理。

## 项目结构

```text
drive-cleaner/
├─ electron/main.js           # 桌面应用入口（窗口、后台服务生命周期）
├─ public/                    # 前端界面（Canvas treemap + 列表）
├─ build/                     # 应用图标
├─ scan.js                    # 磁盘空间扫描器（按 CDRIVE_ROOT 选择盘符）
├─ server.js                  # 本地 HTTP 服务与删除 API
├─ recycle.ps1                # 调用 Windows 回收站 API
├─ electron-builder.yml       # Windows 打包配置
├─ download-app.bat           # 从 Releases 下载最新 exe（源码 ZIP 用户用）
├─ download-app.ps1           # 下载脚本
├─ 启动磁盘空间清理.bat       # 浏览器模式启动入口（开发用）
├─ create-shortcut.bat        # 浏览器模式快捷方式
├─ create-shortcut.ps1        # 快捷方式创建逻辑
└─ data/                      # 源码模式的本地扫描数据（不提交）
```

## 已知限制

- 只支持 Windows x64，可分析本机固定磁盘和可移动磁盘。
- 显示的是文件逻辑大小，与资源管理器或磁盘占用可能略有差异。
- 扫描会跳过符号链接和 junction，避免重复计算与死循环。
- 部分受系统保护的位置可能无法读取，错误会被跳过，不影响其余结果。
- `pagefile.sys`、`hiberfil.sys`、系统还原点等不建议直接删除，界面会以系统项目单独展示。
- 若文件正被其他程序占用，删除可能失败；关闭对应程序后重试。
- 便携版未签名，首次运行可能触发 SmartScreen 提示。

## 免责声明

本工具会执行真实文件删除操作。请在使用前备份重要数据，并确认所选内容确实不再需要。作者不对因使用本工具造成的数据丢失或系统问题承担责任。
