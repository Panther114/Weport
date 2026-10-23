# macOS 与 Linux 安装说明

[返回 README](../README.md)

先检查[下载页面](https://github.com/Panther114/Weport/releases)是否提供目标版本的安装包。v1.3.0 本次仅提供 Windows 安装包；macOS/Linux 暂缓发布，本轮未完成这两个平台的原生运行验证。

## macOS

支持 Apple Silicon（arm64），不支持 Intel Mac。既有版本面向 macOS 15+ 和微信 4.x。

1. 下载对应版本的 `arm64.dmg`，将 Weport 拖入「应用程序」。
2. 首次打开时，右键应用选择「打开」。如被系统拦截，在「系统设置 → 隐私与安全性」检查放行选项。
3. 在「连接微信」选择账号目录，通常位于 `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`。
4. 按页面提示配置数据库密钥，再连接。

安装包采用 ad-hoc 签名，未经过 Apple 公证。确认下载来源可信后，如仍提示应用已损坏，可在终端运行：

```sh
xattr -cr /Applications/Weport.app
```

自动获取密钥可能需要管理员授权，也可能被系统的 SIP/AMFI 保护拒绝。授权并不保证成功；请按实际诊断结果处理，不要为了使用 Weport 长期关闭 SIP。已有密钥时，读取和导出不需要调试权限。

## Linux

支持 x64、微信 4.x。运行环境需要 glibc 2.34+、GLIBCXX 3.4.30+ 和 OpenSSL 3。

Ubuntu/Debian 优先选择 `.deb`，在安装包所在目录运行以下命令，并将文件名替换为实际下载的文件：

```sh
sudo apt install ./Weport-版本号-amd64.deb
```

安装后从应用菜单启动。包依赖会安装 ffmpeg，用于部分微信图片转换。便携包用户需要自行安装 ffmpeg；没有可用转换器时，某些图片只能使用同图的可解密缩略图。

- `.AppImage` 是便携包，运行时会关闭 Chromium 沙箱；无法启动时可检查发行版的 FUSE 2 兼容包。
- `.tar.gz` 不自动配置系统沙箱辅助程序；限制用户命名空间的系统可能无法直接启动。
- 不要通过关闭系统安全策略解决启动问题。

应用会检测 `~/xwechat_files`、`~/.xwechat/xwechat_files`、`~/.local/share/xwechat_files` 和 Flatpak 数据目录。密钥提取可能需要 sudo。失败时检查诊断结果、`libcrypto.so.3`、`libcurl.so.4`、helper 的执行权限与系统 ptrace 限制。

Linux 更新需要手动下载新版本。平台相关的开发细节见[平台文档](agents/platform.md)。
