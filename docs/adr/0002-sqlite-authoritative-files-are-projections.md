---
status: accepted
---

# SQLite 行权威，文件是确定性投影

`Hub` 里的 SQLite 行是真相；磁盘上的文件是由它重新生成的确定性投影，带 checksum。手动改过的文件作为新 revision 导入，绝不静默合并回数据库。

**Considered Options**

- **文件权威、SQLite 只做索引**：符合「可读可 grep」的直觉，但 `SourceRef` 是指针，文件被改名或手改后指针就断了。
- **双写强一致**：看似完美，实则需要两阶段提交与修复流程，是最难的一种。
- **SQLite 权威**（选定）：指针稳定，投影可随时重建。

**Consequences**

- 文件仍然可以被编辑器打开、被 grep、被 git 管理——只是不回写。
- 用户手改文件不会丢，而是变成一次可追溯的 revision。
- 投影规则（命名、目录、checksum）必须是确定性的，否则重建会产生 diff 噪声。
