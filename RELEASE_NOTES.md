# Weport v0.8.1

## 🐛 修复：微信数据目录含非 ASCII 字符时，导出 / 新消息弹窗 / 防撤回全部失效

**症状**：应用能正常连接微信、显示会话列表，但导出报「创建游标失败: -3（消息数据库未找到）」；新消息从不弹窗；防撤回安装失败。

**根因**：微信数据目录若位于含中文等非 ASCII 字符的路径下（例如 `C:\Users\xxx\OneDrive\文档\xwechat_files\...`），`wcdb_api.dll` 内部的**消息库目录扫描**无法处理该路径（在 en-US 系统区域设置下更明显），扫描结果为空 → `message_db_cache_refresh count=0` → 打开消息游标恒返回 `-3`。而 session.db / contact.db 通过完整路径直连仍可打开，所以连接看似正常，问题被掩盖。

**修复**：检测到账号目录含非 ASCII 字符时，自动创建一个 **NTFS junction**（`%APPDATA%\weport\wcdb-junctions\`，无需管理员权限）把账号目录映射到纯 ASCII 路径，仅将该映射路径交给引擎访问消息库；会话、联系人、媒体等其余功能仍使用原始路径。junction 复用现有映射、目标移动后自动重建。

**验证**：同一份微信数据，中文路径下 `list_message_dbs` 返回空、`open_message_cursor` 返回 -3；经 junction 后返回 2 个消息库、游标正常打开。修复后导出、弹窗、防撤回恢复可用。

[MIT License](https://github.com/Panther114/Weport/blob/main/LICENSE)
